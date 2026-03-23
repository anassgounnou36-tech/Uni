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
import type { ExecutionPlan } from '../src/execution/types.js';
import type { NormalizedOrder } from '../src/store/types.js';
import type { ResolveEnvProvider } from '../src/runtime/resolveEnvProvider.js';

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
    candidateBlockOffsets: [0n, 1n],
    competeWindowBlocks: 2n,
    thresholdOut: 20n,
    routeEvalMaxConcurrency: 4,
    infraBlockedRetryCooldownTicks: 2,
    shadowMode: true,
    canaryMode: false,
    canaryAllowlistedPairs: [],
    maxLiveNotionalIn: 10n ** 30n,
    maxLiveInflight: 10,
    minLiveEdgeOut: 1n,
    enableCamelotAmmv3: false,
    enableCamelotTwoHop: false,
    bridgeTokens: ['0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'],
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
          pathKind: 'DIRECT',
          hopCount: 1,
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
        chosenSummary: {
          venue: 'UNISWAP_V3',
          status: 'ROUTEABLE',
          reason: 'ROUTEABLE',
          quotedAmountOut: requiredOutput + netEdgeOut,
          minAmountOut: requiredOutput,
          grossEdgeOut: netEdgeOut + 3n,
          netEdgeOut
        },
        venueAttempts: [
          {
            venue: 'UNISWAP_V3',
            status: 'ROUTEABLE',
            reason: 'ROUTEABLE',
            quotedAmountOut: requiredOutput + netEdgeOut,
            minAmountOut: requiredOutput,
            grossEdgeOut: netEdgeOut + 3n,
            netEdgeOut,
            selectedFeeTier: 500,
            feeTierAttempts: [
              {
                feeTier: 500,
                poolExists: true,
                quoteSucceeded: true,
                quotedAmountOut: requiredOutput + netEdgeOut,
                minAmountOut: requiredOutput,
                grossEdgeOut: netEdgeOut + 3n,
                netEdgeOut,
                status: 'ROUTEABLE',
                reason: 'ROUTEABLE'
              }
            ]
          }
        ],
        alternativeRoutes: [{ venue: 'UNISWAP_V3', eligible: true, netEdgeOut, requiredOutput, minAmountOut: requiredOutput }]
      };
    }
  } as RouteBook;
}

  function noEdgeRouteBook(): RouteBook {
  return {
    selectBestRoute: async () => ({
      ok: false,
      reason: 'NOT_PROFITABLE',
      venueAttempts: [
        {
          venue: 'UNISWAP_V3',
          status: 'NOT_PROFITABLE',
          reason: 'NET_EDGE_NON_POSITIVE',
          quotedAmountOut: 100n,
          minAmountOut: 100n,
          grossEdgeOut: 0n,
          netEdgeOut: -1n,
          selectedFeeTier: 3000,
          quoteCount: 1,
          feeTierAttempts: [
            {
              feeTier: 500,
              poolExists: false,
              quoteSucceeded: false,
              status: 'NOT_ROUTEABLE',
              reason: 'POOL_MISSING'
            },
            {
              feeTier: 3000,
              poolExists: true,
              quoteSucceeded: true,
              quotedAmountOut: 100n,
              minAmountOut: 100n,
              grossEdgeOut: 0n,
              netEdgeOut: -1n,
              status: 'NOT_PROFITABLE',
              reason: 'NET_EDGE_NON_POSITIVE'
            },
            {
              feeTier: 10000,
              poolExists: true,
              quoteSucceeded: false,
              status: 'QUOTE_FAILED',
              reason: 'READ_ERROR'
            }
          ]
        },
        {
          venue: 'CAMELOT_AMMV3',
          status: 'NOT_PROFITABLE',
          reason: 'NET_EDGE_NON_POSITIVE',
          quotedAmountOut: 99n,
          minAmountOut: 100n,
          grossEdgeOut: -1n,
          netEdgeOut: -2n,
          exactOutputViability: {
            status: 'NOT_CHECKED',
            targetOutput: 100n,
            requiredInputForTargetOutput: 1_000n,
            availableInput: 1_000n,
            reason: 'exact-output viability skipped'
          }
        }
      ],
      bestRejectedSummary: {
        venue: 'UNISWAP_V3',
        status: 'NOT_PROFITABLE',
        reason: 'NET_EDGE_NON_POSITIVE',
        quotedAmountOut: 100n,
        minAmountOut: 100n,
        grossEdgeOut: 0n,
        netEdgeOut: -1n,
        selectedFeeTier: 3000,
        quoteCount: 1,
        feeTierAttempts: [
          {
            feeTier: 500,
            poolExists: false,
            quoteSucceeded: false,
            status: 'NOT_ROUTEABLE',
            reason: 'POOL_MISSING'
          },
          {
            feeTier: 3000,
            poolExists: true,
            quoteSucceeded: true,
            quotedAmountOut: 100n,
            minAmountOut: 100n,
            grossEdgeOut: 0n,
            netEdgeOut: -1n,
            status: 'NOT_PROFITABLE',
            reason: 'NET_EDGE_NON_POSITIVE'
          },
          {
            feeTier: 10000,
            poolExists: true,
            quoteSucceeded: false,
            status: 'QUOTE_FAILED',
            reason: 'READ_ERROR'
          }
        ]
      },
      alternativeRoutes: [
        {
          venue: 'UNISWAP_V3',
          eligible: false,
          reason: 'NOT_PROFITABLE',
          details: 'no path'
        }
      ]
    })
  } as RouteBook;
}

