import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { ChaosProxy } from '../chaos/proxy.js';
import { waitForHttpHealth } from '../shared/http.js';
import { ConfigService } from '../service/config-service.js';
import { AuthFileStore, type RotationResult, type RotateWhich } from '../shared/credentials.js';
import type { ClusterConfig, FixtureData, ServiceEndpoint } from '../shared/types.js';

const currentFile = fileURLToPath(import.meta.url);
const distRoot = path.resolve(path.dirname(currentFile), '..');

export function getFreePort(): Promise<number> {
  return getFreePorts(1).then((ports) => ports[0]!);
}

export async function getFreePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, () =>
      new Promise<net.Server>((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
      }),
    ),
  );
  const ports = servers.map((server) => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to allocate port');
    return address.port;
  });
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    ),
  );
  return ports;
}

export interface ManagedService {
  id: string;
  directPort: number;
  chaosPort: number;
  directUrl: string;
  chaosUrl: string;
  proxy: ChaosProxy;
  child?: ChildProcess;
  logs: string[];
  intentionalStop: boolean;
}

export interface FixtureClusterOptions {
  fixturePath: string;
  dataDir?: string;
  coordinatorPort?: number;
  servicePorts?: Record<string, { direct?: number; chaos?: number }>;
  requestTimeoutMs?: number;
  reconcileIntervalMs?: number;
  startCoordinator?: boolean;
  verbose?: boolean;
}

export class FixtureCluster {
  readonly dataDir: string;
  readonly fixture: FixtureData;
  readonly fixturePath: string;
  readonly requestTimeoutMs: number;
  readonly reconcileIntervalMs: number;
  readonly services = new Map<string, ManagedService>();
  coordinatorPort: number | undefined;
  coordinatorUrl: string | undefined;
  coordinatorChild: ChildProcess | undefined;
  coordinatorLogs: string[] = [];
  coordinatorIntentionalStop = false;
  clusterConfigPath: string | undefined;
  authStore: AuthFileStore | undefined;

  private constructor(options: FixtureClusterOptions, fixture: FixtureData, dataDir: string) {
    this.fixturePath = options.fixturePath;
    this.fixture = fixture;
    this.dataDir = dataDir;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 350;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 250;
  }

  static async start(options: FixtureClusterOptions): Promise<FixtureCluster> {
    const fixture = await ConfigService.loadFixture(options.fixturePath);
    const dataDir = options.dataDir ?? (await mkdtemp(path.join(tmpdir(), 'route-fixture-')));
    await mkdir(dataDir, { recursive: true });
    const cluster = new FixtureCluster(options, fixture, dataDir);

    cluster.authStore = new AuthFileStore(path.join(dataDir, 'credentials.json'));
    await cluster.authStore.init(fixture.services.map((service) => service.id));

    for (const definition of fixture.services) {
      const fixed = options.servicePorts?.[definition.id];
      const allocated = await getFreePorts(2);
      const directPort = fixed?.direct ?? allocated[0]!;
      const chaosPort = fixed?.chaos ?? allocated[1]!;
      const directUrl = `http://127.0.0.1:${directPort}`;
      const chaosUrl = `http://127.0.0.1:${chaosPort}`;
      const proxy = new ChaosProxy(definition.id, directUrl);
      await proxy.start(chaosPort);
      cluster.services.set(definition.id, {
        id: definition.id,
        directPort,
        chaosPort,
        directUrl,
        chaosUrl,
        proxy,
        logs: [],
        intentionalStop: false,
      });
      await cluster.spawnService(definition.id);
    }

    cluster.coordinatorPort = options.coordinatorPort ?? (await getFreePort());
    cluster.coordinatorUrl = `http://127.0.0.1:${cluster.coordinatorPort}`;
    await cluster.writeClusterConfig();

    if (options.startCoordinator !== false) {
      await cluster.startCoordinator();
    }
    return cluster;
  }

  getService(id: string): ManagedService {
    const service = this.services.get(id);
    if (!service) throw new Error(`unknown fixture service: ${id}`);
    return service;
  }

  endpoints(): ServiceEndpoint[] {
    return this.fixture.services.map((definition) => {
      const service = this.getService(definition.id);
      return { id: definition.id, baseUrl: service.chaosUrl, directUrl: service.directUrl };
    });
  }

  private async writeClusterConfig(): Promise<void> {
    const config: ClusterConfig = {
      dataDir: this.dataDir,
      fixturePath: this.fixturePath,
      requestTimeoutMs: this.requestTimeoutMs,
      reconcileIntervalMs: this.reconcileIntervalMs,
      credentialsPath: this.authStore?.filePath ?? path.join(this.dataDir, 'credentials.json'),
      services: this.endpoints(),
    };
    this.clusterConfigPath = path.join(this.dataDir, 'cluster-config.json');
    await writeFile(this.clusterConfigPath, JSON.stringify(config, null, 2), 'utf8');
  }

