import http from 'node:http';
import path from 'node:path';
import { rm, rename, mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FixtureCluster } from './cluster.js';
import { parseCliArgs, readJsonBody, sendJson } from '../shared/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const fixturePath = path.join(projectRoot, 'fixtures', 'demo.json');
const dataDir = path.join(projectRoot, '.runtime', 'local');
const CONTROL_PORT = 4400;
const COORDINATOR_PORT = 4100;
const SERVICE_PORTS = {
  checkout: { direct: 4301, chaos: 4201 },
  payments: { direct: 4302, chaos: 4202 },
  risk: { direct: 4303, chaos: 4203 },
};

/**
 * Replaces the persistent data directory with a freshly seeded one only after
 * the new cluster has fully started. If the startup never succeeds, the
 * previous directory stays in place and existing publications keep serving.
 */
async function commitFreshData(freshDir: string, targetDir: string): Promise<void> {
  let hadPrevious = true;
  try {
    await mkdir(targetDir);
    // mkdir succeeded: the target did not exist before.
    hadPrevious = false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!hadPrevious) {
    await rename(freshDir, targetDir);
    return;
  }
  const backupDir = `${targetDir}.backup-${process.pid}-${Date.now()}`;
  await rename(targetDir, backupDir);
  try {
    await rename(freshDir, targetDir);
  } catch (error) {
    // Roll back so a failed swap never leaves the operator without their data.
    await rename(backupDir, targetDir).catch(() => undefined);
    throw error;
  }
  await rm(backupDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const fresh = args.fresh === true;

  // With --fresh the new seed is written into a throwaway directory first.
  // It lives next to the target so the final swap is a same-filesystem atomic
  // rename (os.tmpdir() may be a different mount and fail with EXDEV); the
  // real .runtime/local is only swapped in after a successful startup.
  const runtimeRoot = path.dirname(dataDir);
  await mkdir(runtimeRoot, { recursive: true });
  const startupDataDir = fresh ? await mkdtemp(path.join(runtimeRoot, '.fresh-')) : dataDir;

  const startupAbort = new AbortController();
  let aborting = false;
  const abortStartup = () => {
    if (aborting) {
      console.error('\n再次收到中断，强制退出。');
      process.exit(130);
    }
    aborting = true;
    console.error('\n启动途中收到 Ctrl+C，正在回收本次启动取得的监听和子进程，原有端口占用者保持运行…');
    startupAbort.abort();
  };
  process.on('SIGINT', abortStartup);
  process.on('SIGTERM', abortStartup);

  let cluster: FixtureCluster;
  try {
    cluster = await FixtureCluster.start({
      fixturePath,
      dataDir: startupDataDir,
      coordinatorPort: COORDINATOR_PORT,
      controlPort: CONTROL_PORT,
      servicePorts: SERVICE_PORTS,
      requestTimeoutMs: Number(args['request-timeout-ms'] ?? 1000),
      reconcileIntervalMs: Number(args['reconcile-ms'] ?? 700),
      verbose: args.verbose === true,
      startupSignal: startupAbort.signal,
    });
  } catch (error) {
    if (fresh) await rm(startupDataDir, { recursive: true, force: true }).catch(() => undefined);
    if (startupAbort.signal.aborted) {
      console.error('启动已中断：本次启动的代理、服务和协调器均已回收；原有端口占用者未受影响，可直接重试。');
      process.exit(130);
    }
    console.error('[fixture] 启动失败，已回收本次启动的全部监听和子进程（原有占用者保留并继续响应）:');
    console.error(`  ${(error as Error).message}`);
    console.error('故障解除后可使用同一组端口重新运行本命令；不带 --fresh 时仍可续跑已有发布。');
    process.exit(1);
  }

  if (fresh) {
    try {
      await commitFreshData(startupDataDir, dataDir);
      console.log('新种子数据已切换到 .runtime/local（仅在启动成功后生效）。');
    } catch (error) {
      console.error('[fixture] 切换 --fresh 数据失败，已停止新集群并清理临时目录，原有数据保留:');
      console.error(`  ${(error as Error).message}`);
      await cluster.stop().catch(() => undefined);
      await rm(startupDataDir, { recursive: true, force: true }).catch(() => undefined);
      process.exit(1);
    }
  }

  const controlServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://fixture-control.local');
      const segments = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/') {
        sendJson(res, 200, {
          ok: true,
          control: 'http://127.0.0.1:4400',
          coordinator: cluster.coordinatorUrl,
          services: [...cluster.services.values()].map((service) => ({
            id: service.id,
            direct: service.directUrl,
            chaos: service.chaosUrl,
          })),
          examples: [
            "curl -X POST http://127.0.0.1:4100/api/releases -H 'content-type: application/json' -d '{\"releaseId\":\"demo-1\",\"batchSize\":1,\"changes\":[{\"serviceId\":\"checkout\",\"routeId\":\"slow-quote\",\"timeoutMs\":40}]}'",
            "curl -X POST http://127.0.0.1:4400/chaos/checkout/global -H 'content-type: application/json' -d '{\"dropResponse\":true}'",
            'curl -X POST http://127.0.0.1:4400/chaos/checkout/reset',
            'curl -X POST http://127.0.0.1:4400/restart/checkout',
            'curl -X POST http://127.0.0.1:4400/coordinator/restart',
          ],
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/state') {
        sendJson(res, 200, {
          coordinator: {
            url: cluster.coordinatorUrl,
            pid: cluster.coordinatorChild?.pid,
            alive: Boolean(cluster.coordinatorChild),
          },
          services: [...cluster.services.values()].map((service) => ({
            id: service.id,
            pid: service.child?.pid,
            alive: Boolean(service.child),
            directUrl: service.directUrl,
            chaosUrl: service.chaosUrl,
            chaos: { globalPolicy: service.proxy.globalPolicy, rules: service.proxy.rules },
          })),
        });
        return;
      }

      if (segments[0] === 'chaos' && segments[1] && segments[2] === 'global' && req.method === 'POST') {
        const service = cluster.getService(decodeURIComponent(segments[1]));
        service.proxy.globalPolicy = (await readJsonBody(req)) as never;
        sendJson(res, 200, { ok: true, globalPolicy: service.proxy.globalPolicy });
        return;
      }

      if (segments[0] === 'chaos' && segments[1] && segments[2] === 'rules' && req.method === 'POST') {
        const service = cluster.getService(decodeURIComponent(segments[1]));
        const body = await readJsonBody(req);
        const rule = service.proxy.addRule(body as never);
        sendJson(res, 201, { ok: true, rule });
        return;
      }

      if (segments[0] === 'chaos' && segments[1] && segments[2] === 'reset' && req.method === 'POST') {
        const service = cluster.getService(decodeURIComponent(segments[1]));
        service.proxy.reset();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (segments[0] === 'restart' && segments[1] && req.method === 'POST') {
        const id = decodeURIComponent(segments[1]);
        await cluster.restartService(id);
        sendJson(res, 200, { ok: true, id, pid: cluster.getService(id).child?.pid });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/coordinator/restart') {
        await cluster.restartCoordinator();
        sendJson(res, 200, { ok: true, pid: cluster.coordinatorChild?.pid });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: (error as Error).message });
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      controlServer.once('error', reject);
      controlServer.listen(CONTROL_PORT, '127.0.0.1', resolve);
    });
  } catch (error) {
    console.error(`[fixture] 夹具控制口 ${CONTROL_PORT} 绑定失败，回收本次启动的全部组件:`, (error as Error).message);
    await cluster.stop().catch(() => undefined);
    process.exit(1);
  }

  // Startup succeeded: replace the abort-only handlers with normal shutdown.
  process.removeListener('SIGINT', abortStartup);
  process.removeListener('SIGTERM', abortStartup);

  console.log('\n本地夹具已启动:');
  console.log(`  协调器/看板: ${cluster.coordinatorUrl}/`);
  console.log('  夹具控制 API: http://127.0.0.1:4400/');
  for (const service of cluster.services.values()) {
    console.log(`  ${service.id}: 直连 ${service.directUrl} | 混沌入口 ${service.chaosUrl}`);
  }
  console.log('\n常用操作:');
  console.log('  npm run op -- releases');
  console.log('  npm run op -- status <releaseId>');
  console.log('  npm run op -- config <serviceId> [routeId]');
  console.log('  curl -X POST http://127.0.0.1:4400/restart/checkout');
  console.log('按 Ctrl+C 停止夹具。\n');

  const shutdown = async () => {
    controlServer.close();
    await cluster.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((error) => {
  console.error('[fixture] fatal:', error);
  process.exit(1);
});
