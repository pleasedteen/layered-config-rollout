import path from 'node:path';
import { ConfigService } from './config-service.js';
import { createForwardServiceServer } from './server.js';
import { numberArg, parseCliArgs, requireStringArg } from '../shared/http.js';
import { AuthFileStore } from '../shared/credentials.js';

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const serviceId = requireStringArg(args, 'service-id');
  const dataDir = requireStringArg(args, 'data-dir');
  const fixturePath = requireStringArg(args, 'fixture');
  const port = numberArg(args, 'port', 0);

  const resolvedDataDir = path.resolve(dataDir);
  const credentialsPath =
    typeof args.credentials === 'string' && args.credentials.length > 0
      ? path.resolve(args.credentials)
      : path.join(resolvedDataDir, 'credentials.json');
  const auth = new AuthFileStore(credentialsPath);
  // Creates a single-service credential file if a cluster-managed one was not
  // supplied; the fixture cluster always provisions the shared file first.
  await auth.init([serviceId]);

  const fixture = await ConfigService.loadFixture(path.resolve(fixturePath));
  const configService = await ConfigService.start({
    serviceId,
    dataDir: resolvedDataDir,
    fixture,
  });
  const server = createForwardServiceServer(configService, auth);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`[service:${serviceId}] listening on http://127.0.0.1:${actualPort}`);
  console.log(`[service:${serviceId}] persistent state ${configService.persistentFilePath}`);

  const shutdown = (signal: string) => {
    console.log(`[service:${serviceId}] received ${signal}, closing`);
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[service] fatal:', error);
  process.exit(1);
});
