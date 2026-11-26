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
  EffectiveSwitchRecord,
  ReleaseRecord,
  RevokeDispatchState,
  ServiceDispatchState,
  ServiceEndpoint,
  FixtureData,
  TimelineSegmentStat,
  TimelineSyncReport,
  TimelineSyncState,
} from '../shared/types.js';

export interface CoordinatorOptions {
  dataDir: string;
  fixture: FixtureData;
  endpoints: ServiceEndpoint[];
  requestTimeoutMs?: number;
  retryDelayMs?: number;
  reconcileIntervalMs?: number;
  /** Records per timeline backfill segment (default 50). */
  timelineSegmentSize?: number;
  timelineTimeoutMs?: number;
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
  private readonly timelineChains = new Map<string, Promise<TimelineSyncReport>>();
  private reconcileTimer: NodeJS.Timeout | undefined;
  private timelineTimer: NodeJS.Timeout | undefined;
  private readonly requestTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly timelineSegmentSize: number;
  private readonly timelineTimeoutMs: number;

  constructor(private readonly options: CoordinatorOptions) {
    this.store = new AtomicJsonStore<CoordinatorPersistentState>(
      path.join(options.dataDir, 'coordinator-state.json'),
    );
    for (const endpoint of options.endpoints) this.endpoints.set(endpoint.id, endpoint);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 1200;
    this.retryDelayMs = options.retryDelayMs ?? 180;
    this.timelineSegmentSize = Math.max(1, Math.trunc(options.timelineSegmentSize ?? 50));
    this.timelineTimeoutMs = options.timelineTimeoutMs ?? 5000;
  }

  async start(): Promise<void> {
    await this.store.initialize(() => ({
      version: 1,
      acceptedOrder: 0,
      releases: {},
      timelines: {},
      timelineSync: {},
    }));
    await this.ensureTimelineStateShape();
    await this.reconcileAll();
    for (const release of Object.values(this.store.get().releases)) {
      if (release.status === 'running' || release.status === 'pausing' || release.status === 'revoking') {
        this.ensureLoop(release.id);
      }
    }
    // Best-effort resume of any interrupted segmented backfill after a
    // coordinator restart; the durable per-service cursor prevents gaps and
    // duplicate collection.
    void this.syncAllTimelines().catch((error) => {
      console.error('[coordinator] initial timeline sync failed:', error);
    });
  }

  /** Adds timeline containers to snapshots written by older versions. */
  private async ensureTimelineStateShape(): Promise<void> {
    const state = this.store.get() as Partial<CoordinatorPersistentState>;
    if (state.timelines && state.timelineSync) return;
    await this.store.mutate((draft) => {
      if (!draft.timelines) draft.timelines = {};
      if (!draft.timelineSync) draft.timelineSync = {};
      return { next: draft, result: undefined };
    });
  }

