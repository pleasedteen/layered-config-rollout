import path from 'node:path';
import { AtomicJsonStore, nowIso } from '../shared/store.js';
import {
  CONFIG_KEYS,
  cloneConfig,
  validateConfigValue,
} from '../shared/validation.js';
import type {
  Candidate,
  ConfigKey,
  FixtureData,
  PendingChunkAccept,
  RouteChange,
  RouteConfig,
  ServiceDefinition,
  ServicePersistentState,
  ServiceReleaseRecord,
} from '../shared/types.js';
import { readFile } from 'node:fs/promises';

export interface ServiceHttpResult {
  statusCode: number;
  body: unknown;
  replayed?: boolean;
}

/**
 * A service's durable view of one release, used both by operators and by
 * coordinator reconciliation. `pending` means some chunks are persisted but
 * the group has not been applied yet; the route configuration still reflects
 * the previous state.
 */
export interface ReleaseChunkStatus {
  status: 'active' | 'revoked' | 'pending' | 'absent';
  releaseId: string;
  chunkCount: number | null;
  receivedChunks: number[];
  missingChunks: number[];
  changesApplied: boolean;
  serviceAcceptedAt?: string;
  serviceRevokedAt?: string;
}

interface ParsedChunk {
  index: number;
  count: number;
}

interface ParsedAccept {
  releaseId: string;
  coordinatorAcceptedAt: string;
  acceptedOrder: number;
  changes: RouteChange[];
  chunk?: ParsedChunk;
}

function initialState(service: ServiceDefinition): ServicePersistentState {
  const routes: ServicePersistentState['routes'] = {};
  const candidates: ServicePersistentState['candidates'] = {};
  for (const route of service.routes) {
    routes[route.id] = {
      initial: cloneConfig(route.initial),
      effective: cloneConfig(route.initial),
    };
    candidates[route.id] = {};
  }
  return {
    version: 1,
    serviceId: service.id,
    routes,
    candidates,
    releases: {},
    processedRequests: {},
    pendingChunks: {},
  };
}

function compareCandidateNewestFirst(a: Candidate, b: Candidate): number {
  if (a.acceptedOrder !== b.acceptedOrder) return b.acceptedOrder - a.acceptedOrder;
  const time = Date.parse(b.coordinatorAcceptedAt) - Date.parse(a.coordinatorAcceptedAt);
  if (time !== 0) return time;
  return b.releaseId.localeCompare(a.releaseId);
}

function missingIndexes(count: number, received: number[]): number[] {
  const missing: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (!received.includes(index)) missing.push(index);
  }
  return missing;
}

function addReceived(received: number[], index: number): number[] {
  const next = received.includes(index) ? [...received] : [...received, index];
  next.sort((a, b) => a - b);
  return next;
}

export class ConfigService {
  private constructor(
    public readonly definition: ServiceDefinition,
    private readonly store: AtomicJsonStore<ServicePersistentState>,
  ) {}

  static async start(options: {
    serviceId: string;
    dataDir: string;
    fixture: FixtureData;
  }): Promise<ConfigService> {
    const definition = options.fixture.services.find((s) => s.id === options.serviceId);
    if (!definition) throw new Error(`fixture has no service ${options.serviceId}`);

    const file = path.join(options.dataDir, 'services', `${options.serviceId}.json`);
    const store = new AtomicJsonStore<ServicePersistentState>(file);
    await store.initialize(() => initialState(definition));
    if (!store.get().pendingChunks) store.get().pendingChunks = {};
    return new ConfigService(definition, store);
  }

  static async loadFixture(fixturePath: string): Promise<FixtureData> {
    const raw = await readFile(fixturePath, 'utf8');
    return JSON.parse(raw) as FixtureData;
  }

  get persistentFilePath(): string {
    return this.store.filePath;
  }

  snapshot(): ServicePersistentState {
    return this.store.get();
  }

  /**
   * Hot read path. This is a direct materialized lookup and never scans
   * releases or candidate history.
   */
  getRouteConfig(routeId: string): RouteConfig {
    const route = this.store.get().routes[routeId];
    if (!route) throw new Error(`unknown route: ${this.definition.id}/${routeId}`);
    return cloneConfig(route.effective);
  }

  getAllEffectiveConfigs(): Record<string, RouteConfig> {
    const result: Record<string, RouteConfig> = {};
    for (const [routeId, route] of Object.entries(this.store.get().routes)) {
      result[routeId] = cloneConfig(route.effective);
    }
    return result;
  }

