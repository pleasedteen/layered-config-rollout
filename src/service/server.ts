import http from 'node:http';
import { sendJson, readJsonBody } from '../shared/http.js';
import type { ConfigService } from './config-service.js';

interface RateWindow {
  count: number;
  resetAt: number;
}

export function createForwardServiceServer(service: ConfigService): http.Server {
  const rateWindows = new Map<string, RateWindow>();

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

        if (req.method === 'GET' && segments[1] === 'releases' && segments[2] && segments[3] === 'consistency') {
          const releaseId = decodeURIComponent(segments[2]);
          const consistency = service.getConsistency(releaseId);
          const routes: Record<string, unknown> = {};
          const state = service.snapshot();
          for (const routeId of new Set([
            ...consistency.extraCandidates.map((item) => item.routeId),
            ...consistency.missingCandidates.map((item) => item.routeId),
            ...consistency.mismatchedCandidates.map((item) => item.routeId),
            ...consistency.duplicateCandidates.map((item) => item.routeId),
            ...consistency.staleEffective.map((item) => item.routeId),
            ...(state.releases[releaseId]?.changes.map((change) => change.routeId) ?? []),
          ])) {
            const route = state.routes[routeId];
            if (!route) continue;
            routes[routeId] = {
              initial: route.initial,
              effective: route.effective,
              candidates: state.candidates[routeId] ?? {},
            };
          }
          sendJson(res, 200, {
            ok: true,
            serviceId: service.definition.id,
            releaseId,
            status: consistency.status,
            record: service.getRelease(releaseId),
            consistency,
            routes,
          });
          return;
        }

        if (req.method === 'GET' && segments[1] === 'releases' && segments[2]) {
          const releaseId = decodeURIComponent(segments[2]);
          const release = service.getRelease(releaseId);
          if (!release) {
            sendJson(res, 404, { ok: false, releaseId, status: 'absent' });
            return;
          }
          sendJson(res, 200, release);
          return;
        }

        if (req.method === 'GET' && segments[1] === 'state') {
          sendJson(res, 200, service.snapshot());
          return;
        }

        if (req.method === 'POST' && segments[1] === 'releases' && segments[2] && segments[3] === 'accept') {
          const releaseId = decodeURIComponent(segments[2]);
          const body = await readJsonBody(req);
          const key = req.headers['idempotency-key'];
          const result = await service.acceptRelease(
            releaseId,
            body,
            Array.isArray(key) ? key[0] : key,
          );
          if (result.replayed) res.setHeader('x-idempotent-replay', 'true');
          sendJson(res, result.statusCode, result.body);
          return;
        }

        if (req.method === 'POST' && segments[1] === 'releases' && segments[2] && segments[3] === 'revoke') {
          const releaseId = decodeURIComponent(segments[2]);
          // Drain even if body is unused so the request completes cleanly.
          await readJsonBody(req).catch(() => ({}));
          const key = req.headers['idempotency-key'];
          const result = await service.revokeRelease(
            releaseId,
            Array.isArray(key) ? key[0] : key,
          );
          if (result.replayed) res.setHeader('x-idempotent-replay', 'true');
          sendJson(res, result.statusCode, result.body);
          return;
        }

        if (req.method === 'POST' && segments[1] === 'releases' && segments[2] && segments[3] === 'repair') {
          const releaseId = decodeURIComponent(segments[2]);
          const body = await readJsonBody(req);
          const result = await service.repairRelease(releaseId, body);
          sendJson(res, result.statusCode, result.body);
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