function noEdgeNearMissRouteBook(): RouteBook {
  return {
    selectBestRoute: async () => ({
      ok: false,
      reason: 'CONSTRAINT_REJECTED',
      venueAttempts: [
        {
          venue: 'UNISWAP_V3',
          status: 'CONSTRAINT_REJECTED',
          reason: 'PROFITABILITY_FLOOR',
          quotedAmountOut: 998n,
          minAmountOut: 1_000n,
          grossEdgeOut: 98n,
          netEdgeOut: -2n,
          constraintReason: 'PROFITABILITY_FLOOR',
          constraintBreakdown: {
            requiredOutput: 900n,
            quotedAmountOut: 998n,
            slippageBufferOut: 1n,
            gasCostOut: 1n,
            riskBufferOut: 0n,
            profitFloorOut: 100n,
            slippageFloorOut: 997n,
            profitabilityFloorOut: 1_000n,
            minAmountOut: 1_000n,
            requiredOutputShortfallOut: 0n,
            minAmountOutShortfallOut: 2n,
            bindingFloor: 'PROFITABILITY_FLOOR',
            nearMiss: true,
            nearMissBps: 25n
          },
          exactOutputViability: {
            status: 'NOT_CHECKED',
            targetOutput: 900n,
            requiredInputForTargetOutput: 1_000n,
            availableInput: 1_000n,
            checkedFeeTier: 500,
            reason: 'exact-output viability skipped'
          },
          hedgeGap: {
            requiredOutput: 900n,
            quotedAmountOut: 998n,
            outputCoverageBps: 11_088n,
            requiredOutputShortfallOut: 0n,
            minAmountOutShortfallOut: 2n,
            gapClass: 'EXACT',
            nearMiss: true,
            nearMissBps: 25n
          }
        }
      ],
      bestRejectedSummary: {
        venue: 'UNISWAP_V3',
        status: 'CONSTRAINT_REJECTED',
        reason: 'REQUIRED_OUTPUT',
        quotedAmountOut: 998n,
        minAmountOut: 1_000n,
        grossEdgeOut: 98n,
        netEdgeOut: -2n,
        constraintReason: 'REQUIRED_OUTPUT',
        constraintBreakdown: {
          requiredOutput: 900n,
          quotedAmountOut: 898n,
          slippageBufferOut: 1n,
          gasCostOut: 1n,
          riskBufferOut: 0n,
          profitFloorOut: 0n,
          slippageFloorOut: 897n,
          profitabilityFloorOut: 901n,
          minAmountOut: 901n,
          requiredOutputShortfallOut: 2n,
          minAmountOutShortfallOut: 2n,
          bindingFloor: 'PROFITABILITY_FLOOR',
          nearMiss: true,
          nearMissBps: 25n
        },
        exactOutputViability: {
          status: 'UNSATISFIABLE',
          targetOutput: 900n,
          requiredInputForTargetOutput: 1_001n,
          availableInput: 1_000n,
          inputDeficit: 1n,
          inputSlack: 0n,
          checkedFeeTier: 500,
          reason: 'required output unsatisfiable with available input'
        },
        hedgeGap: {
          requiredOutput: 900n,
          quotedAmountOut: 898n,
          outputCoverageBps: 9_977n,
          requiredOutputShortfallOut: 2n,
          minAmountOutShortfallOut: 2n,
          inputDeficit: 1n,
          inputSlack: 0n,
          gapClass: 'SMALL',
          nearMiss: true,
          nearMissBps: 25n
        }
      },
      alternativeRoutes: [
        {
          venue: 'UNISWAP_V3',
          eligible: false,
          reason: 'NOT_PROFITABLE',
          details: 'Near miss'
        }
      ]
    })
  } as RouteBook;
}

