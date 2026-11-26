import { readFile } from 'node:fs/promises';
import { fetchJson, parseCliArgs } from '../shared/http.js';

function coordinatorUrl(): string {
  const args = parseCliArgs(process.argv.slice(2));
  const value = args.coordinator ?? process.env.COORDINATOR_URL ?? 'http://127.0.0.1:4100';
  if (value !== true && typeof value === 'string') return value.replace(/\/$/, '');
  return 'http://127.0.0.1:4100';
}

function positionals(argv: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--coordinator') {
      index += 1;
      continue;
    }
    if (token.startsWith('--')) continue;
    result.push(token);
  }
  return result;
}

function printReleaseSummary(release: any): void {
  console.log(`${release.id}  ${release.status}  order=#${release.acceptedOrder}`);
  console.log(`  acceptedAt: ${release.coordinatorAcceptedAt}`);
  if (release.progress) {
    console.log(`  rollout: ${release.progress.confirmedBatches}/${release.progress.totalBatches} batches confirmed`);
    for (const batch of release.progress.batches) {
      const states = batch.services
        .map((service: any) => `${service.serviceId}=${service.status}${service.attempts ? `(${service.attempts})` : ''}${service.lastError ? ` err=${service.lastError}` : ''}`)
        .join(', ');
      console.log(`    batch ${batch.index} [${batch.serviceIds.join(', ')}]: ${batch.confirmed ? 'CONFIRMED' : states}`);
    }
  }
  if (release.revocationProgress) {
    console.log(`  revocation: ${release.revocationProgress.confirmedBatches}/${release.revocationProgress.totalBatches} batches removed`);
    for (const batch of release.revocationProgress.batches) {
      const states = batch.services
        .map((service: any) => `${service.serviceId}=${service.status}${service.attempts ? `(${service.attempts})` : ''}${service.lastError ? ` err=${service.lastError}` : ''}`)
        .join(', ');
      console.log(`    revoke batch ${batch.index} [${batch.serviceIds.join(', ')}]: ${batch.confirmed ? 'REMOVED' : states}`);
    }
  }
}

async function publish(payloadPath: string | undefined, base: string): Promise<void> {
  let raw: string;
  if (!payloadPath || payloadPath === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    raw = Buffer.concat(chunks).toString('utf8');
  } else {
    raw = await readFile(payloadPath, 'utf8');
  }
  const body = JSON.parse(raw);
  const result = await fetchJson(`${base}/api/releases`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  if (result.status >= 400) throw new Error(result.text);
  printReleaseSummary(result.body);
}

async function showTimeline(serviceId: string, base: string): Promise<void> {
  const result = await fetchJson(`${base}/api/services/${encodeURIComponent(serviceId)}/timeline`);
  if (result.status !== 200) throw new Error(result.text);
  const view = result.body;
  const sourceLabel = (source: any): string => {
    if (!source || source.type === 'initial') return '服务初始值';
    return `${source.releaseId}#${source.acceptedOrder}`;
  };
  console.log(`服务 ${view.serviceId} 配置生效时间线（实际生效顺序，共 ${view.count} 条）`);
  const sync = view.sync;
  if (sync) {
    console.log(
      `同步进度: lastSeq=${sync.lastSeq} remoteHeadSeq=${sync.remoteHeadSeq ?? '-'} ` +
      `caughtUp=${sync.caughtUp} segments=${sync.segmentFetchCount}` +
      (sync.lastError ? ` lastError=${sync.lastError}` : ''),
    );
  }
  for (const record of view.timeline ?? []) {
    console.log(`#${record.seq} ${record.action} ${record.releaseId} @${record.at}`);
    for (const change of record.changes) {
      const tag = !change.valueChanged && change.sourceChanged ? ' [值相同·来源变化]' : '';
      console.log(
        `  - ${change.routeId}.${change.configKey}: ` +
        `${change.before.value}[${sourceLabel(change.before.source)}] -> ` +
        `${change.after.value}[${sourceLabel(change.after.source)}]${tag}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = positionals(argv)[0];
  const args = parseCliArgs(argv);
  const base = coordinatorUrl();

  if (!command || command === 'help' || args.help === true) {
    console.log(`用法:
  npm run op -- releases
  npm run op -- status <releaseId>
  npm run op -- config <serviceId> [routeId]
  npm run op -- timeline <serviceId>
  npm run op -- sync-timeline <serviceId>
  npm run op -- publish <payload.json|->
  npm run op -- pause <releaseId>
  npm run op -- resume <releaseId>
  npm run op -- revoke <releaseId>
  npm run op -- reconcile [releaseId]

选项:
  --coordinator=http://127.0.0.1:4100
`);
    return;
  }

  if (command === 'releases' || command === 'list') {
    const result = await fetchJson(`${base}/api/releases`);
    if (result.status !== 200) throw new Error(result.text);
    for (const release of result.body.releases) printReleaseSummary(release);
    return;
  }

  if (command === 'status') {
    const id = positionals(argv)[1];
    if (!id) throw new Error('status requires <releaseId>');
    const result = await fetchJson(`${base}/api/releases/${encodeURIComponent(id)}`);
    if (result.status !== 200) throw new Error(result.text);
    printReleaseSummary(result.body);
    return;
  }

  if (command === 'config') {
    const serviceId = positionals(argv)[1];
    const routeId = positionals(argv)[2];
    if (!serviceId) throw new Error('config requires <serviceId>');
    const result = await fetchJson(`${base}/api/services/${encodeURIComponent(serviceId)}/actual-config`);
    if (result.status !== 200) throw new Error(result.text);
    if (routeId) {
      const config = result.body.configs?.[routeId];
      if (!config) throw new Error(`unknown route ${serviceId}/${routeId}`);
      console.log(JSON.stringify({ serviceId, routeId, effective: config }, null, 2));
    } else {
      console.log(JSON.stringify(result.body, null, 2));
    }
    return;
  }

  if (command === 'publish') {
    await publish(positionals(argv)[1], base);
    return;
  }

  if (command === 'timeline' || command === 'tl') {
    const serviceId = positionals(argv)[1];
    if (!serviceId) throw new Error('timeline requires <serviceId>');
    await showTimeline(serviceId, base);
    return;
  }

  if (command === 'sync-timeline') {
    const serviceId = positionals(argv)[1];
    if (!serviceId) throw new Error('sync-timeline requires <serviceId>');
    const result = await fetchJson(`${base}/api/services/${encodeURIComponent(serviceId)}/timeline/sync`, {
      method: 'POST',
    });
    if (result.status !== 200) throw new Error(result.text);
    console.log(JSON.stringify({
      ok: result.body.ok,
      lastSeq: result.body.lastSeq,
      caughtUp: result.body.caughtUp,
      fetchedCount: result.body.fetchedCount,
      segments: result.body.segments?.map((s: any) => ({ afterSeq: s.afterSeq, returned: s.returned, nextSeq: s.nextSeq })),
      error: result.body.error,
    }, null, 2));
    await showTimeline(serviceId, base);
    return;
  }

  const actionMap: Record<string, string> = {
    pause: 'pause',
    resume: 'resume',
    revoke: 'revoke',
    reconcile: 'reconcile',
  };
  const action = actionMap[command];
  if (action) {
    const id = positionals(argv)[1];
    if (!id) throw new Error(`${command} requires <releaseId>`);
    const result = await fetchJson(`${base}/api/releases/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    if (result.status >= 400) throw new Error(result.text);
    printReleaseSummary(result.body);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error('操作失败:', error.message);
  process.exit(1);
});
