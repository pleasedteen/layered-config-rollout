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
  ConfigValueSource,
  EffectiveSwitchRecord,
  FixtureData,
  RouteChange,
  RouteConfig,
  ServiceDefinition,
  ServicePersistentState,
  TimelineChange,
  TimelineValuePoint,
} from '../shared/types.js';
import { readFile } from 'node:fs/promises';

export interface ServiceHttpResult {
  statusCode: number;
  body: unknown;
  replayed?: boolean;
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
    switchSeq: 0,
    switchLog: [],
  };
}

/**
 * Resolves the currently effective value/source for one config item from a
 * draft state. The first sorted candidate is the winner; with no candidate
 * the source is the service's own route initial value.
 */
function currentValuePoint(
  draft: ServicePersistentState,
  routeId: string,
  configKey: ConfigKey,
): TimelineValuePoint {
  const routeState = draft.routes[routeId];
  if (!routeState) throw new Error(`unknown route state: ${routeId}`);
  const winner = draft.candidates[routeId]?.[configKey]?.[0];
  if (winner) {
    return {
      value: routeState.effective[configKey],
      source: {
        type: 'release',
        releaseId: winner.releaseId,
        acceptedOrder: winner.acceptedOrder,
        coordinatorAcceptedAt: winner.coordinatorAcceptedAt,
      },
    };
  }
  return {
    value: routeState.initial[configKey],
    source: { type: 'initial' },
  };
}

function isSameSource(a: ConfigValueSource, b: ConfigValueSource): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'initial' || b.type === 'initial') return true;
  return (
    a.releaseId === b.releaseId &&
    a.acceptedOrder === b.acceptedOrder &&
    a.coordinatorAcceptedAt === b.coordinatorAcceptedAt
  );
}

/**
 * Builds the changed-item list for a set of touched config keys by comparing
 * pre/post value points. Items are kept when the value OR the source changed,
 * so equal-value source hand-offs remain visible.
 */
function diffTouchedKeys(
  draft: ServicePersistentState,
  touched: ReadonlyArray<{ routeId: string; configKey: ConfigKey; before: TimelineValuePoint }>,
): TimelineChange[] {
  const changes: TimelineChange[] = [];
  for (const touchedItem of touched) {
    const after = currentValuePoint(draft, touchedItem.routeId, touchedItem.configKey);
    const valueChanged = touchedItem.before.value !== after.value;
    const sourceChanged = !isSameSource(touchedItem.before.source, after.source);
    if (!valueChanged && !sourceChanged) continue;
    changes.push({
      routeId: touchedItem.routeId,
      configKey: touchedItem.configKey,
      before: touchedItem.before,
      after,
      valueChanged,
      sourceChanged,
    });
  }
  return changes;
}

