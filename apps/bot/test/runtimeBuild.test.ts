import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeOrderHash, decodeSignedOrder } from '@uni/protocol';
import { describe, expect, it } from 'vitest';
import { buildRuntimeFromConfig } from '../src/runtime/buildRuntime.js';
import type { RuntimeConfig } from '../src/runtime/config.js';
import { InMemoryDecisionJournal } from '../src/journal/inMemoryDecisionJournal.js';
import { InMemoryOrderStore } from '../src/store/memory/inMemoryOrderStore.js';
import { BotRuntime } from '../src/runtime/BotRuntime.js';
import { OrdersApiClient } from '../src/intake/ordersApiClient.js';
import { OrdersPoller } from '../src/intake/poller.js';
import { HybridIngressCoordinator } from '../src/ingress/hybridIngress.js';
import { BotMetrics } from '../src/telemetry/metrics.js';
import { InflightTracker } from '../src/runtime/inflightTracker.js';
import { InMemoryNonceLedger, NonceManager } from '../src/send/nonceManager.js';
import type { ForkSimService } from '../src/sim/forkSimService.js';
import type { SequencerClient } from '../src/send/sequencerClient.js';
import type { PreparedExecution } from '../src/execution/preparedExecution.js';
import type { RouteBook } from '../src/routing/routeBook.js';
import type { ResolveEnvProvider } from '../src/runtime/resolveEnvProvider.js';

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    readRpcUrl: 'http://127.0.0.1:8545',
    forkRpcUrl: 'http://127.0.0.1:8545',
    sequencerUrl: 'http://127.0.0.1:8547',
    databaseUrl: undefined,
    allowEphemeralState: true,
    signerPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    executorAddress: '0x3333333333333333333333333333333333333333',

    pollCadenceMs: 100,
    enableWebhookIngress: false,
    webhookHost: '127.0.0.1',
    webhookPort: 18090,
    webhookPath: '/uniswapx/webhook',
    trustProxy: false,
    allowedWebhookCidrs: ['3.14.56.90/32'],
    maxWebhookBodyBytes: 100_000,

    schedulerCadenceMs: 100,
    hotLaneCadenceMs: 100,
    candidateBlocks: [1000n, 1001n],
    candidateBlockOffsets: [0n, 1n],
    maxCandidateBlocksPerOrder: 7,
    competeWindowBlocks: 2n,
    thresholdOut: 1n,

    shadowMode: true,
    canaryMode: false,
    canaryAllowlistedPairs: [],
    maxLiveNotionalIn: 10n ** 30n,
    maxLiveInflight: 2,
    minLiveEdgeOut: 1n,
    enableCamelotAmmv3: false,
    enableCamelotTwoHop: false,
    enableLfjLb: true,
    lfjLbRouter: '0xb4315e873dbcf96ffd0acd8ea43f689d8c20fb30',
    lfjLbQuoter: '0x64b57f4249aA99a812212cee7DAEFEDC40B203cD',
    lfjLbFactory: '0x8e42f2f4101563bf679975178e880fd87d3efd4e',
    enableLfjTwoHop: false,
    maxLfjTwoHopFamiliesPerOrder: 2,
    routeEvalMaxConcurrency: 4,
    infraBlockedRetryCooldownTicks: 2,
    twoHopUnlockMinCoverageBps: 9_800n,
    maxTwoHopFamiliesPerOrder: 2,
    maxRevertedProbesPerOrder: 3,
    maxPrepareStalenessBlocks: 2n,
    maxPrepareStalenessMs: 4_000,
    maxPrepareStaleRetries: 1,
    scheduledUrgentWindowMs: 1_000,
    bridgeTokens: ['0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'],

    enableMetricsServer: false,
    metricsHost: '127.0.0.1',
    metricsPort: 19100,
    ...overrides
  };
}

function routeBookWithEdge(edgeOut: bigint): RouteBook {
  return {
    selectBestRoute: async ({ resolvedOrder }) => ({
      ok: true,
      chosenRoute: {
        venue: 'UNISWAP_V3',
        pathKind: 'DIRECT',
        hopCount: 1,
        tokenIn: resolvedOrder.input.token,
        tokenOut: resolvedOrder.outputs[0]!.token,
        amountIn: resolvedOrder.input.amount,
        requiredOutput: resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n),
        quotedAmountOut: resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n) + edgeOut,
        minAmountOut: resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n),
        limitSqrtPriceX96: 0n,
        slippageBufferOut: 0n,
        gasCostOut: 0n,
        riskBufferOut: 0n,
        profitFloorOut: 0n,
        grossEdgeOut: edgeOut,
        netEdgeOut: edgeOut,
        quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 500 }
      },
      alternativeRoutes: [{ venue: 'UNISWAP_V3', eligible: true, netEdgeOut: edgeOut }]
    })
  } as RouteBook;
}

function makeNormalizedOrder() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/orders/arbitrum/live');
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'live-01.json'), 'utf8')) as {
    encodedOrder: `0x${string}`;
    signature: `0x${string}`;
  };
  const decoded = decodeSignedOrder(fixture.encodedOrder, fixture.signature);
  return {
    orderHash: computeOrderHash(decoded.order) as `0x${string}`,
    orderType: 'Dutch_V3',
    encodedOrder: fixture.encodedOrder,
    signature: fixture.signature,
    decodedOrder: decoded,
    reactor: decoded.order.info.reactor
  };
}