  async rotateCredential(serviceId: string, which: RotateWhich = 'both'): Promise<RotationResult> {
    if (!this.authStore) throw new Error('credential store was not initialized');
    return this.authStore.rotate(serviceId, which);
  }

  serviceMainPath(): string {
    return path.join(distRoot, 'service', 'main.js');
  }

  coordinatorMainPath(): string {
    return path.join(distRoot, 'coordinator', 'main.js');
  }

  private appendLog(buffer: string[], chunk: Buffer, prefix: string, verbose?: boolean): void {
    const text = chunk.toString('utf8');
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      buffer.push(line);
      if (buffer.length > 2000) buffer.shift();
      if (verbose) console.log(prefix, line);
    }
  }

  async spawnService(id: string): Promise<void> {
    const managed = this.getService(id);
    if (managed.child && !managed.child.killed) return;
    managed.intentionalStop = false;
    const child = spawn(
      process.execPath,
      [
        this.serviceMainPath(),
        `--service-id=${id}`,
        `--port=${managed.directPort}`,
        `--data-dir=${this.dataDir}`,
        `--fixture=${this.fixturePath}`,
        `--credentials=${this.authStore?.filePath ?? path.join(this.dataDir, 'credentials.json')}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    managed.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.appendLog(managed.logs, chunk, `[${id}:out]`));
    child.stderr?.on('data', (chunk: Buffer) => this.appendLog(managed.logs, chunk, `[${id}:err]`, true));
    child.on('exit', (code, signal) => {
      if (!managed.intentionalStop) {
        managed.logs.push(`UNEXPECTED_EXIT code=${code ?? ''} signal=${signal ?? ''}`);
      }
      managed.child = undefined;
    });
    try {
      await waitForHttpHealth(managed.directUrl, 15_000);
    } catch (error) {
      throw new Error(
        `${(error as Error).message}\nservice ${id} logs:\n${managed.logs.slice(-30).join('\n')}`,
      );
    }
  }

  private waitForChildExit(child: ChildProcess, timeoutMs = 3000): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async stopService(id: string): Promise<void> {
    const managed = this.getService(id);
    const child = managed.child;
    if (!child) return;
    managed.intentionalStop = true;
    child.kill('SIGTERM');
    await this.waitForChildExit(child);
    managed.child = undefined;
  }

  async restartService(id: string): Promise<ManagedService> {
    await this.stopService(id);
    await this.spawnService(id);
    return this.getService(id);
  }

  async startCoordinator(): Promise<void> {
    if (!this.clusterConfigPath) await this.writeClusterConfig();
    if (this.coordinatorChild && !this.coordinatorChild.killed) return;
    this.coordinatorIntentionalStop = false;
    const child = spawn(
      process.execPath,
      [
        this.coordinatorMainPath(),
        `--port=${this.coordinatorPort ?? 0}`,
        `--data-dir=${this.dataDir}`,
        `--fixture=${this.fixturePath}`,
        `--cluster-config=${this.clusterConfigPath}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.coordinatorChild = child;
    child.stdout?.on('data', (chunk: Buffer) => this.appendLog(this.coordinatorLogs, chunk, '[coordinator:out]'));
    child.stderr?.on('data', (chunk: Buffer) => this.appendLog(this.coordinatorLogs, chunk, '[coordinator:err]', true));
    child.on('exit', (code, signal) => {
      if (!this.coordinatorIntentionalStop) {
        this.coordinatorLogs.push(`UNEXPECTED_EXIT code=${code ?? ''} signal=${signal ?? ''}`);
      }
      this.coordinatorChild = undefined;
    });
    if (!this.coordinatorUrl) throw new Error('coordinator URL was not initialized');
    await waitForHttpHealth(this.coordinatorUrl, 15_000);
  }

  async stopCoordinator(): Promise<void> {
    const child = this.coordinatorChild;
    if (!child) return;
    this.coordinatorIntentionalStop = true;
    child.kill('SIGTERM');
    await this.waitForChildExit(child);
    this.coordinatorChild = undefined;
  }

  async restartCoordinator(): Promise<void> {
    await this.stopCoordinator();
    await this.startCoordinator();
  }

  async stop(): Promise<void> {
    await this.stopCoordinator().catch(() => undefined);
    await Promise.all([...this.services.keys()].map((id) => this.stopService(id).catch(() => undefined)));
    await Promise.all([...this.services.values()].map((service) => service.proxy.stop().catch(() => undefined)));
  }

  async removeDataDir(): Promise<void> {
    await rm(this.dataDir, { recursive: true, force: true });
  }
}
