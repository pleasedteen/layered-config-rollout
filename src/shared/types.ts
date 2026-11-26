export type ConfigKey = 'timeoutMs' | 'rateLimitPerMinute';

export interface RouteConfig {
  timeoutMs: number;
  rateLimitPerMinute: number;
}

export type ConfigPatch = Partial<RouteConfig>;

export interface UpstreamSpec {
  latencyMs?: number;
  status?: number;
  body?: string;
}

export interface RouteDefinition {
  id: string;
  method?: string;
  path: string;
  initial: RouteConfig;
  upstream?: UpstreamSpec;
}

export interface ServiceDefinition {
  id: string;
  displayName?: string;
  routes: RouteDefinition[];
}

export interface FixtureData {
  schemaVersion?: number;
  services: ServiceDefinition[];
}

export interface RouteChange extends ConfigPatch {
  serviceId: string;
  routeId: string;
}

export interface Candidate {
  releaseId: string;
  coordinatorAcceptedAt: string;
  acceptedOrder: number;
  value: number;
}

export type ServiceReleaseStatus = 'active' | 'revoked';

/** The first successful accept response, retained so a legal resend (same
 * payload under a different idempotency key) can still return the first result. */
export interface StoredServiceResponse {
  statusCode: number;
  body: unknown;
  completedAt: string;
}

export interface ServiceReleaseRecord {
  releaseId: string;
  coordinatorAcceptedAt: string;
  acceptedOrder: number;
  status: ServiceReleaseStatus;
  changes: RouteChange[];
  serviceAcceptedAt: string;
  serviceRevokedAt?: string;
  /** Canonical hash of the coordinator payload that created this record. */
  payloadHash?: string;
  /** First successful accept response, replayed for legal resends. */
  acceptResponse?: StoredServiceResponse;
  /** Last time an operator repair rewrote this release's contributions. */
  repairedAt?: string;
}

export interface StoredHttpRequest {
  idempotencyKey: string;
  statusCode: number;
  responseJson: unknown;
  completedAt: string;
  payloadHash?: string;
  releaseId?: string;
}

export interface ReleaseConsistencyIssue {
  routeId: string;
  configKey: ConfigKey;
}

export interface ReleaseConsistencyMismatch extends ReleaseConsistencyIssue {
  expected: number;
  actual: number;
}

export interface ServiceReleaseConsistency {
  releaseId: string;
  status: 'absent' | ServiceReleaseStatus;
  consistent: boolean;
  extraCandidates: ReleaseConsistencyIssue[];
  duplicateCandidates: Array<ReleaseConsistencyIssue & { count: number }>;
  missingCandidates: ReleaseConsistencyIssue[];
  mismatchedCandidates: ReleaseConsistencyMismatch[];
  staleEffective: ReleaseConsistencyMismatch[];
}

export interface RouteState {
  initial: RouteConfig;
  effective: RouteConfig;
}

export interface ServicePersistentState {
  version: 1;
  serviceId: string;
  routes: Record<string, RouteState>;
  candidates: Record<string, Partial<Record<ConfigKey, Candidate[]>>>;
  releases: Record<string, ServiceReleaseRecord>;
  processedRequests: Record<string, StoredHttpRequest>;
}

export type ReleaseStatus =
  | 'running'
  | 'pausing'
  | 'paused'
  | 'completed'
  | 'revoking'
  | 'revoked';

export type DispatchStatus = 'pending' | 'dispatched' | 'accepted';
export type RevokeDispatchStatus = 'pending' | 'dispatched' | 'revoked';

export interface ServiceDispatchState {
  serviceId: string;
  batchIndex: number;
  status: DispatchStatus;
  idempotencyKey: string;
  attempts: number;
  lastError?: string;
  requestBytes?: number;
  lastAttemptAt?: string;
  serviceAcceptedAt?: string;
  coordinatorConfirmedAt?: string;
}

export interface RevokeDispatchState {
  serviceId: string;
  batchIndex: number;
  status: RevokeDispatchStatus;
  idempotencyKey: string;
  attempts: number;
  lastError?: string;
  lastAttemptAt?: string;
  serviceRevokedAt?: string;
  coordinatorConfirmedAt?: string;
}

export interface ReleaseEvent {
  at: string;
  type: string;
  message: string;
}

export interface RevocationState {
  status: 'running' | 'completed';
  currentBatchIndex: number;
  startedAt: string;
  completedAt?: string;
  services: Record<string, RevokeDispatchState>;
}

/** Outcome of an operator-triggered repair for a single service. */
export interface RepairServiceState {
  serviceId: string;
  /** The release status the service was asked to assume. */
  targetStatus: 'active' | 'revoked';
  status: 'repaired' | 'failed';
  attempts: number;
  lastAttemptAt: string;
  /** True when the receipt was lost and success was read back from the service. */
  confirmedViaState?: boolean;
  lastError?: string;
  coordinatorConfirmedAt?: string;
}

export interface RepairState {
  startedAt: string;
  completedAt?: string;
  services: Record<string, RepairServiceState>;
}

export interface RepairResponseBody {
  ok: boolean;
  serviceId: string;
  releaseId: string;
  targetStatus: 'active' | 'revoked';
  status: 'absent' | ServiceReleaseStatus;
  repaired: boolean;
  consistent: boolean;
  issues: string[];
  effective: Record<string, RouteConfig>;
}

export interface ReleaseRecord {
  id: string;
  status: ReleaseStatus;
  coordinatorAcceptedAt: string;
  acceptedOrder: number;
  targetServiceIds: string[];
  changes: RouteChange[];
  batches: string[][];
  currentBatchIndex: number;
  pauseRequested: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  revokedAt?: string;
  services: Record<string, ServiceDispatchState>;
  revocation?: RevocationState;
  repair?: RepairState;
  events: ReleaseEvent[];
}

export interface CoordinatorPersistentState {
  version: 1;
  acceptedOrder: number;
  releases: Record<string, ReleaseRecord>;
}

export interface ServiceEndpoint {
  id: string;
  /** URL used by the coordinator: usually the chaos proxy in the local fixture. */
  baseUrl: string;
  /** Direct URL used for observation and process-level checks. */
  directUrl?: string;
}

export interface ClusterConfig {
  coordinatorPort?: number;
  controlPort?: number;
  dataDir: string;
  fixturePath: string;
  requestTimeoutMs?: number;
  reconcileIntervalMs?: number;
  services: ServiceEndpoint[];
}
