import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ChaosProxy } from '../chaos/proxy.js';
import { probePort, waitForInstanceHealth } from '../shared/http.js';
import { ConfigService } from '../service/config-service.js';
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
  exited: boolean;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
}

export interface FixtureClusterOptions {
  fixturePath: string;
  dataDir?: string;
  coordinatorPort?: number;
  controlPort?: number;
  servicePorts?: Record<string, { direct?: number; chaos?: number }>;
  requestTimeoutMs?: number;
  reconcileIntervalMs?: number;
  startCoordinator?: boolean;
  verbose?: boolean;
  /** Aborting this signal mimics pressing Ctrl+C while the cluster is starting. */
  startupSignal?: AbortSignal;
  /** Test hook: invoked after every service child has reported instance health. */
  onServiceStarted?: (serviceId: string) => void;
}

export class FixtureCluster {
  readonly dataDir: string;
  readonly fixture: FixtureData;
  readonly fixturePath: string;
  readonly requestTimeoutMs: number;
  readonly reconcileIntervalMs: number;
  readonly instanceId: string;
  readonly services = new Map<string, ManagedService>();
  coordinatorPort: number | undefined;
  coordinatorUrl: string | undefined;
  coordinatorChild: ChildProcess | undefined;
  coordinatorLogs: string[] = [];
  coordinatorIntentionalStop = false;
  coordinatorExited = false;
  clusterConfigPath: string | undefined;

  private startupSignal?: AbortSignal;
  private onServiceStarted?: (serviceId: string) => void;
  private readonly startOptions: FixtureClusterOptions;

  private constructor(options: FixtureClusterOptions, fixture: FixtureData, dataDir: string) {
    this.startOptions = options;
    this.fixturePath = options.fixturePath;
    this.fixture = fixture;
    this.dataDir = dataDir;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 350;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 250;
    this.instanceId = randomUUID();
    this.startupSignal = options.startupSignal;
    this.onServiceStarted = options.onServiceStarted;
  }

