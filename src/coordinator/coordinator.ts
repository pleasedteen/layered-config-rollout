import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AtomicJsonStore, delay, nowIso } from '../shared/store.js';
import { fetchJson } from '../shared/http.js';
import { ApiError } from '../shared/errors.js';
import {
  deriveTargetServiceIds,
  normalizeBatches,
  normalizeChanges,
} from '../shared/validation.js';
import type {
  CoordinatorPersistentState,
  DispatchChunkPlan,
  ReleaseRecord,
  RevokeDispatchState,
  ServiceDispatchState,
  ServiceEndpoint,
  FixtureData,
} from '../shared/types.js';
import {
  DEFAULT_DISPATCH_MAX_BYTES,
  buildAcceptChunkBody,
  chunkAcceptRequestPath,
  chunkIdempotencyKey,
  computeDispatchPlan,
  planChunkChanges,
  type ChunkPrefix,
} from '../shared/chunking.js';

export interface CoordinatorOptions {
  dataDir: string;
  fixture: FixtureData;
  endpoints: ServiceEndpoint[];
  requestTimeoutMs?: number;
  retryDelayMs?: number;
  reconcileIntervalMs?: number;
  /** Maximum bytes of any single dispatch request body. */
  dispatchMaxBytes?: number;
}

export interface CreateReleaseInput {
  releaseId?: unknown;
  changes?: unknown;
  targetServiceIds?: unknown;
  batches?: unknown;
  batchSize?: unknown;
  dispatchMaxBytes?: unknown;
}

interface ServiceReleaseStatus {
  status: 'active' | 'revoked' | 'pending' | 'absent';
  receivedChunks: number[];
  missingChunks: number[];
  chunkCount: number | null;
  serviceAcceptedAt?: string;
}

export class Coordinator {
  readonly store: AtomicJsonStore<CoordinatorPersistentState>;
  private readonly endpoints = new Map<string, ServiceEndpoint>();
  private readonly loops = new Map<string, Promise<void>>();
  private reconcileTimer: NodeJS.Timeout | undefined;
  private readonly requestTimeoutMs: number;
  private readonly retryDelayMs: number;
  readonly defaultDispatchMaxBytes: number;

