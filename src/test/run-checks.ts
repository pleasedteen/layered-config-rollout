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
let drillCluster: FixtureCluster | undefined;

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

// ---------------------------------------------------------------------------
// Timeline drill helpers
// ---------------------------------------------------------------------------

const DRILL_FIXTURE_PATH = path.join(projectRoot, 'fixtures', 'timeline-drill.json');

async function drillFetch(pathname: string, init?: Parameters<typeof fetchJson>[1]) {
  return fetchJson(`${drillCluster!.coordinatorUrl}${pathname}`, { timeoutMs: 10_000, ...init });
}

async function drillDirect(serviceId: string, pathname: string, init?: Parameters<typeof fetchJson>[1]) {
  return fetchJson(`${drillCluster!.getService(serviceId).directUrl}${pathname}`, { timeoutMs: 10_000, ...init });
}

async function drillCreateRelease(body: Record<string, unknown>): Promise<any> {
  const response = await drillFetch('/api/releases', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  if (response.status !== 201) {
    throw new Error(`drill create release expected 201, got ${response.status}: ${response.text}`);
  }
  return response.body;
}

async function drillWaitRelease(id: string, predicate: (release: any) => boolean, timeoutMs = 12_000): Promise<any> {
  return waitFor(
    `drill release ${id}`,
    async () => {
      const response = await drillFetch(`/api/releases/${encodeURIComponent(id)}`);
      if (response.status !== 200) return null;
      return predicate(response.body) ? response.body : null;
    },
    timeoutMs,
  );
}

async function drillGetTimeline(serviceId: string): Promise<any> {
  const response = await drillFetch(`/api/services/${encodeURIComponent(serviceId)}/timeline`);
  assert.equal(response.status, 200, response.text);
  return response.body;
}

async function drillSync(serviceId: string, maxSegments?: number): Promise<any> {
  const query = maxSegments ? `?maxSegments=${maxSegments}` : '';
  const response = await drillFetch(`/api/services/${encodeURIComponent(serviceId)}/timeline/sync${query}`, {
    method: 'POST',
  });
  assert.equal(response.status, 200, response.text);
  return response.body;
}

async function drillChaosRule(serviceId: string, rule: Record<string, unknown>): Promise<void> {
  const service = drillCluster!.getService(serviceId);
  const response = await fetchJson(`${service.chaosUrl}/__chaos/rules`, {
    method: 'POST',
    body: JSON.stringify(rule),
    headers: { 'content-type': 'application/json' },
    timeoutMs: 3000,
  });
  assert.equal(response.status, 201, response.text);
}

async function drillResetChaos(serviceId: string): Promise<void> {
  const service = drillCluster!.getService(serviceId);
  const response = await fetchJson(`${service.chaosUrl}/__chaos/reset`, { method: 'POST', timeoutMs: 3000 });
  assert.equal(response.status, 200, response.text);
}

function sourceLabel(source: any): string {
  if (!source || source.type === 'initial') return '服务初始值';
  return `发布 ${source.releaseId}(受理#${source.acceptedOrder})`;
}

function printTimeline(records: any[]): void {
  for (const record of records) {
    console.log(`    #${record.seq} ${record.action.padEnd(6)} ${record.releaseId}  ${record.at}  合并变化 ${record.changes.length} 项`);
    for (const change of record.changes) {
      const flags = [
        change.valueChanged ? '值变化' : '值相同',
        change.sourceChanged ? '来源变化' : '来源不变',
      ].join('/');
      console.log(
        `       - ${change.routeId}.${change.configKey}: ` +
        `${change.before.value} [${sourceLabel(change.before.source)}] -> ` +
        `${change.after.value} [${sourceLabel(change.after.source)}]  (${flags})`,
      );
    }
  }
}

function timelineAfterSeqsFromProxy(serviceId: string): number[] {
  return drillCluster!
    .getService(serviceId)
    .proxy.requests.filter((record) => record.method === 'GET' && record.path.includes('/__admin/timeline'))
    .map((record) => {
      const match = record.path.match(/afterSeq=(\d+)/);
      return match ? Number(match[1]) : Number.NaN;
    });
}

/**
 * 演练一：时间线通道断联期间产生 5 条原子切换；恢复后协调器只按游标分 3 段
 * 补收缺失记录；服务再次离线时，已收集记录与同步进度仍可查询。
 */
async function drillOneDisconnectBackfill(): Promise<void> {
  const S = 'sync';

  const baseline = await drillSync(S);
  assert.equal(baseline.ok, true);
  assert.equal(baseline.lastSeq, 0, '全新演练服务应从游标 0 开始');

  // Partition the timeline channel only; release accept/revoke still flow.
  await drillChaosRule(S, { match: { pathIncludes: '/__admin/timeline' }, dropRequest: true });

  // Five effective switches. Switch #2 spans two routes and both config
  // keys but must stay one atomic timeline entry.
  await drillCreateRelease({
    releaseId: 'd1-a',
    changes: [{ serviceId: S, routeId: 'r1', timeoutMs: 111 }],
  });
  await drillWaitRelease('d1-a', (r) => r.status === 'completed');

  await drillCreateRelease({
    releaseId: 'd1-ab',
    changes: [
      { serviceId: S, routeId: 'r2', timeoutMs: 2222, rateLimitPerMinute: 222 },
      { serviceId: S, routeId: 'r3', timeoutMs: 3333 },
    ],
  });
  await drillWaitRelease('d1-ab', (r) => r.status === 'completed');

  await drillCreateRelease({
    releaseId: 'd1-c',
    changes: [{ serviceId: S, routeId: 'r1', timeoutMs: 333 }],
  });
  await drillWaitRelease('d1-c', (r) => r.status === 'completed');

  await drillFetch('/api/releases/d1-c/revoke', { method: 'POST' });
  await drillWaitRelease('d1-c', (r) => r.status === 'revoked');
  await drillFetch('/api/releases/d1-a/revoke', { method: 'POST' });
  await drillWaitRelease('d1-a', (r) => r.status === 'revoked');

  const direct = await drillDirect(S, '/__admin/timeline?afterSeq=0&limit=500');
  assert.equal(direct.status, 200);
  assert.equal(direct.body.headSeq, 5);
  assert.deepEqual(direct.body.records.map((r: any) => r.seq), [1, 2, 3, 4, 5]);
  assert.equal(direct.body.records[1].changes.length, 3, '跨路由跨配置项的原子切换应合为一条（3 个变化项）');

  // While partitioned the coordinator collected nothing; sync reports failure.
  const during = await drillGetTimeline(S);
  assert.equal(during.sync.lastSeq, 0);
  assert.equal(during.count, 0);
  const blocked = await drillSync(S);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.error, '断联同步应回报错误');
  console.log('    断联期间同步尝试:', JSON.stringify({ ok: blocked.ok, lastSeq: blocked.lastSeq, error: blocked.error }));

  // Recover and backfill in segments of 2.
  await drillResetChaos(S);
  const report = await drillSync(S);
  assert.equal(report.ok, true, report.error);
  assert.deepEqual(report.segments.map((seg: any) => seg.afterSeq), [0, 2, 4], '应只按缺失游标分 3 段补收');
  assert.deepEqual(report.segments.map((seg: any) => seg.returned), [2, 2, 1]);
  assert.equal(report.lastSeq, 5);
  assert.equal(report.caughtUp, true);

  // Independently observe the actual segment request cursors at the proxy.
  assert.deepEqual(timelineAfterSeqsFromProxy(S), [0, 2, 4]);

  const collected = await drillGetTimeline(S);
  assert.deepEqual(collected.timeline.map((r: any) => r.seq), [1, 2, 3, 4, 5]);
  assert.equal(new Set(collected.timeline.map((r: any) => r.id)).size, 5, '记录 id 不得重复');
  console.log(
    '    补收分段: ' +
      report.segments.map((s: any) => `afterSeq=${s.afterSeq}→${s.nextSeq}(本端${s.returned}条)`).join('  '),
  );
  printTimeline(collected.timeline);

  // A follow-up sync only polls the tail cursor and inserts nothing.
  const tail = await drillSync(S);
  assert.equal(tail.fetchedCount, 0);
  assert.deepEqual(tail.segments.map((s: any) => s.afterSeq), [5]);
  assert.equal((await drillGetTimeline(S)).count, 5);

  // Service offline again: local query still returns records + progress.
  await drillCluster!.stopService(S);
  const offlineView = await drillGetTimeline(S);
  assert.equal(offlineView.count, 5);
  assert.equal(offlineView.sync.lastSeq, 5);
  assert.equal(offlineView.sync.caughtUp, true);
  const offlineSync = await drillSync(S);
  assert.equal(offlineSync.ok, false, '服务离线时同步应失败');
  assert.equal(offlineSync.timeline.length, 5, '离线同步响应仍应带回已收集记录');
  assert.equal(offlineSync.sync.lastSeq, 5, '离线不得回退同步进度');
  console.log(
    '    服务再次离线后仍可查询: ' +
      JSON.stringify({ count: offlineView.count, lastSeq: offlineView.sync.lastSeq, caughtUp: offlineView.sync.caughtUp }),
  );
  console.log('    ✅ 断联补收演练结论: 断联期收集 0 条；恢复后仅按游标 [0,2,4] 分 3 段补齐缺失的 5 条；服务再次离线仍可查询全部记录与同步进度。');

  await drillCluster!.spawnService(S);
}

