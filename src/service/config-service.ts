import path from 'node:path';
import { AtomicJsonStore, nowIso } from '../shared/store.js';
import {
  CONFIG_KEYS,
  canonicalizeChanges,
  cloneConfig,
  computeAcceptPayloadHash,
  validateConfigValue,
} from '../shared/validation.js';
import {
  compareCandidateNewestFirst,
  configKeysOfChange,
  selectWinningCandidate,
} from '../shared/candidates.js';
import type {
  Candidate,
  ConfigKey,
  FixtureData,
  RepairResponseBody,
  RouteChange,
  RouteConfig,
  ServiceDefinition,
  ServicePersistentState,
  ServiceReleaseConsistency,
  ServiceReleaseRecord,
} from '../shared/types.js';
import { readFile } from 'node:fs/promises';

export interface ServiceHttpResult {
  statusCode: number;
  body: unknown;
  replayed?: boolean;
}

interface AcceptInput {
  coordinatorAcceptedAt: string;
  acceptedOrder: number;
  changes: RouteChange[];
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

function candidateKey(routeId: string, configKey: ConfigKey): string {
  return `${routeId}::${configKey}`;
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

  private validateAcceptInput(raw: any): AcceptInput {
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

  private recordMatchesPayload(
    record: ServiceReleaseRecord,
    input: AcceptInput,
    payloadHash: string,
  ): boolean {
    if (record.payloadHash !== undefined) return record.payloadHash === payloadHash;
    // Legacy records have no stored fingerprint; compare the visible payload.
    if (record.coordinatorAcceptedAt !== input.coordinatorAcceptedAt) return false;
    if (record.acceptedOrder !== input.acceptedOrder) return false;
    return (
      JSON.stringify(canonicalizeChanges(record.changes)) ===
      JSON.stringify(canonicalizeChanges(input.changes))
    );
  }

  private buildAcceptBody(releaseId: string, serviceAcceptedAt: string, changes: RouteChange[], state: ServicePersistentState) {
    return {
      ok: true,
      serviceId: this.definition.id,
      releaseId,
      status: 'active',
      serviceAcceptedAt,
      appliedRouteIds: changes.map((change) => change.routeId),
      effective: Object.fromEntries(
        changes.map((change) => [change.routeId, { ...state.routes[change.routeId]!.effective }]),
      ),
    };
  }

  private rejectPayloadConflict(releaseId: string, record: ServiceReleaseRecord): ServiceHttpResult {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: `release ${releaseId} was already accepted with a different payload`,
        releaseId,
        status: record.status,
        conflict: 'payload-mismatch',
      },
    };
  }

