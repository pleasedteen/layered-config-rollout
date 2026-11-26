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

/**
 * Deterministic byte-budget split of one release's changes for one service.
 * Persisted on the coordinator so retries and restarts reuse identical chunk
 * boundaries even if configuration changes between runs.
 */
export interface DispatchChunkPlan {
  total: number;
  /** Planned request-body byte length of each chunk. */
  bytes: number[];
  /** Inclusive start offset into the release's per-service change list. */
  starts: number[];
  /** Exclusive end offset into the release's per-service change list. */
  ends: number[];
}

/**
 * Chunked accept state held by a service until the whole group arrives.
 * Nothing is applied while `received` is missing any index.
 */
export interface PendingChunkAccept {
  releaseId: string;
  coordinatorAcceptedAt: string;
  acceptedOrder: number;
  chunkCount: number;
  changesByChunk: Record<string, RouteChange[]>;
  received: number[];
  firstReceivedAt: string;
  updatedAt: string;
}

export type ServiceReleaseStatus = 'active' | 'revoked';

export interface ServiceReleaseRecord {
  releaseId: string;
  coordinatorAcceptedAt: string;
  acceptedOrder: number;
  status: ServiceReleaseStatus;
  changes: RouteChange[];
  serviceAcceptedAt: string;
  serviceRevokedAt?: string;
  chunkCount?: number;
}

export interface StoredHttpRequest {
  idempotencyKey: string;
  statusCode: number;
  responseJson: unknown;
  completedAt: string;
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
  pendingChunks?: Record<string, PendingChunkAccept>;
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
  /** Largest single dispatch request body sent to this service so far. */
  requestBytes?: number;
  /** Deterministic chunking of this release's changes for this service. */
  chunkPlan: DispatchChunkPlan;
  /** Chunk indexes whose content the service has positively persisted. */
  chunksSent: number[];
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
  /** Configured cap for any single dispatch request body, in bytes. */
  dispatchMaxBytes: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  revokedAt?: string;
  services: Record<string, ServiceDispatchState>;
  revocation?: RevocationState;
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
  dispatchMaxBytes?: number;
  services: ServiceEndpoint[];
}
