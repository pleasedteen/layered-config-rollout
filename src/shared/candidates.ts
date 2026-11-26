import type { Candidate, ConfigKey, RouteChange } from './types.js';

/** Newest coordinator acceptance first; acceptedOrder breaks clock ties. */
export function compareCandidateNewestFirst(a: Candidate, b: Candidate): number {
  if (a.acceptedOrder !== b.acceptedOrder) return b.acceptedOrder - a.acceptedOrder;
  const time = Date.parse(b.coordinatorAcceptedAt) - Date.parse(a.coordinatorAcceptedAt);
  if (time !== 0) return time;
  return b.releaseId.localeCompare(a.releaseId);
}

/**
 * Selects the winning candidate for a config key from the candidate stack,
 * ignoring candidates whose release is no longer active and collapsing any
 * duplicate contributions for the same release (keeping the newest one).
 */
export function selectWinningCandidate(
  candidates: Candidate[] | undefined,
  isActive: (releaseId: string) => boolean,
): Candidate | undefined {
  if (!candidates || candidates.length === 0) return undefined;
  const sorted = [...candidates].sort(compareCandidateNewestFirst);
  const seen = new Set<string>();
  for (const candidate of sorted) {
    if (!isActive(candidate.releaseId)) continue;
    if (seen.has(candidate.releaseId)) continue;
    seen.add(candidate.releaseId);
    return candidate;
  }
  return undefined;
}

export function configKeysOfChange(change: RouteChange): ConfigKey[] {
  const keys: ConfigKey[] = [];
  if (change.timeoutMs !== undefined) keys.push('timeoutMs');
  if (change.rateLimitPerMinute !== undefined) keys.push('rateLimitPerMinute');
  return keys;
}