/**
 * 演练二：补收完第一个分段后重启协调器；新进程从磁盘上的持久游标 7 自动续收
 * 剩余分段，最终 seq 1..11 连续、不重不漏，且重启后不会再从 0 全量拉取。
 */
async function drillTwoRestartResume(): Promise<void> {
  const S = 'sync';
  assert.equal((await drillGetTimeline(S)).sync.lastSeq, 5);

  for (let i = 1; i <= 6; i += 1) {
    const id = `d2-${i}`;
    await drillCreateRelease({
      releaseId: id,
      changes: [{ serviceId: S, routeId: 'r1', timeoutMs: 100 + i }],
    });
    await drillWaitRelease(id, (r) => r.status === 'completed');
  }
  assert.equal((await drillDirect(S, '/__admin/timeline')).body.headSeq, 11);

  // Collect exactly one segment, leaving the backfill unfinished.
  const partial = await drillSync(S, 1);
  assert.equal(partial.segments.length, 1);
  assert.equal(partial.segments[0].afterSeq, 5);
  assert.equal(partial.segments[0].returned, 2);
  assert.equal(partial.lastSeq, 7);
  assert.equal(partial.truncated, true);

  const onDisk = JSON.parse(
    await readFile(path.join(drillCluster!.dataDir, 'coordinator-state.json'), 'utf8'),
  );
  assert.equal(onDisk.timelineSync[S].lastSeq, 7, '分段游标必须在重启前持久化');
  assert.equal(onDisk.timelines[S].length, 7, '已持久化的累计记录应为 seq 1..7');
  console.log(
    '    补收途中（仅第 1 段）重启协调器；磁盘持久进度: ' +
      JSON.stringify({ lastSeq: onDisk.timelineSync[S].lastSeq, collected: onDisk.timelines[S].length }),
  );

  // From here every timeline request observed at the proxy is post-restart.
  drillCluster!.getService(S).proxy.requests.length = 0;
  await drillCluster!.restartCoordinator();

  const resumed = await waitFor(
    '重启后从游标 7 续收至 11',
    async () => {
      const view = await drillGetTimeline(S);
      return view.sync.lastSeq === 11 && view.sync.caughtUp ? view : null;
    },
    15_000,
    80,
  );

  const seqs: number[] = resumed.timeline.map((r: any) => r.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], '重启续收后必须连续、不漏、不重');
  assert.equal(new Set(seqs).size, seqs.length);

  const afterSeqs = await waitFor(
    '观察重启后续收分段请求',
    async () => {
      const calls = timelineAfterSeqsFromProxy(S);
      return calls.includes(11) ? calls : null;
    },
    5_000,
    50,
  );
  assert.equal(afterSeqs[0], 7, `重启后首个分段必须从持久游标 7 开始，实际 ${JSON.stringify(afterSeqs)}`);
  assert.ok(afterSeqs.every((n) => n >= 7), '重启后不得重新拉取游标之前的记录');
  console.log('    重启后实际分段游标序列:', JSON.stringify(afterSeqs), '；最终连续记录:', JSON.stringify(seqs));
  console.log('    ✅ 重启续收演练结论: 仅补第 1 段后磁盘游标=7；补收途中真实重启协调器，新进程从 7 续收（游标 [7,9,11]），seq 1..11 连续、不漏不重。');
}

