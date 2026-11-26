import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Mutual authentication primitives for the release channel.
 *
 * Direction 1 (request): the coordinator signs every accept/revoke/query
 * request with the per-service *request* credential. The service verifies the
 * signature, the sender identity and that the signed target service is itself.
 *
 * Direction 2 (receipt/query result): the service signs every accepted
 * response / query result with its independent *receipt* credential. The
 * coordinator only confirms a state transition when the signature is trusted
 * for the target service and the signed nonce/method/path/status match the
 * exact request currently being acknowledged.
 *
 * Credentials are opaque symmetric keys identified by a non-secret keyId.
 * Rotation replaces the single active credential; once replaced, any request
 * or receipt still carrying the old keyId is rejected.
 */

export const AUTH_ALG = 'v1';
export const RECEIPT_ALG = 'v1-receipt';
export const DEFAULT_COORDINATOR_ID = 'coordinator';
/** Signed timestamps older/newer than this are rejected. */
export const SIGNATURE_FRESHNESS_MS = 5 * 60_000;

export interface Credential {
  keyId: string;
  secret: string;
  createdAt: string;
}

export type CredentialKind = 'request' | 'receipt';
export type RotateWhich = CredentialKind | 'both';

export function generateCredential(kind: CredentialKind, serviceId: string): Credential {
  const prefix = kind === 'request' ? 'req' : 'rcp';
  return {
    keyId: `${prefix}-${serviceId}-${randomBytes(6).toString('hex')}`,
    secret: randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
  };
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacHex(secret: string, base: string): string {
  return createHmac('sha256', secret).update(base, 'utf8').digest('hex');
}

function safeEqualText(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function getHeaderCI(headers: Record<string, unknown> | undefined | null, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (Array.isArray(value)) {
      const first = value[0];
      return first === undefined ? undefined : String(first);
    }
    if (value === undefined || value === null) return undefined;
    return String(value);
  }
  return undefined;
}

export interface SignRequestInput {
  credential: Credential;
  senderId: string;
  targetServiceId: string;
  method: string;
  pathname: string;
  body: Buffer | string;
  timestamp?: number;
  nonce?: string;
  idempotencyKey?: string;
}

export interface SignedRequestHeaders {
  'x-ca-sender': string;
  'x-ca-target': string;
  'x-ca-key-id': string;
  'x-ca-ts': string;
  'x-ca-nonce': string;
  'x-ca-signature': string;
}

export function requestSignatureBase(input: {
  method: string;
  pathname: string;
  senderId: string;
  targetServiceId: string;
  keyId: string;
  timestamp: string;
  nonce: string;
  idempotencyKey: string;
  body: Buffer | string;
}): string {
  return [
    AUTH_ALG,
    input.method.toUpperCase(),
    input.pathname,
    input.senderId,
    input.targetServiceId,
    input.keyId,
    input.timestamp,
    input.nonce,
    input.idempotencyKey,
    sha256Hex(input.body),
  ].join('\n');
}

/**
 * Signs a coordinator -> service request. The returned record contains only
 * the `x-ca-*` material; callers still set content-type and the same
 * idempotency-key value passed here.
 */
export function signRequestHeaders(input: SignRequestInput): SignedRequestHeaders {
  const timestamp = String(input.timestamp ?? Date.now());
  const nonce = input.nonce ?? randomUUID();
  const idempotencyKey = input.idempotencyKey ?? '';
  const base = requestSignatureBase({
    method: input.method,
    pathname: input.pathname,
    senderId: input.senderId,
    targetServiceId: input.targetServiceId,
    keyId: input.credential.keyId,
    timestamp,
    nonce,
    idempotencyKey,
    body: input.body,
  });
  return {
    'x-ca-sender': input.senderId,
    'x-ca-target': input.targetServiceId,
    'x-ca-key-id': input.credential.keyId,
    'x-ca-ts': timestamp,
    'x-ca-nonce': nonce,
    'x-ca-signature': `${AUTH_ALG}=${hmacHex(input.credential.secret, base)}`,
  };
}

export type RequestVerification =
  | {
      ok: true;
      senderId: string;
      targetServiceId: string;
      nonce: string;
      keyId: string;
      idempotencyKey: string;
    }
  | { ok: false; statusCode: 401 | 403; error: string };

export interface VerifyRequestInput {
  headers: Record<string, unknown>;
  rawBody: Buffer;
  method: string;
  pathname: string;
  expectedServiceId: string;
  coordinatorId: string;
  credential: Credential;
  now?: number;
}

/**
 * Verifies an incoming request. Authentication (who sent it + integrity) is
 * distinguished from target authorization (signed target === this service).
 */
export function verifySignedRequest(input: VerifyRequestInput): RequestVerification {
  const fail = (statusCode: 401 | 403, error: string): RequestVerification => ({ ok: false, statusCode, error });
  const h = input.headers;

  const senderId = getHeaderCI(h, 'x-ca-sender');
  const targetServiceId = getHeaderCI(h, 'x-ca-target');
  const keyId = getHeaderCI(h, 'x-ca-key-id');
  const timestamp = getHeaderCI(h, 'x-ca-ts');
  const nonce = getHeaderCI(h, 'x-ca-nonce');
  const signature = getHeaderCI(h, 'x-ca-signature');
  const idempotencyKey = getHeaderCI(h, 'idempotency-key') ?? '';

  if (!senderId || !targetServiceId || !keyId || !timestamp || !nonce || !signature) {
    return fail(401, 'missing mutual-auth request headers');
  }
  if (!signature.startsWith(`${AUTH_ALG}=`)) {
    return fail(401, 'unsupported request signature version');
  }
  if (keyId !== input.credential.keyId) {
    return fail(401, `request credential ${keyId} is not active for service ${input.expectedServiceId}`);
  }
  const ts = Number(timestamp);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNATURE_FRESHNESS_MS) {
    return fail(401, 'request signature timestamp is outside the freshness window');
  }

  const base = requestSignatureBase({
    method: input.method,
    pathname: input.pathname,
    senderId,
    targetServiceId,
    keyId,
    timestamp,
    nonce,
    idempotencyKey,
    body: input.rawBody,
  });
  const expectedSignature = `${AUTH_ALG}=${hmacHex(input.credential.secret, base)}`;
  if (!safeEqualText(signature, expectedSignature)) {
    return fail(401, 'request signature does not match the active credential');
  }

  if (senderId !== input.coordinatorId) {
    return fail(401, `untrusted request sender: ${senderId}`);
  }
  if (targetServiceId !== input.expectedServiceId) {
    return fail(
      403,
      `request targets ${targetServiceId}, but this service is ${input.expectedServiceId}; refusing misdelivered write`,
    );
  }

  return { ok: true, senderId, targetServiceId, nonce, keyId, idempotencyKey };
}

