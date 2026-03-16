import { existsSync } from 'node:fs';

import { config as loadEnvFile } from 'dotenv';
import { JsonConsoleLogger } from '../telemetry/logging.js';
import { buildRuntimeFromConfig } from './buildRuntime.js';
import { loadRuntimeConfig } from './config.js';

function loadRuntimeEnvFromFile(): string | undefined {
  const explicitEnvFile = process.env.BOT_ENV_FILE;
  if (explicitEnvFile) {
    loadEnvFile({ path: explicitEnvFile, override: false });
    return explicitEnvFile;
  }

  const defaultEnvFile = '../../.env';
  if (existsSync(defaultEnvFile)) {
    loadEnvFile({ path: defaultEnvFile, override: false });
    return defaultEnvFile;
  }

  return undefined;
}

async function main(): Promise<void> {
  const logger = new JsonConsoleLogger();
  const loadedEnvFile = loadRuntimeEnvFromFile();
  logger.log('info', 'runtime_env_loaded', loadedEnvFile ? { envFile: loadedEnvFile } : undefined);

  const config = loadRuntimeConfig(process.env);
  logger.log('info', 'runtime_config_loaded', {
    shadowMode: config.shadowMode,
    canaryMode: config.canaryMode,
    enableWebhookIngress: config.enableWebhookIngress,
    enableMetricsServer: config.enableMetricsServer,
    enableCamelotAmmv3: config.enableCamelotAmmv3
  });
  logger.log('info', 'runtime_build_started');
  const built = await buildRuntimeFromConfig(config, { logger });
  logger.log('info', 'runtime_build_completed');
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

  logger.log('info', 'runtime_starting');
  await runtime.start();
}

void main();