  async acceptRelease(releaseId: string, rawBody: any, idempotencyKey?: string): Promise<ServiceHttpResult> {
    let input: AcceptInput;
    try {
      input = this.validateAcceptInput({ ...(rawBody ?? {}), releaseId });
    } catch (error) {
      return { statusCode: 400, body: { ok: false, error: (error as Error).message } };
    }

    const key = idempotencyKey || `accept:${releaseId}`;
    const payloadHash = computeAcceptPayloadHash(input);

    return this.store.mutate<ServiceHttpResult>((draft) => {
      const storedRequest = draft.processedRequests[key];
      if (storedRequest) {
        if (storedRequest.payloadHash && storedRequest.payloadHash !== payloadHash) {
          const record = draft.releases[releaseId];
          return {
            result: {
              statusCode: 409,
              body: {
                ok: false,
                error: `idempotency key ${key} was already used with a different payload`,
                releaseId,
                conflict: 'payload-mismatch',
                status: record?.status ?? 'absent',
              },
            },
          };
        }
        return {
          result: {
            statusCode: storedRequest.statusCode,
            body: storedRequest.responseJson,
            replayed: true,
          } satisfies ServiceHttpResult,
        };
      }

      const existing = draft.releases[releaseId];
      if (existing && !this.recordMatchesPayload(existing, input, payloadHash)) {
        return { result: this.rejectPayloadConflict(releaseId, existing) };
      }

      if (existing?.status === 'revoked') {
        // Same payload as what was accepted before it got revoked still must
        // not resurrect it; only the original idempotency key may replay.
        const body = {
          ok: false,
          error: `release ${releaseId} was revoked; a new accept cannot resurrect it`,
          releaseId,
          status: 'revoked',
        };
        return { result: { statusCode: 409, body } };
      }

      if (existing) {
        // Legal resend of the exact payload the service already accepted.
        // Never re-add or mutate candidates: this keeps an operator repair and
        // a later revoke intact even if the original accept is replayed.
        if (!existing.acceptResponse) {
          const body = this.buildAcceptBody(
            releaseId,
            existing.serviceAcceptedAt,
            existing.changes,
            draft,
          );
          existing.acceptResponse = { statusCode: 200, body, completedAt: nowIso() };
        }
        const first = existing.acceptResponse;
        draft.processedRequests[key] = {
          idempotencyKey: key,
          statusCode: first.statusCode,
          responseJson: first.body,
          completedAt: nowIso(),
          payloadHash,
          releaseId,
        };
        return {
          next: draft,
          result: { statusCode: first.statusCode, body: first.body, replayed: true },
        };
      }

      const acceptedAt = nowIso();
      const touchedRoutes = new Set<string>();

      for (const change of input.changes) {
        const routeState = draft.routes[change.routeId];
        if (!routeState) throw new Error(`unknown route state: ${change.routeId}`);
        const candidateMap = (draft.candidates[change.routeId] ??= {});
        touchedRoutes.add(change.routeId);

        for (const configKey of configKeysOfChange(change)) {
          const value = change[configKey]!;
          const list = (candidateMap[configKey] ??= []);
          const filtered = list.filter((candidate) => candidate.releaseId !== releaseId);
          filtered.push({
            releaseId,
            coordinatorAcceptedAt: input.coordinatorAcceptedAt,
            acceptedOrder: input.acceptedOrder,
            value,
          });
          filtered.sort(compareCandidateNewestFirst);
          candidateMap[configKey] = filtered;
        }
      }

      draft.releases[releaseId] = {
        releaseId,
        coordinatorAcceptedAt: input.coordinatorAcceptedAt,
        acceptedOrder: input.acceptedOrder,
        status: 'active',
        changes: input.changes,
        serviceAcceptedAt: acceptedAt,
        payloadHash,
      };
      // Recompute before building the response so it reports the effective
      // values this very acceptance produced.
      this.recomputeEffective(draft, touchedRoutes);
      const body = this.buildAcceptBody(releaseId, acceptedAt, input.changes, draft);
      draft.releases[releaseId]!.acceptResponse = {
        statusCode: 200,
        body,
        completedAt: nowIso(),
      };
      draft.processedRequests[key] = {
        idempotencyKey: key,
        statusCode: 200,
        responseJson: body,
        completedAt: nowIso(),
        payloadHash,
        releaseId,
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
        const touched = this.removeReleaseCandidates(draft, releaseId);
        existing.status = 'revoked';
        existing.serviceRevokedAt = revokedAt;
        this.recomputeEffective(draft, touched);
      } else if (existing?.status === 'revoked') {
        // Keep it revoked and clear any residue a historical conflict left.
        const touched = this.removeReleaseCandidates(draft, releaseId);
        this.recomputeEffective(draft, touched);
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
        releaseId,
      };
      return { next: draft, result: { statusCode: 200, body } };
    });
  }

