import { ChaosProxy } from './proxy.js';
import { numberArg, parseCliArgs, requireStringArg } from '../shared/http.js';

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const serviceId = requireStringArg(args, 'service-id');
  const target = requireStringArg(args, 'target');
  const port = numberArg(args, 'port', 0);

  const proxy = new ChaosProxy(serviceId, target);
  const actualPort = await proxy.start(port);
  console.log(`[chaos:${serviceId}] proxy on http://127.0.0.1:${actualPort} -> ${target}`);

  const shutdown = () => {
    proxy.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('[chaos] fatal:', error);
  process.exit(1);
});
