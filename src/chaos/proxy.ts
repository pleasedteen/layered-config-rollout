import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { sendJson, readJsonBody } from '../shared/http.js';

export interface ChaosMatch {
  method?: string;
  pathIncludes?: string;
  /** Exact value of the `chunk` query parameter, for chunked accept requests. */
  chunkIndex?: number;
}

export interface ChaosPolicy {
  dropRequest?: boolean;
  delayRequestMs?: number;
  dropResponse?: boolean;
  delayResponseMs?: number;
}

export interface ChaosRule extends ChaosPolicy {
  id: string;
  match?: ChaosMatch;
  times?: number;
  remaining?: number;
}

export interface ChaosRequestRecord {
  id: string;
  at: string;
  method: string;
  path: string;
  idempotencyKey?: string;
  requestBytes: number;
  requestBodyPreview?: string;
  routeIds: string[];
  outcome: 'forwarded' | 'request-dropped' | 'response-dropped' | 'target-error';
  targetStatus?: number;
  durationMs: number;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ChaosProxy {
  readonly server: http.Server;
  rules: ChaosRule[] = [];
  globalPolicy: ChaosPolicy = {};
  requests: ChaosRequestRecord[] = [];

  constructor(
    public readonly serviceId: string,
    public readonly targetBaseUrl: string,
  ) {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        else res.destroy();
      });
    });
  }

  async start(port: number): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind chaos proxy');
    return address.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.rules = [];
    this.globalPolicy = {};
    this.requests = [];
  }

  addRule(rule: Omit<ChaosRule, 'id' | 'remaining'> & { id?: string }): ChaosRule {
    const created: ChaosRule = {
      ...rule,
      id: rule.id ?? randomUUID(),
      remaining: rule.times,
    };
    this.rules.push(created);
    return created;
  }

  private record(record: ChaosRequestRecord): void {
    this.requests.push(record);
    if (this.requests.length > 500) this.requests.shift();
  }

  private selectPolicy(method: string, path: string, chunkIndex: number | undefined): ChaosPolicy {
    const policy: ChaosPolicy = {};
    for (const rule of this.rules) {
      if (rule.match?.method && rule.match.method.toUpperCase() !== method.toUpperCase()) continue;
      if (rule.match?.pathIncludes && !path.includes(rule.match.pathIncludes)) continue;
      if (rule.match?.chunkIndex !== undefined && rule.match.chunkIndex !== chunkIndex) continue;
      if (rule.remaining !== undefined) {
        if (rule.remaining <= 0) continue;
        rule.remaining -= 1;
      }
      if (rule.dropRequest) policy.dropRequest = true;
      if (rule.dropResponse) policy.dropResponse = true;
      if (rule.delayRequestMs) policy.delayRequestMs = Math.max(policy.delayRequestMs ?? 0, rule.delayRequestMs);
      if (rule.delayResponseMs) policy.delayResponseMs = Math.max(policy.delayResponseMs ?? 0, rule.delayResponseMs);
    }
    if (this.globalPolicy.dropRequest) policy.dropRequest = true;
    if (this.globalPolicy.dropResponse) policy.dropResponse = true;
    if (this.globalPolicy.delayRequestMs) {
      policy.delayRequestMs = Math.max(policy.delayRequestMs ?? 0, this.globalPolicy.delayRequestMs);
    }
    if (this.globalPolicy.delayResponseMs) {
      policy.delayResponseMs = Math.max(policy.delayResponseMs ?? 0, this.globalPolicy.delayResponseMs);
    }
    return policy;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://chaos.local');

    if (req.method === 'GET' && url.pathname === '/__chaos') {
      sendJson(res, 200, {
        ok: true,
        serviceId: this.serviceId,
        targetBaseUrl: this.targetBaseUrl,
        globalPolicy: this.globalPolicy,
        rules: this.rules,
        requests: this.requests,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__chaos/global') {
      this.globalPolicy = (await readJsonBody(req)) as ChaosPolicy;
      sendJson(res, 200, { ok: true, globalPolicy: this.globalPolicy });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__chaos/rules') {
      const body = (await readJsonBody(req)) as Omit<ChaosRule, 'id'> & { id?: string };
      const rule = this.addRule(body);
      sendJson(res, 201, { ok: true, rule });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__chaos/reset') {
      this.reset();
      sendJson(res, 200, { ok: true });
      return;
    }

    const chunks: Buffer[] = [];
    let requestBytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buffer);
      requestBytes += buffer.length;
    }
    const bodyBuffer = Buffer.concat(chunks);
    const idempotencyKeyHeader = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(idempotencyKeyHeader)
      ? idempotencyKeyHeader[0]
      : idempotencyKeyHeader;

    let routeIds: string[] = [];
    try {
      const parsed = JSON.parse(bodyBuffer.toString('utf8') || '{}');
      if (Array.isArray(parsed.changes)) {
        routeIds = parsed.changes.map((change: any) => String(change?.routeId ?? '')).filter(Boolean);
      }
    } catch {
      // Non-JSON request; routeIds remains empty.
    }

    const chunkParam = url.searchParams.get('chunk');
    const chunkIndex = chunkParam !== null && chunkParam !== '' ? Number(chunkParam) : undefined;
    const policy = this.selectPolicy(req.method ?? 'GET', url.pathname, Number.isNaN(chunkIndex) ? undefined : chunkIndex);
    const baseRecord: ChaosRequestRecord = {
      id: randomUUID(),
      at: new Date().toISOString(),
      method: req.method ?? 'GET',
      path: url.pathname + url.search,
      idempotencyKey,
      requestBytes,
      requestBodyPreview: bodyBuffer.toString('utf8').slice(0, 4000),
      routeIds,
      outcome: 'forwarded',
      durationMs: 0,
    };

    if (policy.delayRequestMs) await sleep(policy.delayRequestMs);

    if (policy.dropRequest) {
      baseRecord.outcome = 'request-dropped';
      baseRecord.durationMs = Date.now() - started;
      this.record(baseRecord);
      req.socket.destroy();
      res.destroy();
      return;
    }

    try {
      const targetUrl = `${this.targetBaseUrl}${url.pathname}${url.search}`;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (key.toLowerCase() === 'host' || key.toLowerCase() === 'content-length') continue;
        if (Array.isArray(value)) value.forEach((item) => headers.append(key, item));
        else headers.set(key, value);
      }

      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: bodyBuffer.length > 0 ? bodyBuffer : undefined,
      });
      const responseBuffer = Buffer.from(await upstream.arrayBuffer());

      if (policy.delayResponseMs) await sleep(policy.delayResponseMs);

      if (policy.dropResponse) {
        baseRecord.outcome = 'response-dropped';
        baseRecord.targetStatus = upstream.status;
        baseRecord.durationMs = Date.now() - started;
        this.record(baseRecord);
        res.socket?.destroy();
        return;
      }

      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (lower === 'content-encoding' || lower === 'transfer-encoding' || lower === 'content-length') return;
        responseHeaders[key] = value;
      });
      responseHeaders['content-length'] = String(responseBuffer.length);
      res.writeHead(upstream.status, responseHeaders);
      res.end(responseBuffer);

      baseRecord.targetStatus = upstream.status;
      baseRecord.durationMs = Date.now() - started;
      this.record(baseRecord);
    } catch (error) {
      baseRecord.outcome = 'target-error';
      baseRecord.error = (error as Error).message;
      baseRecord.durationMs = Date.now() - started;
      this.record(baseRecord);
      if (!res.headersSent) {
        sendJson(res, 502, { ok: false, error: 'chaos proxy target error', detail: (error as Error).message });
      } else {
        res.destroy();
      }
    }
  }
}