  /**
   * Operator repair: rewrites the service state for one release so that it
   * exactly matches the coordinator's original payload (target `active`), or
   * so that it carries no contribution at all (target `revoked`). The whole
   * group is corrected in a single atomic state replacement, so readers only
   * ever observe the complete corrected snapshot.
   */
  async repairRelease(releaseId: string, rawBody: any): Promise<ServiceHttpResult> {
    if (!rawBody || typeof rawBody !== 'object') {
      return { statusCode: 400, body: { ok: false, error: 'request body must be an object' } };
    }
    const targetStatus = (rawBody as any).targetStatus;
    if (targetStatus !== 'active' && targetStatus !== 'revoked') {
      return {
        statusCode: 400,
        body: { ok: false, error: "targetStatus must be 'active' or 'revoked'" },
      };
    }

    let input: AcceptInput | undefined;
    if (targetStatus === 'active') {
      try {
        input = this.validateAcceptInput({ ...rawBody, releaseId });
      } catch (error) {
        return { statusCode: 400, body: { ok: false, error: (error as Error).message } };
      }
    }

    // A repair re-asserts the coordinator's canonical payload; it is applied
    // even when it equals the current state, and never replays an older
    // idempotency record.
    return this.store.mutate<ServiceHttpResult>((draft) => {
      const repairedAt = nowIso();
      const existing = draft.releases[releaseId];
      if (targetStatus === 'active' && existing?.status === 'revoked') {
        // Revocation is final; an active repair must not undo it. Report the
        // truth and let the coordinator treat the mismatch as a failure.
        const consistency = this.computeConsistencyFromState(draft, releaseId);
        return {
          result: {
            statusCode: 200,
            body: this.buildRepairBody(draft, releaseId, targetStatus, consistency),
          },
        };
      }

      // Start from a blank slate for this release: drop every candidate it has
      // anywhere, including extras left behind by an earlier conflict.
      this.removeReleaseCandidates(draft, releaseId);

      if (targetStatus === 'active' && input) {
        for (const change of input.changes) {
          const routeState = draft.routes[change.routeId];
          if (!routeState) throw new Error(`unknown route state: ${change.routeId}`);
          const candidateMap = (draft.candidates[change.routeId] ??= {});
          for (const configKey of configKeysOfChange(change)) {
            const list = (candidateMap[configKey] ??= []);
            list.push({
              releaseId,
              coordinatorAcceptedAt: input.coordinatorAcceptedAt,
              acceptedOrder: input.acceptedOrder,
              value: change[configKey]!,
            });
            list.sort(compareCandidateNewestFirst);
            candidateMap[configKey] = list;
          }
        }

        draft.releases[releaseId] = {
          releaseId,
          coordinatorAcceptedAt: input.coordinatorAcceptedAt,
          acceptedOrder: input.acceptedOrder,
          status: 'active',
          changes: input.changes,
          serviceAcceptedAt: existing?.serviceAcceptedAt ?? repairedAt,
          payloadHash: computeAcceptPayloadHash(input),
          // Keep the very first accepted response so a later legal resend of
          // the same payload still returns it verbatim.
          acceptResponse: existing?.acceptResponse,
          repairedAt,
        };
      } else if (existing) {
        // Keep the revoked marker; only remove the contribution residue.
        existing.status = 'revoked';
        existing.serviceRevokedAt = existing.serviceRevokedAt ?? repairedAt;
        existing.repairedAt = repairedAt;
        existing.changes = [];
      }

      // Recompute every route so the correction is visible as one snapshot and
      // every config key is chosen by coordinator acceptance order.
      this.recomputeEffective(draft);

      if (targetStatus === 'active') {
        const activeRecord = draft.releases[releaseId]!;
        if (!activeRecord.acceptResponse) {
          activeRecord.acceptResponse = {
            statusCode: 200,
            body: this.buildAcceptBody(releaseId, activeRecord.serviceAcceptedAt, activeRecord.changes, draft),
            completedAt: repairedAt,
          };
        }
      }

      const consistency = this.computeConsistencyFromState(draft, releaseId);
      return {
        next: draft,
        result: { statusCode: 200, body: this.buildRepairBody(draft, releaseId, targetStatus, consistency) },
      };
    });
  }

  private buildRepairBody(
    state: ServicePersistentState,
    releaseId: string,
    targetStatus: 'active' | 'revoked',
    consistency: ServiceReleaseConsistency,
  ): RepairResponseBody & { issues: string[] } {
    const statusOk =
      targetStatus === 'active'
        ? consistency.status === 'active'
        : consistency.status === 'revoked' || consistency.status === 'absent';
    return {
      ok: statusOk && consistency.consistent,
      serviceId: this.definition.id,
      releaseId,
      targetStatus,
      status: consistency.status,
      repaired: true,
      consistent: consistency.consistent,
      issues: describeConsistencyIssues(consistency),
      effective: Object.fromEntries(
        Object.entries(state.routes).map(([routeId, route]) => [routeId, cloneConfig(route.effective)]),
      ),
    };
  }

  getConsistency(releaseId: string): ServiceReleaseConsistency {
    return this.computeConsistencyFromState(this.store.get(), releaseId);
  }

  private removeReleaseCandidates(draft: ServicePersistentState, releaseId: string): Set<string> {
    const touched = new Set<string>();
    for (const [routeId, candidateMap] of Object.entries(draft.candidates)) {
      for (const configKey of CONFIG_KEYS) {
        const list = candidateMap[configKey];
        if (!list || list.length === 0) continue;
        const remaining = list.filter((candidate) => candidate.releaseId !== releaseId);
        if (remaining.length !== list.length) {
          candidateMap[configKey] = remaining;
          touched.add(routeId);
        }
      }
    }
    return touched;
  }

  private recomputeEffective(draft: ServicePersistentState, touchedRoutes?: Set<string>): void {
    const isActive = (releaseId: string) => draft.releases[releaseId]?.status === 'active';
    for (const [routeId, routeState] of Object.entries(draft.routes)) {
      if (touchedRoutes && touchedRoutes.size > 0 && !touchedRoutes.has(routeId)) continue;
      const candidateMap = draft.candidates[routeId] ?? {};
      for (const configKey of CONFIG_KEYS) {
        const winner = selectWinningCandidate(candidateMap[configKey], isActive);
        routeState.effective[configKey] = winner ? winner.value : routeState.initial[configKey];
      }
    }
  }