  startTimelineSync(intervalMs = 1000): void {
    if (this.timelineTimer) clearInterval(this.timelineTimer);
    if (!intervalMs || intervalMs <= 0) return;
    this.timelineTimer = setInterval(() => {
      void this.syncAllTimelines().catch((error) => {
        console.error('[coordinator] timeline sync failed:', error);
      });
    }, intervalMs);
    this.timelineTimer.unref?.();
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

  async syncAllTimelines(): Promise<TimelineSyncReport[]> {
    return Promise.all(this.getServiceIds().map((serviceId) => this.requestTimelineSync(serviceId)));
  }

  close(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.timelineTimer) clearInterval(this.timelineTimer);
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

  // ---------------------------------------------------------------------------
  // Effective timeline collection and query
  // ---------------------------------------------------------------------------

  /**
   * Local, durable timeline read. This never contacts the service, so already
   * collected switches and sync progress remain queryable while the service
   * is offline.
   */
  getServiceTimeline(serviceId: string): {
    serviceId: string;
    count: number;
    timeline: EffectiveSwitchRecord[];
    sync: TimelineSyncState;
  } {
    if (!this.endpoints.has(serviceId) && !this.store.get().timelines[serviceId]) {
      throw new ApiError(404, `unknown service: ${serviceId}`);
    }
    const state = this.store.get();
    const timeline = [...(state.timelines[serviceId] ?? [])].sort((a, b) => a.seq - b.seq);
    const sync = this.syncStateView(serviceId);
    return { serviceId, count: timeline.length, timeline, sync };
  }

  /** Collected timeline views for every configured/persisted service. */
  getAllServiceTimelines(): Array<ReturnType<Coordinator['getServiceTimeline']>> {
    const ids = new Set<string>([...this.endpoints.keys(), ...Object.keys(this.store.get().timelines)]);
    return [...ids].sort().map((serviceId) => this.getServiceTimeline(serviceId));
  }

  private syncStateView(serviceId: string): TimelineSyncState {
    const existing = this.store.get().timelineSync[serviceId];
    if (existing) return existing;
    return {
      serviceId,
      lastSeq: 0,
      caughtUp: false,
      segmentSize: this.timelineSegmentSize,
      segmentFetchCount: 0,
      recentSegments: [],
    };
  }

  /**
   * Serializes sync runs per service so startup, timer and manual triggers
   * cannot interleave segment loops.
   */
  requestTimelineSync(
    serviceId: string,
    options: { maxSegments?: number } = {},
  ): Promise<TimelineSyncReport> {
    if (!this.endpoints.has(serviceId)) {
      return Promise.reject(new ApiError(404, `no endpoint configured for service ${serviceId}`));
    }
    const previous = this.timelineChains.get(serviceId) ?? Promise.resolve(null as unknown as TimelineSyncReport);
    const run = previous
      .catch(() => null)
      .then(() => this.syncServiceTimeline(serviceId, options));
    this.timelineChains.set(serviceId, run);
    run.finally(() => {
      if (this.timelineChains.get(serviceId) === run) this.timelineChains.delete(serviceId);
    }).catch(() => undefined);
    return run;
  }

  /**
   * Pulls only the missing timeline suffix in fixed-size segments. Every
   * segment is merged and its cursor persisted in one atomic coordinator
   * state transaction before the next segment is fetched, so a restart at
   * any point resumes from the durable high-water mark without gaps or
   * duplicate rows.
   */
  async syncServiceTimeline(
    serviceId: string,
    options: { maxSegments?: number } = {},
  ): Promise<TimelineSyncReport> {
    const endpoint = this.endpoint(serviceId);
    const maxSegments = options.maxSegments;
    const startedSeq = this.syncStateView(serviceId).lastSeq;
    const segments: TimelineSegmentStat[] = [];
    let fetchedCount = 0;
    let remoteHeadSeq: number | undefined;
    let caughtUp = false;
    let truncated = false;

    // The loop cursor always comes from durable state, never from a local
    // variable alone, which keeps restart/resume and concurrent callers safe.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (maxSegments !== undefined && segments.length >= maxSegments) {
        truncated = true;
        break;
      }
      const afterSeq = this.syncStateView(serviceId).lastSeq;
      const url =
        `${endpoint.baseUrl}/__admin/timeline?afterSeq=${afterSeq}` +
        `&limit=${this.timelineSegmentSize}`;

      let page: any;
      try {
        const response = await fetchJson(url, { method: 'GET', timeoutMs: this.timelineTimeoutMs });
        if (response.status !== 200) {
          throw new Error(`timeline fetch failed with HTTP ${response.status}: ${response.text.slice(0, 200)}`);
        }
        page = response.body;
      } catch (error) {
        const message = (error as Error).message;
        await this.recordSyncError(serviceId, message);
        return {
          ok: false,
          serviceId,
          startedSeq,
          lastSeq: this.syncStateView(serviceId).lastSeq,
          caughtUp: false,
          fetchedCount,
          segments,
          truncated,
          error: message,
        };
      }

      const records: EffectiveSwitchRecord[] = Array.isArray(page?.records) ? page.records : [];
      const headSeq = Number.isInteger(page?.headSeq) ? Number(page.headSeq) : undefined;
      remoteHeadSeq = headSeq;
      const firstSeq = records[0]?.seq;
      if (records.length > 0 && firstSeq !== afterSeq + 1) {
        const message = `timeline gap for ${serviceId}: expected seq ${afterSeq + 1}, service returned ${firstSeq}`;
        await this.recordSyncError(serviceId, message);
        return {
          ok: false,
          serviceId,
          startedSeq,
          lastSeq: afterSeq,
          remoteHeadSeq,
          caughtUp: false,
          fetchedCount,
          segments,
          truncated,
          error: message,
        };
      }

      const nextSeq = records.length > 0 ? records[records.length - 1]!.seq : afterSeq;
      const stat: TimelineSegmentStat = {
        at: nowIso(),
        afterSeq,
        limit: this.timelineSegmentSize,
        returned: records.length,
        nextSeq,
      };

      await this.store.mutate((draft) => {
        const sync = this.ensureSyncDraft(draft, serviceId);
        const list = (draft.timelines[serviceId] ??= []);
        const knownSeqs = new Set(list.map((record) => record.seq));
        for (const record of records) {
          // Idempotent merge: never insert the same service seq twice.
          if (!knownSeqs.has(record.seq) && record.seq > sync.lastSeq) list.push(record);
        }
        list.sort((a, b) => a.seq - b.seq);
        if (list.length > 0) {
          const maxSeq = list[list.length - 1]!.seq;
          if (maxSeq > sync.lastSeq) sync.lastSeq = maxSeq;
        }
        const nowCaughtUp = records.length < this.timelineSegmentSize &&
          (headSeq === undefined || sync.lastSeq >= headSeq);
        // An idle tail-poll that changes nothing need not rewrite the file.
        const meaningful =
          records.length > 0 ||
          !sync.caughtUp ||
          Boolean(sync.lastError) ||
          sync.remoteHeadSeq !== headSeq;
        if (!meaningful) return { result: undefined };
        sync.remoteHeadSeq = headSeq;
        sync.caughtUp = nowCaughtUp;
        sync.lastAttemptAt = stat.at;
        sync.lastSuccessAt = stat.at;
        sync.lastError = undefined;
        if (records.length > 0) {
          sync.segmentFetchCount += 1;
          sync.recentSegments.push(stat);
          if (sync.recentSegments.length > 20) sync.recentSegments.shift();
        }
        return { next: draft, result: undefined };
      });

      segments.push(stat);
      fetchedCount += records.length;
      caughtUp = this.syncStateView(serviceId).caughtUp;

      // A short page means no more rows after this segment.
      if (records.length < this.timelineSegmentSize) break;
    }

    const finalState = this.syncStateView(serviceId);
    return {
      ok: true,
      serviceId,
      startedSeq,
      lastSeq: finalState.lastSeq,
      remoteHeadSeq,
      caughtUp,
      fetchedCount,
      segments,
      truncated,
    };
  }

  private ensureSyncDraft(draft: CoordinatorPersistentState, serviceId: string): TimelineSyncState {
    draft.timelines ??= {};
    draft.timelineSync ??= {};
    return (draft.timelineSync[serviceId] ??= {
      serviceId,
      lastSeq: 0,
      caughtUp: false,
      segmentSize: this.timelineSegmentSize,
      segmentFetchCount: 0,
      recentSegments: [],
    });
  }

  private async recordSyncError(serviceId: string, message: string): Promise<void> {
    await this.store.mutate((draft) => {
      const sync = this.ensureSyncDraft(draft, serviceId);
      sync.lastAttemptAt = nowIso();
      sync.lastError = message;
      sync.caughtUp = false;
      return { next: draft, result: undefined };
    });
  }
}
