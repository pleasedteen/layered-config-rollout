import http from 'node:http';
import { sendJson, readRawBody } from '../shared/http.js';
import {
  hasRequestAuthHeaders,
  signReceiptHeaders,
  verifySignedRequest,
} from '../shared/auth.js';
import type { AuthProvider } from '../shared/credentials.js';
import type { ConfigService } from './config-service.js';

interface RateWindow {
  count: number;
  resetAt: number;
}

export function createForwardServiceServer(service: ConfigService, auth?: AuthProvider): http.Server {
  const rateWindows = new Map<string, RateWindow>();

  /**
   * Serializes a release-channel response and signs it with this service's
   * active receipt credential, binding the nonce from the request it answers.
   */
  async function sendSignedReleaseJson(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    statusCode: number,
    body: unknown,
    context: { nonce?: string; replay?: boolean } = {},
  ): Promise<void> {
    const json = JSON.stringify(body);
    const buffer = Buffer.from(json, 'utf8');
    const headers: Record<string, string | number> = {
      'content-type': 'application/json; charset=utf-8',
      'content-length': buffer.length,
      'cache-control': 'no-store',
    };
    if (context.replay) headers['x-idempotent-replay'] = 'true';
    if (auth && context.nonce) {
      const credential = await auth.receiptCredential(service.definition.id);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const receiptHeaders = signReceiptHeaders({
        credential,
        serviceId: service.definition.id,
        nonce: context.nonce,
        method: req.method ?? 'GET',
        pathname: url.pathname,
        statusCode,
        body: buffer,
      });
      Object.assign(headers, receiptHeaders);
    }
    res.writeHead(statusCode, headers);
    res.end(buffer);
  }

  /**
   * Verifies a release-channel request when auth is configured.
   * Writes are always rejected without valid auth; read queries may remain
   * anonymously observable but are only signed/trusted when authenticated.
   */
  async function authenticateIfPresent(
    req: http.IncomingMessage,
    method: string,
    pathname: string,
    rawBody: Buffer,
    options: { requireAuth: boolean },
  ): Promise<{ nonce?: string } | { rejected: { statusCode: number; body: unknown } }> {
    if (!auth) return {};
    const present = hasRequestAuthHeaders(req.headers as Record<string, unknown>);
    if (!present && !options.requireAuth) return {};
    if (!present && options.requireAuth) {
      return {
        rejected: {
          statusCode: 401,
          body: { ok: false, error: 'mutual authentication required for publish/revoke requests', code: 'auth-required' },
        },
      };
    }
    const credential = await auth.requestCredential(service.definition.id);
    const result = verifySignedRequest({
      headers: req.headers as Record<string, unknown>,
      rawBody,
      method,
      pathname,
      expectedServiceId: service.definition.id,
      coordinatorId: auth.coordinatorId,
      credential,
    });
    if (!result.ok) {
      return { rejected: { statusCode: result.statusCode, body: { ok: false, error: result.error, code: 'auth-rejected' } } };
    }
    return { nonce: result.nonce };
  }

  function resetRateLimits(): void {
    rateWindows.clear();
  }

  function checkRateLimit(routeId: string, limitPerMinute: number): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const now = Date.now();
    const window = rateWindows.get(routeId);
    if (!window || now >= window.resetAt) {
      rateWindows.set(routeId, { count: 1, resetAt: now + 60_000 });
      return { allowed: limitPerMinute >= 1, remaining: Math.max(0, limitPerMinute - 1), retryAfterMs: 60_000 };
    }

    const retryAfterMs = Math.max(0, window.resetAt - now);
    if (window.count >= limitPerMinute) {
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    window.count += 1;
    return { allowed: true, remaining: Math.max(0, limitPerMinute - window.count), retryAfterMs };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const segments = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, serviceId: service.definition.id, pid: process.pid });
        return;
      }

      if (segments[0] === '__admin') {
        // GET /__admin/config/:routeId?
        if (req.method === 'GET' && segments[1] === 'config') {
          if (segments[2]) {
            const routeId = decodeURIComponent(segments[2]);
            try {
              sendJson(res, 200, {
                serviceId: service.definition.id,
                routeId,
                effective: service.getRouteConfig(routeId),
              });
            } catch (error) {
              sendJson(res, 404, { ok: false, error: (error as Error).message });
            }
            return;
          }
          sendJson(res, 200, {
            serviceId: service.definition.id,
            configs: service.getAllEffectiveConfigs(),
          });
          return;
        }

        if (req.method === 'GET' && segments[1] === 'releases' && segments[2]) {
          const releaseId = decodeURIComponent(segments[2]);
          const pathname = url.pathname;
          // Reconciliation queries are part of the mutually-authenticated
          // release channel: an unsigned/forged query is rejected rather than
          // answered. Read-only observation remains available via /__admin/state
          // and /__admin/config*.
          const authResult = await authenticateIfPresent(req, 'GET', pathname, Buffer.alloc(0), {
            requireAuth: true,
          });
          if ('rejected' in authResult) {
            sendJson(res, authResult.rejected.statusCode, authResult.rejected.body);
            return;
          }
          const release = service.getRelease(releaseId);
          if (!release) {
            const payload = { ok: false, releaseId, status: 'absent' as const };
            if (authResult.nonce) {
              await sendSignedReleaseJson(req, res, 404, payload, { nonce: authResult.nonce });
            } else {
              sendJson(res, 404, payload);
            }
            return;
          }
          if (authResult.nonce) {
            await sendSignedReleaseJson(req, res, 200, release, { nonce: authResult.nonce });
          } else {
            sendJson(res, 200, release);
          }
          return;
        }

        if (req.method === 'GET' && segments[1] === 'state') {
          sendJson(res, 200, service.snapshot());
          return;
        }

        if (req.method === 'POST' && segments[1] === 'releases' && segments[2] && segments[3] === 'accept') {
          const releaseId = decodeURIComponent(segments[2]);
          const pathname = url.pathname;
          // Consume and verify the raw signed bytes BEFORE any state access so
          // invalid writes cannot touch config or release records.
          const rawBody = await readRawBody(req);
          const authResult = await authenticateIfPresent(req, 'POST', pathname, rawBody, {
            requireAuth: true,
          });
          if ('rejected' in authResult) {
            sendJson(res, authResult.rejected.statusCode, authResult.rejected.body);
            return;
          }
          let body: unknown;
          try {
            body = rawBody.length === 0 ? {} : JSON.parse(rawBody.toString('utf8'));
          } catch {
            sendJson(res, 400, { ok: false, error: 'request body must be valid JSON' });
            return;
          }
          const key = req.headers['idempotency-key'];
          const result = await service.acceptRelease(
            releaseId,
            body,
            Array.isArray(key) ? key[0] : key,
          );
          await sendSignedReleaseJson(req, res, result.statusCode, result.body, {
            nonce: authResult.nonce,
            replay: result.replayed,
          });
          return;
        }

        if (req.method === 'POST' && segments[1] === 'releases' && segments[2] && segments[3] === 'revoke') {
          const releaseId = decodeURIComponent(segments[2]);
          const pathname = url.pathname;
          const rawBody = await readRawBody(req).catch(() => Buffer.alloc(0));
          const authResult = await authenticateIfPresent(req, 'POST', pathname, rawBody, {
            requireAuth: true,
          });
          if ('rejected' in authResult) {
            sendJson(res, authResult.rejected.statusCode, authResult.rejected.body);
            return;
          }
          const key = req.headers['idempotency-key'];
          const result = await service.revokeRelease(
            releaseId,
            Array.isArray(key) ? key[0] : key,
          );
          await sendSignedReleaseJson(req, res, result.statusCode, result.body, {
            nonce: authResult.nonce,
            replay: result.replayed,
          });
          return;
        }

        if (req.method === 'POST' && segments[1] === 'reset-rate-limits') {
          resetRateLimits();
          sendJson(res, 200, { ok: true });
          return;
        }
      }

      // Mock backend endpoint. The proxy makes a real loopback HTTP request here.
      if (segments[0] === '__upstream' && req.method === 'GET') {
        const routeId = decodeURIComponent(segments[1] ?? '');
        const route = service.definition.routes.find((item) => item.id === routeId);
        if (!route) {
          sendJson(res, 404, { ok: false, error: 'unknown upstream route' });
          return;
        }
        const latencyMs = route.upstream?.latencyMs ?? 0;
        if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
        sendJson(res, route.upstream?.status ?? 200, {
          ok: true,
          routeId,
          servedBy: service.definition.id,
          pid: process.pid,
          body: route.upstream?.body ?? 'ok',
          at: new Date().toISOString(),
        });
        return;
      }

      // Simulated request-forwarding data plane: /proxy/:routeId/...
      if (segments[0] === 'proxy' && segments[1]) {
        const routeId = decodeURIComponent(segments[1]);
        const route = service.definition.routes.find((item) => item.id === routeId);
        if (!route) {
          sendJson(res, 404, { ok: false, error: `unknown route: ${routeId}` });
          return;
        }

        const effective = service.getRouteConfig(routeId);
        const rate = checkRateLimit(routeId, effective.rateLimitPerMinute);
        res.setHeader('x-ratelimit-limit', String(effective.rateLimitPerMinute));
        res.setHeader('x-ratelimit-remaining', String(rate.remaining));
        if (!rate.allowed) {
          res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
          sendJson(res, 429, { ok: false, error: 'rate limit exceeded', routeId, effective });
          return;
        }

        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const upstreamUrl = `http://127.0.0.1:${port}/__upstream/${encodeURIComponent(routeId)}`;
        try {
          const upstreamResponse = await fetch(upstreamUrl, {
            signal: AbortSignal.timeout(effective.timeoutMs),
          });
          const text = await upstreamResponse.text();
          res.writeHead(upstreamResponse.status, {
            'content-type': upstreamResponse.headers.get('content-type') ?? 'application/json',
            'x-route-id': routeId,
            'x-effective-timeout-ms': String(effective.timeoutMs),
          });
          res.end(text);
        } catch (error) {
          const message = (error as Error).message || 'forward failed';
          const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
          sendJson(res, isTimeout ? 504 : 502, {
            ok: false,
            error: isTimeout ? 'upstream timeout according to effective route config' : message,
            routeId,
            effective,
          });
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found', path: url.pathname });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: (error as Error).message });
    }
  });

  return server;
}
