import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

/**
 * Directly tampers with a service's persisted file to recreate the historical
 * damage of a conflicting resend, then restarts the process so the state is
 * reloaded from disk.
 */
async function corruptServiceState(
  serviceId: string,
  _releaseId: string,
  mutate: (state: ServicePersistentState) => void,
): Promise<void> {
  const stateFile = path.join(cluster!.dataDir, 'services', `${serviceId}.json`);
  const state = JSON.parse(await readFile(stateFile, 'utf8')) as ServicePersistentState;
  mutate(state);
  await writeFile(stateFile, JSON.stringify(state, null, 2));
  await cluster!.restartService(serviceId);
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

  await check('同发布 ID 的不同载荷被拒绝；合法重送仍返回首次结果且不叠加候选', async () => {
    const url = cluster!.getService('checkout').directUrl;
    const acceptedAt = new Date().toISOString();
    const firstBody = JSON.stringify({
      coordinatorAcceptedAt: acceptedAt,
      acceptedOrder: 999_010,
      changes: [
        { serviceId: 'checkout', routeId: 'atomic-a', timeoutMs: 1500 },
        { serviceId: 'checkout', routeId: 'atomic-b', timeoutMs: 1600 },
      ],
    });
    const first = await fetch(`${url}/__admin/releases/rel-payload-conflict/accept`, {
      method: 'POST',
      body: firstBody,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-payload-1' },
    });
    assert.equal(first.status, 200);
    const firstJson = await first.clone().json();

    // Same idempotency key, different payload -> refuse.
    const sameKeyDifferent = await fetch(`${url}/__admin/releases/rel-payload-conflict/accept`, {
      method: 'POST',
      body: JSON.stringify({
        coordinatorAcceptedAt: acceptedAt,
        acceptedOrder: 999_010,
        changes: [{ serviceId: 'checkout', routeId: 'atomic-a', timeoutMs: 1 }],
      }),
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-payload-1' },
    });
    assert.equal(sameKeyDifferent.status, 409);
    assert.equal(((await sameKeyDifferent.json()) as any).conflict, 'payload-mismatch');

    // Different key, different payload -> refuse as well.
    const differentKeyDifferent = await fetch(`${url}/__admin/releases/rel-payload-conflict/accept`, {
      method: 'POST',
      body: JSON.stringify({
        coordinatorAcceptedAt: new Date(Date.parse(acceptedAt) + 5).toISOString(),
        acceptedOrder: 999_011,
        changes: [{ serviceId: 'checkout', routeId: 'atomic-a', timeoutMs: 2 }],
      }),
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-payload-2' },
    });
    assert.equal(differentKeyDifferent.status, 409);
    assert.equal(((await differentKeyDifferent.json()) as any).conflict, 'payload-mismatch');

    // Same payload, different key -> first result, marked as a replay, no extra candidate.
    const resend = await fetch(`${url}/__admin/releases/rel-payload-conflict/accept`, {
      method: 'POST',
      body: firstBody,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-payload-3' },
    });
    assert.equal(resend.status, 200);
    assert.equal(resend.headers.get('x-idempotent-replay'), 'true');
    assert.deepEqual(await resend.json(), firstJson);

    const config = await directFetch('checkout', '/__admin/config/atomic-a');
    assert.equal(config.body.effective.timeoutMs, 1500, '冲突载荷不应改变取值');
    const consistency = await directFetch('checkout', '/__admin/releases/rel-payload-conflict/consistency');
    assert.equal(consistency.body.consistency.consistent, true, JSON.stringify(consistency.body.consistency));
    const candidates = consistency.body.routes['atomic-a'].candidates.timeoutMs as Array<{ releaseId: string; value: number }>;
    assert.equal(candidates.filter((item) => item.releaseId === 'rel-payload-conflict').length, 1);
    assert.equal(candidates.find((item) => item.releaseId === 'rel-payload-conflict')?.value, 1500);

    // Clean up so this release no longer hides later assertions.
    const cleanup = await fetch(`${url}/__admin/releases/rel-payload-conflict/revoke`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-payload-cleanup' },
    });
    assert.equal(cleanup.status, 200);
  });

  await check('协调器整组修复：清除多余项、补齐缺失项并保持撤销，未派发批次不动', async () => {
    const url = cluster!.getService('checkout').directUrl;
    const acceptedAt = new Date().toISOString();
    const accept = await fetch(`${url}/__admin/releases/rel-repair-group/accept`, {
      method: 'POST',
      body: JSON.stringify({
        coordinatorAcceptedAt: acceptedAt,
        acceptedOrder: 999_020,
        changes: [
          { serviceId: 'checkout', routeId: 'repair-gamma', timeoutMs: 1700 },
          { serviceId: 'checkout', routeId: 'repair-delta', timeoutMs: 1800 },
        ],
      }),
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-repair-group' },
    });
    assert.equal(accept.status, 200);

    // Simulate the historical damage of a conflicting resend: an extra
    // candidate on an untouched route plus a duplicate, and a missing key.
    const stateFile = path.join(
      cluster!.dataDir,
      'services',
      'checkout.json',
    );
    const before = JSON.parse(await readFile(stateFile, 'utf8')) as ServicePersistentState;
    (before.candidates['repair-extra'] ??= {}).timeoutMs = [
      {
        releaseId: 'rel-repair-group',
        coordinatorAcceptedAt: acceptedAt,
        acceptedOrder: 999_020,
        value: 42,
      },
    ];
    before.candidates['repair-gamma']!.timeoutMs!.push({
      releaseId: 'rel-repair-group',
      coordinatorAcceptedAt: acceptedAt,
      acceptedOrder: 999_020,
      value: 1717,
    });
    delete before.candidates['repair-delta']!.timeoutMs;
    before.routes['repair-delta']!.effective.timeoutMs = 1800;
    await writeFile(stateFile, JSON.stringify(before, null, 2));
    await cluster!.restartService('checkout');

    const dirty = await directFetch('checkout', '/__admin/releases/rel-repair-group/consistency');
    assert.equal(dirty.body.consistency.consistent, false);

    const repair = await directFetch('checkout', '/__admin/releases/rel-repair-group/repair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetStatus: 'active',
        coordinatorAcceptedAt: acceptedAt,
        acceptedOrder: 999_020,
        changes: [
          { serviceId: 'checkout', routeId: 'repair-gamma', timeoutMs: 1700 },
          { serviceId: 'checkout', routeId: 'repair-delta', timeoutMs: 1800 },
        ],
      }),
    });
    assert.equal(repair.status, 200, repair.text);
    assert.equal(repair.body.ok, true, JSON.stringify(repair.body.issues));

    const configA = await directFetch('checkout', '/__admin/config/repair-gamma');
    const configB = await directFetch('checkout', '/__admin/config/repair-delta');
    const configExtra = await directFetch('checkout', '/__admin/config/repair-extra');
    assert.equal(configA.body.effective.timeoutMs, 1700);
    assert.equal(configB.body.effective.timeoutMs, 1800);
    assert.equal(configExtra.body.effective.timeoutMs, 1800, '多余项应被移除并回退到初始值');

    const clean = await directFetch('checkout', '/__admin/releases/rel-repair-group/consistency');
    assert.equal(clean.body.consistency.consistent, true, JSON.stringify(clean.body.consistency));

    // A legal resend of the same payload still yields the first accept result,
    // even after the repair rewrote the group.
    const resend = await fetch(`${url}/__admin/releases/rel-repair-group/accept`, {
      method: 'POST',
      body: JSON.stringify({
        coordinatorAcceptedAt: acceptedAt,
        acceptedOrder: 999_020,
        changes: [
          { serviceId: 'checkout', routeId: 'repair-gamma', timeoutMs: 1700 },
          { serviceId: 'checkout', routeId: 'repair-delta', timeoutMs: 1800 },
        ],
      }),
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-repair-group-resend' },
    });
    assert.equal(resend.status, 200);
    assert.equal(resend.headers.get('x-idempotent-replay'), 'true');
    const recordedFirst = clean.body.record.acceptResponse.body;
    assert.deepEqual(await resend.json(), recordedFirst);
    const afterResend = await directFetch('checkout', '/__admin/releases/rel-repair-group/consistency');
    assert.equal(afterResend.body.consistency.consistent, true, '合法重送不应重新叠加候选');
    assert.equal(
      (afterResend.body.routes['repair-gamma'].candidates.timeoutMs as Array<{ releaseId: string }>).filter(
        (item) => item.releaseId === 'rel-repair-group',
      ).length,
      1,
    );

    // Revoked releases keep their revocation and lose any residue.
    const revoke = await directFetch('checkout', '/__admin/releases/rel-repair-group/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-repair-group-revoke' },
      body: '{}',
    });
    assert.equal(revoke.status, 200);
    const residue = await directFetch('checkout', '/__admin/releases/rel-repair-group/repair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetStatus: 'revoked' }),
    });
    assert.equal(residue.status, 200, residue.text);
    assert.equal(residue.body.status, 'revoked');
    assert.equal(residue.body.consistent, true);
    const revokedRelease = await directFetch('checkout', '/__admin/releases/rel-repair-group');
    assert.equal(revokedRelease.body.status, 'revoked');
    const afterRevokeCleanup = await directFetch('checkout', '/__admin/config/repair-gamma');
    assert.equal(afterRevokeCleanup.body.effective.timeoutMs, 1600, '撤销后应回退到初始值');
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

  await check('未派发批次在修复时保持原状', async () => {
    await addChaosRule('checkout', {
      match: { pathIncludes: 'rel-repair-partial' },
      dropResponse: true,
    });
    await createRelease({
      releaseId: 'rel-repair-partial',
      batches: [['checkout'], ['payments', 'risk']],
      changes: [
        { serviceId: 'checkout', routeId: 'repair-beta', timeoutMs: 1850 },
        { serviceId: 'payments', routeId: 'ledger-entries', timeoutMs: 2050 },
        { serviceId: 'risk', routeId: 'rules-config', timeoutMs: 3050 },
      ],
    });
    await waitFor('checkout accepted rel-repair-partial', async () => {
      const response = await directFetch('checkout', '/__admin/releases/rel-repair-partial');
      return response.status === 200 && response.body.status === 'active' ? response.body : null;
    });
    await cFetch('/api/releases/rel-repair-partial/pause', { method: 'POST' });
    // Let the already-dispatched first batch settle so the release parks in
    // `paused` before the second batch.
    await resetChaos('checkout');
    await waitRelease('rel-repair-partial', (r) => r.status === 'paused');

    // Second batch must have never been dispatched.
    const before = await cFetch('/api/releases/rel-repair-partial');
    assert.equal(before.body.services.payments.status, 'pending');
    assert.equal(before.body.services.risk.status, 'pending');
    assert.equal(hasAnyReleaseRequest('payments', 'rel-repair-partial'), false);
    assert.equal(hasAnyReleaseRequest('risk', 'rel-repair-partial'), false);

    await resetChaos('checkout');
    const repaired = await cFetch('/api/releases/rel-repair-partial/repair', { method: 'POST' });
    assert.equal(repaired.status, 200, repaired.text);

    // Repair must not have touched the never-dispatched batch.
    assert.equal(hasAnyReleaseRequest('payments', 'rel-repair-partial'), false);
    assert.equal(hasAnyReleaseRequest('risk', 'rel-repair-partial'), false);
    const afterBatch = await cFetch('/api/releases/rel-repair-partial');
    assert.equal(afterBatch.body.services.payments.status, 'pending');
    assert.equal(afterBatch.body.services.risk.status, 'pending');

    // The paused release can be resumed and finish normally afterwards.
    await cFetch('/api/releases/rel-repair-partial/resume', { method: 'POST' });
    await waitRelease('rel-repair-partial', (r) => r.status === 'completed');
  });

  await check('协调器修复：回执丢失时凭服务现态确认完成；有错误贡献则不能报成功', async () => {
    // Clean release, then corrupt one service's persisted state directly.
    await createRelease({
      releaseId: 'rel-repair-coord',
      changes: [
        { serviceId: 'checkout', routeId: 'repair-alpha', timeoutMs: 1900 },
        { serviceId: 'checkout', routeId: 'repair-beta', timeoutMs: 1950 },
      ],
    });
    await waitRelease('rel-repair-coord', (r) => r.status === 'completed');
    await waitConfig('checkout', 'repair-alpha', (c) => c.timeoutMs === 1900);

    await corruptServiceState('checkout', 'rel-repair-coord', (state) => {
      // Extra contribution on an unrelated route, plus a duplicate on alpha.
      state.candidates['confirm-payment'] ??= {};
      state.candidates['confirm-payment']!.timeoutMs = [
        ...(state.candidates['confirm-payment']!.timeoutMs ?? []),
        {
          releaseId: 'rel-repair-coord',
          coordinatorAcceptedAt: state.releases['rel-repair-coord']!.coordinatorAcceptedAt,
          acceptedOrder: state.releases['rel-repair-coord']!.acceptedOrder,
          value: 111,
        },
      ];
      state.candidates['repair-alpha']!.timeoutMs!.push({
        releaseId: 'rel-repair-coord',
        coordinatorAcceptedAt: state.releases['rel-repair-coord']!.coordinatorAcceptedAt,
        acceptedOrder: state.releases['rel-repair-coord']!.acceptedOrder,
        value: 1,
      });
    });

    const dirty = await directFetch('checkout', '/__admin/releases/rel-repair-coord/consistency');
    assert.equal(dirty.body.consistency.consistent, false);
    assert.ok(dirty.body.consistency.extraCandidates.length >= 1);
    assert.ok(dirty.body.consistency.duplicateCandidates.length >= 1);

    // Repair response is dropped, but the write lands. The coordinator must
    // confirm via the service's current state rather than reporting failure.
    await resetChaos('checkout');
    await addChaosRule('checkout', {
      match: { method: 'POST', pathIncludes: 'rel-repair-coord/repair' },
      dropResponse: true,
    });
    const repaired = await cFetch('/api/releases/rel-repair-coord/repair', { method: 'POST' });
    assert.equal(repaired.status, 200, repaired.text);
    assert.equal(repaired.body.repaired, true);
    assert.equal(repaired.body.repair.services.checkout.confirmedViaState, true);

    const clean = await directFetch('checkout', '/__admin/releases/rel-repair-coord/consistency');
    assert.equal(clean.body.consistency.consistent, true, JSON.stringify(clean.body.consistency));

    const configExtra = await directFetch('checkout', '/__admin/config/confirm-payment');
    assert.equal(configExtra.body.effective.timeoutMs, 1200, '多余贡献应被移除');

    // With a bad contribution still present and the repair write blocked, the
    // read-back shows inconsistency, so the coordinator must report failure.
    await corruptServiceState('checkout', 'rel-repair-coord', (state) => {
      state.candidates['repair-alpha']!.timeoutMs!.push({
        releaseId: 'rel-repair-coord',
        coordinatorAcceptedAt: state.releases['rel-repair-coord']!.coordinatorAcceptedAt,
        acceptedOrder: state.releases['rel-repair-coord']!.acceptedOrder,
        value: 1,
      });
    });
    await resetChaos('checkout');
    await addChaosRule('checkout', {
      match: { method: 'POST', pathIncludes: 'rel-repair-coord/repair' },
      dropRequest: true,
    });
    const failed = await cFetch('/api/releases/rel-repair-coord/repair', { method: 'POST' });
    assert.equal(failed.status, 409, failed.text);
    assert.equal(failed.body.repaired, false);
    assert.equal(failed.body.repair.services.checkout.status, 'failed');
    await resetChaos('checkout');
    const stillDirty = await directFetch('checkout', '/__admin/releases/rel-repair-coord/consistency');
    assert.equal(stillDirty.body.consistency.consistent, false);

    // Once the write path is clear again, repair succeeds and cleans it up.
    const recovered = await cFetch('/api/releases/rel-repair-coord/repair', { method: 'POST' });
    assert.equal(recovered.status, 200, recovered.text);
    const recoveredState = await directFetch('checkout', '/__admin/releases/rel-repair-coord/consistency');
    assert.equal(recoveredState.body.consistency.consistent, true);
  });

  await check('重启或重送旧接纳/撤销请求后修复仍有效；残留被后续发布盖住时撤销后续发布会露出修正值', async () => {
    const url = cluster!.getService('checkout').directUrl;

    // Publish a later release that covers the same route, so the corrected
    // value is hidden behind it.
    await createRelease({
      releaseId: 'rel-repair-cover',
      changes: [{ serviceId: 'checkout', routeId: 'repair-alpha', timeoutMs: 1200 }],
    });
    await waitRelease('rel-repair-cover', (r) => r.status === 'completed');
    await waitConfig('checkout', 'repair-alpha', (c) => c.timeoutMs === 1200);

    // Restart the coordinator and a service; then replay the old accept and
    // revoke requests (a legal resend must not re-add or un-revoke anything).
    await cluster!.restartCoordinator();
    await cluster!.restartService('checkout');

    const acceptBody = JSON.stringify({
      coordinatorAcceptedAt: '2026-01-01T00:00:00.000Z',
      acceptedOrder: 999_999,
      changes: [{ serviceId: 'checkout', routeId: 'repair-alpha', timeoutMs: 1900 }],
    });
    const resend = await fetch(`${url}/__admin/releases/rel-repair-coord/accept`, {
      method: 'POST',
      body: acceptBody,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-repair-coord-old' },
    });
    assert.equal(resend.status, 409, '重送与已接纳载荷不同的请求应被拒绝');

    // A legal resend of the exact accepted payload (new key) still replays the
    // first accept result after both restarts.
    const record = (await directFetch('checkout', '/__admin/releases/rel-repair-coord')).body;
    const exactPayload = JSON.stringify({
      coordinatorAcceptedAt: record.coordinatorAcceptedAt,
      acceptedOrder: record.acceptedOrder,
      changes: record.changes,
    });
    const legalResend = await fetch(`${url}/__admin/releases/rel-repair-coord/accept`, {
      method: 'POST',
      body: exactPayload,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-repair-coord-legal' },
    });
    assert.equal(legalResend.status, 200, await legalResend.clone().text());
    assert.equal(legalResend.headers.get('x-idempotent-replay'), 'true');
    const beforeLegalConsistency = await directFetch('checkout', '/__admin/releases/rel-repair-coord/consistency');
    assert.equal(beforeLegalConsistency.body.consistency.consistent, true, '合法重送不应破坏修复结果');

    const repairAgain = await cFetch('/api/releases/rel-repair-coord/repair', { method: 'POST' });
    assert.equal(repairAgain.status, 200, repairAgain.text);

    // Revoking the later release must reveal the repaired value.
    await cFetch('/api/releases/rel-repair-cover/revoke', { method: 'POST' });
    await waitRelease('rel-repair-cover', (r) => r.status === 'revoked');
    await waitConfig('checkout', 'repair-alpha', (c) => c.timeoutMs === 1900);

    // Revoking the repaired release falls back to the initial value.
    await cFetch('/api/releases/rel-repair-coord/revoke', { method: 'POST' });
    await waitRelease('rel-repair-coord', (r) => r.status === 'revoked');
    await waitConfig('checkout', 'repair-alpha', (c) => c.timeoutMs === 1400);

    // Replaying the old revoke must not change anything.
    const revokeReplay = await fetch(`${url}/__admin/releases/rel-repair-coord/revoke`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'key-repair-coord-old-revoke' },
    });
    assert.equal(revokeReplay.status, 200);
    const stillOriginal = await directFetch('checkout', '/__admin/config/repair-alpha');
    assert.equal(stillOriginal.body.effective.timeoutMs, 1400);
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
  console.log('全部自检通过：发布、暂停、并发优先级、原子性、载荷冲突拒绝、操作员修复、持久化、重启对账和夹具控制均正常。');
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