describe('runtime build composition', () => {
  it('buildRuntimeFromConfig_wiresTradingDependencies', async () => {
    const built = await buildRuntimeFromConfig(config());

    expect(built.runtime).toBeInstanceOf(BotRuntime);
    expect(built.schedulerContext).toBeDefined();
    expect(built.hotLaneContext).toBeDefined();
    expect(built.sequencerClient).toBeDefined();
    expect(built.simService).toBeDefined();
    expect(built.nonceManager).toBeDefined();
    expect(built.executionPreparer).toBeDefined();
    expect(built.ingressCoordinator).toBeDefined();
    expect(built.poller).toBeDefined();
  });

  it('buildRuntimeFromConfig_rejectsLiveModeWithoutDurableJournal', async () => {
    await expect(
      buildRuntimeFromConfig(
        config({
          shadowMode: false,
          canaryMode: false,
          databaseUrl: undefined
        })
      )
    ).rejects.toThrow('databaseUrl is required for live/canary mode');
  });

  it('buildRuntimeFromConfig_rejectsCanaryModeWithEphemeralState', async () => {
    await expect(
      buildRuntimeFromConfig(
        config({
          shadowMode: false,
          canaryMode: true,
          allowEphemeralState: true,
          databaseUrl: undefined
        })
      )
    ).rejects.toThrow('databaseUrl is required for live/canary mode');
  });

  it('buildRuntimeFromConfig_allowsShadowDevWithEphemeralState', async () => {
    const built = await buildRuntimeFromConfig(
      config({
        shadowMode: true,
        allowEphemeralState: true,
        databaseUrl: undefined
      })
    );

    expect(built.orderStore).toBeInstanceOf(InMemoryOrderStore);
    expect(built.decisionJournal).toBeInstanceOf(InMemoryDecisionJournal);
  });

  it('livePolicyUsesInflightTrackerNotHotQueueLength', async () => {
    const metrics = new BotMetrics();
    const store = new InMemoryOrderStore();
    const journal = new InMemoryDecisionJournal();
    const ingress = new HybridIngressCoordinator({ store, journal, metrics });
    const poller = new OrdersPoller(
      new OrdersApiClient({
        baseUrl: 'https://orders.example',
        chainId: 42161,
        fetchImpl: async () => ({ ok: true, json: async () => [] } as Response)
      })
    );
    const inflightTracker = new InflightTracker();
    const normalized = makeNormalizedOrder();
    const outputToken = normalized.decodedOrder.order.baseOutputs[0]!.token;
    const nonceManager = new NonceManager({ ledger: new InMemoryNonceLedger(), chainNonceReader: async () => 1n });
    let prepareCalls = 0;

    const runtime = new BotRuntime({
      config: config({
        shadowMode: false,
        canaryMode: true,
        maxLiveInflight: 1,
        canaryAllowlistedPairs: [{ inputToken: normalized.decodedOrder.order.baseInput.token, outputToken }]
      }),
      poller,
      ingress,
      store,
      journal,
      metrics,
      inflightTracker,
      requireTradingDeps: true,
      schedulerContext: {
        routeBook: routeBookWithEdge(10n),
        resolveEnvProvider: {
          getCurrent: async () => ({ chainId: 42161n, blockNumber: 1000n, blockNumberish: 1000n, timestamp: 1_900_000_000n, baseFeePerGas: 1n, sampledAtMs: 1 })
        } as ResolveEnvProvider,
        resolveEnv: { timestamp: 1_900_000_000n, basefee: 1n, chainId: 42161n }
      },
      hotLaneContext: {
        routeBook: routeBookWithEdge(10n),
        resolveEnv: { timestamp: 1_900_000_000n, basefee: 1n, chainId: 42161n },
        conditionalEnvelope: { TimestampMax: 1_900_000_100n },
        executor: '0x3333333333333333333333333333333333333333',
        simService: {
          simulatePrepared: async (prepared: PreparedExecution) => ({
            ok: true,
            reason: 'SUPPORTED',
            preparedExecution: prepared,
            txRequest: prepared.txRequest,
            serializedTransaction: prepared.serializedTransaction,
            gasUsed: 21_000n
          })
        } as ForkSimService,
        sequencerClient: {
          sendPreparedExecution: async () => ({ accepted: true, attempts: [{ writer: 'sequencer', classification: 'accepted' }], records: [] })
        } as unknown as SequencerClient,
        nonceManager,
        executionPreparer: async () => {
          prepareCalls += 1;
          throw new Error('prepare-failed-for-test');
        }
      }
    });
    await store.upsertDiscovered(normalized, normalized);
    await store.transition(normalized.orderHash, 'DECODED');
    await store.transition(normalized.orderHash, 'SUPPORTED', 'SUPPORTED');
    await store.transition(normalized.orderHash, 'SCHEDULED');

    (runtime as unknown as { hotQueue: Array<Record<string, unknown>> }).hotQueue.push(
      { orderHash: normalized.orderHash, scheduledBlock: 1000n, competeWindowEnd: 1002n, predictedEdgeOut: 10n },
      { orderHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', scheduledBlock: 1000n, competeWindowEnd: 1002n, predictedEdgeOut: 10n }
    );
    await (runtime as unknown as { hotLaneTick: () => Promise<void> }).hotLaneTick();
    expect(prepareCalls).toBeGreaterThan(0);

    const beforeBlocked = prepareCalls;
    (runtime as unknown as { hotQueue: Array<Record<string, unknown>> }).hotQueue.push({
      orderHash: normalized.orderHash,
      scheduledBlock: 1000n,
      competeWindowEnd: 1002n,
      predictedEdgeOut: 10n
    });
    inflightTracker.markAttempted('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    await (runtime as unknown as { hotLaneTick: () => Promise<void> }).hotLaneTick();
    expect(prepareCalls).toEqual(beforeBlocked);
  });
});
