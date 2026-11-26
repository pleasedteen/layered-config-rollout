import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_COORDINATOR_ID,
  generateCredential,
  type Credential,
  type RotateWhich,
} from './auth.js';

export type { RotateWhich } from './auth.js';

/**
 * Durable, per-service mutual-auth credentials.
 *
 * The local fixture writes one `credentials.json` into the shared data
 * directory before spawning processes. Both the coordinator and the services
 * re-read this tiny file on every authenticated exchange, so rotation is
 * visible immediately and the *current* credentials survive process restarts.
 * Only one active request credential and one active receipt credential per
 * service are retained: rotating deactivates the previous key at once.
 */

export interface ServiceAuthMaterial {
  serviceId: string;
  /** Coordinator -> service request signing credential. */
  request: Credential;
  /** Service -> coordinator receipt signing credential. */
  receipt: Credential;
}

export interface ClusterAuthFile {
  version: 1;
  coordinatorId: string;
  services: Record<string, ServiceAuthMaterial>;
}

export interface AuthProvider {
  readonly coordinatorId: string;
  requestCredential(serviceId: string): Promise<Credential>;
  receiptCredential(serviceId: string): Promise<Credential>;
  rotate(serviceId: string, which: RotateWhich): Promise<RotationResult>;
}

export interface RotationResult {
  serviceId: string;
  which: RotateWhich;
  before: ServiceAuthMaterial;
  after: ServiceAuthMaterial;
}

export function generateClusterAuth(
  serviceIds: string[],
  coordinatorId: string = DEFAULT_COORDINATOR_ID,
): ClusterAuthFile {
  const services: Record<string, ServiceAuthMaterial> = {};
  for (const serviceId of serviceIds) {
    services[serviceId] = {
      serviceId,
      request: generateCredential('request', serviceId),
      receipt: generateCredential('receipt', serviceId),
    };
  }
  return { version: 1, coordinatorId, services };
}

export class AuthFileStore implements AuthProvider {
  readonly coordinatorId: string = DEFAULT_COORDINATOR_ID;

  constructor(
    public readonly filePath: string,
    coordinatorId: string = DEFAULT_COORDINATOR_ID,
  ) {
    this.coordinatorId = coordinatorId;
  }

  /** Loads the file if present, otherwise creates it for the given services. */
  async init(serviceIds: string[]): Promise<ClusterAuthFile> {
    let auth: ClusterAuthFile | undefined;
    try {
      auth = await this.read();
    } catch (error) {
      // Atomic temp+rename writes mean a present file is always complete and
      // parseable; only a missing file should trigger first-time generation.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!auth) {
      const created = generateClusterAuth(serviceIds, this.coordinatorId);
      await this.write(created);
      return created;
    }
    let changed = false;
    for (const serviceId of serviceIds) {
      if (!auth.services[serviceId]) {
        auth.services[serviceId] = {
          serviceId,
          request: generateCredential('request', serviceId),
          receipt: generateCredential('receipt', serviceId),
        };
        changed = true;
      }
    }
    if (changed) await this.write(auth);
    return auth;
  }

  /** Always re-reads from disk so cross-process rotations are observed. */
  async read(): Promise<ClusterAuthFile> {
    const raw = await readFile(this.filePath, 'utf8');
    const parsed = JSON.parse(raw) as ClusterAuthFile;
    if (parsed?.version !== 1 || !parsed.services) {
      throw new Error(`invalid credentials file: ${this.filePath}`);
    }
    return parsed;
  }

  private async write(auth: ClusterAuthFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(auth, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  async rotate(serviceId: string, which: RotateWhich): Promise<RotationResult> {
    const auth = await this.read();
    const current = auth.services[serviceId];
    if (!current) throw new Error(`no credentials for service ${serviceId}`);
    const before: ServiceAuthMaterial = structuredClone(current);
    const after: ServiceAuthMaterial = structuredClone(current);
    if (which === 'request' || which === 'both') {
      after.request = generateCredential('request', serviceId);
    }
    if (which === 'receipt' || which === 'both') {
      after.receipt = generateCredential('receipt', serviceId);
    }
    auth.services[serviceId] = after;
    await this.write(auth);
    return { serviceId, which, before, after };
  }

  async requestCredential(serviceId: string): Promise<Credential> {
    const auth = await this.read();
    const material = auth.services[serviceId];
    if (!material) throw new Error(`no request credential for service ${serviceId}`);
    return material.request;
  }

  async receiptCredential(serviceId: string): Promise<Credential> {
    const auth = await this.read();
    const material = auth.services[serviceId];
    if (!material) throw new Error(`no receipt credential for service ${serviceId}`);
    return material.receipt;
  }
}

/** In-memory provider for embedded/unit usage without a credentials file. */
export class InMemoryAuthProvider implements AuthProvider {
  private auth: ClusterAuthFile;

  constructor(serviceIds: string[], coordinatorId: string = DEFAULT_COORDINATOR_ID) {
    this.auth = generateClusterAuth(serviceIds, coordinatorId);
  }

  get coordinatorId(): string {
    return this.auth.coordinatorId;
  }

  data(): ClusterAuthFile {
    return this.auth;
  }

  async requestCredential(serviceId: string): Promise<Credential> {
    const material = this.auth.services[serviceId];
    if (!material) throw new Error(`no request credential for service ${serviceId}`);
    return material.request;
  }

  async receiptCredential(serviceId: string): Promise<Credential> {
    const material = this.auth.services[serviceId];
    if (!material) throw new Error(`no receipt credential for service ${serviceId}`);
    return material.receipt;
  }

  async rotate(serviceId: string, which: RotateWhich): Promise<RotationResult> {
    const current = this.auth.services[serviceId];
    if (!current) throw new Error(`no credentials for service ${serviceId}`);
    const before = structuredClone(current);
    const after = structuredClone(current);
    if (which === 'request' || which === 'both') after.request = generateCredential('request', serviceId);
    if (which === 'receipt' || which === 'both') after.receipt = generateCredential('receipt', serviceId);
    this.auth.services[serviceId] = after;
    return { serviceId, which, before, after };
  }
}
