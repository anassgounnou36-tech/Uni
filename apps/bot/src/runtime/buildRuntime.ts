import { createPublicClient, createTestClient, createWalletClient, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { createPostgresAdapter } from '../db/postgres.js';
import type { SqlAdapter } from '../db/types.js';
import { prepareExecution } from '../execution/prepareExecution.js';
import { HybridIngressCoordinator } from '../ingress/hybridIngress.js';
import { WebhookIngressServer } from '../ingress/webhookServer.js';
import { OrdersApiClient } from '../intake/ordersApiClient.js';
import { OrdersPoller } from '../intake/poller.js';
import { InMemoryDecisionJournal } from '../journal/inMemoryDecisionJournal.js';
import { PostgresDecisionJournal } from '../journal/postgresDecisionJournal.js';
import type { DecisionJournal } from '../journal/types.js';
import { UniV3RoutePlanner } from '../routing/univ3/routePlanner.js';
import { InMemoryNonceLedger, NonceManager, PostgresNonceLedger } from '../send/nonceManager.js';
import { SequencerClient } from '../send/sequencerClient.js';
import { ForkSimService } from '../sim/forkSimService.js';
import { InMemoryOrderStore } from '../store/memory/inMemoryOrderStore.js';
import { PostgresOrderStore } from '../store/postgres/postgresOrderStore.js';
import type { OrderStore } from '../store/types.js';
import { BotMetrics } from '../telemetry/metrics.js';
import { PrometheusMetricsServer } from '../telemetry/prometheus.js';
import { BotRuntime, type HotLaneContext, type SchedulerContext } from './BotRuntime.js';
import type { RuntimeConfig } from './config.js';
import { InflightTracker } from './inflightTracker.js';

const DEFAULT_DEV_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const UNISWAPX_ORDERS_API = 'https://api.uniswap.org/v2/orders';
const UNIV3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984' as const;
const UNIV3_QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' as const;

export type BuildRuntimeOverrides = {
  nowMs: () => number;
  readClient: PublicClient;
  poller: OrdersPoller;
  ingressCoordinator: HybridIngressCoordinator;
  schedulerContext: SchedulerContext;
  hotLaneContext: HotLaneContext;
  sequencerClient: SequencerClient;
  simService: ForkSimService;
  nonceManager: NonceManager;
  executionPreparer: HotLaneContext['executionPreparer'];
  orderStore: OrderStore;
  decisionJournal: DecisionJournal;
  metrics: BotMetrics;
  metricsServer?: PrometheusMetricsServer;
  webhookServer?: WebhookIngressServer;
  inflightTracker: InflightTracker;
  sqlAdapter: SqlAdapter;
  createSqlAdapter: (databaseUrl: string) => Promise<SqlAdapter>;
};

export type BuildRuntimeResult = {
  runtime: BotRuntime;
  orderStore: OrderStore;
  decisionJournal: DecisionJournal;
  poller: OrdersPoller;
  ingressCoordinator: HybridIngressCoordinator;
  schedulerContext: SchedulerContext;
  hotLaneContext: HotLaneContext;
  sequencerClient: SequencerClient;
  simService: ForkSimService;
  nonceManager: NonceManager;
  executionPreparer: HotLaneContext['executionPreparer'];
  readClient: PublicClient;
  metricsServer?: PrometheusMetricsServer;
  webhookServer?: WebhookIngressServer;
  inflightTracker: InflightTracker;
  sqlAdapter?: SqlAdapter;
};

function assertStatePolicy(config: RuntimeConfig): void {
  const inLiveOrCanaryMode = config.shadowMode === false || config.canaryMode === true;
  if (inLiveOrCanaryMode && !config.databaseUrl) {
    throw new Error('databaseUrl is required for live/canary mode');
  }
  if (!config.databaseUrl && !(config.shadowMode === true && config.allowEphemeralState === true)) {
    throw new Error('ephemeral order store is not allowed outside shadow dev mode');
  }
}

export async function buildRuntimeFromConfig(
  config: RuntimeConfig,
  overrides: Partial<BuildRuntimeOverrides> = {}
): Promise<BuildRuntimeResult> {
  assertStatePolicy(config);
  const inLiveOrCanaryMode = config.shadowMode === false || config.canaryMode === true;

  let sqlAdapter = overrides.sqlAdapter;
  if (!sqlAdapter && config.databaseUrl) {
    const createAdapter = overrides.createSqlAdapter ?? createPostgresAdapter;
    try {
      sqlAdapter = await createAdapter(config.databaseUrl);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.includes('failed to create Postgres adapter for durable runtime')) {
        throw error;
      }
      throw new Error(`failed to create Postgres adapter for durable runtime: ${detail}`);
    }
  }

  const nowMs = overrides.nowMs ?? (() => Date.now());
  const metrics = overrides.metrics ?? new BotMetrics();
  const readClient =
    overrides.readClient ??
    createPublicClient({
      chain: arbitrum,
      transport: http(config.readRpcUrl)
    });

  const orderStore =
    overrides.orderStore ??
    (sqlAdapter
      ? new PostgresOrderStore(sqlAdapter)
      : new InMemoryOrderStore());

  const decisionJournal =
    overrides.decisionJournal ??
    (sqlAdapter
      ? new PostgresDecisionJournal(sqlAdapter)
      : new InMemoryDecisionJournal());

  if (orderStore instanceof PostgresOrderStore) {
    await orderStore.writeSchema();
  }
  if (decisionJournal instanceof PostgresDecisionJournal) {
    await decisionJournal.ensureSchema();
  }

  const poller =
    overrides.poller ??
    new OrdersPoller(
      new OrdersApiClient({
        baseUrl: UNISWAPX_ORDERS_API,
        chainId: 42161,
        cadenceMs: config.pollCadenceMs
      })
    );

  const ingressCoordinator =
    overrides.ingressCoordinator ??
    new HybridIngressCoordinator({
      store: orderStore,
      journal: decisionJournal,
      metrics
    });

  const sequencerClient =
    overrides.sequencerClient ??
    new SequencerClient({
      sequencerUrl: config.sequencerUrl,
      fallbackUrl: config.readRpcUrl,
      shadowMode: config.shadowMode
    });

  const signerPrivateKey = config.signerPrivateKey ?? DEFAULT_DEV_PRIVATE_KEY;
  const account = privateKeyToAccount(signerPrivateKey);
  const forkRpcUrl = config.forkRpcUrl ?? config.readRpcUrl;
  const forkTransport = http(forkRpcUrl);
  const forkPublicClient = createPublicClient({ chain: arbitrum, transport: forkTransport });
  const forkWalletClient = createWalletClient({ account, chain: arbitrum, transport: forkTransport });
  const forkTestClient = createTestClient({ chain: arbitrum, mode: 'anvil', transport: forkTransport });

  const simService =
    overrides.simService ??
    new ForkSimService({
      clients: {
        publicClient: forkPublicClient,
        walletClient: forkWalletClient,
        testClient: forkTestClient,
        sender: account.address
      }
    });

  const durableNonceLedger = sqlAdapter ? new PostgresNonceLedger(sqlAdapter) : undefined;
  if (durableNonceLedger) {
    await durableNonceLedger.ensureSchema();
  }

  const nonceManager =
    overrides.nonceManager ??
    new NonceManager({
      ledger: durableNonceLedger ?? new InMemoryNonceLedger(),
      chainNonceReader: async (address) => BigInt(await forkPublicClient.getTransactionCount({ address, blockTag: 'pending' }))
    });

  if (inLiveOrCanaryMode) {
    if (!sqlAdapter) {
      throw new Error('databaseUrl is required for live/canary mode');
    }
    if (!(orderStore instanceof PostgresOrderStore)) {
      throw new Error('durable order store is required for live/canary mode');
    }
    if (!(decisionJournal instanceof PostgresDecisionJournal)) {
      throw new Error('durable decision journal is required for live/canary mode');
    }
    if (!durableNonceLedger && !overrides.nonceManager) {
      throw new Error('durable nonce ledger is required for live/canary mode');
    }
  }

  const executionPreparer =
    overrides.executionPreparer ??
    (async ({ executionPlan }) =>
      prepareExecution({
        executionPlan,
        account: account.address,
        nonceManager,
        publicClient: forkPublicClient,
        walletClient: forkWalletClient,
        txPolicy: {
          gasHeadroomBps: 100n,
          maxGasCeiling: 2_000_000n
        },
        conditionalPolicy: {
          currentL2TimestampSec: BigInt(Math.floor(nowMs() / 1000)),
          scheduledWindowBlocks: config.competeWindowBlocks,
          avgBlockTimeSec: 1n,
          maxStalenessSec: 10n
        }
      }));

  const schedulerContext =
    overrides.schedulerContext ??
    {
      routePlanner: new UniV3RoutePlanner({
        client: readClient,
        factory: UNIV3_FACTORY,
        quoter: UNIV3_QUOTER_V2
      }),
      resolveEnv: {
        timestamp: BigInt(Math.floor(nowMs() / 1000)),
        basefee: 100_000_000n,
        chainId: 42161n
      }
    };

  const hotLaneContext =
    overrides.hotLaneContext ??
    {
      ...schedulerContext,
      conditionalEnvelope: {
        TimestampMax: BigInt(Math.floor(nowMs() / 1000)) + 120n
      },
      executor: config.executorAddress,
      simService,
      sequencerClient,
      nonceManager,
      executionPreparer
    };

  const webhookServer =
    overrides.webhookServer ??
    (config.enableWebhookIngress
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
          async (envelope) => ingressCoordinator.ingest(envelope)
        )
      : undefined);

  const metricsServer =
    overrides.metricsServer ??
    (config.enableMetricsServer
      ? new PrometheusMetricsServer({
          host: config.metricsHost,
          port: config.metricsPort,
          metrics
        })
      : undefined);

  const inflightTracker = overrides.inflightTracker ?? new InflightTracker();

  const runtime = new BotRuntime({
    config,
    poller,
    ingress: ingressCoordinator,
    store: orderStore,
    journal: decisionJournal,
    metrics,
    webhookServer,
    metricsServer,
    inflightTracker,
    requireTradingDeps: true,
    schedulerContext,
    hotLaneContext
  });

  return {
    runtime,
    orderStore,
    decisionJournal,
    poller,
    ingressCoordinator,
    schedulerContext,
    hotLaneContext,
    sequencerClient,
    simService,
    nonceManager,
    executionPreparer,
    readClient,
    metricsServer,
    webhookServer,
    inflightTracker,
    sqlAdapter
  };
}