  getRelease(releaseId: string) {
    return this.store.get().releases[releaseId] ?? null;
  }

  /**
   * Reports applied and buffered state of one release. Buffered chunks are
   * persisted per chunk, so after a crash the service can still report
   * exactly which chunk indexes it already has.
   */
  getReleaseStatus(releaseId: string): ReleaseChunkStatus {
    const state = this.store.get();
    const release = state.releases[releaseId];
    if (release) {
      const chunkCount = release.chunkCount ?? 1;
      const all = Array.from({ length: chunkCount }, (_, index) => index);
      return {
        status: release.status,
        releaseId,
        chunkCount,
        receivedChunks: all,
        missingChunks: [],
        changesApplied: release.status === 'active',
        serviceAcceptedAt: release.serviceAcceptedAt,
        serviceRevokedAt: release.serviceRevokedAt,
      };
    }
    const pending = state.pendingChunks?.[releaseId];
    if (pending) {
      return {
        status: 'pending',
        releaseId,
        chunkCount: pending.chunkCount,
        receivedChunks: [...pending.received],
        missingChunks: missingIndexes(pending.chunkCount, pending.received),
        changesApplied: false,
      };
    }
    return {
      status: 'absent',
      releaseId,
      chunkCount: null,
      receivedChunks: [],
      missingChunks: [],
      changesApplied: false,
    };
  }

  private parseAcceptInput(releaseId: string, raw: any): ParsedAccept {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('request body must be an object');
    if (raw.releaseId !== undefined && raw.releaseId !== releaseId) {
      throw new Error(`body releaseId ${raw.releaseId} does not match request path ${releaseId}`);
    }
    if (typeof raw.coordinatorAcceptedAt !== 'string' || Number.isNaN(Date.parse(raw.coordinatorAcceptedAt))) {
      throw new Error('coordinatorAcceptedAt must be an ISO timestamp');
    }
    const acceptedOrder = Number(raw.acceptedOrder);
    if (!Number.isInteger(acceptedOrder) || acceptedOrder < 0) {
      throw new Error('acceptedOrder must be a non-negative integer');
    }
    if (!Array.isArray(raw.changes) || raw.changes.length === 0) {
      throw new Error('changes must be a non-empty array containing only this service changes');
    }

    let chunk: ParsedChunk | undefined;
    if (raw.chunk !== undefined) {
      if (!raw.chunk || typeof raw.chunk !== 'object') throw new Error('chunk must be an object');
      const index = Number(raw.chunk.index);
      const count = Number(raw.chunk.count);
      if (!Number.isInteger(index) || index < 0) throw new Error('chunk.index must be a non-negative integer');
      if (!Number.isInteger(count) || count < 1) throw new Error('chunk.count must be a positive integer');
      if (index >= count) throw new Error('chunk.index must be smaller than chunk.count');
      chunk = { index, count };
    }

    const changes: RouteChange[] = [];
    const seen = new Set<string>();
    for (const item of raw.changes) {
      if (!item || typeof item !== 'object') throw new Error('each change must be an object');
      if (item.serviceId !== this.definition.id) {
        throw new Error(`refusing change for ${String(item.serviceId)} on service ${this.definition.id}`);
      }
      if (typeof item.routeId !== 'string') throw new Error('change.routeId must be a string');
      const route = this.definition.routes.find((r) => r.id === item.routeId);
      if (!route) throw new Error(`unknown route: ${this.definition.id}/${item.routeId}`);
      const key = `${item.serviceId}/${item.routeId}`;
      if (seen.has(key)) throw new Error(`duplicate change for ${key}`);
      seen.add(key);

      const change: RouteChange = { serviceId: item.serviceId, routeId: item.routeId };
      let hasValue = false;
      for (const configKey of CONFIG_KEYS) {
        if (item[configKey] !== undefined) {
          change[configKey] = validateConfigValue(configKey, item[configKey]);
          hasValue = true;
        }
      }
      if (!hasValue) throw new Error(`change for ${key} has no configuration value`);
      changes.push(change);
    }
    return { releaseId, coordinatorAcceptedAt: raw.coordinatorAcceptedAt, acceptedOrder, changes, chunk };
  }

