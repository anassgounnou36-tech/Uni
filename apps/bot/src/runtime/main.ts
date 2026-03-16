import { existsSync } from 'node:fs';

import { config as loadEnvFile } from 'dotenv';
import { buildRuntimeFromConfig } from './buildRuntime.js';
import { loadRuntimeConfig } from './config.js';

function loadRuntimeEnvFromFile(): void {
  const explicitEnvFile = process.env.BOT_ENV_FILE;
  if (explicitEnvFile) {
    loadEnvFile({ path: explicitEnvFile, override: false });
    return;
  }

  const defaultEnvFile = '../../.env';
  if (existsSync(defaultEnvFile)) {
    loadEnvFile({ path: defaultEnvFile, override: false });
  }
}

async function main(): Promise<void> {
  loadRuntimeEnvFromFile();
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
