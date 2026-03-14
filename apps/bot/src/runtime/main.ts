import { UNISWAPX_ORDERS_API } from '@uni/config';
import { OrdersApiClient } from '../intake/ordersApiClient.js';
import { OrdersPoller } from '../intake/poller.js';
import { HybridIngressCoordinator } from '../ingress/hybridIngress.js';
import { WebhookIngressServer } from '../ingress/webhookServer.js';
import { InMemoryDecisionJournal } from '../journal/inMemoryDecisionJournal.js';
import { InMemoryOrderStore } from '../store/memory/inMemoryOrderStore.js';
import { BotMetrics } from '../telemetry/metrics.js';
import { PrometheusMetricsServer } from '../telemetry/prometheus.js';
import { BotRuntime } from './BotRuntime.js';
import { loadRuntimeConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadRuntimeConfig(process.env);
  const metrics = new BotMetrics();
  const store = new InMemoryOrderStore();
  const journal = new InMemoryDecisionJournal();
  const poller = new OrdersPoller(
    new OrdersApiClient({
      baseUrl: UNISWAPX_ORDERS_API,
      chainId: 42161,
      cadenceMs: config.pollCadenceMs
    })
  );
  const ingress = new HybridIngressCoordinator({ store, journal, metrics });

  const webhookServer = config.enableWebhookIngress
    ? new WebhookIngressServer(
        {
          host: config.webhookHost,
          port: config.webhookPort,
          path: config.webhookPath,
          trustProxy: config.trustProxy,
          allowedCidrs: config.allowedWebhookCidrs,
          maxBodyBytes: config.maxWebhookBodyBytes,
          metrics
        },
        async (envelope) => ingress.ingest(envelope)
      )
    : undefined;

  const metricsServer = config.enableMetricsServer
    ? new PrometheusMetricsServer({ host: config.metricsHost, port: config.metricsPort, metrics })
    : undefined;

  const runtime = new BotRuntime({
    config,
    poller,
    ingress,
    store,
    journal,
    metrics,
    webhookServer,
    metricsServer
  });

  const shutdown = async () => {
    await runtime.stop();
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
