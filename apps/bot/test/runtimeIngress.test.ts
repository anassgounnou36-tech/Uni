import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeOrderHash, decodeSignedOrder } from '@uni/protocol';
import { describe, expect, it } from 'vitest';
import { HybridIngressCoordinator } from '../src/ingress/hybridIngress.js';
import { WebhookIngressServer } from '../src/ingress/webhookServer.js';
import { OrdersApiClient } from '../src/intake/ordersApiClient.js';
import { OrdersPoller } from '../src/intake/poller.js';
import { InMemoryDecisionJournal } from '../src/journal/inMemoryDecisionJournal.js';
import { InMemoryNonceLedger, NonceManager } from '../src/send/nonceManager.js';
import { InMemoryOrderStore } from '../src/store/memory/inMemoryOrderStore.js';
import { BotMetrics } from '../src/telemetry/metrics.js';
import { PrometheusMetricsServer } from '../src/telemetry/prometheus.js';
import { BotRuntime } from '../src/runtime/BotRuntime.js';
import type { RuntimeConfig } from '../src/runtime/config.js';
import type { PreparedExecution } from '../src/execution/preparedExecution.js';
import type { ForkSimService } from '../src/sim/forkSimService.js';
import type { SequencerClient } from '../src/send/sequencerClient.js';
import type { UniV3RoutePlanner } from '../src/routing/univ3/routePlanner.js';

function fixture(name: string): { encodedOrder: `0x${string}`; signature: `0x${string}` } {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/orders/arbitrum/live');
  return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) as { encodedOrder: `0x${string}`; signature: `0x${string}` };
}

function makeApiPayload(name = 'live-01.json') {
  const signed = fixture(name);
  const decoded = decodeSignedOrder(signed.encodedOrder, signed.signature);
  return {
    orderHash: computeOrderHash(decoded.order),
    orderType: 'Dutch_V3',
    encodedOrder: signed.encodedOrder,
    signature: signed.signature
  } as const;
}

function makeWebhookPayload(name = 'live-01.json') {
  const payload = makeApiPayload(name);
  return {
    orderHash: payload.orderHash,
    createdAt: Date.now() - 100,
    signature: payload.signature,
    orderStatus: 'open' as const,
    encodedOrder: payload.encodedOrder,
    chainId: 42161 as const
  };
}

function routePlannerWithEdge(netEdgeOut: bigint): UniV3RoutePlanner {
  return {
    planBestRoute: async ({ resolvedOrder }) => ({
      ok: true,
      consideredFees: [500],
      route: {
        tokenIn: resolvedOrder.input.token,
        tokenOut: resolvedOrder.outputs[0]!.token,
        amountIn: resolvedOrder.input.amount,
        requiredOutput: resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n),
        quotedAmountOut: resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n) + netEdgeOut,
        poolFee: 500,
        minAmountOut: resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n),
        slippageBufferOut: 0n,
        gasCostOut: 0n,
        riskBufferOut: 0n,
        profitFloorOut: 0n,
        grossEdgeOut: netEdgeOut,
        netEdgeOut
      }
    })
  } as UniV3RoutePlanner;
}

