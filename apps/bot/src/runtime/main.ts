import { buildRuntimeFromConfig } from './buildRuntime.js';
import { loadRuntimeConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadRuntimeConfig(process.env);
  const built = await buildRuntimeFromConfig(config);
  const runtime = built.runtime;

  const shutdown = async () => {
    await runtime.stop();
    await built.sqlAdapter?.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  await runtime.start();
}

void main();