function noEdgeRequiredOutputSatisfiableRouteBook(): RouteBook {
  return {
    selectBestRoute: async () => ({
      ok: false,
      reason: 'CONSTRAINT_REJECTED',
      venueAttempts: [
        {
          venue: 'UNISWAP_V3',
          status: 'CONSTRAINT_REJECTED',
          reason: 'REQUIRED_OUTPUT',
          quotedAmountOut: 899n,
          minAmountOut: 901n,
          grossEdgeOut: -1n,
          netEdgeOut: -1n,
          constraintReason: 'REQUIRED_OUTPUT',
          exactOutputViability: {
            status: 'SATISFIABLE',
            targetOutput: 900n,
            requiredInputForTargetOutput: 999n,
            availableInput: 1_000n,
            inputDeficit: 0n,
            inputSlack: 1n,
            checkedFeeTier: 500,
            reason: 'required output satisfiable with available input'
          },
          hedgeGap: {
            requiredOutput: 900n,
            quotedAmountOut: 899n,
            outputCoverageBps: 9_988n,
            requiredOutputShortfallOut: 1n,
            minAmountOutShortfallOut: 2n,
            inputDeficit: 0n,
            inputSlack: 1n,
            gapClass: 'MEDIUM',
            nearMiss: true,
            nearMissBps: 25n
          }
        }
      ],
      bestRejectedSummary: {
        venue: 'UNISWAP_V3',
        status: 'CONSTRAINT_REJECTED',
        reason: 'REQUIRED_OUTPUT',
        quotedAmountOut: 899n,
        minAmountOut: 901n,
        grossEdgeOut: -1n,
        netEdgeOut: -1n,
        constraintReason: 'REQUIRED_OUTPUT',
        exactOutputViability: {
          status: 'SATISFIABLE',
          targetOutput: 900n,
          requiredInputForTargetOutput: 999n,
          availableInput: 1_000n,
          inputDeficit: 0n,
          inputSlack: 1n,
          checkedFeeTier: 500,
          reason: 'required output satisfiable with available input'
        },
        hedgeGap: {
          requiredOutput: 900n,
          quotedAmountOut: 899n,
          outputCoverageBps: 9_988n,
          requiredOutputShortfallOut: 1n,
          minAmountOutShortfallOut: 2n,
          inputDeficit: 0n,
          inputSlack: 1n,
          gapClass: 'MEDIUM',
          nearMiss: true,
          nearMissBps: 25n
        }
      },
      alternativeRoutes: [{ venue: 'UNISWAP_V3', eligible: false, reason: 'NOT_PROFITABLE', details: 'No edge' }]
    })
  } as RouteBook;
}

