import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeOrderHash, decodeSignedOrder } from '@uni/protocol';
import { describe, expect, it } from 'vitest';
import type { RouteBook } from '../src/routing/routeBook.js';
import type { RuntimeConfig } from '../src/runtime/config.js';
import { BotRuntime } from '../src/runtime/BotRuntime.js';
import { HybridIngressCoordinator } from '../src/ingress/hybridIngress.js';
import { InMemoryDecisionJournal } from '../src/journal/inMemoryDecisionJournal.js';
import { OrdersApiClient } from '../src/intake/ordersApiClient.js';
import { OrdersPoller } from '../src/intake/poller.js';
import { InMemoryNonceLedger, NonceManager } from '../src/send/nonceManager.js';
import type { SequencerClient } from '../src/send/sequencerClient.js';
import type { ForkSimService } from '../src/sim/forkSimService.js';
import { InMemoryOrderStore } from '../src/store/memory/inMemoryOrderStore.js';
import { BotMetrics } from '../src/telemetry/metrics.js';
import { JsonConsoleLogger } from '../src/telemetry/logging.js';
import { InflightTracker } from '../src/runtime/inflightTracker.js';
import type { PreparedExecution } from '../src/execution/preparedExecution.js';
import type { NormalizedOrder } from '../src/store/types.js';

function fixture(name: string): { encodedOrder: `0x${string}`; signature: `0x${string}` } {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/orders/arbitrum/live');
  return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) as { encodedOrder: `0x${string}`; signature: `0x${string}` };
}

function makePayload(name = 'live-01.json') {
  const signed = fixture(name);
  const decoded = decodeSignedOrder(signed.encodedOrder, signed.signature);
  return {
    orderHash: computeOrderHash(decoded.order) as `0x${string}`,
    orderType: 'Dutch_V3',
    encodedOrder: signed.encodedOrder,
    signature: signed.signature
  };
}

function toNormalizedOrder(payload: ReturnType<typeof makePayload>): NormalizedOrder {
  const decoded = decodeSignedOrder(payload.encodedOrder, payload.signature);
  return {
    orderHash: payload.orderHash,
    orderType: payload.orderType,
    encodedOrder: payload.encodedOrder,
    signature: payload.signature,
    decodedOrder: decoded,
    reactor: decoded.order.info.reactor
  };
}

function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    readRpcUrl: 'https://read.example',
    sequencerUrl: 'https://sequencer.example',
    databaseUrl: undefined,
    allowEphemeralState: true,
    signerPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    executorAddress: '0x3333333333333333333333333333333333333333',
    pollCadenceMs: 100,
    enableWebhookIngress: false,
    webhookHost: '127.0.0.1',
    webhookPort: 0,
    webhookPath: '/uniswapx/webhook',
    trustProxy: false,
    allowedWebhookCidrs: ['127.0.0.1/32'],
    maxWebhookBodyBytes: 1000000,
    schedulerCadenceMs: 100,
    hotLaneCadenceMs: 100,
    candidateBlocks: [1000n, 1001n],
    competeWindowBlocks: 2n,
    thresholdOut: 20n,
    shadowMode: true,
    canaryMode: false,
    canaryAllowlistedPairs: [],
    maxLiveNotionalIn: 10n ** 30n,
    maxLiveInflight: 10,
    minLiveEdgeOut: 1n,
    enableCamelotAmmv3: false,
    enableMetricsServer: false,
    metricsHost: '127.0.0.1',
    metricsPort: 0,
    ...overrides
  };
}

function routeBookWithNetEdge(netEdgeOut: bigint): RouteBook {
  return {
    selectBestRoute: async ({ resolvedOrder }) => {
      const requiredOutput = resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n);
      return {
        ok: true,
        chosenRoute: {
          venue: 'UNISWAP_V3',
          tokenIn: resolvedOrder.input.token,
          tokenOut: resolvedOrder.outputs[0]!.token,
          amountIn: resolvedOrder.input.amount,
          requiredOutput,
          quotedAmountOut: requiredOutput + netEdgeOut,
          minAmountOut: requiredOutput,
          limitSqrtPriceX96: 0n,
          slippageBufferOut: 1n,
          gasCostOut: 1n,
          riskBufferOut: 1n,
          profitFloorOut: 1n,
          grossEdgeOut: netEdgeOut + 3n,
          netEdgeOut,
          quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 500 }
        },
        alternativeRoutes: [{ venue: 'UNISWAP_V3', eligible: true, netEdgeOut, requiredOutput, minAmountOut: requiredOutput }]
      };
    }
  } as RouteBook;
}

function noEdgeRouteBook(): RouteBook {
  return {
    selectBestRoute: async () => ({
      ok: false,
      reason: 'NOT_ROUTEABLE',
      alternativeRoutes: [
        {
          venue: 'UNISWAP_V3',
          eligible: false,
          reason: 'NOT_ROUTEABLE',
          details: 'no path'
        }
      ]
    })
  } as RouteBook;
}

