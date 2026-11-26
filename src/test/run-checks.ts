import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { FixtureCluster } from '../fixture/cluster.js';
import { fetchJson } from '../shared/http.js';
import { delay } from '../shared/store.js';
import { ConfigService } from '../service/config-service.js';
import { Coordinator } from '../coordinator/coordinator.js';
import { InMemoryAuthProvider } from '../shared/credentials.js';
import {
  signReceiptHeaders,
  signRequestHeaders,
  verifyReceiptSignature,
} from '../shared/auth.js';
import type { Credential, SignedRequestHeaders } from '../shared/auth.js';
import type { FixtureData, RouteConfig, ServicePersistentState } from '../shared/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const FIXTURE_PATH = path.join(projectRoot, 'fixtures', 'demo.json');

interface Failure {
  name: string;
  error: unknown;
}

const failures: Failure[] = [];
let passed = 0;
let cluster: FixtureCluster | undefined;

const hardTimer = setTimeout(() => {
  console.error('\n❌ 自检超过 75 秒，强制结束。');
  if (cluster) {
    console.error('coordinator logs:\n', cluster.coordinatorLogs.slice(-40).join('\n'));
    for (const service of cluster.services.values()) {
      console.error(`service ${service.id} logs:\n`, service.logs.slice(-30).join('\n'));
    }
  }
  process.exit(2);
}, 75_000);
hardTimer.unref?.();

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  const started = Date.now();
  process.stdout.write(`\n▶ ${name}\n`);
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ 通过 (${Date.now() - started}ms)`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  ✗ 失败 (${Date.now() - started}ms)`);
    console.error(error instanceof Error ? `    ${error.stack ?? error.message}` : error);
  }
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 12_000,
  intervalMs = 70,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`等待条件超时: ${label}${lastError ? `; lastError=${String(lastError)}` : ''}`);
}

function cUrl(pathname: string): string {
  if (!cluster?.coordinatorUrl) throw new Error('coordinator is not running');
  return `${cluster.coordinatorUrl}${pathname}`;
}

async function cFetch(pathname: string, init?: Parameters<typeof fetchJson>[1]) {
  return fetchJson(cUrl(pathname), { timeoutMs: 5000, ...init });
}

async function createRelease(body: Record<string, unknown>): Promise<any> {
  const response = await cFetch('/api/releases', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  if (response.status !== 201) {
    throw new Error(`create release expected 201, got ${response.status}: ${response.text}`);
  }
  return response.body;
}

async function waitRelease(id: string, predicate: (release: any) => boolean, timeoutMs = 12_000): Promise<any> {
  return waitFor(
    `release ${id} condition`,
    async () => {
      const response = await cFetch(`/api/releases/${encodeURIComponent(id)}`);
      if (response.status !== 200) return null;
      return predicate(response.body) ? response.body : null;
    },
    timeoutMs,
  );
}

function serviceUrl(serviceId: string): string {
  return cluster!.getService(serviceId).directUrl;
}

async function directFetch(serviceId: string, pathname: string, init: Record<string, any> = {}) {
  // The release query endpoint requires the same mutual auth as writes, so
  // automatically sign any /__admin/releases request with the active key.
  if (pathname.startsWith('/__admin/releases/')) {
    const method = String(init.method ?? 'GET').toUpperCase();
    const body =
      typeof init.body === 'string' ? init.body : init.body === undefined || init.body === null ? '' : JSON.stringify(init.body);
    const incomingHeaders = (init.headers ?? {}) as Record<string, unknown>;
    const idemHeader = incomingHeaders['idempotency-key'];
    const idempotencyKey = Array.isArray(idemHeader) ? String(idemHeader[0] ?? '') : idemHeader === undefined ? undefined : String(idemHeader);
    const signature = await caHeaders(serviceId, {
      pathname: pathname.split('?')[0]!,
      method,
      body,
      idempotencyKey,
    });
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(incomingHeaders)) {
      if (typeof value === 'string') headers[key] = value;
    }
    Object.assign(headers, signature);
    return fetchJson(`${serviceUrl(serviceId)}${pathname}`, { timeoutMs: 5000, ...init, method, headers });
  }
  return fetchJson(`${serviceUrl(serviceId)}${pathname}`, { timeoutMs: 5000, ...init });
}

/** Signs a direct-to-service request with the cluster's active request key. */
async function caHeaders(
  serviceId: string,
  params: { pathname: string; method?: string; body?: string; idempotencyKey?: string },
): Promise<SignedRequestHeaders> {
  const credential = await cluster!.authStore!.requestCredential(serviceId);
  return signRequestHeaders({
    credential,
    senderId: cluster!.authStore!.coordinatorId,
    targetServiceId: serviceId,
    method: params.method ?? 'POST',
    pathname: params.pathname,
    body: params.body ?? '',
    idempotencyKey: params.idempotencyKey,
  });
}

/** Performs a signed direct fetch against a service admin endpoint. */
async function signedDirectFetch(
  serviceId: string,
  pathname: string,
  init: { method?: string; body?: string; idempotencyKey?: string } = {},
) {
  const method = init.method ?? 'POST';
  const headers = await caHeaders(serviceId, {
    pathname,
    method,
    body: init.body ?? '',
    idempotencyKey: init.idempotencyKey,
  });
  return fetchJson(`${serviceUrl(serviceId)}${pathname}`, {
    method,
    timeoutMs: 5000,
    body: init.body,
    headers: { ...headers, 'content-type': 'application/json', ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}) },
  });
}

async function waitConfig(
  serviceId: string,
  routeId: string,
  predicate: (config: RouteConfig) => boolean,
  timeoutMs = 10_000,
): Promise<RouteConfig> {
  return waitFor(
    `config ${serviceId}/${routeId}`,
    async () => {
      const response = await directFetch(serviceId, `/__admin/config/${encodeURIComponent(routeId)}`);
      if (response.status !== 200) return null;
      const config = response.body.effective as RouteConfig;
      return predicate(config) ? config : null;
    },
    timeoutMs,
  );
}

async function addChaosRule(serviceId: string, rule: Record<string, unknown>): Promise<void> {
  const service = cluster!.getService(serviceId);
  const response = await fetchJson(`${service.chaosUrl}/__chaos/rules`, {
    method: 'POST',
    body: JSON.stringify(rule),
    headers: { 'content-type': 'application/json' },
    timeoutMs: 3000,
  });
  assert.equal(response.status, 201, response.text);
}

async function resetChaos(serviceId: string): Promise<void> {
  const service = cluster!.getService(serviceId);
  const response = await fetchJson(`${service.chaosUrl}/__chaos/reset`, { method: 'POST', timeoutMs: 3000 });
  assert.equal(response.status, 200, response.text);
}

function acceptRecords(serviceId: string, releaseId: string) {
  return cluster!
    .getService(serviceId)
    .proxy.requests.filter((record) => record.method === 'POST' && record.path.includes(`/releases/${releaseId}/accept`));
}

function hasAnyReleaseRequest(serviceId: string, releaseId: string): boolean {
  return cluster!
    .getService(serviceId)
    .proxy.requests.some((record) => record.path.includes(`/releases/${releaseId}`));
}