function noEdgeCamelotUnsatisfiableRouteBook(): RouteBook {
  return {
    selectBestRoute: async () => ({
      ok: false,
      reason: 'CONSTRAINT_REJECTED',
      venueAttempts: [
        {
          venue: 'CAMELOT_AMMV3',
          status: 'CONSTRAINT_REJECTED',
          reason: 'REQUIRED_OUTPUT',
          quotedAmountOut: 899n,
          minAmountOut: 901n,
          grossEdgeOut: -1n,
          netEdgeOut: -1n,
          constraintReason: 'REQUIRED_OUTPUT',
          exactOutputViability: {
            status: 'UNSATISFIABLE',
            targetOutput: 900n,
            requiredInputForTargetOutput: 1_001n,
            availableInput: 1_000n,
            inputDeficit: 1n,
            inputSlack: 0n,
            reason: 'required output unsatisfiable with available input'
          },
          hedgeGap: {
            requiredOutput: 900n,
            quotedAmountOut: 899n,
            outputCoverageBps: 9_988n,
            requiredOutputShortfallOut: 1n,
            minAmountOutShortfallOut: 2n,
            inputDeficit: 1n,
            inputSlack: 0n,
            gapClass: 'MEDIUM',
            nearMiss: true,
            nearMissBps: 25n
          }
        }
      ],
      bestRejectedSummary: {
        venue: 'CAMELOT_AMMV3',
        status: 'CONSTRAINT_REJECTED',
        reason: 'REQUIRED_OUTPUT',
        quotedAmountOut: 899n,
        minAmountOut: 901n,
        grossEdgeOut: -1n,
        netEdgeOut: -1n,
        constraintReason: 'REQUIRED_OUTPUT',
        exactOutputViability: {
          status: 'UNSATISFIABLE',
          targetOutput: 900n,
          requiredInputForTargetOutput: 1_001n,
          availableInput: 1_000n,
          inputDeficit: 1n,
          inputSlack: 0n,
          reason: 'required output unsatisfiable with available input'
        },
        hedgeGap: {
          requiredOutput: 900n,
          quotedAmountOut: 899n,
          outputCoverageBps: 9_988n,
          requiredOutputShortfallOut: 1n,
          minAmountOutShortfallOut: 2n,
          inputDeficit: 1n,
          inputSlack: 0n,
          gapClass: 'MEDIUM',
          nearMiss: true,
          nearMissBps: 25n
        }
      },
      alternativeRoutes: [{ venue: 'CAMELOT_AMMV3', eligible: false, reason: 'NOT_PROFITABLE', details: 'No edge' }]
    })
  } as RouteBook;
}

