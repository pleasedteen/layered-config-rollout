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

export interface ServiceReleaseRecord {
  releaseId: string;
  coordinatorAcceptedAt: string;
  acceptedOrder: number;
  status: ServiceReleaseStatus;
  changes: RouteChange[];
  serviceAcceptedAt: string;
  serviceRevokedAt?: string;
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

/**
 * Identifies where an effective config value came from at a point in the
 * timeline: either the service's own route initial value, or an accepted
 * release candidate.
 */
export type ConfigValueSource =
  | { type: 'initial' }
  | {
      type: 'release';
      releaseId: string;
      acceptedOrder: number;
      coordinatorAcceptedAt: string;
    };

export interface TimelineValuePoint {
  value: number;
  source: ConfigValueSource;
}

/**
 * One configuration item inside an atomic effective switch. An item is
 * recorded whenever its value OR its winning source changed, so an
 * equal-value source hand-off (e.g. overlapping same-value releases) is
 * still visible.
 */
export interface TimelineChange {
  routeId: string;
  configKey: ConfigKey;
  before: TimelineValuePoint;
  after: TimelineValuePoint;
  valueChanged: boolean;
  sourceChanged: boolean;
}

/**
 * One atomic effective switch on a service. A single accept/revoke that
 * touches many routes/config keys materializes exactly one such record.
 * `seq` is service-local, contiguous and follows the actual effective
 * commit order.
 */
export interface EffectiveSwitchRecord {
  seq: number;
  id: string;
  serviceId: string;
  /** Service-local time at which the switch was atomically committed. */
  at: string;
  action: 'accept' | 'revoke';
  releaseId: string;
  coordinatorAcceptedOrder?: number;
  coordinatorAcceptedAt?: string;
  changes: TimelineChange[];
}

export interface ServiceTimelinePage {
  serviceId: string;
  /** Contiguous head sequence currently persisted by the service. */
  headSeq: number;
  afterSeq: number;
  limit: number;
  /** Cursor to pass as the next `afterSeq` (last returned seq). */
  nextSeq: number;
  records: EffectiveSwitchRecord[];
}

export interface ServicePersistentState {
  version: 1;
  serviceId: string;
  routes: Record<string, RouteState>;
  candidates: Record<string, Partial<Record<ConfigKey, Candidate[]>>>;
  releases: Record<string, ServiceReleaseRecord>;
  processedRequests: Record<string, StoredHttpRequest>;
  /** Monotonic contiguous sequence for effective switches. */
  switchSeq: number;
  /** Append-only effective switch journal, ascending by seq. */
  switchLog: EffectiveSwitchRecord[];
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
  events: ReleaseEvent[];
}

export interface CoordinatorPersistentState {
  version: 1;
  acceptedOrder: number;
  releases: Record<string, ReleaseRecord>;
  /** Collected effective-switch records per service, ascending by seq. */
  timelines: Record<string, EffectiveSwitchRecord[]>;
  /** Durable segmented-backfill progress per service. */
  timelineSync: Record<string, TimelineSyncState>;
}

export interface TimelineSegmentStat {
  at: string;
  afterSeq: number;
  limit: number;
  returned: number;
  nextSeq: number;
}

export interface TimelineSyncState {
  serviceId: string;
  /** Durable contiguous high-water mark; every seq <= lastSeq is collected. */
  lastSeq: number;
  /** Last headSeq advertised by the service. */
  remoteHeadSeq?: number;
  caughtUp: boolean;
  segmentSize: number;
  /** Cumulative successful segment fetches. */
  segmentFetchCount: number;
  /** Last few fetched segments (newest last). */
  recentSegments: TimelineSegmentStat[];
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}

export interface TimelineSyncReport {
  ok: boolean;
  serviceId: string;
  startedSeq: number;
  lastSeq: number;
  remoteHeadSeq?: number;
  caughtUp: boolean;
  /** Records collected by this specific sync call. */
  fetchedCount: number;
  segments: TimelineSegmentStat[];
  /** True when maxSegments stopped the call before catching up. */
  truncated: boolean;
  error?: string;
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
  /** Max records requested per timeline backfill segment. */
  timelineSegmentSize?: number;
  /** Periodic timeline sync interval in ms; 0 disables the timer. */
  timelineSyncIntervalMs?: number;
  services: ServiceEndpoint[];
}
