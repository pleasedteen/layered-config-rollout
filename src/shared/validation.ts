import { createHash } from 'node:crypto';
import type {
  ConfigKey,
  FixtureData,
  RouteChange,
  RouteConfig,
  ServiceDefinition,
} from './types.js';

export const CONFIG_KEYS: ConfigKey[] = ['timeoutMs', 'rateLimitPerMinute'];

function canonicalChange(change: RouteChange): Record<string, unknown> {
  const result: Record<string, unknown> = {
    serviceId: change.serviceId,
    routeId: change.routeId,
  };
  for (const key of CONFIG_KEYS) {
    if (change[key] !== undefined) result[key] = change[key];
  }
  return result;
}

/** Order-independent, whitespace-free form used to compare release payloads. */
export function canonicalizeChanges(changes: RouteChange[]): Array<Record<string, unknown>> {
  return changes
    .map(canonicalChange)
    .sort((a, b) => `${String(a.serviceId)}/${String(a.routeId)}`.localeCompare(`${String(b.serviceId)}/${String(b.routeId)}`));
}

export interface AcceptPayloadIdentity {
  coordinatorAcceptedAt: string;
  acceptedOrder: number;
  changes: RouteChange[];
}

/** Stable fingerprint of the coordinator payload that created a release. */
export function computeAcceptPayloadHash(input: AcceptPayloadIdentity): string {
  const canonical = JSON.stringify({
    coordinatorAcceptedAt: input.coordinatorAcceptedAt,
    acceptedOrder: input.acceptedOrder,
    changes: canonicalizeChanges(input.changes),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function isConfigKey(value: string): value is ConfigKey {
  return value === 'timeoutMs' || value === 'rateLimitPerMinute';
}

export function cloneConfig(config: RouteConfig): RouteConfig {
  return { timeoutMs: config.timeoutMs, rateLimitPerMinute: config.rateLimitPerMinute };
}

export function validateConfigValue(key: ConfigKey, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  if (key === 'timeoutMs' && (value < 1 || value > 60_000)) {
    throw new Error('timeoutMs must be between 1 and 60000');
  }
  if (key === 'rateLimitPerMinute' && (value < 0 || value > 10_000_000)) {
    throw new Error('rateLimitPerMinute must be between 0 and 10000000');
  }
  return value;
}

export function normalizeChange(input: unknown): RouteChange {
  if (!input || typeof input !== 'object') {
    throw new Error('each change must be an object');
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.serviceId !== 'string' || raw.serviceId.length === 0) {
    throw new Error('change.serviceId is required');
  }
  if (typeof raw.routeId !== 'string' || raw.routeId.length === 0) {
    throw new Error('change.routeId is required');
  }

  const change: RouteChange = { serviceId: raw.serviceId, routeId: raw.routeId };
  let hasPatch = false;
  for (const key of CONFIG_KEYS) {
    if (raw[key] !== undefined) {
      change[key] = validateConfigValue(key, raw[key]);
      hasPatch = true;
    }
  }
  if (!hasPatch) {
    throw new Error(`change for ${raw.serviceId}/${raw.routeId} must contain timeoutMs or rateLimitPerMinute`);
  }
  return change;
}

export function findService(fixture: FixtureData, serviceId: string): ServiceDefinition {
  const service = fixture.services.find((item) => item.id === serviceId);
  if (!service) throw new Error(`unknown service: ${serviceId}`);
  return service;
}

export function validateChangeAgainstFixture(fixture: FixtureData, change: RouteChange): void {
  const service = findService(fixture, change.serviceId);
  const route = service.routes.find((item) => item.id === change.routeId);
  if (!route) {
    throw new Error(`unknown route: ${change.serviceId}/${change.routeId}`);
  }
}

export function normalizeChanges(input: unknown, fixture?: FixtureData): RouteChange[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('changes must be a non-empty array');
  }
  const changes = input.map(normalizeChange);
  const seen = new Set<string>();
  for (const change of changes) {
    const key = `${change.serviceId}/${change.routeId}`;
    if (seen.has(key)) {
      throw new Error(`duplicate change for ${key}; combine keys into one object`);
    }
    seen.add(key);
    if (fixture) validateChangeAgainstFixture(fixture, change);
  }
  return changes;
}

export function normalizeBatches(
  targetServiceIds: string[],
  input: unknown,
  batchSizeInput?: unknown,
): string[][] {
  const targetSet = new Set(targetServiceIds);

  if (input !== undefined) {
    if (!Array.isArray(input) || input.length === 0) {
      throw new Error('batches must be a non-empty array of service-id arrays');
    }
    const batches = input.map((batch, index) => {
      if (!Array.isArray(batch) || batch.length === 0 || batch.some((id) => typeof id !== 'string')) {
        throw new Error(`batches[${index}] must be a non-empty string array`);
      }
      return [...(batch as string[])];
    });
    const seen = new Set<string>();
    for (const batch of batches) {
      for (const id of batch) {
        if (!targetSet.has(id)) throw new Error(`batch contains service outside targetServiceIds: ${id}`);
        if (seen.has(id)) throw new Error(`service ${id} appears in more than one batch`);
        seen.add(id);
      }
    }
    if (seen.size !== targetServiceIds.length) {
      throw new Error('batches must partition all target services exactly once');
    }
    return batches;
  }

  let size = targetServiceIds.length;
  if (batchSizeInput !== undefined) {
    size = typeof batchSizeInput === 'string' ? Number(batchSizeInput) : (batchSizeInput as number);
    if (!Number.isInteger(size) || size < 1) throw new Error('batchSize must be a positive integer');
  }

  const batches: string[][] = [];
  for (let i = 0; i < targetServiceIds.length; i += size) {
    batches.push(targetServiceIds.slice(i, i + size));
  }
  return batches;
}

export function deriveTargetServiceIds(changes: RouteChange[], input: unknown): string[] {
  const fromChanges = [...new Set(changes.map((change) => change.serviceId))];
  if (input === undefined) return fromChanges;
  if (!Array.isArray(input) || input.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('targetServiceIds must be an array of non-empty strings');
  }
  const targetIds = [...new Set(input as string[])];
  for (const id of fromChanges) {
    if (!targetIds.includes(id)) throw new Error(`change service ${id} is missing from targetServiceIds`);
  }
  for (const id of targetIds) {
    if (!fromChanges.includes(id)) throw new Error(`target service ${id} has no changes in this release`);
  }
  return targetIds;
}