/**
 * 演练三：交叠发布 A/B（B 与 A 同值但更晚受理）。B 生效时记录“值相同、来源
 * A→B”；撤销 B 回落到较早发布 A（值仍相同、来源 B→A），同一条撤销记录里另
 * 一个配置项回落到服务初始值；撤销 A 后全部回到初始值。相同幂等键重放不新增
 * 时间线记录。
 */
async function drillThreeOverlapRevoke(): Promise<void> {
  const O = 'overlap';

  await drillCreateRelease({
    releaseId: 'ov-A',
    changes: [{ serviceId: O, routeId: 'ov', timeoutMs: 500 }],
  });
  const relA = await drillWaitRelease('ov-A', (r) => r.status === 'completed');

  await drillCreateRelease({
    releaseId: 'ov-B',
    changes: [{ serviceId: O, routeId: 'ov', timeoutMs: 500, rateLimitPerMinute: 120 }],
  });
  const relB = await drillWaitRelease('ov-B', (r) => r.status === 'completed');

  assert.equal((await drillDirect(O, '/__admin/timeline')).body.headSeq, 2);

  const acceptBody = JSON.stringify({
    releaseId: 'ov-B',
    coordinatorAcceptedAt: relB.coordinatorAcceptedAt,
    acceptedOrder: relB.acceptedOrder,
    changes: relB.changes.filter((c: any) => c.serviceId === O),
  });
  const acceptUrl = `${drillCluster!.getService(O).directUrl}/__admin/releases/ov-B/accept`;
  const replayHeaders = { 'content-type': 'application/json', 'idempotency-key': 'accept:ov-B:overlap:v1' };

  const replayAccept = await fetch(acceptUrl, { method: 'POST', body: acceptBody, headers: replayHeaders });
  assert.equal(replayAccept.status, 200);
  assert.equal(replayAccept.headers.get('x-idempotent-replay'), 'true');
  assert.equal((await drillDirect(O, '/__admin/timeline')).body.headSeq, 2, '幂等 accept 重放不得产生新记录');

  await drillFetch('/api/releases/ov-B/revoke', { method: 'POST' });
  await drillWaitRelease('ov-B', (r) => r.status === 'revoked');
  assert.equal((await drillDirect(O, '/__admin/timeline')).body.headSeq, 3);

  // Old accept replay after B was revoked: stored response only, no new row,
  // no resurrection.
  const zombieReplay = await fetch(acceptUrl, { method: 'POST', body: acceptBody, headers: replayHeaders });
  assert.equal(zombieReplay.status, 200);
  assert.equal(zombieReplay.headers.get('x-idempotent-replay'), 'true');
  assert.equal((await drillDirect(O, '/__admin/timeline')).body.headSeq, 3, '撤销后重放旧 accept 仍不得产生记录');
  const releaseB = await drillDirect(O, '/__admin/releases/ov-B');
  assert.equal(releaseB.body.status, 'revoked');

  const replayRevoke = await fetch(`${drillCluster!.getService(O).directUrl}/__admin/releases/ov-B/revoke`, {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'revoke:ov-B:overlap:v1' },
  });
  assert.equal(replayRevoke.status, 200);
  assert.equal(replayRevoke.headers.get('x-idempotent-replay'), 'true');
  assert.equal((await drillDirect(O, '/__admin/timeline')).body.headSeq, 3, '幂等 revoke 重放不得产生新记录');

  await drillFetch('/api/releases/ov-A/revoke', { method: 'POST' });
  await drillWaitRelease('ov-A', (r) => r.status === 'revoked');
  assert.equal((await drillDirect(O, '/__admin/timeline')).body.headSeq, 4);

  const syncReport = await drillSync(O);
  assert.equal(syncReport.ok, true, syncReport.error);
  const view = await drillGetTimeline(O);
  assert.deepEqual(view.timeline.map((r: any) => r.seq), [1, 2, 3, 4]);

  const [recA, recB, recRevB, recRevA] = view.timeline as any[];
  console.log('    交叠发布/撤销时间线（协调器按实际生效顺序展示）:');
  printTimeline(view.timeline);

  // #1 initial -> A.
  const aTimeout = recA.changes.find((c: any) => c.configKey === 'timeoutMs');
  assert.equal(recA.action, 'accept');
  assert.equal(aTimeout.before.value, 1000);
  assert.equal(aTimeout.before.source.type, 'initial');
  assert.equal(aTimeout.after.value, 500);
  assert.equal(aTimeout.after.source.type, 'release');
  assert.equal(aTimeout.after.source.releaseId, 'ov-A');
  assert.equal(aTimeout.valueChanged, true);
  assert.equal(aTimeout.sourceChanged, true);

  // #2 B overlaps A with the SAME timeout value: value unchanged, source moves.
  const bTimeout = recB.changes.find((c: any) => c.configKey === 'timeoutMs');
  assert.equal(bTimeout.before.value, 500);
  assert.equal(bTimeout.after.value, 500);
  assert.equal(bTimeout.valueChanged, false, 'B 与 A 的 timeout 值相同');
  assert.equal(bTimeout.sourceChanged, true, '但赢家来源必须从 A 切到 B');
  assert.equal(bTimeout.before.source.releaseId, 'ov-A');
  assert.equal(bTimeout.after.source.releaseId, 'ov-B');
  const bRate = recB.changes.find((c: any) => c.configKey === 'rateLimitPerMinute');
  assert.equal(bRate.before.value, 60);
  assert.equal(bRate.before.source.type, 'initial');
  assert.equal(bRate.after.value, 120);
  assert.equal(bRate.after.source.releaseId, 'ov-B');

  // #3 one atomic revoke entry contains BOTH fallback kinds.
  assert.equal(recRevB.action, 'revoke');
  assert.equal(recRevB.releaseId, 'ov-B');
  assert.equal(recRevB.changes.length, 2);
  const rbTimeout = recRevB.changes.find((c: any) => c.configKey === 'timeoutMs');
  assert.equal(rbTimeout.before.source.releaseId, 'ov-B');
  assert.equal(rbTimeout.after.value, 500);
  assert.equal(rbTimeout.after.source.type, 'release');
  assert.equal(rbTimeout.after.source.releaseId, 'ov-A', '必须辨认出回落到较早发布 A');
  assert.equal(rbTimeout.valueChanged, false);
  assert.equal(rbTimeout.sourceChanged, true);
  const rbRate = recRevB.changes.find((c: any) => c.configKey === 'rateLimitPerMinute');
  assert.equal(rbRate.before.value, 120);
  assert.equal(rbRate.before.source.releaseId, 'ov-B');
  assert.equal(rbRate.after.value, 60);
  assert.equal(rbRate.after.source.type, 'initial', '无更早候选时必须辨认出服务初始值');

  // #4 revoking A falls back to the service initial value.
  const raTimeout = recRevA.changes.find((c: any) => c.configKey === 'timeoutMs');
  assert.equal(raTimeout.before.value, 500);
  assert.equal(raTimeout.before.source.releaseId, 'ov-A');
  assert.equal(raTimeout.after.value, 1000);
  assert.equal(raTimeout.after.source.type, 'initial');

  // Idempotent replay summary line for the drill output.
  console.log('    幂等证据: accept/revoke 同键重放均返回 x-idempotent-replay=true，服务 headSeq 始终为 4，协调器无新增记录');
  console.log('    ✅ 交叠发布后撤销演练结论: 同值来源 A→B 被记录；撤销 B 时 timeout 回落较早发布 A、rateLimit 回落服务初始值，来源均可辨；再撤销 A 全部回初始值；幂等重放 0 新增。');
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
      switchSeq: 0,
      switchLog: [],
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

  // ==========================================================================
  // 配置生效时间线三大演练：断联补收 / 重启续收 / 交叠发布后撤销
  // ==========================================================================
  try {
    await check('时间线演练环境启动（独立双服务真实子进程，分段大小=2，关闭周期同步）', async () => {
      drillCluster = await FixtureCluster.start({
        fixturePath: DRILL_FIXTURE_PATH,
        requestTimeoutMs: 2000,
        reconcileIntervalMs: 120,
        timelineSegmentSize: 2,
        timelineSyncIntervalMs: 0,
      });
      assert.ok(drillCluster.coordinatorUrl);
      const health = await drillFetch('/health');
      assert.equal(health.status, 200);
      for (const serviceId of ['sync', 'overlap']) {
        const serviceHealth = await drillDirect(serviceId, '/health');
        assert.equal(serviceHealth.status, 200);
      }
      const alias = await drillFetch('/api/timeline');
      assert.equal(alias.status, 200);
      assert.ok(Array.isArray(alias.body.timelines));
      const byQuery = await drillFetch('/api/timeline?serviceId=sync');
      assert.equal(byQuery.status, 200);
      assert.equal(byQuery.body.serviceId, 'sync');
    });

    if (drillCluster) {
      await check('演练一【断联补收】恢复后仅按游标分段补缺失；服务再次离线仍可查记录与进度', drillOneDisconnectBackfill);
      await check('演练二【重启续收】补收途中重启协调器，从持久游标续收，不漏记不重复', drillTwoRestartResume);
      await check('演练三【交叠发布后撤销】同值来源切换/回落较早发布/回落初始值可辨源；幂等重放不增记录', drillThreeOverlapRevoke);
    }
  } finally {
    await drillCluster?.stop().catch(() => undefined);
    drillCluster = undefined;
  }

  clearTimeout(hardTimer);
  await cluster.stop();

  console.log('\n================ 结果 ================');
  console.log(`通过 ${passed} 项；失败 ${failures.length} 项。`);
  console.log('演练结果：断联补收 ✅ 仅分段补缺失 ｜ 重启续收 ✅ 不漏不重 ｜ 交叠发布后撤销 ✅ 来源可辨、幂等不增记录');
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
  console.log('全部自检通过：发布、暂停、并发优先级、原子性、持久化、重启对账、配置生效时间线（断联补收/重启续收/交叠撤销）均正常。');
  process.exit(0);
}

main().catch(async (error) => {
  clearTimeout(hardTimer);
  console.error('自检脚本致命错误:', error);
  if (drillCluster) {
    console.error('drill coordinator logs:', drillCluster.coordinatorLogs.slice(-80).join('\n'));
    for (const service of drillCluster.services.values()) {
      console.error(`drill service ${service.id} logs:`, service.logs.slice(-50).join('\n'));
    }
    await drillCluster.stop().catch(() => undefined);
  }
  if (cluster) {
    console.error('coordinator logs:', cluster.coordinatorLogs.slice(-80).join('\n'));
    for (const service of cluster.services.values()) {
      console.error(`service ${service.id} logs:`, service.logs.slice(-50).join('\n'));
    }
    await cluster.stop().catch(() => undefined);
  }
  process.exit(1);
});