  /**
   * Starts the whole cluster and only resolves once every coordinator,
   * service, chaos proxy and applicable control port required by THIS startup
   * is ready. Health answers from previous occupants never count: readiness is
   * proven by a health body carrying this cluster's instance id.
   *
   * On bind failure, component-not-ready or startup abort, every listener and
   * child process acquired by this startup is reclaimed (including processes
   * that never became ready), while pre-existing occupants are left untouched
   * and keep answering, so the same fixed ports can be retried afterwards.
   */
  static async start(options: FixtureClusterOptions): Promise<FixtureCluster> {
    const fixture = await ConfigService.loadFixture(options.fixturePath);
    const dataDir = options.dataDir ?? (await mkdtemp(path.join(tmpdir(), 'route-fixture-')));
    await mkdir(dataDir, { recursive: true });
    const cluster = new FixtureCluster(options, fixture, dataDir);

    try {
      await cluster.preflightFixedPorts();

      for (const definition of fixture.services) {
        cluster.throwIfAborted();
        const fixed = options.servicePorts?.[definition.id];
        const allocated = await getFreePorts(2);
        const directPort = fixed?.direct ?? allocated[0]!;
        const chaosPort = fixed?.chaos ?? allocated[1]!;
        const directUrl = `http://127.0.0.1:${directPort}`;
        const chaosUrl = `http://127.0.0.1:${chaosPort}`;
        const proxy = new ChaosProxy(definition.id, directUrl);
        try {
          await proxy.start(chaosPort);
        } catch (error) {
          throw new Error(
            `混沌代理 ${definition.id} 绑定控制口 ${chaosPort} 失败: ${(error as Error).message}`,
          );
        }
        cluster.services.set(definition.id, {
          id: definition.id,
          directPort,
          chaosPort,
          directUrl,
          chaosUrl,
          proxy,
          logs: [],
          intentionalStop: false,
          exited: false,
        });
        await cluster.spawnService(definition.id, cluster.startupSignal);
        cluster.onServiceStarted?.(definition.id);
      }

      cluster.coordinatorPort = options.coordinatorPort ?? (await getFreePort());
      cluster.coordinatorUrl = `http://127.0.0.1:${cluster.coordinatorPort}`;
      await cluster.writeClusterConfig();

      if (options.startCoordinator !== false) {
        await cluster.startCoordinator(cluster.startupSignal);
      }
      return cluster;
    } catch (error) {
      await cluster.stop().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Pre-flight check for every fixed port the caller asked for. A pre-existing
   * listener means this startup cannot claim the port, so fail fast with a
   * readable message before spawning anything. The probe never touches the
   * occupant beyond a TCP connect and does not close any socket of its own.
   */
  private async preflightFixedPorts(): Promise<void> {
    const fixedPorts = new Map<number, string>();
    if (this.startOptions.controlPort !== undefined) fixedPorts.set(this.startOptions.controlPort, '夹具控制口');
    if (this.startOptions.coordinatorPort !== undefined) {
      fixedPorts.set(this.startOptions.coordinatorPort, '协调器 API');
    }
    for (const definition of this.fixture.services) {
      const fixed = this.startOptions.servicePorts?.[definition.id];
      if (fixed?.direct !== undefined) fixedPorts.set(fixed.direct, `${definition.id} 直连口`);
      if (fixed?.chaos !== undefined) fixedPorts.set(fixed.chaos, `${definition.id} 混沌控制口`);
    }
    for (const [port, label] of [...fixedPorts.entries()].sort((a, b) => a[0] - b[0])) {
      const occupied = await probePort(port);
      if (occupied) {
        throw new Error(
          `${label}端口 ${port} 已被其他进程占用；本次启动不接管该占用者，故障解除后可用同一组端口重试`,
        );
      }
    }
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
      services: this.endpoints(),
    };
    this.clusterConfigPath = path.join(this.dataDir, 'cluster-config.json');
    await writeFile(this.clusterConfigPath, JSON.stringify(config, null, 2), 'utf8');
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

  private throwIfAborted(): void {
    if (this.startupSignal?.aborted) {
      throw new Error('启动途中收到中断信号（Ctrl+C），回收本次启动的全部组件');
    }
  }

  async spawnService(id: string, signal?: AbortSignal): Promise<void> {
    const managed = this.getService(id);
    if (managed.child && !managed.child.killed) return;
    managed.intentionalStop = false;
    managed.exited = false;
    managed.exitCode = undefined;
    managed.exitSignal = undefined;
    const child = spawn(
      process.execPath,
      [
        this.serviceMainPath(),
        `--service-id=${id}`,
        `--port=${managed.directPort}`,
        `--data-dir=${this.dataDir}`,
        `--fixture=${this.fixturePath}`,
        `--instance-id=${this.instanceId}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    managed.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.appendLog(managed.logs, chunk, `[${id}:out]`));
    child.stderr?.on('data', (chunk: Buffer) => this.appendLog(managed.logs, chunk, `[${id}:err]`, true));
    child.on('exit', (code, exitSignal) => {
      managed.exited = true;
      managed.exitCode = code;
      managed.exitSignal = exitSignal;
      if (!managed.intentionalStop) {
        managed.logs.push(`UNEXPECTED_EXIT code=${code ?? ''} signal=${exitSignal ?? ''}`);
      }
      managed.child = undefined;
    });
    try {
      await waitForInstanceHealth(managed.directUrl, this.instanceId, {
        signal,
        label: `服务 ${id}`,
        didExit: () => ({
          exited: managed.exited,
          code: managed.exitCode,
          signal: managed.exitSignal,
        }),
      });
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

  async startCoordinator(signal?: AbortSignal): Promise<void> {
    if (!this.clusterConfigPath) await this.writeClusterConfig();
    if (this.coordinatorChild && !this.coordinatorChild.killed) return;
    this.coordinatorIntentionalStop = false;
    this.coordinatorExited = false;
    const child = spawn(
      process.execPath,
      [
        this.coordinatorMainPath(),
        `--port=${this.coordinatorPort ?? 0}`,
        `--data-dir=${this.dataDir}`,
        `--fixture=${this.fixturePath}`,
        `--cluster-config=${this.clusterConfigPath}`,
        `--instance-id=${this.instanceId}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.coordinatorChild = child;
    child.stdout?.on('data', (chunk: Buffer) => this.appendLog(this.coordinatorLogs, chunk, '[coordinator:out]'));
    child.stderr?.on('data', (chunk: Buffer) => this.appendLog(this.coordinatorLogs, chunk, '[coordinator:err]', true));
    child.on('exit', (code, exitSignal) => {
      this.coordinatorExited = true;
      if (!this.coordinatorIntentionalStop) {
        this.coordinatorLogs.push(`UNEXPECTED_EXIT code=${code ?? ''} signal=${exitSignal ?? ''}`);
      }
      this.coordinatorChild = undefined;
    });
    if (!this.coordinatorUrl) throw new Error('coordinator URL was not initialized');
    try {
      await waitForInstanceHealth(this.coordinatorUrl, this.instanceId, {
        signal,
        label: '协调器',
        didExit: () => ({ exited: this.coordinatorExited }),
      });
    } catch (error) {
      throw new Error(
        `${(error as Error).message}\ncoordinator logs:\n${this.coordinatorLogs.slice(-30).join('\n')}`,
      );
    }
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