  private computeConsistencyFromState(
    state: ServicePersistentState,
    releaseId: string,
  ): ServiceReleaseConsistency {
    const record = state.releases[releaseId] ?? null;
    const status = record?.status ?? 'absent';

    const expected = new Map<
      string,
      { value: number; coordinatorAcceptedAt: string; acceptedOrder: number; routeId: string; configKey: ConfigKey }
    >();
    if (record?.status === 'active') {
      for (const change of record.changes) {
        const route = this.definition.routes.find((item) => item.id === change.routeId);
        if (!route) continue;
        for (const configKey of configKeysOfChange(change)) {
          expected.set(candidateKey(change.routeId, configKey), {
            value: change[configKey]!,
            coordinatorAcceptedAt: record.coordinatorAcceptedAt,
            acceptedOrder: record.acceptedOrder,
            routeId: change.routeId,
            configKey,
          });
        }
      }
    }

    const actual = new Map<string, Candidate[]>();
    const relevantRoutes = new Set<string>();
    for (const [routeId, candidateMap] of Object.entries(state.candidates)) {
      for (const configKey of CONFIG_KEYS) {
        const list = candidateMap[configKey];
        if (!list) continue;
        const mine = list.filter((candidate) => candidate.releaseId === releaseId);
        if (mine.length > 0) {
          actual.set(candidateKey(routeId, configKey), mine);
          relevantRoutes.add(routeId);
        }
      }
    }
    for (const change of record?.changes ?? []) relevantRoutes.add(change.routeId);

    const consistency: ServiceReleaseConsistency = {
      releaseId,
      status,
      consistent: true,
      extraCandidates: [],
      duplicateCandidates: [],
      missingCandidates: [],
      mismatchedCandidates: [],
      staleEffective: [],
    };

    for (const [key, expectedEntry] of expected) {
      const mine = actual.get(key) ?? [];
      if (mine.length === 0) {
        consistency.missingCandidates.push({
          routeId: expectedEntry.routeId,
          configKey: expectedEntry.configKey,
        });
        continue;
      }
      if (mine.length > 1) {
        consistency.duplicateCandidates.push({
          routeId: expectedEntry.routeId,
          configKey: expectedEntry.configKey,
          count: mine.length,
        });
      }
      const candidate = [...mine].sort(compareCandidateNewestFirst)[0]!;
      if (
        candidate.value !== expectedEntry.value ||
        candidate.coordinatorAcceptedAt !== expectedEntry.coordinatorAcceptedAt ||
        candidate.acceptedOrder !== expectedEntry.acceptedOrder
      ) {
        consistency.mismatchedCandidates.push({
          routeId: expectedEntry.routeId,
          configKey: expectedEntry.configKey,
          expected: expectedEntry.value,
          actual: candidate.value,
        });
      }
    }

    for (const [key, mine] of actual) {
      if (expected.has(key)) continue;
      const [routeId, configKey] = key.split('::') as [string, ConfigKey];
      consistency.extraCandidates.push({ routeId, configKey });
      if (mine.length > 1) {
        consistency.duplicateCandidates.push({ routeId, configKey, count: mine.length });
      }
    }

    // Materialized values must match a fresh selection over the active stacks.
    const isActive = (rid: string) => state.releases[rid]?.status === 'active';
    for (const routeId of relevantRoutes) {
      const routeState = state.routes[routeId];
      if (!routeState) continue;
      const candidateMap = state.candidates[routeId] ?? {};
      for (const configKey of CONFIG_KEYS) {
        const winner = selectWinningCandidate(candidateMap[configKey], isActive);
        const expectedValue = winner ? winner.value : routeState.initial[configKey];
        if (routeState.effective[configKey] !== expectedValue) {
          consistency.staleEffective.push({
            routeId,
            configKey,
            expected: expectedValue,
            actual: routeState.effective[configKey],
          });
        }
      }
    }

    consistency.consistent =
      consistency.extraCandidates.length === 0 &&
      consistency.duplicateCandidates.length === 0 &&
      consistency.missingCandidates.length === 0 &&
      consistency.mismatchedCandidates.length === 0 &&
      consistency.staleEffective.length === 0;

    return consistency;
  }
}

function describeConsistencyIssues(consistency: ServiceReleaseConsistency): string[] {
  const issues: string[] = [];
  for (const item of consistency.extraCandidates) {
    issues.push(`extra candidate ${item.routeId}/${item.configKey}`);
  }
  for (const item of consistency.duplicateCandidates) {
    issues.push(`duplicate candidates ${item.routeId}/${item.configKey} x${item.count}`);
  }
  for (const item of consistency.missingCandidates) {
    issues.push(`missing candidate ${item.routeId}/${item.configKey}`);
  }
  for (const item of consistency.mismatchedCandidates) {
    issues.push(
      `mismatched candidate ${item.routeId}/${item.configKey} expected=${item.expected} actual=${item.actual}`,
    );
  }
  for (const item of consistency.staleEffective) {
    issues.push(
      `stale effective ${item.routeId}/${item.configKey} expected=${item.expected} actual=${item.actual}`,
    );
  }
  return issues;
}