  /**
   * Applies one release group to candidates and effective config in a single
   * atomic mutation. Callers guarantee `changes` are already validated.
   */
  private applyReleaseGroup(
    draft: ServicePersistentState,
    input: ParsedAccept,
    changes: RouteChange[],
    acceptedAt: string,
    chunkCount?: number,
  ): Record<string, unknown> {
    for (const change of changes) {
      const routeState = draft.routes[change.routeId];
      if (!routeState) throw new Error(`unknown route state: ${change.routeId}`);
      const candidateMap = (draft.candidates[change.routeId] ??= {});

      for (const configKey of CONFIG_KEYS) {
        const value = change[configKey];
        if (value === undefined) continue;
        const typedKey = configKey as ConfigKey;
        const list = (candidateMap[typedKey] ??= []);
        const filtered = list.filter((candidate) => candidate.releaseId !== input.releaseId);
        filtered.push({
          releaseId: input.releaseId,
          coordinatorAcceptedAt: input.coordinatorAcceptedAt,
          acceptedOrder: input.acceptedOrder,
          value,
        });
        filtered.sort(compareCandidateNewestFirst);
        candidateMap[typedKey] = filtered;
        const winner = filtered[0];
        if (winner) routeState.effective[typedKey] = winner.value;
      }
    }

    const record: ServiceReleaseRecord = {
      releaseId: input.releaseId,
      coordinatorAcceptedAt: input.coordinatorAcceptedAt,
      acceptedOrder: input.acceptedOrder,
      status: 'active',
      changes: changes.map((change) => ({ ...change })),
      serviceAcceptedAt: acceptedAt,
    };
    if (chunkCount !== undefined) record.chunkCount = chunkCount;
    draft.releases[input.releaseId] = record;

    return {
      ok: true,
      serviceId: this.definition.id,
      releaseId: input.releaseId,
      status: 'active',
      serviceAcceptedAt: acceptedAt,
      chunkCount: chunkCount ?? 1,
      appliedRouteIds: changes.map((change) => change.routeId),
      effective: Object.fromEntries(
        changes.map((change) => [change.routeId, { ...draft.routes[change.routeId]!.effective }]),
      ),
    };
  }

  async acceptRelease(releaseId: string, rawBody: any, idempotencyKey?: string): Promise<ServiceHttpResult> {
    let input: ParsedAccept;
    try {
      input = this.parseAcceptInput(releaseId, { ...(rawBody ?? {}), releaseId });
    } catch (error) {
      return { statusCode: 400, body: { ok: false, error: (error as Error).message } };
    }

    const key =
      idempotencyKey ||
      (input.chunk ? `accept:${releaseId}:chunk${input.chunk.index}` : `accept:${releaseId}`);

    return this.store.mutate<ServiceHttpResult>((draft) => {
      draft.pendingChunks ??= {};
      const storedRequest = draft.processedRequests[key];
      if (storedRequest) {
        return {
          result: {
            statusCode: storedRequest.statusCode,
            body: storedRequest.responseJson,
            replayed: true,
          } satisfies ServiceHttpResult,
        };
      }

      const existing = draft.releases[releaseId];
      if (existing?.status === 'revoked') {
        const body = {
          ok: false,
          error: `release ${releaseId} was revoked; a new accept cannot resurrect it`,
          releaseId,
          status: 'revoked',
        };
        return { result: { statusCode: 409, body } };
      }

      const acceptedAt = existing?.serviceAcceptedAt ?? nowIso();

      if (!input.chunk) {
        const body = this.applyReleaseGroup(draft, input, input.changes, acceptedAt);
        draft.processedRequests[key] = {
          idempotencyKey: key,
          statusCode: 200,
          responseJson: body,
          completedAt: nowIso(),
        };
        return { next: draft, result: { statusCode: 200, body } };
      }

      const chunk = input.chunk;
      let pending: PendingChunkAccept | undefined = draft.pendingChunks[releaseId];
      if (
        pending &&
        (pending.chunkCount !== chunk.count ||
          pending.coordinatorAcceptedAt !== input.coordinatorAcceptedAt ||
          pending.acceptedOrder !== input.acceptedOrder)
      ) {
        const body = {
          ok: false,
          error: `release ${releaseId} already has buffered chunks from a different dispatch plan`,
          releaseId,
          status: 'pending',
          chunkCount: pending.chunkCount,
        };
        return { result: { statusCode: 409, body } };
      }
      if (!pending) {
        const timestamp = nowIso();
        pending = {
          releaseId,
          coordinatorAcceptedAt: input.coordinatorAcceptedAt,
          acceptedOrder: input.acceptedOrder,
          chunkCount: chunk.count,
          changesByChunk: {},
          received: [],
          firstReceivedAt: timestamp,
          updatedAt: timestamp,
        };
        draft.pendingChunks[releaseId] = pending;
      }

      pending.changesByChunk[String(chunk.index)] = input.changes.map((change) => ({ ...change }));
      pending.received = addReceived(pending.received, chunk.index);
      pending.updatedAt = nowIso();

      const missing = missingIndexes(pending.chunkCount, pending.received);
      if (missing.length > 0) {
        const body = {
          ok: true,
          serviceId: this.definition.id,
          releaseId,
          status: 'pending',
          chunkCount: pending.chunkCount,
          chunks: { index: chunk.index, count: pending.chunkCount },
          receivedChunks: [...pending.received],
          missingChunks: missing,
        };
        draft.processedRequests[key] = {
          idempotencyKey: key,
          statusCode: 202,
          responseJson: body,
          completedAt: nowIso(),
        };
        return { next: draft, result: { statusCode: 202, body } };
      }

      // The group is complete: merge every buffered chunk and apply it as one
      // atomic change set, then drop the buffer.
      const merged: RouteChange[] = [];
      const seen = new Set<string>();
      let duplicate: string | undefined;
      for (let index = 0; index < pending.chunkCount; index += 1) {
        for (const change of pending.changesByChunk[String(index)] ?? []) {
          const routeKey = `${change.serviceId}/${change.routeId}`;
          if (seen.has(routeKey)) duplicate = routeKey;
          seen.add(routeKey);
          merged.push(change);
        }
      }
      delete draft.pendingChunks[releaseId];

      if (duplicate) {
        const body = {
          ok: false,
          error: `buffered chunk group repeats ${duplicate}; the whole group was not applied`,
          releaseId,
          status: 'absent',
        };
        return { next: draft, result: { statusCode: 400, body } };
      }

      const body = this.applyReleaseGroup(draft, input, merged, acceptedAt, pending.chunkCount);
      body.chunks = { index: chunk.index, count: pending.chunkCount };
      draft.processedRequests[key] = {
        idempotencyKey: key,
        statusCode: 200,
        responseJson: body,
        completedAt: nowIso(),
      };
      return { next: draft, result: { statusCode: 200, body } };
    });
  }

