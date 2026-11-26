import path from 'node:path';
import { ConfigService } from './config-service.js';
import { createForwardServiceServer } from './server.js';
import { numberArg, parseCliArgs, requireStringArg } from '../shared/http.js';

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const serviceId = requireStringArg(args, 'service-id');
  const dataDir = requireStringArg(args, 'data-dir');
  const fixturePath = requireStringArg(args, 'fixture');
  const port = numberArg(args, 'port', 0);

  const fixture = await ConfigService.loadFixture(path.resolve(fixturePath));
  const configService = await ConfigService.start({
    serviceId,
    dataDir: path.resolve(dataDir),
    fixture,
  });
  const server = createForwardServiceServer(configService);

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
