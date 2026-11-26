import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { Coordinator } from './coordinator.js';
import { createCoordinatorServer } from './server.js';
import { numberArg, parseCliArgs, requireStringArg } from '../shared/http.js';
import { ConfigService } from '../service/config-service.js';
import type { ClusterConfig } from '../shared/types.js';

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const dataDir = path.resolve(requireStringArg(args, 'data-dir'));
  const fixturePath = path.resolve(requireStringArg(args, 'fixture'));
  const clusterConfigPath = args['cluster-config'];
  const port = numberArg(args, 'port', 4100);

  let clusterConfig: ClusterConfig | undefined;
  if (typeof clusterConfigPath === 'string') {
    clusterConfig = JSON.parse(await readFile(path.resolve(clusterConfigPath), 'utf8')) as ClusterConfig;
  }

  const fixture = await ConfigService.loadFixture(fixturePath);
  const coordinator = new Coordinator({
    dataDir,
    fixture,
    endpoints: clusterConfig?.services ?? [],
    requestTimeoutMs: clusterConfig?.requestTimeoutMs ?? 1200,
    reconcileIntervalMs: clusterConfig?.reconcileIntervalMs ?? 700,
  });
  await coordinator.start();
  coordinator.startPeriodicReconcile(clusterConfig?.reconcileIntervalMs ?? 700);

  const server = createCoordinatorServer(coordinator);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`[coordinator] listening on http://127.0.0.1:${actualPort}`);
  console.log(`[coordinator] dashboard http://127.0.0.1:${actualPort}/`);
  console.log(`[coordinator] state ${path.join(dataDir, 'coordinator-state.json')}`);

  const shutdown = (signal: string) => {
    console.log(`[coordinator] received ${signal}, closing`);
    coordinator.close();
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[coordinator] fatal:', error);
  process.exit(1);
});