export function hasRequestAuthHeaders(headers: Record<string, unknown>): boolean {
  return Boolean(getHeaderCI(headers, 'x-ca-signature') || getHeaderCI(headers, 'x-ca-key-id'));
}

export interface SignReceiptInput {
  credential: Credential;
  serviceId: string;
  nonce: string;
  method: string;
  pathname: string;
  statusCode: number;
  body: Buffer | string;
  timestamp?: number;
}

export function receiptSignatureBase(input: {
  serviceId: string;
  keyId: string;
  timestamp: string;
  nonce: string;
  method: string;
  pathname: string;
  statusCode: number;
  body: Buffer | string;
}): string {
  return [
    RECEIPT_ALG,
    input.serviceId,
    input.keyId,
    input.timestamp,
    input.nonce,
    input.method.toUpperCase(),
    input.pathname,
    String(input.statusCode),
    sha256Hex(input.body),
  ].join('\n');
}

/** Signs a service -> coordinator receipt/query result. */
export function signReceiptHeaders(input: SignReceiptInput): Record<string, string> {
  const timestamp = String(input.timestamp ?? Date.now());
  const base = receiptSignatureBase({
    serviceId: input.serviceId,
    keyId: input.credential.keyId,
    timestamp,
    nonce: input.nonce,
    method: input.method,
    pathname: input.pathname,
    statusCode: input.statusCode,
    body: input.body,
  });
  return {
    'x-rc-service': input.serviceId,
    'x-rc-key-id': input.credential.keyId,
    'x-rc-ts': timestamp,
    'x-rc-nonce': input.nonce,
    'x-rc-signature': `${AUTH_ALG}=${hmacHex(input.credential.secret, base)}`,
  };
}

export interface VerifyReceiptInput {
  headers: Record<string, unknown>;
  rawBody: Buffer | string;
  statusCode: number;
  credential: Credential;
  expected: {
    serviceId: string;
    nonce: string;
    method: string;
    pathname: string;
  };
  now?: number;
}

export type ReceiptVerification = { ok: true } | { ok: false; error: string };

/**
 * Verifies a receipt/query result. The receipt must be produced with the
 * target service's active receipt credential and must bind the exact request
 * nonce, method and path (which contains release id and action) plus the
 * observed HTTP status and body.
 */
export function verifyReceiptSignature(input: VerifyReceiptInput): ReceiptVerification {
  const h = input.headers;
  const serviceId = getHeaderCI(h, 'x-rc-service');
  const keyId = getHeaderCI(h, 'x-rc-key-id');
  const timestamp = getHeaderCI(h, 'x-rc-ts');
  const nonce = getHeaderCI(h, 'x-rc-nonce');
  const signature = getHeaderCI(h, 'x-rc-signature');

  if (!serviceId || !keyId || !timestamp || !nonce || !signature) {
    return { ok: false, error: 'receipt is missing authentication headers' };
  }
  if (!signature.startsWith(`${AUTH_ALG}=`)) {
    return { ok: false, error: 'unsupported receipt signature version' };
  }
  if (keyId !== input.credential.keyId) {
    return { ok: false, error: `receipt credential ${keyId} is not active for ${input.expected.serviceId}` };
  }
  if (serviceId !== input.expected.serviceId) {
    return { ok: false, error: `receipt from ${serviceId} does not match target service ${input.expected.serviceId}` };
  }
  if (nonce !== input.expected.nonce) {
    return { ok: false, error: 'receipt nonce does not match the current request' };
  }
  const ts = Number(timestamp);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNATURE_FRESHNESS_MS) {
    return { ok: false, error: 'receipt timestamp is outside the freshness window' };
  }

  const base = receiptSignatureBase({
    serviceId,
    keyId,
    timestamp,
    nonce,
    method: input.expected.method,
    pathname: input.expected.pathname,
    statusCode: input.statusCode,
    body: input.rawBody,
  });
  const expectedSignature = `${AUTH_ALG}=${hmacHex(input.credential.secret, base)}`;
  if (!safeEqualText(signature, expectedSignature)) {
    return { ok: false, error: 'receipt signature does not match the active credential' };
  }
  return { ok: true };
}
