import { ApiError } from './errors.js';
import type { DispatchChunkPlan, RouteChange } from './types.js';

/**
 * Upper bound for one dispatch request body. Configurable per coordinator run;
 * the default is the 16 KiB value used by the self-check.
 */
export const DEFAULT_DISPATCH_MAX_BYTES = 16 * 1024;

export interface ChunkPrefix {
  releaseId: string;
  coordinatorAcceptedAt: string;
  acceptedOrder: number;
}

export function buildAcceptChunkBody(
  prefix: ChunkPrefix,
  totalChunks: number,
  index: number,
  changes: RouteChange[],
): string {
  return JSON.stringify({
    releaseId: prefix.releaseId,
    coordinatorAcceptedAt: prefix.coordinatorAcceptedAt,
    acceptedOrder: prefix.acceptedOrder,
    chunk: { index, count: totalChunks },
    changes,
  });
}

function greedyGroup(
  prefix: ChunkPrefix,
  changes: RouteChange[],
  sizingTotal: number,
  maxBytes: number,
): { groups: RouteChange[][]; firstOversized?: { change: RouteChange; bytes: number } } {
  const groups: RouteChange[][] = [];
  let current: RouteChange[] = [];
  let firstOversized: { change: RouteChange; bytes: number } | undefined;

  for (const change of changes) {
    const candidate = [...current, change];
    const candidateBytes = Buffer.byteLength(
      buildAcceptChunkBody(prefix, sizingTotal, groups.length, candidate),
    );
    if (candidateBytes <= maxBytes) {
      current = candidate;
      continue;
    }
    if (current.length > 0) {
      groups.push(current);
      current = [];
    }
    const singleBytes = Buffer.byteLength(
      buildAcceptChunkBody(prefix, sizingTotal, groups.length, [change]),
    );
    if (singleBytes > maxBytes) {
      firstOversized ??= { change, bytes: singleBytes };
      // Keep it anyway so the caller can report one clear error; no chunk
      // below the cap could ever carry this change.
      groups.push([change]);
      continue;
    }
    current = [change];
  }
  if (current.length > 0) groups.push(current);
  return { groups, firstOversized };
}

/**
 * Deterministically splits this release's changes for one service so that
 * every dispatched request body fits in `maxBytes` bytes. Only boundaries are
 * persisted; the change payload itself stays on the release record.
 *
 * Sizing uses `changes.length` as the chunk count, which is the largest value
 * the count can ever take and therefore an upper bound on its digit count.
 * A real body (with the true, smaller count) is never larger than the body
 * measured here, so the split is guaranteed to stay under the cap without
 * iterating on the count.
 */
export function computeDispatchPlan(
  prefix: ChunkPrefix,
  changes: RouteChange[],
  maxBytes: number,
): DispatchChunkPlan {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new ApiError(400, `dispatchMaxBytes must be a positive integer, got ${String(maxBytes)}`);
  }
  if (changes.length === 0) {
    return { total: 0, bytes: [], starts: [], ends: [] };
  }

  const result = greedyGroup(prefix, changes, changes.length, maxBytes);
  if (result.firstOversized) {
    const { change, bytes } = result.firstOversized;
    throw new ApiError(
      400,
      `change for ${change.serviceId}/${change.routeId} alone needs ${bytes} request bytes, ` +
        `exceeding the ${maxBytes}-byte dispatch limit`,
    );
  }

  const groups = result.groups;
  const total = groups.length;
  const starts: number[] = [];
  const ends: number[] = [];
  const bytes: number[] = [];
  let offset = 0;
  groups.forEach((group, index) => {
    starts.push(offset);
    ends.push(offset + group.length);
    offset += group.length;
    const measured = Buffer.byteLength(buildAcceptChunkBody(prefix, total, index, group));
    if (measured > maxBytes) {
      throw new ApiError(
        400,
        `planned chunk ${index} needs ${measured} bytes, exceeding the ${maxBytes}-byte dispatch limit`,
      );
    }
    bytes.push(measured);
  });
  return { total, bytes, starts, ends };
}

export function planChunkChanges(
  plan: DispatchChunkPlan,
  serviceChanges: RouteChange[],
  index: number,
): RouteChange[] {
  const start = plan.starts[index];
  const end = plan.ends[index];
  if (start === undefined || end === undefined) return [];
  return serviceChanges.slice(start, end);
}

export function chunkAcceptRequestPath(releaseId: string, index: number): string {
  return `/__admin/releases/${encodeURIComponent(releaseId)}/accept?chunk=${index}`;
}

export function chunkIdempotencyKey(releaseId: string, serviceId: string, index: number): string {
  return `accept:${releaseId}:${serviceId}:c${index}:v1`;
}
