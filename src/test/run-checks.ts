import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { FixtureCluster } from '../fixture/cluster.js';
import { fetchJson } from '../shared/http.js';
import { delay } from '../shared/store.js';
import { ConfigService } from '../service/config-service.js';
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

async function directFetch(serviceId: string, pathname: string, init?: Parameters<typeof fetchJson>[1]) {
  return fetchJson(`${serviceUrl(serviceId)}${pathname}`, { timeoutMs: 5000, ...init });
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

/** Drops fault-injection rules but keeps the request log, so size/chunk
 * assertions still see every dispatch that ever happened. */
function clearChaosRules(serviceId: string): void {
  cluster!.getService(serviceId).proxy.rules = [];
}

function acceptRecords(serviceId: string, releaseId: string) {
  return cluster!
    .getService(serviceId)
    .proxy.requests.filter((record) => record.method === 'POST' && record.path.includes(`/releases/${releaseId}/accept`));
}

function allAcceptRecords(serviceId: string, releaseId: string) {
  return acceptRecords(serviceId, releaseId);
}

function chunkIndexOf(record: { path: string }): number | null {
  const match = /[?&]chunk=(\d+)/.exec(record.path);
  return match ? Number(match[1]) : null;
}

function progressService(release: any, serviceId: string): any {
  for (const batch of release.progress?.batches ?? []) {
    const found = batch.services.find((service: any) => service.serviceId === serviceId);
    if (found) return found;
  }
  return undefined;
}

function routeIdsOf(record: { requestBodyPreview?: string; routeIds: string[] }): string[] {
  if (record.routeIds.length > 0) return record.routeIds;
  try {
    const body = JSON.parse(record.requestBodyPreview ?? '{}');
    return Array.isArray(body.changes) ? body.changes.map((change: any) => String(change?.routeId ?? '')) : [];
  } catch {
    return [];
  }
}

async function waitServiceReleaseStatus(
  serviceId: string,
  releaseId: string,
  predicate: (body: any) => boolean,
  timeoutMs = 12_000,
): Promise<any> {
  return waitFor(
    `${serviceId} release status ${releaseId}`,
    async () => {
      const response = await directFetch(serviceId, `/__admin/releases/${encodeURIComponent(releaseId)}`);
      if (response.status !== 200) return null;
      return predicate(response.body) ? response.body : null;
    },
    timeoutMs,
  );
}

async function bulkChanges(count: number, offset = 0): Promise<any[]> {
  const routes = cluster!.fixture.services.find((service) => service.id === 'bulk')!.routes;
  assert.ok(routes.length >= count, 'bulk fixture must define enough routes');
  return routes.slice(offset, offset + count).map((route, index) => ({
    serviceId: 'bulk',
    routeId: route.id,
    timeoutMs: 2000 + (index % 97),
    rateLimitPerMinute: 100 + (index % 29),
  }));
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
    dispatchMaxBytes: 16 * 1024,
  });
  console.log(`临时持久化目录: ${cluster.dataDir}`);
  console.log(`协调器: ${cluster.coordinatorUrl}/`);
  console.log(`单次下发上限: ${cluster.dispatchMaxBytes} bytes`);

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
    const bad = await directFetch('checkout', '/__admin/releases/rel-atomic-bad/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-bad-atomic' },
      body: JSON.stringify({
        coordinatorAcceptedAt: new Date().toISOString(),
        acceptedOrder: 999_001,
        changes: [
          { serviceId: 'checkout', routeId: 'atomic-a', timeoutMs: 111 },
          { serviceId: 'checkout', routeId: 'missing-route', timeoutMs: 222 },
        ],
      }),
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
    const first = await fetch(`${cluster!.getService('checkout').directUrl}/__admin/releases/rel-atomic-good/accept`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-good-atomic' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-idempotent-replay'), null);

    const second = await fetch(`${cluster!.getService('checkout').directUrl}/__admin/releases/rel-atomic-good/accept`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-good-atomic' },
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
    const acceptBody = JSON.stringify({
      coordinatorAcceptedAt: new Date().toISOString(),
      acceptedOrder: 999_003,
      changes: [{ serviceId: 'checkout', routeId: 'customer-profile', timeoutMs: 444 }],
    });
    const accept = await fetch(`${url}/__admin/releases/rel-zombie/accept`, {
      method: 'POST',
      body: acceptBody,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-zombie-accept' },
    });
    assert.equal(accept.status, 200);
    await waitConfig('checkout', 'customer-profile', (c) => c.timeoutMs === 444);

    const revoke = await fetch(`${url}/__admin/releases/rel-zombie/revoke`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-zombie-revoke' },
    });
    assert.equal(revoke.status, 200);
    await waitConfig('checkout', 'customer-profile', (c) => c.timeoutMs === 700);

    const replay = await fetch(`${url}/__admin/releases/rel-zombie/accept`, {
      method: 'POST',
      body: acceptBody,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-zombie-accept' },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
    const release = await directFetch('checkout', '/__admin/releases/rel-zombie');
    assert.equal(release.body.status, 'revoked');
    const config = await directFetch('checkout', '/__admin/config/customer-profile');
    assert.equal(config.body.effective.timeoutMs, 700);
  });

  await check('超下发上限的单服务发布按实际字节拆片，每片只带本发布在该服务的内容', async () => {
    const bulk = cluster!.getService('bulk');
    bulk.proxy.reset();
    const changes = await bulkChanges(260);
    const created = await createRelease({
      releaseId: 'rel-chunked-bulk',
      changes,
    });
    const plan = created.services.bulk.chunkPlan;
    assert.ok(plan, `协调器应为该服务保存分片计划；实际 services=${JSON.stringify(created.services?.bulk)}`);
    assert.ok(plan.total >= 2, `260 条变更应拆成多片，实际 ${plan.total} 片`);
    assert.equal(created.dispatchMaxBytes, 16 * 1024);

    const done = await waitRelease('rel-chunked-bulk', (r) => r.status === 'completed', 20_000);
    assert.equal(progressService(done, 'bulk').chunks.total, plan.total);

    const records = allAcceptRecords('bulk', 'rel-chunked-bulk');
    assert.ok(records.length >= plan.total, '应至少每片一次 accept 请求');
    const chunkIndexes = new Set<number>();
    let totalBytes = 0;
    const expectedRouteIds = new Set(changes.map((change) => change.routeId));
    for (const record of records) {
      const index = chunkIndexOf(record);
      assert.notEqual(index, null, `每个分片请求都应带 chunk 序号: ${record.path}`);
      chunkIndexes.add(index!);
      assert.ok(record.requestBytes <= 16 * 1024, `分片 ${index} 请求体 ${record.requestBytes} 字节超过 16 KiB`);
      totalBytes += record.requestBytes;
      const routeIds = routeIdsOf(record);
      assert.ok(routeIds.length > 0, '分片请求应包含变更');
      for (const routeId of routeIds) {
        assert.ok(expectedRouteIds.has(routeId), `分片不应包含本次发布之外的 ${routeId}`);
        assert.ok(routeId.startsWith('bulk-'), `分片不应包含其他服务的路由 ${routeId}`);
      }
    }
    assert.equal(chunkIndexes.size, plan.total, '每个分片序号都应被下发');
    assert.ok(totalBytes > 16 * 1024, `整组变更 ${totalBytes} 字节应超过单次下发上限，才有意义`);

    const first = await directFetch('bulk', '/__admin/config/bulk-0001');
    assert.equal(first.body.effective.timeoutMs, 2000);
    const lastChange = changes[changes.length - 1]!;
    const lastRoute = await directFetch('bulk', `/__admin/config/${lastChange.routeId}`);
    assert.equal(lastRoute.body.effective.timeoutMs, lastChange.timeoutMs);
    const untouched = await directFetch('bulk', '/__admin/config/bulk-0261');
    assert.equal(untouched.body.effective.timeoutMs, 1000 + ((260 % 50) * 10));

    await cFetch('/api/releases/rel-chunked-bulk/revoke', { method: 'POST' });
    await waitRelease('rel-chunked-bulk', (r) => r.status === 'revoked');
    await waitConfig('bulk', 'bulk-0001', (c) => c.timeoutMs === 1000);
  });

  await check('单次下发上限可按发布配置：更小上限拆出更多分片，放不下的单条变更明确拒绝', async () => {
    const small = await createRelease({
      releaseId: 'rel-chunk-small-cap',
      dispatchMaxBytes: 1024,
      changes: await bulkChanges(260),
    });
    assert.equal(small.dispatchMaxBytes, 1024);
    const plan = small.services.bulk.chunkPlan;
    assert.ok(plan.total >= 20, `1 KiB 上限下 260 条变更应拆成 20 片以上，实际 ${plan.total}`);
    await waitRelease('rel-chunk-small-cap', (r) => r.status === 'completed', 20_000);
    const records = allAcceptRecords('bulk', 'rel-chunk-small-cap');
    for (const record of records) {
      assert.ok(record.requestBytes <= 1024, `按发布配置的上限仍是 1024，实际 ${record.requestBytes}`);
    }
    await cFetch('/api/releases/rel-chunk-small-cap/revoke', { method: 'POST' });
    await waitRelease('rel-chunk-small-cap', (r) => r.status === 'revoked');

    const tooSmall = await cFetch('/api/releases', {
      method: 'POST',
      body: JSON.stringify({
        releaseId: 'rel-chunk-impossible',
        dispatchMaxBytes: 120,
        changes: [{ serviceId: 'bulk', routeId: 'bulk-0001', timeoutMs: 4321, rateLimitPerMinute: 9999 }],
      }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(tooSmall.status, 400, tooSmall.text);
    assert.ok(tooSmall.body.error.includes('dispatch limit'), tooSmall.text);

    const invalidCap = await cFetch('/api/releases', {
      method: 'POST',
      body: JSON.stringify({
        releaseId: 'rel-chunk-invalid-cap',
        dispatchMaxBytes: 0,
        changes: [{ serviceId: 'bulk', routeId: 'bulk-0001', timeoutMs: 4321 }],
      }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(invalidCap.status, 400, invalidCap.text);
  });

  await check('分片收齐前保持原配置；同服务的其他发布不被卡住，整组生效后按受理顺序选值', async () => {
    const bulk = cluster!.getService('bulk');
    bulk.proxy.reset();
    await addChaosRule('bulk', {
      match: { pathIncludes: 'rel-mid-a', chunkIndex: 1 },
      dropRequest: true,
    });

    const changes = await bulkChanges(260);
    const a = await createRelease({
      releaseId: 'rel-mid-a',
      targetServiceIds: ['bulk', 'risk'],
      batches: [['bulk'], ['risk']],
      changes: [...changes, { serviceId: 'risk', routeId: 'score-order', timeoutMs: 3030 }],
    });
    assert.ok((a.services.bulk.chunkPlan.total ?? 0) >= 2, 'A 应被拆成多片');

    const partial = await waitServiceReleaseStatus('bulk', 'rel-mid-a', (body) => body.status === 'pending');
    assert.deepEqual(partial.receivedChunks, [0], '目前应只持久收到分片 0');
    assert.ok(partial.missingChunks.includes(1));
    const beforeApply = await directFetch('bulk', '/__admin/config/bulk-0001');
    assert.equal(beforeApply.body.effective.timeoutMs, 1000, '服务收齐整组前必须继续使用原配置');
    assert.equal(hasAnyReleaseRequest('risk', 'rel-mid-a'), false, '上一批整组未生效前不应下发下一批');

    // B covers the same config key on the same service; A being incomplete
    // must not block it.
    await createRelease({
      releaseId: 'rel-mid-b',
      changes: [{ serviceId: 'bulk', routeId: 'bulk-0001', timeoutMs: 4321 }],
    });
    await waitRelease('rel-mid-b', (r) => r.status === 'completed');
    await waitConfig('bulk', 'bulk-0001', (c) => c.timeoutMs === 4321);

    await resetChaos('bulk');
    const aDone = await waitRelease('rel-mid-a', (r) => r.status === 'completed', 20_000);
    assert.equal(aDone.progress.confirmedBatches, 2);
    const afterA = await directFetch('bulk', '/__admin/config/bulk-0001');
    assert.equal(afterA.body.effective.timeoutMs, 4321, '两份都被接纳后，较晚受理的 B 仍是赢家');
    const aValue = changes[1]!;
    const otherRoute = await directFetch('bulk', `/__admin/config/${aValue.routeId}`);
    assert.equal(otherRoute.body.effective.timeoutMs, aValue.timeoutMs);

    await cFetch('/api/releases/rel-mid-b/revoke', { method: 'POST' });
    await waitRelease('rel-mid-b', (r) => r.status === 'revoked');
    await waitConfig('bulk', 'bulk-0001', (c) => c.timeoutMs === 2000);

    await cFetch('/api/releases/rel-mid-a/revoke', { method: 'POST' });
    await waitRelease('rel-mid-a', (r) => r.status === 'revoked', 20_000);
    await waitConfig('bulk', 'bulk-0001', (c) => c.timeoutMs === 1000);
    await waitConfig('bulk', aValue.routeId, (c) => c.timeoutMs === 1000 + (1 % 50) * 10);
  });

  await check('通过原有入口撤销已完成的分片发布时，整组回退到其他适用发布或初始值', async () => {
    const bulk = cluster!.getService('bulk');
    bulk.proxy.reset();
    const base = await createRelease({
      releaseId: 'rel-fallback-base',
      changes: [
        { serviceId: 'bulk', routeId: 'bulk-0001', timeoutMs: 777 },
        { serviceId: 'bulk', routeId: 'bulk-0002', timeoutMs: 888, rateLimitPerMinute: 55 },
        { serviceId: 'bulk', routeId: 'bulk-0003', timeoutMs: 999 },
      ],
    });
    assert.ok(base.services.bulk.chunkPlan.total >= 1);
    await waitRelease('rel-fallback-base', (r) => r.status === 'completed');
    await waitConfig('bulk', 'bulk-0001', (c) => c.timeoutMs === 777);

    const changes = await bulkChanges(260);
    const chunked = await createRelease({ releaseId: 'rel-fallback-chunked', changes });
    assert.ok(chunked.services.bulk.chunkPlan.total >= 2, '回退组应跨多个分片');
    await waitRelease('rel-fallback-chunked', (r) => r.status === 'completed', 20_000);
    const covered = await directFetch('bulk', '/__admin/config/bulk-0004');
    assert.equal(covered.body.effective.timeoutMs, changes[3]!.timeoutMs);

    const revoke = await cFetch('/api/releases/rel-fallback-chunked/revoke', { method: 'POST' });
    assert.equal(revoke.status, 202);
    const revoked = await waitRelease('rel-fallback-chunked', (r) => r.status === 'revoked', 20_000);
    assert.equal(revoked.revocationProgress.confirmedBatches, revoked.revocationProgress.totalBatches);

    // Routes also covered by the older release fall back to it.
    await waitConfig('bulk', 'bulk-0001', (c) => c.timeoutMs === 777);
    await waitConfig('bulk', 'bulk-0002', (c) => c.timeoutMs === 888 && c.rateLimitPerMinute === 55);
    await waitConfig('bulk', 'bulk-0003', (c) => c.timeoutMs === 999);
    // Every other route in the revoked group falls back to its initial value.
    await waitConfig('bulk', 'bulk-0004', (c) => c.timeoutMs === 1000 + ((3 % 50) * 10));
    const lastChange = changes[changes.length - 1]!;
    const lastIndex = 259;
    await waitConfig('bulk', lastChange.routeId, (c) => c.timeoutMs === 1000 + ((lastIndex % 50) * 10));

    const serviceState = await directFetch('bulk', '/__admin/releases/rel-fallback-chunked');
    assert.equal(serviceState.body.status, 'revoked');
    assert.equal(serviceState.body.changesApplied, false);

    await cFetch('/api/releases/rel-fallback-base/revoke', { method: 'POST' });
    await waitRelease('rel-fallback-base', (r) => r.status === 'revoked');
    await waitConfig('bulk', 'bulk-0001', (c) => c.timeoutMs === 1000);
    await waitConfig('bulk', 'bulk-0002', (c) => c.timeoutMs === 1010 && c.rateLimitPerMinute === 101);
  });

  await check('应答丢失后只补发服务未持久收到的分片，不重发已落盘分片', async () => {
    const bulk = cluster!.getService('bulk');
    bulk.proxy.reset();
    await addChaosRule('bulk', {
      match: { pathIncludes: 'rel-lost-chunk', chunkIndex: 0 },
      dropResponse: true,
    });
    await createRelease({
      releaseId: 'rel-lost-chunk',
      changes: await bulkChanges(260),
    });
    await waitRelease('rel-lost-chunk', (r) => r.status === 'completed', 20_000);

    const records = allAcceptRecords('bulk', 'rel-lost-chunk');
    const chunkZero = records.filter((record) => chunkIndexOf(record) === 0);
    assert.equal(chunkZero.length, 1, '分片 0 已落盘，应答丢失后不应再次下发');
    assert.equal(chunkZero[0]!.outcome, 'response-dropped');
    const otherIndexes = new Set(records.filter((record) => chunkIndexOf(record) !== 0).map(chunkIndexOf));
    assert.ok(otherIndexes.size >= 1, '其余分片应被补发');
    await waitConfig('bulk', 'bulk-0001', (c) => c.timeoutMs === 2000);

    await cFetch('/api/releases/rel-lost-chunk/revoke', { method: 'POST' });
    await waitRelease('rel-lost-chunk', (r) => r.status === 'revoked', 20_000);
    await resetChaos('bulk');
  });

  await check('服务与协调器重启后，只按已持久收到的分片继续补发并由协调器确认', async () => {
    const bulk = cluster!.getService('bulk');
    bulk.proxy.reset();
    await addChaosRule('bulk', {
      match: { pathIncludes: 'rel-restart-chunked', chunkIndex: 1 },
      dropRequest: true,
    });
    await createRelease({
      releaseId: 'rel-restart-chunked',
      changes: await bulkChanges(260),
    });
    const partial = await waitServiceReleaseStatus('bulk', 'rel-restart-chunked', (body) => body.status === 'pending');
    assert.deepEqual(partial.receivedChunks, [0]);
    const beforeRestart = await directFetch('bulk', '/__admin/config/bulk-0001');
    assert.equal(beforeRestart.body.effective.timeoutMs, 1000);

    const chunkZeroBefore = allAcceptRecords('bulk', 'rel-restart-chunked').filter(
      (record) => chunkIndexOf(record) === 0,
    ).length;
    await cluster!.restartService('bulk');
    const afterServiceRestart = await waitServiceReleaseStatus(
      'bulk',
      'rel-restart-chunked',
      (body) => body.status === 'pending',
    );
    assert.deepEqual(afterServiceRestart.receivedChunks, [0], '服务重启后应从磁盘恢复已收到的分片');
    const stillOld = await directFetch('bulk', '/__admin/config/bulk-0001');
    assert.equal(stillOld.body.effective.timeoutMs, 1000, '重启后未收齐前仍用原配置');

    await cluster!.restartCoordinator();
    await delay(200);
    const chunkZeroAfterRestart = allAcceptRecords('bulk', 'rel-restart-chunked').filter(
      (record) => chunkIndexOf(record) === 0,
    ).length;
    assert.equal(chunkZeroAfterRestart, chunkZeroBefore, '两端重启后不应补发已持久收到的分片 0');

    await clearChaosRules('bulk');
    await cFetch('/api/reconcile', { method: 'POST' });
    const done = await waitRelease('rel-restart-chunked', (r) => r.status === 'completed', 20_000);
    const doneService = progressService(done, 'bulk');
    assert.equal(doneService.chunks.confirmed, doneService.chunks.total);
    await waitConfig('bulk', 'bulk-0001', (c) => c.timeoutMs === 2000);
    assert.equal(
      allAcceptRecords('bulk', 'rel-restart-chunked').filter((record) => chunkIndexOf(record) === 0).length,
      chunkZeroBefore,
      '恢复后仍不应重发分片 0',
    );

    await cFetch('/api/releases/rel-restart-chunked/revoke', { method: 'POST' });
    await waitRelease('rel-restart-chunked', (r) => r.status === 'revoked', 20_000);
    await waitConfig('bulk', 'bulk-0001', (c) => c.timeoutMs === 1000);
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
  console.log(
    '全部自检通过：分片下发大小、分批推进、收齐前保持原配置、应答丢失与重启恢复、撤销回退、原子性、持久化均正常。',
  );
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