async function main(): Promise<void> {
  console.log('启动自带数据的本地夹具（真实 Node 子进程 + 混沌代理）...');
  cluster = await FixtureCluster.start({
    fixturePath: FIXTURE_PATH,
    requestTimeoutMs: 250,
    reconcileIntervalMs: 120,
  });
  console.log(`临时持久化目录: ${cluster.dataDir}`);
  console.log(`协调器: ${cluster.coordinatorUrl}/`);

  await check('初始配置与模拟转发数据面可用', async () => {
    const health = await cFetch('/health');
    assert.equal(health.status, 200);

    const config = await directFetch('checkout', '/__admin/config/create-order');
    assert.equal(config.status, 200);
    assert.deepEqual(config.body.effective, { timeoutMs: 1000, rateLimitPerMinute: 60 });

    const proxy = await directFetch('checkout', '/proxy/slow-quote');
    assert.equal(proxy.status, 200, proxy.text);
    assert.equal(proxy.body.routeId, 'slow-quote');
  });

  await check('单路由发布只下发该路由的增量，不包含无关路由', async () => {
    cluster!.getService('checkout').proxy.reset();
    await createRelease({
      releaseId: 'rel-delta-payload',
      targetServiceIds: ['checkout'],
      batches: [['checkout']],
      changes: [{ serviceId: 'checkout', routeId: 'webhook-delivery', timeoutMs: 1234 }],
    });
    await waitRelease('rel-delta-payload', (r) => r.status === 'completed');
    await waitConfig('checkout', 'webhook-delivery', (c) => c.timeoutMs === 1234);

    const records = acceptRecords('checkout', 'rel-delta-payload');
    assert.ok(records.length >= 1, '应至少记录一次 accept 请求');
    const record = records[0]!;
    assert.deepEqual(record.routeIds, ['webhook-delivery']);
    assert.ok(record.requestBodyPreview?.includes('webhook-delivery'));
    assert.ok(record.requestBodyPreview?.includes('1234'));
    for (const unrelated of ['create-order', 'inventory-reserve', 'customer-profile', 'atomic-a', 'restart-route']) {
      assert.equal(record.requestBodyPreview?.includes(unrelated), false, `请求体不应包含无关路由 ${unrelated}`);
    }

    const fullConfig = await directFetch('checkout', '/__admin/config');
    assert.equal(fullConfig.status, 200);
    assert.ok(record.requestBytes < Buffer.byteLength(fullConfig.text) / 2, '单路由增量应明显小于全量配置');

    await cFetch('/api/releases/rel-delta-payload/revoke', { method: 'POST' });
    await waitRelease('rel-delta-payload', (r) => r.status === 'revoked');
    const revokeRecord = cluster!
      .getService('checkout')
      .proxy.requests.find((item) => item.method === 'POST' && item.path.includes('/releases/rel-delta-payload/revoke'));
    assert.ok(revokeRecord, '应记录撤销请求');
    assert.ok((revokeRecord?.requestBytes ?? Number.POSITIVE_INFINITY) <= 2, '按 releaseId 撤销的请求体应是常量大小');
  });

  await check('分批闸门：当前批未全部确认时，后续批不会发出', async () => {
    await addChaosRule('payments', {
      match: { pathIncludes: 'rel-batch-gate' },
      dropRequest: true,
    });

    await createRelease({
      releaseId: 'rel-batch-gate',
      batches: [['checkout', 'payments'], ['risk']],
      changes: [
        { serviceId: 'checkout', routeId: 'calculate-shipping', timeoutMs: 1111 },
        { serviceId: 'payments', routeId: 'refund', timeoutMs: 2222 },
        { serviceId: 'risk', routeId: 'rules-config', timeoutMs: 3333 },
      ],
    });

    const pending = await waitRelease(
      'rel-batch-gate',
      (r) => r.services.checkout?.status === 'accepted' && (r.services.payments?.attempts ?? 0) >= 1,
    );
    assert.notEqual(pending.services.payments.status, 'accepted');

    await delay(420);
    assert.equal(hasAnyReleaseRequest('risk', 'rel-batch-gate'), false, '支付未确认前不应向 risk 下发第二批');
    const riskRelease = await directFetch('risk', '/__admin/releases/rel-batch-gate');
    assert.equal(riskRelease.status, 404);

    await resetChaos('payments');
    const done = await waitRelease('rel-batch-gate', (r) => r.status === 'completed');
    assert.equal(done.progress.confirmedBatches, 2);
  });

  await check('暂停后当前已发出批次可收尾，但不会启动下一批；继续后完成', async () => {
    await addChaosRule('checkout', {
      match: { pathIncludes: 'rel-pause' },
      dropResponse: true,
    });

    await createRelease({
      releaseId: 'rel-pause',
      batches: [['checkout'], ['payments', 'risk']],
      changes: [
        { serviceId: 'checkout', routeId: 'create-order', timeoutMs: 1010 },
        { serviceId: 'payments', routeId: 'charge-card', timeoutMs: 2020 },
        { serviceId: 'risk', routeId: 'score-order', timeoutMs: 3030 },
      ],
    });

    await waitFor('checkout actual rel-pause', async () => {
      const response = await directFetch('checkout', '/__admin/releases/rel-pause');
      return response.status === 200 && response.body.status === 'active' ? response.body : null;
    });

    const pauseResponse = await cFetch('/api/releases/rel-pause/pause', { method: 'POST' });
    assert.equal(pauseResponse.status, 200);
    assert.ok(['pausing', 'paused'].includes(pauseResponse.body.status));

    await waitRelease('rel-pause', (r) => r.status === 'pausing');
    await delay(420);
    assert.equal(hasAnyReleaseRequest('payments', 'rel-pause'), false);
    assert.equal(hasAnyReleaseRequest('risk', 'rel-pause'), false);

    await resetChaos('checkout');
    const paused = await waitRelease('rel-pause', (r) => r.status === 'paused');
    assert.equal(paused.progress.confirmedBatches, 1);

    await delay(300);
    assert.equal(hasAnyReleaseRequest('payments', 'rel-pause'), false, '暂停边界后仍不能发下一批');
    assert.equal(hasAnyReleaseRequest('risk', 'rel-pause'), false, '暂停边界后仍不能发下一批');

    const resume = await cFetch('/api/releases/rel-pause/resume', { method: 'POST' });
    assert.equal(resume.status, 200);
    await waitRelease('rel-pause', (r) => r.status === 'completed');
  });

  await check('同服务跨发布并发：A 应答丢失时 B 可生效确认；优先级按协调器受理顺序', async () => {
    await addChaosRule('checkout', {
      match: { pathIncludes: 'rel-concurrent-a' },
      dropResponse: true,
    });

    await createRelease({
      releaseId: 'rel-concurrent-a',
      changes: [{ serviceId: 'checkout', routeId: 'concurrent-precedence', timeoutMs: 200 }],
    });

    await waitFor('checkout accepted A locally', async () => {
      const response = await directFetch('checkout', '/__admin/releases/rel-concurrent-a');
      return response.status === 200 && response.body.status === 'active' ? response.body : null;
    });
    await waitRelease('rel-concurrent-a', (r) => (r.services.checkout?.attempts ?? 0) >= 1);
    const aBeforeB = await cFetch('/api/releases/rel-concurrent-a');
    assert.notEqual(aBeforeB.body.services.checkout.status, 'accepted', '混沌规则仍在丢弃 A 应答');

    await createRelease({
      releaseId: 'rel-concurrent-b',
      changes: [{ serviceId: 'checkout', routeId: 'concurrent-precedence', timeoutMs: 300 }],
    });
    await waitRelease('rel-concurrent-b', (r) => r.status === 'completed');
    await waitConfig('checkout', 'concurrent-precedence', (c) => c.timeoutMs === 300);

    const aStillUnconfirmed = await cFetch('/api/releases/rel-concurrent-a');
    assert.notEqual(aStillUnconfirmed.body.services.checkout.status, 'accepted');

    await resetChaos('checkout');
    await waitRelease('rel-concurrent-a', (r) => r.status === 'completed');
    const configAfterAck = await directFetch('checkout', '/__admin/config/concurrent-precedence');
    assert.equal(configAfterAck.body.effective.timeoutMs, 300, '较晚受理的 B 应胜过较早受理的 A');

    await cFetch('/api/releases/rel-concurrent-b/revoke', { method: 'POST' });
    await waitRelease('rel-concurrent-b', (r) => r.status === 'revoked');
    await waitConfig('checkout', 'concurrent-precedence', (c) => c.timeoutMs === 200);

    await cFetch('/api/releases/rel-concurrent-a/revoke', { method: 'POST' });
    await waitRelease('rel-concurrent-a', (r) => r.status === 'revoked');
    await waitConfig('checkout', 'concurrent-precedence', (c) => c.timeoutMs === 1000);
  });

  await check('乱序接纳：较早协调器受理的发布晚到服务，也不会覆盖较晚受理的赢家', async () => {
    await addChaosRule('checkout', {
      match: { pathIncludes: 'rel-order-a' },
      dropRequest: true,
    });

    await createRelease({
      releaseId: 'rel-order-a',
      changes: [{ serviceId: 'checkout', routeId: 'inventory-reserve', timeoutMs: 110 }],
    });
    await waitRelease('rel-order-a', (r) => (r.services.checkout?.attempts ?? 0) >= 1);
    const absent = await directFetch('checkout', '/__admin/releases/rel-order-a');
    assert.equal(absent.status, 404);

    await createRelease({
      releaseId: 'rel-order-b',
      changes: [{ serviceId: 'checkout', routeId: 'inventory-reserve', timeoutMs: 220 }],
    });
    await waitRelease('rel-order-b', (r) => r.status === 'completed');
    await waitConfig('checkout', 'inventory-reserve', (c) => c.timeoutMs === 220);

    await resetChaos('checkout');
    await waitRelease('rel-order-a', (r) => r.status === 'completed');
    const config = await directFetch('checkout', '/__admin/config/inventory-reserve');
    assert.equal(config.body.effective.timeoutMs, 220, '服务晚接纳 A 只让 A 开始参与候选，不应按服务接纳时间夺冠');

    await cFetch('/api/releases/rel-order-b/revoke', { method: 'POST' });
    await waitRelease('rel-order-b', (r) => r.status === 'revoked');
    await waitConfig('checkout', 'inventory-reserve', (c) => c.timeoutMs === 110);
    await cFetch('/api/releases/rel-order-a/revoke', { method: 'POST' });
    await waitRelease('rel-order-a', (r) => r.status === 'revoked');
    await waitConfig('checkout', 'inventory-reserve', (c) => c.timeoutMs === 900);
  });

  await check('整组修改原子接纳；非法组全部不生效；同键重放返回首次结果', async () => {
    const badBody = JSON.stringify({
      coordinatorAcceptedAt: new Date().toISOString(),
      acceptedOrder: 999_001,
      changes: [
        { serviceId: 'checkout', routeId: 'atomic-a', timeoutMs: 111 },
        { serviceId: 'checkout', routeId: 'missing-route', timeoutMs: 222 },
      ],
    });
    const bad = await signedDirectFetch('checkout', '/__admin/releases/rel-atomic-bad/accept', {
      body: badBody,
      idempotencyKey: 'key-bad-atomic',
    });
    assert.equal(bad.status, 400);
    const unchanged = await directFetch('checkout', '/__admin/config/atomic-a');
    assert.equal(unchanged.body.effective.timeoutMs, 1100);
    const missingRelease = await directFetch('checkout', '/__admin/releases/rel-atomic-bad');
    assert.equal(missingRelease.status, 404);

    const body = JSON.stringify({
      coordinatorAcceptedAt: new Date().toISOString(),
      acceptedOrder: 999_002,
      changes: [
        { serviceId: 'checkout', routeId: 'atomic-a', timeoutMs: 222 },
        { serviceId: 'checkout', routeId: 'atomic-b', timeoutMs: 333 },
      ],
    });
    const goodPath = '/__admin/releases/rel-atomic-good/accept';
    // One signed envelope is replayed byte-for-byte with the same idempotency key.
    const goodHeaders = {
      ...(await caHeaders('checkout', {
        pathname: goodPath,
        body,
        idempotencyKey: 'key-good-atomic',
      })),
      'content-type': 'application/json',
      'idempotency-key': 'key-good-atomic',
    };
    const first = await fetch(`${cluster!.getService('checkout').directUrl}${goodPath}`, {
      method: 'POST',
      body,
      headers: goodHeaders,
    });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-idempotent-replay'), null);

    const second = await fetch(`${cluster!.getService('checkout').directUrl}${goodPath}`, {
      method: 'POST',
      body,
      headers: goodHeaders,
    });
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-idempotent-replay'), 'true');

    const a = await directFetch('checkout', '/__admin/config/atomic-a');
    const b = await directFetch('checkout', '/__admin/config/atomic-b');
    assert.equal(a.body.effective.timeoutMs, 222);
    assert.equal(b.body.effective.timeoutMs, 333);
  });

  await check('撤销后的旧 accept 请求按原幂等结果重放，不会复活已撤销发布', async () => {
    const url = cluster!.getService('checkout').directUrl;
    const acceptPath = '/__admin/releases/rel-zombie/accept';
    const revokePath = '/__admin/releases/rel-zombie/revoke';
    const acceptBody = JSON.stringify({
      coordinatorAcceptedAt: new Date().toISOString(),
      acceptedOrder: 999_003,
      changes: [{ serviceId: 'checkout', routeId: 'customer-profile', timeoutMs: 444 }],
    });
    // Sign once: the exact captured request (same signature/nonce) is replayed.
    const acceptHeaders = {
      ...(await caHeaders('checkout', {
        pathname: acceptPath,
        body: acceptBody,
        idempotencyKey: 'key-zombie-accept',
      })),
      'content-type': 'application/json',
      'idempotency-key': 'key-zombie-accept',
    };
    const accept = await fetch(`${url}${acceptPath}`, {
      method: 'POST',
      body: acceptBody,
      headers: acceptHeaders,
    });
    assert.equal(accept.status, 200);
    await waitConfig('checkout', 'customer-profile', (c) => c.timeoutMs === 444);

    const revokeBody = '{}';
    const revokeHeaders = {
      ...(await caHeaders('checkout', {
        pathname: revokePath,
        body: revokeBody,
        idempotencyKey: 'key-zombie-revoke',
      })),
      'content-type': 'application/json',
      'idempotency-key': 'key-zombie-revoke',
    };
    const revoke = await fetch(`${url}${revokePath}`, {
      method: 'POST',
      body: revokeBody,
      headers: revokeHeaders,
    });
    assert.equal(revoke.status, 200);
    await waitConfig('checkout', 'customer-profile', (c) => c.timeoutMs === 700);

    const replay = await fetch(`${url}${acceptPath}`, {
      method: 'POST',
      body: acceptBody,
      headers: acceptHeaders,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
    const release = await directFetch('checkout', '/__admin/releases/rel-zombie');
    assert.equal(release.body.status, 'revoked');
    const config = await directFetch('checkout', '/__admin/config/customer-profile');
    assert.equal(config.body.effective.timeoutMs, 700);
  });

  await check('单路由读取为物化 O(1)：20,000 条历史下 100,000 次读取保持快速', async () => {
    const perfDir = path.join(os.tmpdir(), `route-perf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(perfDir, { recursive: true });
    await mkdir(path.join(perfDir, 'services'), { recursive: true });
    const historyCount = 20_000;
    const candidates = Array.from({ length: historyCount }, (_, index) => ({
      releaseId: `hist-${index}`,
      coordinatorAcceptedAt: new Date(index + 1).toISOString(),
      acceptedOrder: index + 1,
      value: 1000 + index,
    })).sort((a, b) => b.acceptedOrder - a.acceptedOrder);

    const releases = Object.fromEntries(
      candidates.map((candidate) => [
        candidate.releaseId,
        {
          releaseId: candidate.releaseId,
          coordinatorAcceptedAt: candidate.coordinatorAcceptedAt,
          acceptedOrder: candidate.acceptedOrder,
          status: 'active' as const,
          changes: [{ serviceId: 'perf', routeId: 'only', timeoutMs: candidate.value }],
          serviceAcceptedAt: candidate.coordinatorAcceptedAt,
        },
      ]),
    );

    const state: ServicePersistentState = {
      version: 1,
      serviceId: 'perf',
      routes: {
        only: {
          initial: { timeoutMs: 10, rateLimitPerMinute: 1 },
          effective: { timeoutMs: candidates[0]!.value, rateLimitPerMinute: 1 },
        },
      },
      candidates: { only: { timeoutMs: candidates } },
      releases,
      processedRequests: {},
    };
    await writeFile(path.join(perfDir, 'services', 'perf.json'), JSON.stringify(state));

    const fixture: FixtureData = {
      services: [
        {
          id: 'perf',
          routes: [{ id: 'only', path: '/proxy/only', initial: { timeoutMs: 10, rateLimitPerMinute: 1 } }],
        },
      ],
    };
    const service = await ConfigService.start({ serviceId: 'perf', dataDir: perfDir, fixture });
    assert.equal(Object.keys(service.snapshot().releases).length, historyCount);

    const iterations = 100_000;
    const started = performance.now();
    let sum = 0;
    for (let i = 0; i < iterations; i += 1) {
      sum += service.getRouteConfig('only').timeoutMs;
    }
    const elapsed = performance.now() - started;
    assert.ok(sum > 0);
    assert.ok(elapsed < 1000, `100k materialized reads took ${elapsed.toFixed(1)}ms`);
    console.log(`    历史发布=${historyCount}，读取=${iterations}，耗时=${elapsed.toFixed(1)}ms`);
  });

  await check('实际配置驱动转发：超时返回 504，限流返回 429', async () => {
    await createRelease({
      releaseId: 'rel-data-timeout',
      changes: [{ serviceId: 'checkout', routeId: 'slow-quote', timeoutMs: 40 }],
    });
    await waitRelease('rel-data-timeout', (r) => r.status === 'completed');
    await waitConfig('checkout', 'slow-quote', (c) => c.timeoutMs === 40);
    const timeoutResponse = await directFetch('checkout', '/proxy/slow-quote');
    assert.equal(timeoutResponse.status, 504, timeoutResponse.text);

    await createRelease({
      releaseId: 'rel-data-rate',
      changes: [{ serviceId: 'checkout', routeId: 'rate-limited-demo', rateLimitPerMinute: 2 }],
    });
    await waitRelease('rel-data-rate', (r) => r.status === 'completed');
    await waitConfig('checkout', 'rate-limited-demo', (c) => c.rateLimitPerMinute === 2);
    await directFetch('checkout', '/__admin/reset-rate-limits', { method: 'POST' });

    const codes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await directFetch('checkout', '/proxy/rate-limited-demo');
      codes.push(response.status);
    }
    assert.deepEqual(codes, [200, 200, 429]);
  });

  await check('协调器离线时服务进程重启，仍从本地文件继续使用生效配置', async () => {
    await createRelease({
      releaseId: 'rel-restart',
      changes: [{ serviceId: 'checkout', routeId: 'restart-route', timeoutMs: 4321 }],
    });
    await waitRelease('rel-restart', (r) => r.status === 'completed');

    await cluster!.stopCoordinator();
    assert.equal(cluster!.coordinatorChild, undefined);

    const oldPid = cluster!.getService('checkout').child?.pid;
    assert.ok(oldPid);
    await cluster!.restartService('checkout');
    const newPid = cluster!.getService('checkout').child?.pid;
    assert.ok(newPid);
    assert.notEqual(oldPid, newPid);

    const config = await waitConfig('checkout', 'restart-route', (c) => c.timeoutMs === 4321);
    assert.equal(config.rateLimitPerMinute, 333);
    const release = await directFetch('checkout', '/__admin/releases/rel-restart');
    assert.equal(release.body.status, 'active');

    const proxy = await directFetch('checkout', '/proxy/restart-route');
    assert.equal(proxy.status, 200, proxy.text);

    await cluster!.startCoordinator();
    const afterRestart = await waitRelease('rel-restart', (r) => r.status === 'completed');
    assert.equal(afterRestart.status, 'completed');
  });

  await check('通信恢复/协调器重启后，按服务实际接纳状态继续未完成发布', async () => {
    await addChaosRule('payments', {
      match: { pathIncludes: 'rel-recover-accept' },
      dropResponse: true,
    });
    await createRelease({
      releaseId: 'rel-recover-accept',
      changes: [{ serviceId: 'payments', routeId: 'payment-methods', timeoutMs: 777 }],
    });
    await waitFor('payments actual accept recovery', async () => {
      const response = await directFetch('payments', '/__admin/releases/rel-recover-accept');
      return response.status === 200 && response.body.status === 'active' ? response.body : null;
    });
    await waitRelease(
      'rel-recover-accept',
      (r) => r.status === 'running' && (r.services.payments?.attempts ?? 0) >= 1 && r.services.payments.status !== 'accepted',
    );

    await cluster!.restartCoordinator();
    await delay(200);
    const stillRunning = await cFetch('/api/releases/rel-recover-accept');
    assert.equal(stillRunning.body.status, 'running');

    await resetChaos('payments');
    await cFetch('/api/reconcile', { method: 'POST' });
    await waitRelease('rel-recover-accept', (r) => r.status === 'completed');
    await waitConfig('payments', 'payment-methods', (c) => c.timeoutMs === 777);
  });

  await check('协调器重启并恢复通信后，按服务实际撤销状态完成撤销', async () => {
    await addChaosRule('checkout', {
      match: { pathIncludes: 'rel-restart' },
      dropResponse: true,
    });

    const revoke = await cFetch('/api/releases/rel-restart/revoke', { method: 'POST' });
    assert.equal(revoke.status, 202);

    await waitFor('checkout actual revoked', async () => {
      const response = await directFetch('checkout', '/__admin/releases/rel-restart');
      return response.status === 200 && response.body.status === 'revoked' ? response.body : null;
    });
    await waitRelease(
      'rel-restart',
      (r) => r.status === 'revoking' && (r.revocation?.services.checkout?.attempts ?? 0) >= 1,
    );

    await cluster!.restartCoordinator();
    await resetChaos('checkout');
    await cFetch('/api/reconcile', { method: 'POST' });

    await waitRelease('rel-restart', (r) => r.status === 'revoked');
    await waitConfig('checkout', 'restart-route', (c) => c.timeoutMs === 1300);
  });

  await check('双向认证·错投：无凭证/投错服务/篡改目标的写入一律拒绝且不落盘', async () => {
    // (1) Completely unsigned write must be rejected before any state access.
    const anonPath = '/__admin/releases/rel-misdirect-anon/accept';
    const anonBody = JSON.stringify({
      coordinatorAcceptedAt: new Date().toISOString(),
      acceptedOrder: 999_101,
      changes: [{ serviceId: 'checkout', routeId: 'atomic-a', timeoutMs: 888 }],
    });
    const beforeAnon = (await directFetch('checkout', '/__admin/config/atomic-a')).body.effective.timeoutMs as number;
    const anon = await fetch(`${serviceUrl('checkout')}${anonPath}`, {
      method: 'POST',
      body: anonBody,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(anon.status, 401, '无凭证 accept 必须是 401');
    const afterAnon = (await directFetch('checkout', '/__admin/config/atomic-a')).body.effective.timeoutMs as number;
    assert.equal(afterAnon, beforeAnon, '无凭证写入不得改变配置');
    assert.equal((await directFetch('checkout', '/__admin/releases/rel-misdirect-anon')).status, 404);

    // Unsigned revoke is rejected too.
    const anonRevoke = await fetch(`${serviceUrl('checkout')}/__admin/releases/rel-misdirect-anon/revoke`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(anonRevoke.status, 401);

    // Reconciliation query is also mutually authenticated: no signature -> 401.
    const anonQuery = await fetch(`${serviceUrl('checkout')}/__admin/releases/rel-misdirect-anon`);
    assert.equal(anonQuery.status, 401, '未签名的对账查询必须被拒绝');

    // (2) A checkout-signed envelope physically delivered to payments (错投).
    const crossCheckoutPath = '/__admin/releases/rel-misdirect-cross/accept';
    const crossCheckoutBody = JSON.stringify({
      coordinatorAcceptedAt: new Date().toISOString(),
      acceptedOrder: 999_102,
      changes: [{ serviceId: 'checkout', routeId: 'atomic-a', timeoutMs: 889 }],
    });
    const crossCheckoutHeaders = await caHeaders('checkout', {
      pathname: crossCheckoutPath,
      body: crossCheckoutBody,
      idempotencyKey: 'accept:rel-misdirect-cross:checkout:v1',
    });
    const paymentsBefore = (await directFetch('payments', '/__admin/config/ledger-entries')).body.effective.timeoutMs as number;
    const deliveredToPayments = await fetch(`${serviceUrl('payments')}${crossCheckoutPath}`, {
      method: 'POST',
      body: crossCheckoutBody,
      headers: {
        ...crossCheckoutHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'accept:rel-misdirect-cross:checkout:v1',
      },
    });
    assert.ok(
      [401, 403].includes(deliveredToPayments.status),
      `checkout 凭证错投到 payments 应拒绝，实际 ${deliveredToPayments.status}`,
    );
    const paymentsAfter = (await directFetch('payments', '/__admin/config/ledger-entries')).body.effective.timeoutMs as number;
    assert.equal(paymentsAfter, paymentsBefore, '错投不得改变目标服务配置');
    assert.equal((await directFetch('payments', '/__admin/releases/rel-misdirect-cross')).status, 404);

    // (3) A payments-signed envelope delivered to checkout.
    const crossPaymentsPath = '/__admin/releases/rel-misdirect-cross2/accept';
    const crossPaymentsBody = JSON.stringify({
      coordinatorAcceptedAt: new Date().toISOString(),
      acceptedOrder: 999_103,
      changes: [{ serviceId: 'payments', routeId: 'ledger-entries', timeoutMs: 890 }],
    });
    const crossPaymentsHeaders = await caHeaders('payments', {
      pathname: crossPaymentsPath,
      body: crossPaymentsBody,
      idempotencyKey: 'accept:rel-misdirect-cross2:payments:v1',
    });
    const checkoutBefore = (await directFetch('checkout', '/__admin/config/atomic-b')).body.effective.timeoutMs as number;
    const deliveredToCheckout = await fetch(`${serviceUrl('checkout')}${crossPaymentsPath}`, {
      method: 'POST',
      body: crossPaymentsBody,
      headers: {
        ...crossPaymentsHeaders,
        'content-type': 'application/json',
        'idempotency-key': 'accept:rel-misdirect-cross2:payments:v1',
      },
    });
    assert.ok([401, 403].includes(deliveredToCheckout.status));
    const checkoutAfter = (await directFetch('checkout', '/__admin/config/atomic-b')).body.effective.timeoutMs as number;
    assert.equal(checkoutAfter, checkoutBefore, '反向错投也不得改变配置');
    assert.equal((await directFetch('checkout', '/__admin/releases/rel-misdirect-cross2')).status, 404);

    // (4) Valid signature, but the plaintext target header is tampered with.
    const tamperPath = '/__admin/releases/rel-misdirect-tamper/accept';
    const tamperBody = JSON.stringify({
      coordinatorAcceptedAt: new Date().toISOString(),
      acceptedOrder: 999_104,
      changes: [{ serviceId: 'checkout', routeId: 'atomic-a', timeoutMs: 891 }],
    });
    const tamperHeaders = await caHeaders('checkout', {
      pathname: tamperPath,
      body: tamperBody,
      idempotencyKey: 'accept:rel-misdirect-tamper:checkout:v1',
    });
    const tampered = await fetch(`${serviceUrl('checkout')}${tamperPath}`, {
      method: 'POST',
      body: tamperBody,
      headers: {
        ...tamperHeaders,
        'x-ca-target': 'risk',
        'content-type': 'application/json',
        'idempotency-key': 'accept:rel-misdirect-tamper:checkout:v1',
      },
    });
    assert.equal(tampered.status, 401, '篡改目标头导致签名失效，必须 401');
    assert.equal((await directFetch('checkout', '/__admin/releases/rel-misdirect-tamper')).status, 404);

    // (5) Properly authenticated envelope to checkout whose BODY nevertheless
    // carries another service's change: the service refuses the foreign change.
    const foreignChangePath = '/__admin/releases/rel-misdirect-body/accept';
    const foreignChangeBody = JSON.stringify({
      coordinatorAcceptedAt: new Date().toISOString(),
      acceptedOrder: 999_105,
      changes: [{ serviceId: 'payments', routeId: 'refund', timeoutMs: 892 }],
    });
    const foreignChange = await signedDirectFetch('checkout', foreignChangePath, {
      body: foreignChangeBody,
      idempotencyKey: 'key-misdirect-body',
    });
    assert.equal(foreignChange.status, 400, '非本服务的变更必须被业务校验拒绝');
    assert.equal((await directFetch('checkout', '/__admin/releases/rel-misdirect-body')).status, 404);

    // (6) A signed reconcile query gets a receipt that verifies under the
    // target service's active receipt key and binds the request nonce.
    const queryPath = '/__admin/releases/rel-delta-payload';
    const queryHeaders = await caHeaders('checkout', { pathname: queryPath, method: 'GET' });
    const query = await fetchJson(`${serviceUrl('checkout')}${queryPath}`, {
      method: 'GET',
      headers: { ...queryHeaders },
      timeoutMs: 5000,
    });
    assert.equal(query.status, 200);
    const queryReceiptCredential = await cluster!.authStore!.receiptCredential('checkout');
    const queryReceipt = verifyReceiptSignature({
      headers: query.headers,
      rawBody: query.text,
      statusCode: query.status,
      credential: queryReceiptCredential,
      expected: {
        serviceId: 'checkout',
        nonce: queryHeaders['x-ca-nonce'],
        method: 'GET',
        pathname: queryPath,
      },
    });
    assert.equal(queryReceipt.ok, true, `真实服务查询回执应变验通过: ${queryReceipt.ok ? '' : queryReceipt.error}`);
    const wrongNonceReceipt = verifyReceiptSignature({
      headers: query.headers,
      rawBody: query.text,
      statusCode: query.status,
      credential: queryReceiptCredential,
      expected: { serviceId: 'checkout', nonce: 'different-nonce', method: 'GET', pathname: queryPath },
    });
    assert.equal(wrongNonceReceipt.ok, false, 'nonce 不匹配的真实回执必须失败');
  });

  await check('双向认证·可信回执：伪造/错服务/错 nonce 的回执不能确认动作', async () => {
    // In-process coordinator pointed at a rogue "checkout" endpoint whose
    // receipt behaviour can be switched between forged and properly signed.
    const rogueAuth = new InMemoryAuthProvider(['checkout', 'payments']);
    const checkoutReceipt = await rogueAuth.receiptCredential('checkout');
    const paymentsReceipt = await rogueAuth.receiptCredential('payments');
    type RoguePhase = 'unsigned' | 'wrong-service' | 'bad-nonce' | 'valid';
    let phase: RoguePhase = 'unsigned';

    const rogue = http.createServer(async (req, res) => {
      const rogueUrl = new URL(req.url ?? '/', 'http://rogue.local');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      void Buffer.concat(chunks);
      const requestNonce = typeof req.headers['x-ca-nonce'] === 'string' ? req.headers['x-ca-nonce'] : '';
      const payload = JSON.stringify({
        ok: true,
        serviceId: 'checkout',
        releaseId: 'rel-rogue-receipt',
        status: 'active',
        serviceAcceptedAt: new Date().toISOString(),
      });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (phase === 'wrong-service') {
        Object.assign(
          headers,
          signReceiptHeaders({
            credential: paymentsReceipt,
            serviceId: 'payments',
            nonce: requestNonce,
            method: req.method ?? 'POST',
            pathname: rogueUrl.pathname,
            statusCode: 200,
            body: payload,
          }),
        );
      } else if (phase === 'bad-nonce') {
        Object.assign(
          headers,
          signReceiptHeaders({
            credential: checkoutReceipt,
            serviceId: 'checkout',
            nonce: `not-the-request-nonce-${requestNonce}`,
            method: req.method ?? 'POST',
            pathname: rogueUrl.pathname,
            statusCode: 200,
            body: payload,
          }),
        );
      } else if (phase === 'valid') {
        Object.assign(
          headers,
          signReceiptHeaders({
            credential: checkoutReceipt,
            serviceId: 'checkout',
            nonce: requestNonce,
            method: req.method ?? 'POST',
            pathname: rogueUrl.pathname,
            statusCode: 200,
            body: payload,
          }),
        );
      }
      res.writeHead(200, headers);
      res.end(payload);
    });
    await new Promise<void>((resolve) => rogue.listen(0, '127.0.0.1', resolve));
    const roguePort = (rogue.address() as { port: number }).port;

    const rogueDir = await mkdtemp(path.join(os.tmpdir(), 'route-rogue-'));
    const rogueCoordinator = new Coordinator({
      dataDir: rogueDir,
      fixture: cluster!.fixture,
      endpoints: [{ id: 'checkout', baseUrl: `http://127.0.0.1:${roguePort}` }],
      auth: rogueAuth,
      requestTimeoutMs: 1000,
      retryDelayMs: 30,
    });
    await rogueCoordinator.start();

    try {
      await rogueCoordinator.createRelease({
        releaseId: 'rel-rogue-receipt',
        changes: [{ serviceId: 'checkout', routeId: 'atomic-a', timeoutMs: 7777 }],
      });

      await delay(450);
      assert.notEqual(
        rogueCoordinator.getRelease('rel-rogue-receipt').services.checkout?.status,
        'accepted',
        '无签名回执不得确认',
      );

      phase = 'wrong-service';
      await delay(350);
      assert.notEqual(
        rogueCoordinator.getRelease('rel-rogue-receipt').services.checkout?.status,
        'accepted',
        '其他服务凭证签署的错投回执不得确认目标服务动作',
      );

      phase = 'bad-nonce';
      await delay(350);
      assert.notEqual(
        rogueCoordinator.getRelease('rel-rogue-receipt').services.checkout?.status,
        'accepted',
        'nonce 与当前请求不匹配的回执不得确认',
      );

      phase = 'valid';
      await waitFor('rogue valid receipt confirms', async () => {
        const release = rogueCoordinator.getRelease('rel-rogue-receipt');
        return release.services.checkout?.status === 'accepted' ? release : null;
      }, 5000, 40);
      await waitFor('rogue release completes', async () => {
        const release = rogueCoordinator.getRelease('rel-rogue-receipt');
        return release.status === 'completed' ? release : null;
      }, 5000, 40);
    } finally {
      rogueCoordinator.close();
      await new Promise<void>((resolve) => rogue.close(() => resolve()));
    }

    // Signature binding unit checks on top of the live rogue scenario.
    const receiptInput = {
      credential: checkoutReceipt,
      serviceId: 'checkout',
      nonce: 'n-1',
      method: 'POST',
      pathname: '/__admin/releases/r1/accept',
      statusCode: 200,
      body: '{"ok":true}',
    } as const;
    const goodReceiptHeaders = signReceiptHeaders(receiptInput);
    assert.equal(
      verifyReceiptSignature({
        headers: goodReceiptHeaders,
        rawBody: receiptInput.body,
        statusCode: 200,
        credential: checkoutReceipt,
        expected: { serviceId: 'checkout', nonce: 'n-1', method: 'POST', pathname: receiptInput.pathname },
      }).ok,
      true,
    );
    assert.equal(
      verifyReceiptSignature({
        headers: goodReceiptHeaders,
        rawBody: '{"ok":false}',
        statusCode: 200,
        credential: checkoutReceipt,
        expected: { serviceId: 'checkout', nonce: 'n-1', method: 'POST', pathname: receiptInput.pathname },
      }).ok,
      false,
      '回执正文被篡改必须失败',
    );
    assert.equal(
      verifyReceiptSignature({
        headers: goodReceiptHeaders,
        rawBody: receiptInput.body,
        statusCode: 201,
        credential: checkoutReceipt,
        expected: { serviceId: 'checkout', nonce: 'n-1', method: 'POST', pathname: receiptInput.pathname },
      }).ok,
      false,
      'HTTP 状态与签名不一致必须失败',
    );
  });

  await check('双向认证·轮换：请求/回执凭证按服务独立轮换，旧凭证停用即拒', async () => {
    const authStore = cluster!.authStore!;
    const before = await authStore.read();
    const oldRiskRequest: Credential = before.services.risk!.request;
    const oldRiskReceipt: Credential = before.services.risk!.receipt;
    const paymentsRequestKeyBefore = before.services.payments!.request.keyId;
    const checkoutReceiptKeyBefore = before.services.checkout!.receipt.keyId;

    // Rotate only the risk REQUEST credential through the coordinator API.
    const rotateResponse = await cFetch('/api/services/risk/credentials/rotate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ which: 'request' }),
    });
    assert.equal(rotateResponse.status, 200, rotateResponse.text);
    assert.equal(rotateResponse.body.active.requestKeyId !== oldRiskRequest.keyId, true);
    assert.equal(rotateResponse.body.active.receiptKeyId, oldRiskReceipt.keyId, 'which=request 不得轮换回执凭证');

    const afterRequestRotation = await authStore.read();
    assert.notEqual(afterRequestRotation.services.risk!.request.keyId, oldRiskRequest.keyId);
    assert.equal(afterRequestRotation.services.risk!.receipt.keyId, oldRiskReceipt.keyId, '回执凭证应保持不变');
    assert.equal(afterRequestRotation.services.payments!.request.keyId, paymentsRequestKeyBefore, '其他服务凭证不受影响');
    assert.equal(afterRequestRotation.services.checkout!.receipt.keyId, checkoutReceiptKeyBefore);

    // Requests still signed with the deactivated request key are rejected.
    const oldKeyPath = '/__admin/releases/rel-rot-old-request/accept';
    const oldKeyBody = JSON.stringify({
      coordinatorAcceptedAt: new Date().toISOString(),
      acceptedOrder: 999_201,
      changes: [{ serviceId: 'risk', routeId: 'rules-config', timeoutMs: 4444 }],
    });
    const oldKeyHeaders = signRequestHeaders({
      credential: oldRiskRequest,
      senderId: authStore.coordinatorId,
      targetServiceId: 'risk',
      method: 'POST',
      pathname: oldKeyPath,
      body: oldKeyBody,
      idempotencyKey: 'accept:rel-rot-old-request:risk:v1',
    });
    const oldKeyResponse = await fetch(`${serviceUrl('risk')}${oldKeyPath}`, {
      method: 'POST',
      body: oldKeyBody,
      headers: { ...oldKeyHeaders, 'content-type': 'application/json', 'idempotency-key': 'accept:rel-rot-old-request:risk:v1' },
    });
    assert.ok([401, 403].includes(oldKeyResponse.status), `旧请求凭证必须被拒，实际 ${oldKeyResponse.status}`);
    assert.equal((await directFetch('risk', '/__admin/releases/rel-rot-old-request')).status, 404);

    // The coordinator uses the new request key automatically: release completes.
    await createRelease({
      releaseId: 'rel-rot-request-ok',
      changes: [{ serviceId: 'risk', routeId: 'device-fingerprint', timeoutMs: 4321 }],
    });
    await waitRelease('rel-rot-request-ok', (r) => r.status === 'completed');
    await waitConfig('risk', 'device-fingerprint', (c) => c.timeoutMs === 4321);

    // Rotate only the risk RECEIPT credential.
    const receiptRotation = await cluster!.rotateCredential('risk', 'receipt');
    assert.notEqual(receiptRotation.after.receipt.keyId, receiptRotation.before.receipt.keyId);
    assert.equal(receiptRotation.after.request.keyId, receiptRotation.before.request.keyId, '轮换回执不应改动请求凭证');
    const currentRiskReceipt = (await authStore.read()).services.risk!.receipt;

    const oldReceiptHeaders = signReceiptHeaders({
      credential: oldRiskReceipt,
      serviceId: 'risk',
      nonce: 'n-rot-old',
      method: 'POST',
      pathname: '/__admin/releases/x/accept',
      statusCode: 200,
      body: '{}',
    });
    assert.equal(
      verifyReceiptSignature({
        headers: oldReceiptHeaders,
        rawBody: '{}',
        statusCode: 200,
        credential: currentRiskReceipt,
        expected: { serviceId: 'risk', nonce: 'n-rot-old', method: 'POST', pathname: '/__admin/releases/x/accept' },
      }).ok,
      false,
      '停用的旧回执凭证签署的回执一律拒绝',
    );

    const newReceiptHeaders = signReceiptHeaders({
      credential: receiptRotation.after.receipt,
      serviceId: 'risk',
      nonce: 'n-rot-new',
      method: 'POST',
      pathname: '/__admin/releases/x/accept',
      statusCode: 200,
      body: '{}',
    });
    assert.equal(
      verifyReceiptSignature({
        headers: newReceiptHeaders,
        rawBody: '{}',
        statusCode: 200,
        credential: currentRiskReceipt,
        expected: { serviceId: 'risk', nonce: 'n-rot-new', method: 'POST', pathname: '/__admin/releases/x/accept' },
      }).ok,
      true,
      '现行回执凭证必须通过',
    );

    // A valid signature from another service's receipt key is still untrusted
    // when presented for risk (target-service binding).
    const checkoutReceipt = (await authStore.read()).services.checkout!.receipt;
    const foreignReceiptHeaders = signReceiptHeaders({
      credential: checkoutReceipt,
      serviceId: 'checkout',
      nonce: 'n-rot-foreign',
      method: 'POST',
      pathname: '/__admin/releases/x/accept',
      statusCode: 200,
      body: '{}',
    });
    assert.equal(
      verifyReceiptSignature({
        headers: foreignReceiptHeaders,
        rawBody: '{}',
        statusCode: 200,
        credential: currentRiskReceipt,
        expected: { serviceId: 'risk', nonce: 'n-rot-foreign', method: 'POST', pathname: '/__admin/releases/x/accept' },
      }).ok,
      false,
      '其他服务的可信回执不能确认 risk 的动作',
    );

    // End-to-end confirmation still works with the rotated receipt key.
    await createRelease({
      releaseId: 'rel-rot-receipt-ok',
      changes: [{ serviceId: 'risk', routeId: 'device-fingerprint', timeoutMs: 4322 }],
    });
    await waitRelease('rel-rot-receipt-ok', (r) => r.status === 'completed');
    await waitConfig('risk', 'device-fingerprint', (c) => c.timeoutMs === 4322);
  });

  await check('双向认证·重启恢复：落盘丢回执且停机轮换后，用现行凭证查询补确认，撤销选择性回退', async () => {
    // Phase 1: accept is durably applied, receipt lost via chaos response drop.
    await addChaosRule('payments', {
      match: { pathIncludes: 'rel-auth-recover' },
      dropResponse: true,
    });
    await createRelease({
      releaseId: 'rel-auth-recover',
      changes: [{ serviceId: 'payments', routeId: 'ledger-entries', timeoutMs: 616 }],
    });
    await waitFor('payments applied rel-auth-recover', async () => {
      const response = await directFetch('payments', '/__admin/releases/rel-auth-recover');
      return response.status === 200 && response.body.status === 'active' ? response.body : null;
    });
    await waitRelease(
      'rel-auth-recover',
      (r) => r.status === 'running' && (r.services.payments?.attempts ?? 0) >= 1 && r.services.payments.status !== 'accepted',
    );

    // Coordinator is down; rotate BOTH payments credentials in the meantime.
    await cluster!.stopCoordinator();
    const rotation = await cluster!.rotateCredential('payments', 'both');
    const staleRequestHeaders = signRequestHeaders({
      credential: rotation.before.request,
      senderId: cluster!.authStore!.coordinatorId,
      targetServiceId: 'payments',
      method: 'GET',
      pathname: '/__admin/releases/rel-auth-recover',
      body: '',
    });
    const staleRequest = await fetch(
      `${serviceUrl('payments')}/__admin/releases/rel-auth-recover`,
      { headers: { ...staleRequestHeaders } },
    );
    assert.ok([401, 403].includes(staleRequest.status), '停机轮换后旧请求凭证也必须被服务拒绝');

    // Restart loads current credentials; initial reconcile cannot pass the
    // chaos drop, then clearing chaos + explicit reconcile recovers via query.
    await cluster!.startCoordinator();
    await resetChaos('payments');
    await cFetch('/api/reconcile', { method: 'POST' });
    await waitRelease('rel-auth-recover', (r) => r.status === 'completed', 15_000);
    await waitConfig('payments', 'ledger-entries', (c) => c.timeoutMs === 616);

    // Stack a later release B on the same route; it wins over A.
    await createRelease({
      releaseId: 'rel-auth-recover-b',
      changes: [{ serviceId: 'payments', routeId: 'ledger-entries', timeoutMs: 626 }],
    });
    await waitRelease('rel-auth-recover-b', (r) => r.status === 'completed');
    await waitConfig('payments', 'ledger-entries', (c) => c.timeoutMs === 626);

    // Revoke B, lose the revoke receipt, restart the coordinator again.
    await addChaosRule('payments', {
      match: { pathIncludes: 'rel-auth-recover-b' },
      dropResponse: true,
    });
    const revokeResponse = await cFetch('/api/releases/rel-auth-recover-b/revoke', { method: 'POST' });
    assert.equal(revokeResponse.status, 202, revokeResponse.text);
    await waitFor('payments B revoked on disk', async () => {
      const response = await directFetch('payments', '/__admin/releases/rel-auth-recover-b');
      return response.status === 200 && response.body.status === 'revoked' ? response.body : null;
    });
    await waitRelease(
      'rel-auth-recover-b',
      (r) => r.status === 'revoking' && (r.revocation?.services.payments?.attempts ?? 0) >= 1,
    );

    await cluster!.restartCoordinator();
    await resetChaos('payments');
    await cFetch('/api/reconcile', { method: 'POST' });
    await waitRelease('rel-auth-recover-b', (r) => r.status === 'revoked', 15_000);
    // Selective rollback: removing the later B reveals earlier A=616, not initial.
    await waitConfig('payments', 'ledger-entries', (c) => c.timeoutMs === 616);

    // Revoke A normally: contribution removed, route returns to its initial 1500.
    await cFetch('/api/releases/rel-auth-recover/revoke', { method: 'POST' });
    await waitRelease('rel-auth-recover', (r) => r.status === 'revoked', 15_000);
    await waitConfig('payments', 'ledger-entries', (c) => c.timeoutMs === 1500);
  });

  await check('混沌能力保留：按发布 ID 注入延迟仍作用于已认证请求且签名头/回执透传', async () => {
    const managed = cluster!.getService('risk');
    managed.proxy.reset();
    await addChaosRule('risk', {
      match: { pathIncludes: 'rel-delay-auth' },
      delayResponseMs: 140,
      times: 1,
    });

    const started = Date.now();
    await createRelease({
      releaseId: 'rel-delay-auth',
      changes: [{ serviceId: 'risk', routeId: 'device-fingerprint', timeoutMs: 5151 }],
    });
    await waitRelease('rel-delay-auth', (r) => r.status === 'completed', 10_000);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 90, `注入的 140ms 应答延迟应可观测，实际完成耗时 ${elapsed}ms`);
    await waitConfig('risk', 'device-fingerprint', (c) => c.timeoutMs === 5151);

    const acceptRecord = managed.proxy.requests.find(
      (record) => record.method === 'POST' && record.path.includes('/releases/rel-delay-auth/accept'),
    );
    assert.ok(acceptRecord, '混沌代理应记录该发布的 accept 请求');
    assert.equal(acceptRecord?.targetStatus, 200, '延迟后应把已签名回执透传回协调器');
    assert.ok((acceptRecord?.durationMs ?? 0) >= 100, `代理记录时长应包含注入延迟，实际 ${acceptRecord?.durationMs}ms`);
  });

  clearTimeout(hardTimer);
  await cluster.stop();

  console.log('\n================ 结果 ================');
  console.log(`通过 ${passed} 项；失败 ${failures.length} 项。`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`- ${failure.name}: ${(failure.error as Error)?.message ?? failure.error}`);
    if (cluster) {
      console.error('\n协调器最近日志:\n', cluster.coordinatorLogs.slice(-60).join('\n'));
      for (const service of cluster.services.values()) {
        console.error(`\n服务 ${service.id} 最近日志:\n`, service.logs.slice(-40).join('\n'));
      }
      await cluster.stop().catch(() => undefined);
    }
    process.exit(1);
  }
  console.log('全部自检通过：发布、暂停、分批闸门、并发优先级、原子性、持久化、重启对账、双向认证（错投拒绝/可信回执/独立轮换/重启恢复）和夹具混沌控制均正常。');
  process.exit(0);
}

main().catch(async (error) => {
  clearTimeout(hardTimer);
  console.error('自检脚本致命错误:', error);
  if (cluster) {
    console.error('coordinator logs:', cluster.coordinatorLogs.slice(-80).join('\n'));
    for (const service of cluster.services.values()) {
      console.error(`service ${service.id} logs:`, service.logs.slice(-50).join('\n'));
    }
    await cluster.stop().catch(() => undefined);
  }
  process.exit(1);
});