function makeRuntime(params: {
  config: RuntimeConfig;
  schedulerRouteBook: RouteBook;
  hotRouteBook?: RouteBook;
  simService?: ForkSimService;
  sequencerClient?: SequencerClient;
  logger?: JsonConsoleLogger;
}) {
  const metrics = new BotMetrics();
  const store = new InMemoryOrderStore();
  const journal = new InMemoryDecisionJournal();
  const ingress = new HybridIngressCoordinator({ metrics, journal, store });
  const poller = new OrdersPoller(
    new OrdersApiClient({
      baseUrl: 'https://orders.example',
      chainId: 42161,
      fetchImpl: async () => ({ ok: true, json: async () => [] } as Response)
    })
  );
  const nonceManager = new NonceManager({ ledger: new InMemoryNonceLedger(), chainNonceReader: async () => 1n });

  const runtime = new BotRuntime({
    config: params.config,
    poller,
    ingress,
    store,
    journal,
    metrics,
    inflightTracker: new InflightTracker(),
    schedulerContext: {
      routeBook: params.schedulerRouteBook,
      resolveEnv: { timestamp: 1_900_000_000n, basefee: 1n, chainId: 42161n }
    },
    hotLaneContext: {
      routeBook: params.hotRouteBook ?? params.schedulerRouteBook,
      resolveEnv: { timestamp: 1_900_000_000n, basefee: 1n, chainId: 42161n },
      conditionalEnvelope: { TimestampMax: 1_900_000_100n },
      executor: '0x3333333333333333333333333333333333333333',
      simService:
        params.simService ??
        ({
          simulatePrepared: async (prepared: PreparedExecution) => ({
            ok: true,
            reason: 'SUPPORTED',
            preparedExecution: prepared,
            txRequest: prepared.txRequest,
            serializedTransaction: prepared.serializedTransaction,
            gasUsed: 21_000n
          })
        } as ForkSimService),
      sequencerClient:
        params.sequencerClient ??
        ({
          sendPreparedExecution: async () => ({
            accepted: true,
            attempts: [{ writer: 'sequencer', classification: 'accepted' }],
            records: []
          })
        } as SequencerClient),
      nonceManager,
      executionPreparer: async ({ executionPlan }) => {
        const lease = await nonceManager.lease('0x2222222222222222222222222222222222222222', executionPlan.orderHash);
        return {
          orderHash: executionPlan.orderHash,
          executionPlan,
          txRequest: {
            from: '0x2222222222222222222222222222222222222222',
            to: executionPlan.executor,
            data: executionPlan.executeCalldata,
            value: 0n,
            nonce: lease.nonce,
            gas: 21_000n,
            chainId: 42161n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
            type: 'eip1559'
          },
          serializedTransaction: '0x1234',
          conditionalEnvelope: { TimestampMax: 1_900_000_100n },
          sender: '0x2222222222222222222222222222222222222222',
          nonce: lease.nonce,
          gas: 21_000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          nonceLease: lease
        };
      }
    },
    logger: params.logger
  });

  return { runtime, store, journal, ingress, metrics };
}