  async revokeRelease(releaseId: string, idempotencyKey?: string): Promise<ServiceHttpResult> {
    const key = idempotencyKey || `revoke:${releaseId}`;
    return this.store.mutate<ServiceHttpResult>((draft) => {
      draft.pendingChunks ??= {};
      const storedRequest = draft.processedRequests[key];
      if (storedRequest) {
        return {
          result: {
            statusCode: storedRequest.statusCode,
            body: storedRequest.responseJson,
            replayed: true,
          } satisfies ServiceHttpResult,
          };
      }

      // Chunks that were buffered but never completed are simply discarded:
      // they never affected candidates or effective config.
      const buffered = draft.pendingChunks[releaseId];
      if (buffered) delete draft.pendingChunks[releaseId];

      const existing = draft.releases[releaseId];
      const revokedAt = existing?.serviceRevokedAt ?? nowIso();

      if (existing?.status === 'active') {
        for (const change of existing.changes) {
          const routeState = draft.routes[change.routeId];
          const candidateMap = draft.candidates[change.routeId];
          if (!routeState || !candidateMap) continue;

          for (const configKey of CONFIG_KEYS) {
            if (change[configKey] === undefined) continue;
            const list = candidateMap[configKey];
            if (!list) continue;
            const remaining = list.filter((candidate) => candidate.releaseId !== releaseId);
            remaining.sort(compareCandidateNewestFirst);
            candidateMap[configKey] = remaining;
            const winner = remaining[0];
            routeState.effective[configKey] = winner
              ? winner.value
              : routeState.initial[configKey];
          }
        }
        existing.status = 'revoked';
        existing.serviceRevokedAt = revokedAt;
      }

      const status = existing?.status === 'revoked' ? 'revoked' : 'absent';
      const body = {
        ok: true,
        serviceId: this.definition.id,
        releaseId,
        status,
        serviceRevokedAt: revokedAt,
        discardedBufferedChunks: buffered ? buffered.received.length : 0,
      };
      draft.processedRequests[key] = {
        idempotencyKey: key,
        statusCode: 200,
        responseJson: body,
        completedAt: nowIso(),
      };
      return { next: draft, result: { statusCode: 200, body } };
    });
  }
}