  constructor(private readonly options: CoordinatorOptions) {
    this.store = new AtomicJsonStore<CoordinatorPersistentState>(
      path.join(options.dataDir, 'coordinator-state.json'),
    );
    for (const endpoint of options.endpoints) this.endpoints.set(endpoint.id, endpoint);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 1200;
    this.retryDelayMs = options.retryDelayMs ?? 180;
    this.defaultDispatchMaxBytes = options.dispatchMaxBytes ?? DEFAULT_DISPATCH_MAX_BYTES;
    if (!Number.isInteger(this.defaultDispatchMaxBytes) || this.defaultDispatchMaxBytes < 1) {
      throw new Error(`dispatchMaxBytes must be a positive integer, got ${String(options.dispatchMaxBytes)}`);
    }
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

  private parseDispatchMaxBytes(input: unknown): number {
    if (input === undefined || input === null) return this.defaultDispatchMaxBytes;
    const value = typeof input === 'string' ? Number(input) : (input as number);
    if (!Number.isInteger(value) || value < 1) {
      throw new ApiError(400, 'dispatchMaxBytes must be a positive integer');
    }
    return value;
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

    const dispatchMaxBytes = this.parseDispatchMaxBytes(input.dispatchMaxBytes);

    const record = await this.store.mutate((draft) => {
      if (requestedId && draft.releases[requestedId]) {
        throw new ApiError(409, `release already exists: ${requestedId}`);
      }
      draft.acceptedOrder += 1;
      const id = requestedId || `rel-${draft.acceptedOrder}-${randomUUID().slice(0, 8)}`;
      const timestamp = nowIso();
      const prefix: ChunkPrefix = { releaseId: id, coordinatorAcceptedAt: timestamp, acceptedOrder: draft.acceptedOrder };
      const services: Record<string, ServiceDispatchState> = {};
      targetServiceIds.forEach((serviceId) => {
        const batchIndex = batches.findIndex((batch) => batch.includes(serviceId));
        const plan = computeDispatchPlan(prefix, changes.filter((c) => c.serviceId === serviceId), dispatchMaxBytes);
        services[serviceId] = {
          serviceId,
          batchIndex,
          status: 'pending',
          idempotencyKey: chunkIdempotencyKey(id, serviceId, 0),
          attempts: 0,
          chunkPlan: plan,
          chunksSent: [],
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
        dispatchMaxBytes,
        createdAt: timestamp,
        updatedAt: timestamp,
        services,
        events: [
          {
            at: timestamp,
            type: 'accepted',
            message:
              `Coordinator accepted release with ${changes.length} change(s), ${batches.length} batch(es), ` +
              `max dispatch body ${dispatchMaxBytes} bytes`,
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

  private dispatchMaxBytesFor(release: ReleaseRecord): number {
    return release.dispatchMaxBytes ?? this.defaultDispatchMaxBytes;
  }

  private chunkPlanFor(release: ReleaseRecord, serviceId: string): DispatchChunkPlan {
    const existing = release.services[serviceId]?.chunkPlan;
    if (existing) return existing;
    return computeDispatchPlan(
      { releaseId: release.id, coordinatorAcceptedAt: release.coordinatorAcceptedAt, acceptedOrder: release.acceptedOrder },
      this.changesForService(release, serviceId),
      this.dispatchMaxBytesFor(release),
    );
  }

  /**
   * Sends only the chunks this service has not positively reported as
   * persisted. Retries a 503/202-free chunk set are safe because each chunk
   * has its own stable idempotency key.
   */
  async attemptAccept(id: string, serviceId: string): Promise<void> {
    const before = this.store.get().releases[id];
    const dispatch = before?.services[serviceId];
    if (!before || !dispatch || dispatch.status === 'accepted') return;
    const baseUrl = this.endpoint(serviceId).baseUrl;
    const serviceChanges = this.changesForService(before, serviceId);
    const plan = this.chunkPlanFor(before, serviceId);
    const maxBytes = this.dispatchMaxBytesFor(before);
    const prefix: ChunkPrefix = {
      releaseId: id,
      coordinatorAcceptedAt: before.coordinatorAcceptedAt,
      acceptedOrder: before.acceptedOrder,
    };

    if (!before.services[serviceId]?.chunkPlan) {
      // Legacy release created before chunking existed: persist the plan so
      // future retries use exactly the same boundaries.
      await this.store.mutate((draft) => {
        const serviceState = draft.releases[id]?.services[serviceId];
        if (serviceState && !serviceState.chunkPlan) serviceState.chunkPlan = plan;
        return { next: draft, result: undefined };
      });
    }

    if (plan.total === 0) {
      await this.markAccepted(id, serviceId, undefined);
      return;
    }

    const confirmed = await this.fetchServiceReleaseStatus(id, serviceId);
    if (confirmed?.status === 'active') {
      await this.markAccepted(id, serviceId, confirmed.serviceAcceptedAt);
      return;
    }
    if (confirmed?.status === 'revoked') {
      // A revoked release cannot be resurrected; surface it instead of
      // silently retrying forever.
      await this.recordAcceptError(id, serviceId, new Error('service reports this release as revoked'));
      return;
    }

    const sent = new Set(confirmed && confirmed.status === 'pending' ? confirmed.receivedChunks : []);
    if (!confirmed) {
      for (const chunkIndex of dispatch.chunksSent ?? []) sent.add(chunkIndex);
    } else if (confirmed.status === 'pending' && confirmed.receivedChunks.length > 0) {
      await this.markChunksSent(id, serviceId, confirmed.receivedChunks);
    }
    // A service that already holds the whole group but has not applied it is
    // waiting for its final chunk: it needs a single (idempotent) resend, not
    // a zero-chunk dispatch that would wait forever.
    if (sent.size >= plan.total && confirmed?.status === 'pending') {
      sent.delete(plan.total - 1);
    }

    await this.store.mutate((draft) => {
      const serviceState = draft.releases[id]?.services[serviceId];
      if (serviceState && serviceState.status !== 'accepted') {
        serviceState.status = 'dispatched';
        serviceState.attempts += 1;
        serviceState.lastAttemptAt = nowIso();
      }
      return { next: draft, result: undefined };
    });

    let lastError: unknown;
    for (let index = 0; index < plan.total; index += 1) {
      if (sent.has(index)) continue;
      const chunkChanges = planChunkChanges(plan, serviceChanges, index);
      const body = buildAcceptChunkBody(prefix, plan.total, index, chunkChanges);
      const requestBytes = Buffer.byteLength(body);
      if (requestBytes > maxBytes) {
        lastError = new Error(
          `planned chunk ${index} is ${requestBytes} bytes, above the ${maxBytes}-byte dispatch limit`,
        );
        break;
      }

      try {
        const response = await fetchJson(`${baseUrl}${chunkAcceptRequestPath(id, index)}`, {
          method: 'POST',
          body,
          timeoutMs: this.requestTimeoutMs,
          headers: {
            'content-type': 'application/json',
            'idempotency-key': chunkIdempotencyKey(id, serviceId, index),
          },
        });

        if (response.status === 200 && response.body?.status === 'active') {
          await this.markAccepted(id, serviceId, response.body.serviceAcceptedAt, requestBytes);
          return;
        }
        if (
          (response.status === 202 || response.status === 200) &&
          response.body?.status === 'pending'
        ) {
          await this.markChunkSent(id, serviceId, index, requestBytes);
          sent.add(index);
          continue;
        }
        if (response.status === 409 && response.body?.status === 'revoked') {
          await this.recordAcceptError(id, serviceId, new Error('service reports this release as revoked'));
          return;
        }
        throw new Error(`chunk ${index} accept failed with HTTP ${response.status}: ${response.text.slice(0, 300)}`);
      } catch (error) {
        lastError = error;
        // Ask the service what it actually persisted instead of guessing.
        const reconciled = await this.fetchServiceReleaseStatus(id, serviceId);
        if (reconciled?.status === 'active') {
          await this.markAccepted(id, serviceId, reconciled.serviceAcceptedAt);
          return;
        }
        if (reconciled?.status === 'pending') {
          const received = reconciled.receivedChunks.filter((value) => value >= 0 && value < plan.total);
          for (const chunkIndex of received) sent.add(chunkIndex);
          await this.markChunksSent(id, serviceId, received);
          if (received.includes(index)) continue;
          // The chunk was not persisted; leave the rest for the next attempt
          // rather than hammering an unresponsive service.
          break;
        }
        await this.recordAcceptError(id, serviceId, error);
        break;
      }
    }

    if (lastError) {
      const serviceState = this.store.get().releases[id]?.services[serviceId];
      if (serviceState?.status !== 'accepted') {
        await this.recordAcceptError(id, serviceId, lastError);
      }
      return;
    }

    // All chunks were acknowledged but the service only confirmed the whole
    // group on its last chunk; verify once more in case that reply was lost.
    const finalStatus = await this.fetchServiceReleaseStatus(id, serviceId);
    if (finalStatus?.status === 'active') {
      await this.markAccepted(id, serviceId, finalStatus.serviceAcceptedAt);
    }
  }

  private async markChunkSent(id: string, serviceId: string, index: number, requestBytes: number): Promise<void> {
    await this.markChunksSent(id, serviceId, [index], requestBytes);
  }

  private async markChunksSent(
    id: string,
    serviceId: string,
    indexes: number[],
    requestBytes?: number,
  ): Promise<void> {
    await this.store.mutate((draft) => {
      const serviceState = draft.releases[id]?.services[serviceId];
      if (serviceState && serviceState.status !== 'accepted') {
        const set = new Set(serviceState.chunksSent ?? []);
        for (const index of indexes) set.add(index);
        serviceState.chunksSent = [...set].sort((a, b) => a - b);
        if (requestBytes !== undefined) serviceState.requestBytes = Math.max(serviceState.requestBytes ?? 0, requestBytes);
        serviceState.lastError = undefined;
      }
      return { next: draft, result: undefined };
    });
  }

  private async fetchServiceReleaseStatus(
    id: string,
    serviceId: string,
  ): Promise<ServiceReleaseStatus | null> {
    const endpoint = this.endpoint(serviceId);
    try {
      const response = await fetchJson(
        `${endpoint.baseUrl}/__admin/releases/${encodeURIComponent(id)}`,
        { method: 'GET', timeoutMs: this.requestTimeoutMs },
      );
      if (response.status === 404) {
        return { status: 'absent', receivedChunks: [], missingChunks: [], chunkCount: null };
      }
      if (response.status !== 200 || !response.body) return null;
      return {
        status: response.body.status,
        receivedChunks: Array.isArray(response.body.receivedChunks) ? response.body.receivedChunks : [],
        missingChunks: Array.isArray(response.body.missingChunks) ? response.body.missingChunks : [],
        chunkCount: typeof response.body.chunkCount === 'number' ? response.body.chunkCount : null,
        serviceAcceptedAt: response.body.serviceAcceptedAt,
      };
    } catch {
      return null;
    }
  }

  private async markAccepted(
    id: string,
    serviceId: string,
    serviceAcceptedAt?: string,
    requestBytes?: number,
  ): Promise<void> {
    await this.store.mutate((draft) => {
      const serviceState = draft.releases[id]?.services[serviceId];
      if (serviceState && serviceState.status !== 'accepted') {
        serviceState.status = 'accepted';
        serviceState.serviceAcceptedAt = serviceAcceptedAt;
        serviceState.coordinatorConfirmedAt = nowIso();
        serviceState.lastError = undefined;
        if (requestBytes !== undefined) serviceState.requestBytes = Math.max(serviceState.requestBytes ?? 0, requestBytes);
        serviceState.chunksSent = Array.from({ length: serviceState.chunkPlan?.total ?? 0 }, (_, index) => index);
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

  async reconcileServiceAccept(
    id: string,
    serviceId: string,
    expectedChunk?: number,
    expectedCount?: number,
  ): Promise<ServiceReleaseStatus> {
    const status = await this.fetchServiceReleaseStatus(id, serviceId);
    if (!status) return { status: 'absent', receivedChunks: [], missingChunks: [], chunkCount: null };
    if (status.status === 'active') {
      await this.markAccepted(id, serviceId, status.serviceAcceptedAt);
      return status;
    }
    if (status.status === 'pending') {
      const set = new Set(status.receivedChunks);
      if (expectedChunk !== undefined) set.add(expectedChunk);
      const received = [...set].sort((a, b) => a - b);
      await this.markChunksSent(id, serviceId, received);
      return { ...status, receivedChunks: received };
    }
    return status;
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
              const status = await this.reconcileServiceAccept(release.id, serviceId);
              if (status.status === 'active' || status.status === 'pending') this.ensureLoop(release.id);
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
}