describe('runtime scheduler no-edge diagnostics + dropped state persistence', () => {
  it('scheduler no-edge transitions order to DROPPED with SCHEDULER_NO_EDGE reason', async () => {
    const payload = makePayload();
    const logs: string[] = [];
    const logger = new JsonConsoleLogger((line) => logs.push(line));
    const { runtime, store, journal, ingress } = makeRuntime({
      config: runtimeConfig({ thresholdOut: 10n }),
      schedulerRouteBook: noEdgeRouteBook(),
      logger
    });

    await ingress.ingest({ source: 'POLL', receivedAtMs: 1, payload, orderHashHint: payload.orderHash });
    await (runtime as unknown as { schedulerTick: () => Promise<void> }).schedulerTick();

    const record = await store.get(payload.orderHash);
    expect(record?.state).toEqual('DROPPED');
    expect(record?.reason).toEqual('SCHEDULER_NO_EDGE');

    const dropped = (await journal.byOrderHash(payload.orderHash)).find((event) => event.type === 'ORDER_DROPPED');
    expect(dropped?.payload.reason).toEqual('SCHEDULER_NO_EDGE');

    const events = logs.map((line) => JSON.parse(line).event as string);
    expect(events).toContain('scheduler_no_edge');
  });

  it('scheduler no-edge dropped payload includes compact economics evaluations', async () => {
    const payload = makePayload();
    const { runtime, journal, ingress } = makeRuntime({
      config: runtimeConfig({ candidateBlocks: [1000n, 1001n], thresholdOut: 10n }),
      schedulerRouteBook: noEdgeRouteBook()
    });

    await ingress.ingest({ source: 'POLL', receivedAtMs: 1, payload, orderHashHint: payload.orderHash });
    await (runtime as unknown as { schedulerTick: () => Promise<void> }).schedulerTick();

    const dropped = (await journal.byOrderHash(payload.orderHash)).find((event) => event.type === 'ORDER_DROPPED');
    expect(dropped?.payload).toMatchObject({
      reason: 'SCHEDULER_NO_EDGE',
      thresholdOut: '10',
      candidateBlocks: ['1000', '1001']
    });
    expect(typeof dropped?.payload.bestObservedNetEdgeOut).toEqual('string');
    expect(Array.isArray(dropped?.payload.evaluations)).toEqual(true);
    const firstEvaluation = dropped?.payload.evaluations?.[0] as Record<string, unknown> | undefined;
    expect(firstEvaluation).toMatchObject({
      block: '1000',
      selectionOk: false
    });
    expect(firstEvaluation).toHaveProperty('requiredOutput');
    expect(firstEvaluation).toHaveProperty('quotedAmountOut');
    expect(firstEvaluation).toHaveProperty('minAmountOut');
    expect(firstEvaluation).toHaveProperty('gasCostOut');
    expect(firstEvaluation).toHaveProperty('riskBufferOut');
    expect(firstEvaluation).toHaveProperty('profitFloorOut');
    expect(firstEvaluation).toHaveProperty('netEdgeOut');
    expect(firstEvaluation).toHaveProperty('alternativeRoutes');
    expect(firstEvaluation).not.toHaveProperty('route');
    expect(firstEvaluation).not.toHaveProperty('executionPlan');
  });

  it('hot-lane SKIP transitions order to DROPPED with skip reason and dropped journal event', async () => {
    const payload = makePayload();
    const normalized = toNormalizedOrder(payload);
    const { runtime, store, journal } = makeRuntime({
      config: runtimeConfig({
        shadowMode: false,
        canaryMode: true,
        canaryAllowlistedPairs: [{ inputToken: normalized.decodedOrder.order.baseInput.token, outputToken: '0x0000000000000000000000000000000000000001' }]
      }),
      schedulerRouteBook: routeBookWithNetEdge(30n)
    });

    await store.upsertDiscovered(normalized, normalized);
    await store.transition(payload.orderHash, 'DECODED');
    await store.transition(payload.orderHash, 'SUPPORTED', 'SUPPORTED');
    await store.transition(payload.orderHash, 'SCHEDULED');
    (runtime as unknown as { hotQueue: Array<Record<string, unknown>> }).hotQueue.push({
      orderHash: payload.orderHash,
      scheduledBlock: 1000n,
      competeWindowEnd: 1002n,
      predictedEdgeOut: 30n
    });

    await (runtime as unknown as { hotLaneTick: () => Promise<void> }).hotLaneTick();

    const record = await store.get(payload.orderHash);
    expect(record?.state).toEqual('DROPPED');
    expect(record?.reason).toEqual('PAIR_NOT_ALLOWLISTED');
    const dropped = (await journal.byOrderHash(payload.orderHash)).find((event) => event.type === 'ORDER_DROPPED');
    expect(dropped?.payload.reason).toEqual('PAIR_NOT_ALLOWLISTED');
  });

  it('shadow NO_SEND path persists SIM_OK with SHADOW_MODE reason', async () => {
    const payload = makePayload();
    const normalized = toNormalizedOrder(payload);
    const { runtime, store } = makeRuntime({
      config: runtimeConfig({ shadowMode: true }),
      schedulerRouteBook: routeBookWithNetEdge(30n)
    });

    await store.upsertDiscovered(normalized, normalized);
    await store.transition(payload.orderHash, 'DECODED');
    await store.transition(payload.orderHash, 'SUPPORTED', 'SUPPORTED');
    await store.transition(payload.orderHash, 'SCHEDULED');
    (runtime as unknown as { hotQueue: Array<Record<string, unknown>> }).hotQueue.push({
      orderHash: payload.orderHash,
      scheduledBlock: 1000n,
      competeWindowEnd: 1002n,
      predictedEdgeOut: 30n
    });

    await (runtime as unknown as { hotLaneTick: () => Promise<void> }).hotLaneTick();

    const record = await store.get(payload.orderHash);
    expect(record?.state).toEqual('SIM_OK');
    expect(record?.reason).toEqual('SHADOW_MODE');
  });

  it('live accepted send path persists SUBMITTING', async () => {
    const payload = makePayload();
    const normalized = toNormalizedOrder(payload);
    const { runtime, store } = makeRuntime({
      config: runtimeConfig({ shadowMode: false, canaryMode: false }),
      schedulerRouteBook: routeBookWithNetEdge(30n)
    });

    await store.upsertDiscovered(normalized, normalized);
    await store.transition(payload.orderHash, 'DECODED');
    await store.transition(payload.orderHash, 'SUPPORTED', 'SUPPORTED');
    await store.transition(payload.orderHash, 'SCHEDULED');
    (runtime as unknown as { hotQueue: Array<Record<string, unknown>> }).hotQueue.push({
      orderHash: payload.orderHash,
      scheduledBlock: 1000n,
      competeWindowEnd: 1002n,
      predictedEdgeOut: 30n
    });

    await (runtime as unknown as { hotLaneTick: () => Promise<void> }).hotLaneTick();

    const record = await store.get(payload.orderHash);
    expect(record?.state).toEqual('SUBMITTING');
  });
});
