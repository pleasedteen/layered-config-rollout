import http from 'node:http';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FixtureCluster } from './cluster.js';
import { optionalNumberArg, parseCliArgs, readJsonBody, sendJson } from '../shared/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const fixturePath = path.join(projectRoot, 'fixtures', 'demo.json');
const dataDir = path.join(projectRoot, '.runtime', 'local');

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.fresh === true) await rm(dataDir, { recursive: true, force: true });
  const dispatchMaxBytes = optionalNumberArg(args, 'dispatch-max-bytes') ?? 16 * 1024;
  if (!Number.isInteger(dispatchMaxBytes) || dispatchMaxBytes < 1) {
    throw new Error('--dispatch-max-bytes must be a positive integer');
  }

  const cluster = await FixtureCluster.start({
    fixturePath,
    dataDir,
    coordinatorPort: 4100,
    servicePorts: {
      checkout: { direct: 4301, chaos: 4201 },
      payments: { direct: 4302, chaos: 4202 },
      risk: { direct: 4303, chaos: 4203 },
    },
    requestTimeoutMs: Number(args['request-timeout-ms'] ?? 1000),
    reconcileIntervalMs: Number(args['reconcile-ms'] ?? 700),
    dispatchMaxBytes,
    verbose: args.verbose === true,
  });

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

  await new Promise<void>((resolve, reject) => {
    controlServer.once('error', reject);
    controlServer.listen(4400, '127.0.0.1', resolve);
  });

  console.log('\n本地夹具已启动:');
  console.log(`  协调器/看板: ${cluster.coordinatorUrl}/`);
  console.log(`  夹具控制 API: http://127.0.0.1:4400/`);
  console.log(`  单次下发上限: ${dispatchMaxBytes} bytes`);
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