function compareCandidateNewestFirst(a: Candidate, b: Candidate): number {
  if (a.acceptedOrder !== b.acceptedOrder) return b.acceptedOrder - a.acceptedOrder;
  const time = Date.parse(b.coordinatorAcceptedAt) - Date.parse(a.coordinatorAcceptedAt);
  if (time !== 0) return time;
  return b.releaseId.localeCompare(a.releaseId);
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
    // Migrate snapshots written before the effective-switch journal existed.
    const loaded = store.get() as Partial<ServicePersistentState>;
    if (typeof loaded.switchSeq !== 'number' || !Array.isArray(loaded.switchLog)) {
      await store.mutate((draft) => {
        if (typeof draft.switchSeq !== 'number') draft.switchSeq = 0;
        if (!Array.isArray(draft.switchLog)) draft.switchLog = [];
        return { next: draft, result: undefined };
      });
    }
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
   * Segmented effective-switch journal read. Returns records with
   * `seq > afterSeq`, at most `limit`, in actual effective (ascending seq)
   * order. The coordinator uses `nextSeq` as the next cursor.
   */
  getTimeline(options: { afterSeq?: number; limit?: number } = {}) {
    const state = this.store.get();
    const afterSeq = Number.isInteger(options.afterSeq) && (options.afterSeq as number) >= 0
      ? (options.afterSeq as number)
      : 0;
    const requestedLimit = options.limit ?? 100;
    const limit = Math.min(500, Math.max(1, Math.trunc(requestedLimit) || 100));
    const records = state.switchLog
      .filter((record) => record.seq > afterSeq)
      .slice(0, limit);
    const nextSeq = records.length > 0 ? records[records.length - 1]!.seq : afterSeq;
    return {
      serviceId: state.serviceId,
      headSeq: state.switchSeq,
      afterSeq,
      limit,
      nextSeq,
      records,
    };
  }

  /**
   * Appends the single atomic switch record for one first-time accept/revoke
   * execution. Called inside the same store mutation as the effective config
   * and idempotency response, so replays can never reach it and the record
   * commits atomically with the switch it describes. Operations that change
   * neither value nor source produce no timeline entry.
   */
  private appendSwitch(
    draft: ServicePersistentState,
    details: {
      action: EffectiveSwitchRecord['action'];
      releaseId: string;
      coordinatorAcceptedOrder?: number;
      coordinatorAcceptedAt?: string;
      changes: TimelineChange[];
    },
  ): void {
    if (details.changes.length === 0) return;
    draft.switchSeq += 1;
    const seq = draft.switchSeq;
    const record: EffectiveSwitchRecord = {
      seq,
      id: `${draft.serviceId}#effective-${seq}`,
      serviceId: draft.serviceId,
      at: nowIso(),
      action: details.action,
      releaseId: details.releaseId,
      coordinatorAcceptedOrder: details.coordinatorAcceptedOrder,
      coordinatorAcceptedAt: details.coordinatorAcceptedAt,
      changes: details.changes,
    };
    draft.switchLog.push(record);
  }

  private validateAcceptInput(raw: any): {
    coordinatorAcceptedAt: string;
    acceptedOrder: number;
    changes: RouteChange[];
  } {
    if (!raw || typeof raw !== 'object') throw new Error('request body must be an object');
    if (typeof raw.releaseId !== 'string' || raw.releaseId.length === 0) {
      throw new Error('releaseId is required in body');
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
    return { coordinatorAcceptedAt: raw.coordinatorAcceptedAt, acceptedOrder, changes };
  }

  async acceptRelease(releaseId: string, rawBody: any, idempotencyKey?: string): Promise<ServiceHttpResult> {
    let input: ReturnType<ConfigService['validateAcceptInput']>;
    try {
      input = this.validateAcceptInput({ ...(rawBody ?? {}), releaseId });
    } catch (error) {
      return { statusCode: 400, body: { ok: false, error: (error as Error).message } };
    }

    const key = idempotencyKey || `accept:${releaseId}`;
    return this.store.mutate<ServiceHttpResult>((draft) => {
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

      // Capture pre-switch value/source for every touched config key before
      // any candidate stack mutation.
      const beforePoints: Array<{ routeId: string; configKey: ConfigKey; before: TimelineValuePoint }> = [];
      for (const change of input.changes) {
        for (const configKey of CONFIG_KEYS) {
          if (change[configKey] === undefined) continue;
          const key = configKey as ConfigKey;
          beforePoints.push({
            routeId: change.routeId,
            configKey: key,
            before: currentValuePoint(draft, change.routeId, key),
          });
        }
      }

      for (const change of input.changes) {
        const routeState = draft.routes[change.routeId];
        if (!routeState) throw new Error(`unknown route state: ${change.routeId}`);
        const candidateMap = (draft.candidates[change.routeId] ??= {});

        for (const configKey of CONFIG_KEYS) {
          const value = change[configKey];
          if (value === undefined) continue;
          const key2 = configKey as ConfigKey;
          const list = (candidateMap[key2] ??= []);
          const filtered = list.filter((candidate) => candidate.releaseId !== releaseId);
          filtered.push({
            releaseId,
            coordinatorAcceptedAt: input.coordinatorAcceptedAt,
            acceptedOrder: input.acceptedOrder,
            value,
          });
          filtered.sort(compareCandidateNewestFirst);
          candidateMap[key2] = filtered;
          const winner = filtered[0];
          if (winner) routeState.effective[key2] = winner.value;
        }
      }

      draft.releases[releaseId] = {
        releaseId,
        coordinatorAcceptedAt: input.coordinatorAcceptedAt,
        acceptedOrder: input.acceptedOrder,
        status: 'active',
        changes: input.changes,
        serviceAcceptedAt: acceptedAt,
      };

      // One atomic switch record for the whole cross-route/cross-key group.
      const timelineChanges = diffTouchedKeys(draft, beforePoints);
      this.appendSwitch(draft, {
        action: 'accept',
        releaseId,
        coordinatorAcceptedOrder: input.acceptedOrder,
        coordinatorAcceptedAt: input.coordinatorAcceptedAt,
        changes: timelineChanges,
      });

      const body = {
        ok: true,
        serviceId: this.definition.id,
        releaseId,
        status: 'active',
        serviceAcceptedAt: acceptedAt,
        appliedRouteIds: input.changes.map((change) => change.routeId),
        effective: Object.fromEntries(
          input.changes.map((change) => [change.routeId, { ...draft.routes[change.routeId]!.effective }]),
        ),
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

  async revokeRelease(releaseId: string, idempotencyKey?: string): Promise<ServiceHttpResult> {
    const key = idempotencyKey || `revoke:${releaseId}`;
    return this.store.mutate<ServiceHttpResult>((draft) => {
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
      const revokedAt = existing?.serviceRevokedAt ?? nowIso();

      if (existing?.status === 'active') {
        // Capture pre-revoke value/source for every key this release touched.
        const beforePoints: Array<{ routeId: string; configKey: ConfigKey; before: TimelineValuePoint }> = [];
        for (const change of existing.changes) {
          for (const configKey of CONFIG_KEYS) {
            if (change[configKey] === undefined) continue;
            const key = configKey as ConfigKey;
            beforePoints.push({
              routeId: change.routeId,
              configKey: key,
              before: currentValuePoint(draft, change.routeId, key),
            });
          }
        }

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

        // Records fallback to the earlier winning release or to `initial`.
        const timelineChanges = diffTouchedKeys(draft, beforePoints);
        this.appendSwitch(draft, {
          action: 'revoke',
          releaseId,
          coordinatorAcceptedOrder: existing.acceptedOrder,
          coordinatorAcceptedAt: existing.coordinatorAcceptedAt,
          changes: timelineChanges,
        });
      }

      const status = existing?.status === 'revoked' ? 'revoked' : 'absent';
      const body = {
        ok: true,
        serviceId: this.definition.id,
        releaseId,
        status,
        serviceRevokedAt: revokedAt,
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