function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    readRpcUrl: 'https://read.example',
    sequencerUrl: 'https://sequencer.example',
    pollCadenceMs: 15,
    enableWebhookIngress: false,
    webhookHost: '127.0.0.1',
    webhookPort: 0,
    webhookPath: '/uniswapx/webhook',
    trustProxy: false,
    allowedWebhookCidrs: ['127.0.0.1/32'],
    maxWebhookBodyBytes: 1000000,
    schedulerCadenceMs: 15,
    hotLaneCadenceMs: 15,
    candidateBlocks: [1000n],
    competeWindowBlocks: 2n,
    thresholdOut: 1n,
    shadowMode: true,
    canaryMode: false,
    canaryAllowlistedPairs: [],
    maxLiveNotionalIn: 10n ** 30n,
    maxLiveInflight: 100,
    minLiveEdgeOut: 1n,
    enableMetricsServer: false,
    metricsHost: '127.0.0.1',
    metricsPort: 0,
    ...overrides
  };
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('runtime ingress and orchestration', () => {
  it('webhookRejectsNonAllowlistedIp', async () => {
    const metrics = new BotMetrics();
    const journal = new InMemoryDecisionJournal();
    const store = new InMemoryOrderStore();
    const ingress = new HybridIngressCoordinator({ metrics, journal, store });
    const server = new WebhookIngressServer(
      {
        host: '127.0.0.1',
        port: 18081,
        path: '/uniswapx/webhook',
        trustProxy: true,
        allowedCidrs: ['3.14.56.90/32'],
        maxBodyBytes: 100_000
      },
      async (envelope) => ingress.ingest(envelope)
    );
    await server.start();

    const response = await fetch('http://127.0.0.1:18081/uniswapx/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '1.2.3.4'
      },
      body: JSON.stringify(makeWebhookPayload())
    });

    expect(response.status).toEqual(403);
    await server.stop();
  });

  it('webhookAcceptsValidPayloadFromAllowlistedIp', async () => {
    const metrics = new BotMetrics();
    const journal = new InMemoryDecisionJournal();
    const store = new InMemoryOrderStore();
    const ingress = new HybridIngressCoordinator({ metrics, journal, store });
    const server = new WebhookIngressServer(
      {
        host: '127.0.0.1',
        port: 18082,
        path: '/uniswapx/webhook',
        trustProxy: true,
        allowedCidrs: ['1.2.3.4/32'],
        maxBodyBytes: 100_000
      },
      async (envelope) => ingress.ingest(envelope)
    );
    await server.start();

    const response = await fetch('http://127.0.0.1:18082/uniswapx/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '1.2.3.4'
      },
      body: JSON.stringify(makeWebhookPayload())
    });

    expect(response.status).toEqual(202);
    const events = await journal.byType('ORDER_SEEN');
    expect(events[0]?.payload.source).toEqual('WEBHOOK');
    expect(events[0]?.payload.validation).toEqual('ACCEPTED');
    await server.stop();
  });

  it('pollAndWebhookSameOrderCreateOneCanonicalOrder', async () => {
    const run = async (first: 'POLL' | 'WEBHOOK') => {
      const metrics = new BotMetrics();
      const journal = new InMemoryDecisionJournal();
      const store = new InMemoryOrderStore();
      const ingress = new HybridIngressCoordinator({ metrics, journal, store });
      const apiPayload = makeApiPayload();
      const webhookPayload = makeWebhookPayload();

      if (first === 'POLL') {
        await ingress.ingest({ source: 'POLL', receivedAtMs: 1, payload: apiPayload, orderHashHint: apiPayload.orderHash as `0x${string}` });
        await ingress.ingest({ source: 'WEBHOOK', receivedAtMs: 2, payload: webhookPayload, createdAtMs: 1, orderHashHint: webhookPayload.orderHash });
      } else {
        await ingress.ingest({ source: 'WEBHOOK', receivedAtMs: 1, payload: webhookPayload, createdAtMs: 1, orderHashHint: webhookPayload.orderHash });
        await ingress.ingest({ source: 'POLL', receivedAtMs: 2, payload: apiPayload, orderHashHint: apiPayload.orderHash as `0x${string}` });
      }

      const records = store.list();
      expect(records).toHaveLength(1);
      const seen = await journal.byType('ORDER_SEEN');
      expect(seen).toHaveLength(2);
      expect(records[0]?.firstSeenSource).toEqual(first);
      expect(records[0]?.confirmedBySources.sort()).toEqual(['POLL', 'WEBHOOK']);
    };

    await run('WEBHOOK');
    await run('POLL');
  });

  it('runtimeShadowModeNeverBroadcasts', async () => {
    const payload = makeApiPayload();
    const fetchImpl: typeof fetch = async () => ({ ok: true, json: async () => [payload] } as Response);
    const poller = new OrdersPoller(new OrdersApiClient({ baseUrl: 'https://orders.example', chainId: 42161, cadenceMs: 10, fetchImpl }));
    const journal = new InMemoryDecisionJournal();
    const metrics = new BotMetrics();
    const store = new InMemoryOrderStore();
    const ingress = new HybridIngressCoordinator({ metrics, journal, store });
    const nonceManager = new NonceManager({ ledger: new InMemoryNonceLedger(), chainNonceReader: async () => 1n });

    let sendCalls = 0;
    const runtime = new BotRuntime({
      config: runtimeConfig({ shadowMode: true }),
      poller,
      ingress,
      store,
      journal,
      metrics,
      schedulerContext: {
        routePlanner: routePlannerWithEdge(10n),
        resolveEnv: { timestamp: 1_900_000_000n, basefee: 1n, chainId: 42161n }
      },
      hotLaneContext: {
        routePlanner: routePlannerWithEdge(10n),
        resolveEnv: { timestamp: 1_900_000_000n, basefee: 1n, chainId: 42161n },
        conditionalEnvelope: { TimestampMax: 1_900_000_010n },
        executor: '0x3333333333333333333333333333333333333333',
        simService: {
          simulatePrepared: async (prepared: PreparedExecution) => ({
            ok: true,
            reason: 'SUPPORTED',
            preparedExecution: prepared,
            txRequest: prepared.txRequest,
            serializedTransaction: prepared.serializedTransaction,
            gasUsed: 21_000n,
            receipt: { status: 'success', transactionHash: '0x11'.padEnd(66, '1') as `0x${string}`, gasUsed: 21_000n }
          })
        } as ForkSimService,
        sequencerClient: {
          sendPreparedExecution: async () => {
            sendCalls += 1;
            return { accepted: true, attempts: [{ writer: 'sequencer', classification: 'accepted' }], records: [] };
          }
        } as unknown as SequencerClient,
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
            serializedTransaction: '0x02',
            conditionalEnvelope: { TimestampMax: 1_900_000_010n },
            sender: '0x2222222222222222222222222222222222222222',
            nonce: lease.nonce,
            gas: 21_000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
            nonceLease: lease
          };
        }
      }
    });

    await runtime.start();
    await wait(80);
    await runtime.stop();

    expect(sendCalls).toEqual(0);
    const events = await journal.byOrderHash(payload.orderHash as `0x${string}`);
    expect(events.map((event) => event.type)).toContain('PREPARED');
    expect(events.map((event) => event.type)).toContain('SIM_RESULT');
    expect(events.find((event) => event.type === 'SEND_RESULT')?.payload.reason).toEqual('SHADOW_MODE');
  });

  it('canaryModeOnlyAllowsConfiguredPairs', async () => {
    const payload = makeApiPayload();
    const signed = decodeSignedOrder(payload.encodedOrder, payload.signature);
    const outputToken = signed.order.baseOutputs[0]!.token;

    const runScenario = async (allowlisted: boolean) => {
      const fetchImpl: typeof fetch = async () => ({ ok: true, json: async () => [payload] } as Response);
      const poller = new OrdersPoller(new OrdersApiClient({ baseUrl: 'https://orders.example', chainId: 42161, cadenceMs: 10, fetchImpl }));
      const journal = new InMemoryDecisionJournal();
      const metrics = new BotMetrics();
      const store = new InMemoryOrderStore();
      const ingress = new HybridIngressCoordinator({ metrics, journal, store });
      const nonceManager = new NonceManager({ ledger: new InMemoryNonceLedger(), chainNonceReader: async () => 1n });
      let sendCalls = 0;

      const runtime = new BotRuntime({
        config: runtimeConfig({
          shadowMode: false,
          canaryMode: true,
          canaryAllowlistedPairs: allowlisted
            ? [{ inputToken: signed.order.baseInput.token, outputToken }]
            : [{ inputToken: signed.order.baseInput.token, outputToken: '0x0000000000000000000000000000000000000001' }],
          maxLiveInflight: 10,
          maxLiveNotionalIn: signed.order.baseInput.startAmount + 1n,
          minLiveEdgeOut: 1n
        }),
        poller,
        ingress,
        store,
        journal,
        metrics,
        schedulerContext: {
          routePlanner: routePlannerWithEdge(10n),
          resolveEnv: { timestamp: 1_900_000_000n, basefee: 1n, chainId: 42161n }
        },
        hotLaneContext: {
          routePlanner: routePlannerWithEdge(10n),
          resolveEnv: { timestamp: 1_900_000_000n, basefee: 1n, chainId: 42161n },
          conditionalEnvelope: { TimestampMax: 1_900_000_010n },
          executor: '0x3333333333333333333333333333333333333333',
          simService: {
            simulatePrepared: async (prepared: PreparedExecution) => ({
              ok: true,
              reason: 'SUPPORTED',
              preparedExecution: prepared,
              txRequest: prepared.txRequest,
              serializedTransaction: prepared.serializedTransaction,
              gasUsed: 21_000n,
              receipt: { status: 'success', transactionHash: '0x22'.padEnd(66, '2') as `0x${string}`, gasUsed: 21_000n }
            })
          } as ForkSimService,
          sequencerClient: {
            sendPreparedExecution: async () => {
              sendCalls += 1;
              return { accepted: true, attempts: [{ writer: 'sequencer', classification: 'accepted' }], records: [] };
            }
          } as unknown as SequencerClient,
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
              serializedTransaction: '0x03',
              conditionalEnvelope: { TimestampMax: 1_900_000_010n },
              sender: '0x2222222222222222222222222222222222222222',
              nonce: lease.nonce,
              gas: 21_000n,
              maxFeePerGas: 1n,
              maxPriorityFeePerGas: 1n,
              nonceLease: lease
            };
          }
        }
      });

      await runtime.start();
      await wait(80);
      await runtime.stop();
      return sendCalls;
    };

    expect(await runScenario(true)).toBeGreaterThan(0);
    expect(await runScenario(false)).toEqual(0);
  });

  it('metricsExposeIngressAndDecisionCounters', async () => {
    const payload = makeApiPayload();
    const fetchImpl: typeof fetch = async () => ({ ok: true, json: async () => [payload] } as Response);
    const poller = new OrdersPoller(new OrdersApiClient({ baseUrl: 'https://orders.example', chainId: 42161, cadenceMs: 10, fetchImpl }));
    const journal = new InMemoryDecisionJournal();
    const metrics = new BotMetrics();
    const store = new InMemoryOrderStore();
    const ingress = new HybridIngressCoordinator({ metrics, journal, store });
    const nonceManager = new NonceManager({ ledger: new InMemoryNonceLedger(), chainNonceReader: async () => 1n });
    const metricsServer = new PrometheusMetricsServer({ host: '127.0.0.1', port: 18083, metrics });

    const runtime = new BotRuntime({
      config: runtimeConfig({ shadowMode: false }),
      poller,
      ingress,
      store,
      journal,
      metrics,
      metricsServer,
      schedulerContext: {
        routePlanner: routePlannerWithEdge(10n),
        resolveEnv: { timestamp: 1_900_000_000n, basefee: 1n, chainId: 42161n }
      },
      hotLaneContext: {
        routePlanner: routePlannerWithEdge(10n),
        resolveEnv: { timestamp: 1_900_000_000n, basefee: 1n, chainId: 42161n },
        conditionalEnvelope: { TimestampMax: 1_900_000_010n },
        executor: '0x3333333333333333333333333333333333333333',
        simService: {
          simulatePrepared: async (prepared: PreparedExecution) => ({
            ok: true,
            reason: 'SUPPORTED',
            preparedExecution: prepared,
            txRequest: prepared.txRequest,
            serializedTransaction: prepared.serializedTransaction,
            gasUsed: 21_000n,
            receipt: { status: 'success', transactionHash: '0x33'.padEnd(66, '3') as `0x${string}`, gasUsed: 21_000n }
          })
        } as ForkSimService,
        sequencerClient: {
          sendPreparedExecution: async () => ({ accepted: true, attempts: [{ writer: 'sequencer', classification: 'accepted' }], records: [] })
        } as unknown as SequencerClient,
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
            serializedTransaction: '0x04',
            conditionalEnvelope: { TimestampMax: 1_900_000_010n },
            sender: '0x2222222222222222222222222222222222222222',
            nonce: lease.nonce,
            gas: 21_000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
            nonceLease: lease
          };
        }
      }
    });

    await runtime.start();
    await wait(80);
    const response = await fetch('http://127.0.0.1:18083/metrics');
    const body = await response.text();
    await runtime.stop();

    expect(body).toContain('orders_seen_total');
    expect(body).toContain('orders_supported_total');
    expect(body).toContain('orders_scheduled_total');
    expect(body).toContain('sim_ok_total');
    expect(body).toContain('send_attempt_total');
  });

  it('gracefulShutdownStopsAllLoops', async () => {
    const payload = makeApiPayload();
    const fetchImpl: typeof fetch = async () => ({ ok: true, json: async () => [payload] } as Response);
    const poller = new OrdersPoller(new OrdersApiClient({ baseUrl: 'https://orders.example', chainId: 42161, cadenceMs: 10, fetchImpl }));
    const journal = new InMemoryDecisionJournal();
    const metrics = new BotMetrics();
    const store = new InMemoryOrderStore();
    const ingress = new HybridIngressCoordinator({ metrics, journal, store });

    const webhookServer = new WebhookIngressServer(
      {
        host: '127.0.0.1',
        port: 18084,
        path: '/uniswapx/webhook',
        trustProxy: true,
        allowedCidrs: ['1.2.3.4/32'],
        maxBodyBytes: 100_000
      },
      async (envelope) => ingress.ingest(envelope)
    );

    const runtime = new BotRuntime({
      config: runtimeConfig({ enableWebhookIngress: true }),
      poller,
      ingress,
      store,
      journal,
      metrics,
      webhookServer
    });

    await runtime.start();
    expect(runtime.isRunning()).toEqual(true);
    await runtime.stop();
    expect(runtime.isRunning()).toEqual(false);
  });
});
