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
  RouteChange,
  RouteConfig,
  ServiceDefinition,
  ServicePersistentState,
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
  };
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