function makeRuntime(params: {
  config: RuntimeConfig;
  schedulerRouteBook: RouteBook;
  hotRouteBook?: RouteBook;
  simService?: ForkSimService;
  sequencerClient?: SequencerClient;
  executionPreparer?: (input: { executionPlan: ExecutionPlan }) => Promise<PreparedExecution>;
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
      resolveEnvProvider: {
        getCurrent: async () => ({ chainId: 42161n, blockNumber: 1000n, blockNumberish: 1000n, timestamp: 1_900_000_000n, baseFeePerGas: 1n, sampledAtMs: 1 })
      } as ResolveEnvProvider,
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
      executionPreparer:
        params.executionPreparer
        ?? (async ({ executionPlan }) => {
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
        })
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
    expect(events).toContain('routebook_no_edge_summary');
  });

  it('infra-blocked evaluation does not become SCHEDULER_NO_EDGE and emits ORDER_EVALUATION_BLOCKED', async () => {
    const payload = makePayload();
    const routeBook = {
      selectBestRoute: async () => ({
        ok: false as const,
        reason: 'RATE_LIMITED' as const,
        infraBlocked: true,
        venueAttempts: [
          {
            venue: 'UNISWAP_V3' as const,
            status: 'RATE_LIMITED' as const,
            reason: 'RATE_LIMITED',
            errorCategory: 'RATE_LIMITED' as const,
            errorMessage: 'exceeded compute units'
          }
        ],
        bestRejectedSummary: {
          venue: 'UNISWAP_V3' as const,
          status: 'RATE_LIMITED' as const,
          reason: 'RATE_LIMITED',
          errorCategory: 'RATE_LIMITED' as const,
          errorMessage: 'exceeded compute units',
          candidateClass: 'INFRA_BLOCKED' as const
        },
        alternativeRoutes: []
      })
    } as RouteBook;
    const { runtime, store, journal, ingress } = makeRuntime({
      config: runtimeConfig({ thresholdOut: 10n }),
      schedulerRouteBook: routeBook
    });

    await ingress.ingest({ source: 'POLL', receivedAtMs: 1, payload, orderHashHint: payload.orderHash });
    await (runtime as unknown as { schedulerTick: () => Promise<void> }).schedulerTick();

    const record = await store.get(payload.orderHash);
    expect(record?.state).toEqual('SUPPORTED');
    expect(record?.reason).toEqual('SUPPORTED');
    const dropped = (await journal.byOrderHash(payload.orderHash)).find((event) => event.type === 'ORDER_DROPPED');
    expect(dropped).toBeUndefined();
    const blocked = (await journal.byOrderHash(payload.orderHash)).find((event) => event.type === 'ORDER_EVALUATION_BLOCKED');
    expect(blocked).toBeDefined();
    expect(blocked?.payload.reason).toEqual('RATE_LIMITED');
  });

  it('rate-limited candidates use cooldown and do not thrash each tick', async () => {
    const payload = makePayload();
    let calls = 0;
    const routeBook = {
      selectBestRoute: async () => {
        calls += 1;
        return {
          ok: false as const,
          reason: 'RATE_LIMITED' as const,
          infraBlocked: true,
          venueAttempts: [
            {
              venue: 'UNISWAP_V3' as const,
              status: 'RATE_LIMITED' as const,
              reason: 'RATE_LIMITED',
              errorCategory: 'RATE_LIMITED' as const,
              errorMessage: '429'
            }
          ],
          bestRejectedSummary: {
            venue: 'UNISWAP_V3' as const,
            status: 'RATE_LIMITED' as const,
            reason: 'RATE_LIMITED',
            errorCategory: 'RATE_LIMITED' as const,
            errorMessage: '429',
            candidateClass: 'INFRA_BLOCKED' as const
          },
          alternativeRoutes: []
        };
      }
    } as RouteBook;
    const { runtime, ingress } = makeRuntime({
      config: runtimeConfig({ infraBlockedRetryCooldownTicks: 2 }),
      schedulerRouteBook: routeBook
    });

    await ingress.ingest({ source: 'POLL', receivedAtMs: 1, payload, orderHashHint: payload.orderHash });
    await (runtime as unknown as { schedulerTick: () => Promise<void> }).schedulerTick();
    await (runtime as unknown as { schedulerTick: () => Promise<void> }).schedulerTick();
    await (runtime as unknown as { schedulerTick: () => Promise<void> }).schedulerTick();

    // Two candidate blocks per evaluation tick; with cooldown we only evaluate on ticks 1 and 3.
    expect(calls).toBe(4);
  });

  it('scheduler no-edge dropped payload includes compact economics evaluations', async () => {
    const payload = makePayload();
    const { runtime, journal, ingress } = makeRuntime({
      config: runtimeConfig({ candidateBlockOffsets: [0n, 1n], thresholdOut: 10n }),
      schedulerRouteBook: noEdgeRouteBook()
    });

    await ingress.ingest({ source: 'POLL', receivedAtMs: 1, payload, orderHashHint: payload.orderHash });
    await (runtime as unknown as { schedulerTick: () => Promise<void> }).schedulerTick();

    const dropped = (await journal.byOrderHash(payload.orderHash)).find((event) => event.type === 'ORDER_DROPPED');
    expect(dropped?.payload).toMatchObject({
      reason: 'SCHEDULER_NO_EDGE',
      thresholdOut: '10',
      candidateBlockOffsets: ['0', '1']
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
    expect(firstEvaluation).toHaveProperty('venueAttempts');
    expect(firstEvaluation).toHaveProperty('bestRejectedSummary');
    const venueAttempts = (firstEvaluation?.venueAttempts ?? []) as Array<Record<string, unknown>>;
    const uniswapAttempt = venueAttempts.find((attempt) => attempt.venue === 'UNISWAP_V3');
    expect(uniswapAttempt).toBeDefined();
    expect(uniswapAttempt).toHaveProperty('feeTierAttempts');
    expect(dropped?.payload).toHaveProperty('bestRejectedSummary');
    expect(firstEvaluation).not.toHaveProperty('route');
    expect(firstEvaluation).not.toHaveProperty('executionPlan');
  });

  it('routebook no-edge summary log stays concise', async () => {
    const payload = makePayload();
    const logs: string[] = [];
    const logger = new JsonConsoleLogger((line) => logs.push(line));
    const { runtime, ingress } = makeRuntime({
      config: runtimeConfig({ candidateBlockOffsets: [0n], thresholdOut: 10n }),
      schedulerRouteBook: noEdgeRouteBook(),
      logger
    });

    await ingress.ingest({ source: 'POLL', receivedAtMs: 1, payload, orderHashHint: payload.orderHash });
    await (runtime as unknown as { schedulerTick: () => Promise<void> }).schedulerTick();

    const summaryRecord = logs
      .map((line) => JSON.parse(line) as { event: string; fields?: Record<string, unknown> })
      .find((record) => record.event === 'routebook_no_edge_summary');
    expect(summaryRecord).toBeDefined();
    expect(summaryRecord?.fields?.venueAttemptStatuses).toBeDefined();
    expect(summaryRecord?.fields?.venueAttempts).toBeUndefined();
    const statuses = summaryRecord?.fields?.venueAttemptStatuses as Array<Record<string, unknown>>;
    expect(statuses[0]).toMatchObject({
      venue: 'UNISWAP_V3'
    });
    expect(statuses[0]).not.toHaveProperty('feeTierAttempts');
  });

  it('near-miss rejected candidate increments metric and is preserved in logs and dropped payload', async () => {
    const payload = makePayload();
    const logs: string[] = [];
    const logger = new JsonConsoleLogger((line) => logs.push(line));
    const { runtime, journal, ingress, metrics } = makeRuntime({
      config: runtimeConfig({ candidateBlockOffsets: [0n], thresholdOut: 10n }),
      schedulerRouteBook: noEdgeNearMissRouteBook(),
      logger
    });

    await ingress.ingest({ source: 'POLL', receivedAtMs: 1, payload, orderHashHint: payload.orderHash });
    await (runtime as unknown as { schedulerTick: () => Promise<void> }).schedulerTick();

    expect(metrics.snapshot().counters.scheduler_near_miss_total).toBe(1);
    const summaryRecord = logs
      .map((line) => JSON.parse(line) as { event: string; fields?: Record<string, unknown> })
      .find((record) => record.event === 'routebook_no_edge_summary');
    expect(summaryRecord?.fields?.bestRejectedConstraintReason).toBe('REQUIRED_OUTPUT');
    expect(summaryRecord?.fields?.bestRejectedCandidateClass).toBeDefined();
    expect(typeof summaryRecord?.fields?.bestRejectedCandidateClass).toBe('string');
    expect(summaryRecord?.fields?.bestRejectedNearMiss).toBe(true);
    expect(summaryRecord?.fields?.bestRejectedShortfallOut).toBe('2');
    expect(summaryRecord?.fields?.bestRejectedExactOutputStatus).toBe('UNSATISFIABLE');
    expect(summaryRecord?.fields?.bestRejectedInputDeficit).toBe('1');
    expect(summaryRecord?.fields?.bestRejectedGapClass).toBe('SMALL');
    expect(summaryRecord?.fields?.bestRejectedOutputCoverageBps).toBe('9977');
    expect(summaryRecord?.fields?.bestRejectedRequiredOutputShortfallOut).toBe('2');
    expect(summaryRecord?.fields?.bestRejectedInputSlack).toBe('0');
    expect(summaryRecord?.fields?.bestRejectedCheckedFeeTier).toBe(500);

    const dropped = (await journal.byOrderHash(payload.orderHash)).find((event) => event.type === 'ORDER_DROPPED');
    const droppedBestRejected = dropped?.payload.bestRejectedSummary as Record<string, unknown> | undefined;
    expect(droppedBestRejected?.candidateClass).toBeDefined();
    expect((droppedBestRejected?.candidateClass as string).length).toBeGreaterThan(0);
    expect(droppedBestRejected?.constraintReason).toBe('REQUIRED_OUTPUT');
    expect((droppedBestRejected?.exactOutputViability as Record<string, unknown> | undefined)?.status).toBe('UNSATISFIABLE');
    expect((droppedBestRejected?.hedgeGap as Record<string, unknown> | undefined)?.gapClass).toBe('SMALL');
    const breakdown = droppedBestRejected?.constraintBreakdown as Record<string, unknown> | undefined;
    expect(breakdown?.nearMiss).toBe(true);
    expect(breakdown?.nearMissBps).toBe('25');
    const firstEvaluation = (dropped?.payload.evaluations?.[0] ?? {}) as Record<string, unknown>;
    const firstVenueAttempt = ((firstEvaluation.venueAttempts as Array<Record<string, unknown>> | undefined) ?? [])[0];
    expect(firstVenueAttempt?.constraintBreakdown).toBeDefined();
    expect((firstVenueAttempt?.exactOutputViability as Record<string, unknown> | undefined)?.status).toBe('NOT_CHECKED');
    expect((firstVenueAttempt?.hedgeGap as Record<string, unknown> | undefined)?.gapClass).toBe('EXACT');
    const venueAttempts = (dropped?.payload.evaluations?.[0] as Record<string, unknown> | undefined)
      ?.venueAttempts as Array<Record<string, unknown>> | undefined;
    const validCandidateClasses = new Set([
      'POLICY_BLOCKED',
      'LIQUIDITY_BLOCKED',
      'ROUTE_MISSING',
      'QUOTE_FAILED',
      'GAS_NOT_PRICEABLE',
      'UNKNOWN'
    ]);
    for (const attempt of venueAttempts ?? []) {
      expect(typeof attempt.candidateClass).toBe('string');
      expect((attempt.candidateClass as string).length).toBeGreaterThan(0);
      expect(validCandidateClasses.has(attempt.candidateClass as string)).toBe(true);
    }
    expect(metrics.snapshot().counters.scheduler_required_output_unsatisfiable_total).toBe(1);
    expect(metrics.snapshot().counters.scheduler_required_output_near_miss_total).toBe(1);
    expect(metrics.snapshot().counters['scheduler_gap_class_total{gap_class="SMALL"}']).toBe(1);
    expect(metrics.snapshot().counters.scheduler_required_output_satisfiable_total).toBeUndefined();
  });

  it('candidateClass_is_serialized_in_bestRejectedSummary_and_dropped_payloads', async () => {
    const payload = makePayload();
    const { runtime, journal, ingress } = makeRuntime({
      config: runtimeConfig({ candidateBlockOffsets: [0n], thresholdOut: 10n }),
      schedulerRouteBook: noEdgeNearMissRouteBook()
    });

    await ingress.ingest({ source: 'POLL', receivedAtMs: 1, payload, orderHashHint: payload.orderHash });
    await (runtime as unknown as { schedulerTick: () => Promise<void> }).schedulerTick();

    const dropped = (await journal.byOrderHash(payload.orderHash)).find((event) => event.type === 'ORDER_DROPPED');
    const bestRejected = dropped?.payload.bestRejectedSummary as Record<string, unknown> | undefined;
    expect(typeof bestRejected?.candidateClass).toBe('string');
    expect((bestRejected?.candidateClass as string).length).toBeGreaterThan(0);
    const evaluations = (dropped?.payload.evaluations ?? []) as Array<Record<string, unknown>>;
    for (const evaluation of evaluations) {
      const droppedBestRejected = evaluation.bestRejectedSummary as Record<string, unknown> | undefined;
      if (droppedBestRejected) {
        expect(typeof droppedBestRejected.candidateClass).toBe('string');
        expect((droppedBestRejected.candidateClass as string).length).toBeGreaterThan(0);
      }
      const venueAttempts = (evaluation.venueAttempts ?? []) as Array<Record<string, unknown>>;
      for (const attempt of venueAttempts) {
        expect(typeof attempt.candidateClass).toBe('string');
        expect((attempt.candidateClass as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('increments satisfiable-required-output counter only when best rejected viability is SATISFIABLE', async () => {
    const payload = makePayload();
    const { runtime, ingress, metrics } = makeRuntime({
      config: runtimeConfig({ candidateBlockOffsets: [0n], thresholdOut: 10n }),
      schedulerRouteBook: noEdgeRequiredOutputSatisfiableRouteBook()
    });

    await ingress.ingest({ source: 'POLL', receivedAtMs: 1, payload, orderHashHint: payload.orderHash });
    await (runtime as unknown as { schedulerTick: () => Promise<void> }).schedulerTick();

    expect(metrics.snapshot().counters.scheduler_required_output_satisfiable_total).toBe(1);
    expect(metrics.snapshot().counters.scheduler_required_output_unsatisfiable_total).toBeUndefined();
    expect(metrics.snapshot().counters['scheduler_gap_class_total{gap_class="MEDIUM"}']).toBe(1);
  });

  it('increments camelot unsatisfiable counter when camelot is best REQUIRED_OUTPUT rejected', async () => {
    const payload = makePayload();
    const { runtime, ingress, metrics } = makeRuntime({
      config: runtimeConfig({ candidateBlockOffsets: [0n], thresholdOut: 10n }),
      schedulerRouteBook: noEdgeCamelotUnsatisfiableRouteBook()
    });

    await ingress.ingest({ source: 'POLL', receivedAtMs: 1, payload, orderHashHint: payload.orderHash });
    await (runtime as unknown as { schedulerTick: () => Promise<void> }).schedulerTick();

    expect(metrics.snapshot().counters.scheduler_required_output_unsatisfiable_total).toBe(1);
    expect(metrics.snapshot().counters.scheduler_camelot_required_output_unsatisfiable_total).toBe(1);
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

  it('prepare failure transitions to PREPARE_FAILED, emits rich prepare events, and avoids tight-loop retries', async () => {
    const payload = makePayload();
    const normalized = toNormalizedOrder(payload);
    let prepareCalls = 0;
    const { runtime, store, journal, metrics } = makeRuntime({
      config: runtimeConfig({ shadowMode: false, canaryMode: false }),
      schedulerRouteBook: routeBookWithNetEdge(30n),
      executionPreparer: async () => {
        prepareCalls += 1;
        const error = new Error('failed to prepare execution payload');
        error.name = 'PrepareExecutionError';
        throw error;
      }
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
    await (runtime as unknown as { hotLaneTick: () => Promise<void> }).hotLaneTick();

    const record = await store.get(payload.orderHash);
    expect(record?.state).toEqual('PREPARE_FAILED');
    expect(record?.reason).toEqual('PREPARE_FAILED');
    expect(prepareCalls).toEqual(1);

    const events = await journal.byOrderHash(payload.orderHash);
    const prepared = events.find((event) => event.type === 'PREPARED');
    expect(prepared?.payload).toMatchObject({ ok: false, reason: 'PREPARE_FAILED' });

    const prepareFailed = events.find((event) => event.type === 'ORDER_PREPARE_FAILED');
    expect(prepareFailed?.payload).toMatchObject({
      orderHash: payload.orderHash,
      venue: 'UNISWAP_V3',
      pathKind: 'DIRECT',
      hopCount: 1,
      executionMode: 'EXACT_INPUT',
      pathDescriptor: `DIRECT: ${normalized.decodedOrder.order.baseInput.token} -> ${normalized.decodedOrder.order.baseOutputs[0]!.token}`,
      error: 'PrepareExecutionError',
      message: 'failed to prepare execution payload'
    });

    const dropped = events.find((event) => event.type === 'ORDER_DROPPED');
    expect(dropped?.payload).toMatchObject({
      reason: 'PREPARE_FAILED',
      chosenRouteVenue: 'UNISWAP_V3',
      chosenRoutePathKind: 'DIRECT',
      chosenRouteHopCount: 1,
      chosenRouteExecutionMode: 'EXACT_INPUT',
      error: 'PrepareExecutionError',
      message: 'failed to prepare execution payload'
    });
    expect((dropped?.payload as Record<string, unknown>).chosenRoutePathDescriptor).toEqual(
      `DIRECT: ${normalized.decodedOrder.order.baseInput.token} -> ${normalized.decodedOrder.order.baseOutputs[0]!.token}`
    );

    const counters = metrics.snapshot().counters;
    expect(counters.orders_prepare_failed_total).toBe(1);
    expect(counters['orders_prepare_failed_total{venue="UNISWAP_V3",path_kind="DIRECT",execution_mode="EXACT_INPUT"}']).toBe(1);
    expect(counters['prepare_failure_reason_total{reason="PrepareExecutionError"}']).toBe(1);
  });
});
