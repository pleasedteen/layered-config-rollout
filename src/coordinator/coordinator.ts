import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AtomicJsonStore, delay, nowIso } from '../shared/store.js';
import { fetchJson } from '../shared/http.js';
import { ApiError } from '../shared/errors.js';
import {
  canonicalizeChanges,
  deriveTargetServiceIds,
  normalizeBatches,
  normalizeChanges,
} from '../shared/validation.js';
import type {
  CoordinatorPersistentState,
  ReleaseRecord,
  RepairServiceState,
  RevokeDispatchState,
  ServiceDispatchState,
  ServiceEndpoint,
  FixtureData,
} from '../shared/types.js';

export interface CoordinatorOptions {
  dataDir: string;
  fixture: FixtureData;
  endpoints: ServiceEndpoint[];
  requestTimeoutMs?: number;
  retryDelayMs?: number;
  reconcileIntervalMs?: number;
}

export interface CreateReleaseInput {
  releaseId?: unknown;
  changes?: unknown;
  targetServiceIds?: unknown;
  batches?: unknown;
  batchSize?: unknown;
}

export class Coordinator {
  readonly store: AtomicJsonStore<CoordinatorPersistentState>;
  private readonly endpoints = new Map<string, ServiceEndpoint>();
  private readonly loops = new Map<string, Promise<void>>();
  private reconcileTimer: NodeJS.Timeout | undefined;
  private readonly requestTimeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: CoordinatorOptions) {
    this.store = new AtomicJsonStore<CoordinatorPersistentState>(
      path.join(options.dataDir, 'coordinator-state.json'),
    );
    for (const endpoint of options.endpoints) this.endpoints.set(endpoint.id, endpoint);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 1200;
    this.retryDelayMs = options.retryDelayMs ?? 180;
  }

  async start(): Promise<void> {
    await this.store.initialize(() => ({ version: 1, acceptedOrder: 0, releases: {} }));
    await this.reconcileAll();
    for (const release of Object.values(this.store.get().releases)) {
      if (release.status === 'running' || release.status === 'pausing' || release.status === 'revoking') {
        this.ensureLoop(release.id);
      }
    }
  }

  startPeriodicReconcile(intervalMs = 700): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = setInterval(() => {
      void this.reconcileAll().catch((error) => {
        console.error('[coordinator] reconcile failed:', error);
      });
    }, intervalMs);
    this.reconcileTimer.unref?.();
  }

  close(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
  }

  getRelease(id: string): ReleaseRecord {
    const release = this.store.get().releases[id];
    if (!release) throw new ApiError(404, `unknown release: ${id}`);
    return release;
  }

  getServiceIds(): string[] {
    return [...this.endpoints.keys()];
  }

  listReleases(): ReleaseRecord[] {
    return Object.values(this.store.get().releases).sort((a, b) => b.acceptedOrder - a.acceptedOrder);
  }

  private endpoint(serviceId: string): ServiceEndpoint {
    const endpoint = this.endpoints.get(serviceId);
    if (!endpoint) throw new ApiError(500, `no endpoint configured for service ${serviceId}`);
    return endpoint;
  }

  private changesForService(release: ReleaseRecord, serviceId: string) {
    return release.changes.filter((change) => change.serviceId === serviceId);
  }

  private ensureLoop(id: string): void {
    if (this.loops.has(id)) return;
    const promise = this.runAppropriateLoop(id)
      .catch((error) => {
        console.error(`[coordinator] loop for ${id} failed:`, error);
      })
      .finally(() => {
        this.loops.delete(id);
      });
    this.loops.set(id, promise);
  }

  private async runAppropriateLoop(id: string): Promise<void> {
    const release = this.store.get().releases[id];
    if (!release) return;
    if (release.status === 'revoking') await this.runRevocationLoop(id);
    else if (release.status === 'running' || release.status === 'pausing') await this.runRolloutLoop(id);
  }

  async createRelease(input: CreateReleaseInput): Promise<ReleaseRecord> {
    const changes = normalizeChanges(input.changes, this.options.fixture);
    const targetServiceIds = deriveTargetServiceIds(changes, input.targetServiceIds);
    for (const serviceId of targetServiceIds) this.endpoint(serviceId);
    const batches = normalizeBatches(targetServiceIds, input.batches, input.batchSize);

    const requestedId = typeof input.releaseId === 'string' ? input.releaseId.trim() : '';
    if (requestedId && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requestedId)) {
      throw new ApiError(400, 'releaseId may contain only letters, numbers, dot, underscore and dash');
    }

    const record = await this.store.mutate((draft) => {
      if (requestedId && draft.releases[requestedId]) {
        throw new ApiError(409, `release already exists: ${requestedId}`);
      }
      draft.acceptedOrder += 1;
      const id = requestedId || `rel-${draft.acceptedOrder}-${randomUUID().slice(0, 8)}`;
      const timestamp = nowIso();
      const services: Record<string, ServiceDispatchState> = {};
      targetServiceIds.forEach((serviceId) => {
        const batchIndex = batches.findIndex((batch) => batch.includes(serviceId));
        services[serviceId] = {
          serviceId,
          batchIndex,
          status: 'pending',
          idempotencyKey: `accept:${id}:${serviceId}:v1`,
          attempts: 0,
        };
      });

      const release: ReleaseRecord = {
        id,
        status: 'running',
        coordinatorAcceptedAt: timestamp,
        acceptedOrder: draft.acceptedOrder,
        targetServiceIds,
        changes,
        batches,
        currentBatchIndex: 0,
        pauseRequested: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        services,
        events: [
          {
            at: timestamp,
            type: 'accepted',
            message: `Coordinator accepted release with ${changes.length} change(s), ${batches.length} batch(es)`,
          },
        ],
      };
      draft.releases[id] = release;
      return { next: draft, result: release };
    });

    this.ensureLoop(record.id);
    return record;
  }

  async pauseRelease(id: string): Promise<ReleaseRecord> {
    const record = await this.store.mutate((draft) => {
      const release = draft.releases[id];
      if (!release) throw new ApiError(404, `unknown release: ${id}`);
      if (release.status === 'completed' || release.status === 'revoked') {
        return { result: release };
      }
      if (release.status === 'paused') return { result: release };
      release.pauseRequested = true;
      if (release.status === 'running') release.status = 'pausing';
      release.updatedAt = nowIso();
      release.events.push({ at: nowIso(), type: 'pause-requested', message: 'Pause requested; current dispatched batch will settle' });
      return { next: draft, result: release };
    });
    return record;
  }

  async resumeRelease(id: string): Promise<ReleaseRecord> {
    const record = await this.store.mutate((draft) => {
      const release = draft.releases[id];
      if (!release) throw new ApiError(404, `unknown release: ${id}`);
      if (release.status !== 'paused') throw new ApiError(409, `release is ${release.status}, not paused`);
      release.status = 'running';
      release.pauseRequested = false;
      release.updatedAt = nowIso();
      release.events.push({ at: nowIso(), type: 'resumed', message: 'Resumed; next batch will be dispatched' });
      return { next: draft, result: release };
    });
    this.ensureLoop(id);
    return record;
  }

  async revokeRelease(id: string): Promise<ReleaseRecord> {
    const existing = this.getRelease(id);
    if (existing.status === 'revoked' || existing.status === 'revoking') return existing;
    if (existing.status !== 'completed') {
      throw new ApiError(409, `only completed releases can be revoked; current status is ${existing.status}`);
    }

    const record = await this.store.mutate((draft) => {
      const release = draft.releases[id]!;
      if (release.status === 'revoked' || release.status === 'revoking') {
        return { result: release };
      }
      if (release.status !== 'completed') {
        throw new ApiError(409, `only completed releases can be revoked; current status is ${release.status}`);
      }
      const timestamp = nowIso();
      const services: Record<string, RevokeDispatchState> = {};
      for (const serviceId of release.targetServiceIds) {
        services[serviceId] = {
          serviceId,
          batchIndex: release.services[serviceId]?.batchIndex ?? 0,
          status: 'pending',
          idempotencyKey: `revoke:${id}:${serviceId}:v1`,
          attempts: 0,
        };
      }
      release.status = 'revoking';
      release.updatedAt = timestamp;
      release.revocation = {
        status: 'running',
        currentBatchIndex: 0,
        startedAt: timestamp,
        services,
      };
      release.events.push({ at: timestamp, type: 'revoke-started', message: 'Revocation started; all target services must remove the contribution' });
      return { next: draft, result: release };
    });

    this.ensureLoop(id);
    return record;
  }

  private async runRolloutLoop(id: string): Promise<void> {
    while (true) {
      const release = this.store.get().releases[id];
      if (!release) return;
      if (release.status === 'paused' || release.status === 'completed' || release.status === 'revoking' || release.status === 'revoked') {
        return;
      }

      const batchIndex = release.currentBatchIndex;
      const batch = release.batches[batchIndex];
      if (!batch) {
        await this.markCompleted(id);
        return;
      }

      await Promise.all(batch.map((serviceId) => this.attemptAccept(id, serviceId)));

      const observed = this.store.get().releases[id];
      if (!observed) return;
      if (observed.status === 'paused') return;
      const currentBatch = observed.batches[batchIndex] ?? batch;
      const allAccepted = currentBatch.every((serviceId) => observed.services[serviceId]?.status === 'accepted');

      if (!allAccepted) {
        await delay(this.retryDelayMs);
        continue;
      }

      const advancement = await this.store.mutate<{
        state: 'missing' | 'advanced' | 'retry' | 'paused' | 'completed' | 'continue';
      }>((draft) => {
        const current = draft.releases[id];
        if (!current) return { result: { state: 'missing' as const } };
        if (current.currentBatchIndex !== batchIndex) {
          return { result: { state: 'advanced' as const } };
        }
        const stillAllAccepted = (current.batches[batchIndex] ?? []).every(
          (serviceId) => current.services[serviceId]?.status === 'accepted',
        );
        if (!stillAllAccepted) return { result: { state: 'retry' as const } };

        const nextIndex = batchIndex + 1;
        current.currentBatchIndex = nextIndex;
        current.updatedAt = nowIso();
        if (nextIndex >= current.batches.length) {
          current.status = 'completed';
          current.completedAt = nowIso();
          current.events.push({ at: nowIso(), type: 'completed', message: 'All batches confirmed' });
          return { next: draft, result: { state: 'completed' as const } };
        }
        if (current.pauseRequested) {
          current.status = 'paused';
          current.events.push({ at: nowIso(), type: 'paused', message: `Batch ${batchIndex + 1} confirmed; paused before batch ${nextIndex + 1}` });
          return { next: draft, result: { state: 'paused' as const } };
        }
        current.events.push({ at: nowIso(), type: 'batch-confirmed', message: `Batch ${batchIndex + 1}/${current.batches.length} confirmed` });
        return { next: draft, result: { state: 'continue' as const } };
      });

      if (advancement.state === 'paused' || advancement.state === 'completed' || advancement.state === 'missing') return;
      if (advancement.state === 'advanced') continue;
      // retry or continue both loop; continue will pick up new currentBatchIndex.
    }
  }

  private async markCompleted(id: string): Promise<void> {
    await this.store.mutate((draft) => {
      const release = draft.releases[id];
      if (!release || release.status === 'completed') return { result: undefined };
      release.status = 'completed';
      release.completedAt = nowIso();
      release.currentBatchIndex = release.batches.length;
      release.events.push({ at: nowIso(), type: 'completed', message: 'All batches confirmed' });
      return { next: draft, result: undefined };
    });
  }

  async attemptAccept(id: string, serviceId: string): Promise<void> {
    const before = this.store.get().releases[id];
    const dispatch = before?.services[serviceId];
    if (!before || !dispatch || dispatch.status === 'accepted') return;
    const baseUrl = this.endpoint(serviceId).baseUrl;
    const changes = this.changesForService(before, serviceId);
    const body = JSON.stringify({
      releaseId: id,
      coordinatorAcceptedAt: before.coordinatorAcceptedAt,
      acceptedOrder: before.acceptedOrder,
      changes,
    });

    await this.store.mutate((draft) => {
      const serviceState = draft.releases[id]?.services[serviceId];
      if (serviceState && serviceState.status !== 'accepted') {
        serviceState.status = 'dispatched';
        serviceState.attempts += 1;
        serviceState.lastAttemptAt = nowIso();
        serviceState.requestBytes = Buffer.byteLength(body);
      }
      return { next: draft, result: undefined };
    });

    try {
      const response = await fetchJson(
        `${baseUrl}/__admin/releases/${encodeURIComponent(id)}/accept`,
        {
          method: 'POST',
          body,
          timeoutMs: this.requestTimeoutMs,
          headers: {
            'content-type': 'application/json',
            'idempotency-key': dispatch.idempotencyKey,
          },
        },
      );
      if (response.status === 200 && response.body?.status === 'active') {
        await this.markAccepted(id, serviceId, response.body.serviceAcceptedAt);
        return;
      }
      throw new Error(`accept failed with HTTP ${response.status}: ${response.text.slice(0, 300)}`);
    } catch (error) {
      const reconciled = await this.reconcileServiceAccept(id, serviceId).catch(() => false);
      if (!reconciled) await this.recordAcceptError(id, serviceId, error);
    }
  }

  private async markAccepted(id: string, serviceId: string, serviceAcceptedAt?: string): Promise<void> {
    await this.store.mutate((draft) => {
      const serviceState = draft.releases[id]?.services[serviceId];
      if (serviceState && serviceState.status !== 'accepted') {
        serviceState.status = 'accepted';
        serviceState.serviceAcceptedAt = serviceAcceptedAt;
        serviceState.coordinatorConfirmedAt = nowIso();
        serviceState.lastError = undefined;
      }
      return { next: draft, result: undefined };
    });
  }

  private async recordAcceptError(id: string, serviceId: string, error: unknown): Promise<void> {
    await this.store.mutate((draft) => {
      const serviceState = draft.releases[id]?.services[serviceId];
      if (serviceState && serviceState.status !== 'accepted') {
        serviceState.lastError = (error as Error).message;
      }
      return { next: draft, result: undefined };
    });
  }

  async reconcileServiceAccept(id: string, serviceId: string): Promise<boolean> {
    const endpoint = this.endpoint(serviceId);
    try {
      const response = await fetchJson(
        `${endpoint.baseUrl}/__admin/releases/${encodeURIComponent(id)}`,
        { method: 'GET', timeoutMs: this.requestTimeoutMs },
      );
      if (response.status === 200 && response.body?.status === 'active') {
        await this.markAccepted(id, serviceId, response.body.serviceAcceptedAt);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async runRevocationLoop(id: string): Promise<void> {
    while (true) {
      const release = this.store.get().releases[id];
      const revocation = release?.revocation;
      if (!release || !revocation || release.status === 'revoked') return;

      const batchIndex = revocation.currentBatchIndex;
      const batch = release.batches[batchIndex];
      if (!batch) {
        await this.markRevoked(id);
        return;
      }

      await Promise.all(batch.map((serviceId) => this.attemptRevoke(id, serviceId)));

      const observed = this.store.get().releases[id];
      const observedRevocation = observed?.revocation;
      if (!observed || !observedRevocation) return;
      const allRevoked = batch.every(
        (serviceId) => observedRevocation.services[serviceId]?.status === 'revoked',
      );
      if (!allRevoked) {
        await delay(this.retryDelayMs);
        continue;
      }

      const done = await this.store.mutate((draft) => {
        const current = draft.releases[id];
        if (!current?.revocation) return { result: true };
        if (current.revocation.currentBatchIndex !== batchIndex) return { result: false };
        current.revocation.currentBatchIndex = batchIndex + 1;
        current.updatedAt = nowIso();
        if (batchIndex + 1 >= current.batches.length) {
          current.status = 'revoked';
          current.revocation.status = 'completed';
          current.revocation.completedAt = nowIso();
          current.revokedAt = nowIso();
          current.events.push({ at: nowIso(), type: 'revoked', message: 'Every target service removed this release contribution' });
          return { next: draft, result: true };
        }
        current.events.push({ at: nowIso(), type: 'revoke-batch-confirmed', message: `Revocation batch ${batchIndex + 1}/${current.batches.length} confirmed` });
        return { next: draft, result: false };
      });
      if (done) return;
    }
  }

  async attemptRevoke(id: string, serviceId: string): Promise<void> {
    const before = this.store.get().releases[id];
    const dispatch = before?.revocation?.services[serviceId];
    if (!before || !dispatch || dispatch.status === 'revoked') return;
    const baseUrl = this.endpoint(serviceId).baseUrl;

    await this.store.mutate((draft) => {
      const state = draft.releases[id]?.revocation?.services[serviceId];
      if (state && state.status !== 'revoked') {
        state.status = 'dispatched';
        state.attempts += 1;
        state.lastAttemptAt = nowIso();
      }
      return { next: draft, result: undefined };
    });

    try {
      const response = await fetchJson(
        `${baseUrl}/__admin/releases/${encodeURIComponent(id)}/revoke`,
        {
          method: 'POST',
          body: '{}',
          timeoutMs: this.requestTimeoutMs,
          headers: {
            'content-type': 'application/json',
            'idempotency-key': dispatch.idempotencyKey,
          },
        },
      );
      if (response.status === 200 && (response.body?.status === 'revoked' || response.body?.status === 'absent')) {
        await this.markRevokeConfirmed(id, serviceId, response.body.serviceRevokedAt);
        return;
      }
      throw new Error(`revoke failed with HTTP ${response.status}: ${response.text.slice(0, 300)}`);
    } catch (error) {
      const reconciled = await this.reconcileServiceRevoke(id, serviceId).catch(() => false);
      if (!reconciled) {
        await this.store.mutate((draft) => {
          const state = draft.releases[id]?.revocation?.services[serviceId];
          if (state && state.status !== 'revoked') state.lastError = (error as Error).message;
          return { next: draft, result: undefined };
        });
      }
    }
  }

  private async reconcileServiceRevoke(id: string, serviceId: string): Promise<boolean> {
    const endpoint = this.endpoint(serviceId);
    try {
      const response = await fetchJson(
        `${endpoint.baseUrl}/__admin/releases/${encodeURIComponent(id)}`,
        { method: 'GET', timeoutMs: this.requestTimeoutMs },
      );
      if (response.status === 404) {
        await this.markRevokeConfirmed(id, serviceId);
        return true;
      }
      if (response.status === 200 && response.body?.status === 'revoked') {
        await this.markRevokeConfirmed(id, serviceId, response.body.serviceRevokedAt);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async markRevokeConfirmed(id: string, serviceId: string, serviceRevokedAt?: string): Promise<void> {
    await this.store.mutate((draft) => {
      const state = draft.releases[id]?.revocation?.services[serviceId];
      if (state && state.status !== 'revoked') {
        state.status = 'revoked';
        state.serviceRevokedAt = serviceRevokedAt;
        state.coordinatorConfirmedAt = nowIso();
        state.lastError = undefined;
      }
      return { next: draft, result: undefined };
    });
  }

  private async markRevoked(id: string): Promise<void> {
    await this.store.mutate((draft) => {
      const release = draft.releases[id];
      if (!release) return { result: undefined };
      release.status = 'revoked';
      release.revokedAt = nowIso();
      if (release.revocation) {
        release.revocation.status = 'completed';
        release.revocation.currentBatchIndex = release.batches.length;
        release.revocation.completedAt = nowIso();
      }
      release.events.push({ at: nowIso(), type: 'revoked', message: 'Every target service removed this release contribution' });
      return { next: draft, result: undefined };
    });
  }

  /**
   * Polls the actual service records. This is used after network loss or
   * coordinator restart; service state is authoritative for what it accepted.
   */
  async reconcileAll(): Promise<void> {
    const state = await this.store.load();
    for (const release of Object.values(state.releases)) {
      if (release.status === 'running' || release.status === 'pausing') {
        const batch = release.batches[release.currentBatchIndex] ?? [];
        await Promise.all(
          batch
            .filter((serviceId) => release.services[serviceId]?.status !== 'accepted')
            .map(async (serviceId) => {
              const accepted = await this.reconcileServiceAccept(release.id, serviceId);
              if (accepted) this.ensureLoop(release.id);
            }),
        );
        this.ensureLoop(release.id);
      } else if (release.status === 'revoking' && release.revocation) {
        const batch = release.batches[release.revocation.currentBatchIndex] ?? [];
        await Promise.all(
          batch
            .filter((serviceId) => release.revocation?.services[serviceId]?.status !== 'revoked')
            .map(async (serviceId) => {
              const revoked = await this.reconcileServiceRevoke(release.id, serviceId);
              if (revoked) this.ensureLoop(release.id);
            }),
        );
        this.ensureLoop(release.id);
      }
    }
  }

  async getActualConfig(serviceId: string): Promise<unknown> {
    const endpoint = this.endpoint(serviceId);
    const url = endpoint.directUrl ?? endpoint.baseUrl;
    const response = await fetchJson(`${url}/__admin/config`, { timeoutMs: this.requestTimeoutMs });
    if (response.status !== 200) throw new Error(`service config fetch failed: ${response.status}`);
    return response.body;
  }

  /**
   * Operator reconciliation: for each target service, ask it to rebuild this
   * release's contributions from the coordinator's canonical record (active
   * releases) or to strip every residue (revoked releases). Pending, never
   * dispatched batches are left untouched.
   *
   * If the repair receipt is lost while the write still took effect, the
   * coordinator confirms via a read-back of the service's persisted state.
   * A release whose repair leaves any inconsistent contribution must fail.
   */
  async repairRelease(id: string): Promise<{
    release: ReleaseRecord;
    repaired: boolean;
    services: Record<string, RepairServiceState>;
  }> {
    const release = this.getRelease(id);
    // A release that has been revoked (or is on the revocation path) must be
    // repaired towards "no contribution" so repair can never resurrect it.
    const targetStatus: 'active' | 'revoked' =
      release.status === 'revoked' || release.status === 'revoking' ? 'revoked' : 'active';

    const eligibleServiceIds = release.targetServiceIds.filter((serviceId) =>
      targetStatus === 'revoked'
        ? this.isRevokeDispatched(release, serviceId)
        : this.isAcceptDispatched(release, serviceId),
    );

    const now = nowIso();
    const services: Record<string, RepairServiceState> = {};
    for (const serviceId of eligibleServiceIds) {
      services[serviceId] = {
        serviceId,
        targetStatus,
        status: 'failed',
        attempts: 0,
        lastAttemptAt: now,
      };
    }

    await this.store.mutate((draft) => {
      const current = draft.releases[id];
      if (!current) return { result: undefined };
      current.repair = {
        startedAt: now,
        services: structuredClone(services),
      };
      current.events.push({
        at: now,
        type: 'repair-started',
        message: `Repair started for ${eligibleServiceIds.length} dispatched service(s) targeting ${targetStatus}`,
      });
      return { next: draft, result: undefined };
    });

    await Promise.all(
      eligibleServiceIds.map((serviceId) => this.repairService(id, serviceId, targetStatus)),
    );

    const finalState = this.store.get().releases[id]!;
    const repaired = eligibleServiceIds.every(
      (serviceId) => finalState.repair?.services[serviceId]?.status === 'repaired',
    );

    await this.store.mutate((draft) => {
      const current = draft.releases[id];
      if (!current?.repair) return { result: undefined };
      current.repair.completedAt = nowIso();
      current.events.push({
        at: nowIso(),
        type: repaired ? 'repair-completed' : 'repair-failed',
        message: repaired
          ? 'Every dispatched service now matches the coordinator payload'
          : 'Repair left inconsistent contributions on at least one service',
      });
      return { next: draft, result: undefined };
    });

    return {
      release: this.store.get().releases[id]!,
      repaired,
      services: this.store.get().releases[id]!.repair?.services ?? services,
    };
  }

  /**
   * A service takes part in repair only if the coordinator ever sent it this
   * release. Batches that were never dispatched stay exactly as they are.
   */
  private isAcceptDispatched(release: ReleaseRecord, serviceId: string): boolean {
    const dispatch = release.services[serviceId];
    if (!dispatch) return false;
    return dispatch.status !== 'pending' || dispatch.attempts > 0;
  }

  private isRevokeDispatched(release: ReleaseRecord, serviceId: string): boolean {
    const dispatch = release.revocation?.services[serviceId];
    if (!dispatch) return false;
    return dispatch.status !== 'pending' || dispatch.attempts > 0;
  }

  private async repairService(
    id: string,
    serviceId: string,
    targetStatus: 'active' | 'revoked',
  ): Promise<void> {
    const release = this.store.get().releases[id]!;
    const endpoint = this.endpoint(serviceId);
    const changes = this.changesForService(release, serviceId);
    const body =
      targetStatus === 'active'
        ? JSON.stringify({
            releaseId: id,
            targetStatus,
            coordinatorAcceptedAt: release.coordinatorAcceptedAt,
            acceptedOrder: release.acceptedOrder,
            changes,
          })
        : JSON.stringify({ releaseId: id, targetStatus });

    await this.store.mutate((draft) => {
      const state = draft.releases[id]?.repair?.services[serviceId];
      if (state) {
        state.attempts += 1;
        state.lastAttemptAt = nowIso();
      }
      return { next: draft, result: undefined };
    });

    try {
      const response = await fetchJson(
        `${endpoint.baseUrl}/__admin/releases/${encodeURIComponent(id)}/repair`,
        {
          method: 'POST',
          body,
          timeoutMs: this.requestTimeoutMs,
          headers: { 'content-type': 'application/json' },
        },
      );
      if (response.status === 200 && response.body?.ok === true && response.body?.consistent !== false) {
        await this.markRepaired(id, serviceId, false);
        return;
      }
      throw new Error(`repair failed with HTTP ${response.status}: ${response.text.slice(0, 300)}`);
    } catch (error) {
      // The receipt may have been lost after the write landed. Confirm by
      // reading the service's actual persisted state.
      const confirmed = await this.confirmRepairViaState(id, serviceId, targetStatus).catch(() => false);
      if (confirmed) {
        await this.markRepaired(id, serviceId, true);
        return;
      }
      await this.store.mutate((draft) => {
        const state = draft.releases[id]?.repair?.services[serviceId];
        if (state) {
          state.status = 'failed';
          state.lastError = (error as Error).message;
        }
        return { next: draft, result: undefined };
      });
    }
  }

  /** Reads back the service state and checks the release has no bad contribution. */
  private async confirmRepairViaState(
    id: string,
    serviceId: string,
    targetStatus: 'active' | 'revoked',
  ): Promise<boolean> {
    const endpoint = this.endpoint(serviceId);
    const release = this.store.get().releases[id];
    if (!release) return false;
    const response = await fetchJson(
      `${endpoint.baseUrl}/__admin/releases/${encodeURIComponent(id)}/consistency`,
      { method: 'GET', timeoutMs: this.requestTimeoutMs },
    );
    if (response.status !== 200) return false;
    const status = response.body?.status;
    const consistency = response.body?.consistency;
    if (consistency?.consistent !== true) return false;
    if (targetStatus === 'revoked') return status === 'revoked' || status === 'absent';
    if (status !== 'active') return false;
    // A read-back alone is not enough: the service might be a healthy active
    // record that still disagrees with the coordinator payload.
    const record = response.body?.record;
    if (!record || record.coordinatorAcceptedAt !== release.coordinatorAcceptedAt) return false;
    if (record.acceptedOrder !== release.acceptedOrder) return false;
    const expected = this.changesForService(release, serviceId);
    if (JSON.stringify(canonicalizeChanges(record.changes ?? [])) !== JSON.stringify(canonicalizeChanges(expected))) {
      return false;
    }
    return true;
  }

  private async markRepaired(id: string, serviceId: string, confirmedViaState: boolean): Promise<void> {
    await this.store.mutate((draft) => {
      const release = draft.releases[id];
      const state = release?.repair?.services[serviceId];
      if (!release || !state) return { result: undefined };
      state.status = 'repaired';
      state.confirmedViaState = confirmedViaState;
      state.coordinatorConfirmedAt = nowIso();
      state.lastError = undefined;
      if (state.targetStatus === 'active') {
        // The service now provably matches the coordinator payload, so the
        // coordinator's own dispatch record can follow it.
        const dispatch = release.services[serviceId];
        if (dispatch && dispatch.status !== 'accepted') {
          dispatch.status = 'accepted';
          dispatch.coordinatorConfirmedAt = nowIso();
          dispatch.lastError = undefined;
        }
      } else {
        const revokeDispatch = release.revocation?.services[serviceId];
        if (revokeDispatch && revokeDispatch.status !== 'revoked') {
          revokeDispatch.status = 'revoked';
          revokeDispatch.coordinatorConfirmedAt = nowIso();
          revokeDispatch.lastError = undefined;
        }
      }
      return { next: draft, result: undefined };
    });
  }

  /**
   * Explicit operator reconciliation over every known release. Presence-only
   * periodic reconciliation never calls this; it is only reachable through
   * the operator reconcile endpoints.
   */
  async repairAll(): Promise<{
    ok: boolean;
    results: Array<{ releaseId: string; repaired: boolean }>;
  }> {
    await this.reconcileAll();
    const releases = this.listReleases();
    const results = await Promise.all(
      releases.map(async (release) => {
        const outcome = await this.repairRelease(release.id);
        return { releaseId: release.id, repaired: outcome.repaired };
      }),
    );
    return { ok: results.every((item) => item.repaired), results };
  }
}
