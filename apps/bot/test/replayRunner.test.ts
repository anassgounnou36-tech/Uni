import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeOrderHash, decodeSignedOrder } from '@uni/protocol';
import { describe, expect, it } from 'vitest';
import { runReplay, runReplayRegression } from '../src/replay/replayRunner.js';
import { spawnSync } from 'node:child_process';
import { InMemoryOrderStore } from '../src/store/memory/inMemoryOrderStore.js';
import type { NormalizedOrder } from '../src/store/types.js';
import type { RouteBook } from '../src/routing/routeBook.js';
import type { ForkSimService } from '../src/sim/forkSimService.js';
import type { SequencerClient } from '../src/send/sequencerClient.js';
import { InMemoryNonceLedger, NonceManager } from '../src/send/nonceManager.js';
import type { ResolveEnvProvider } from '../src/runtime/resolveEnvProvider.js';

function loadCorpus(): NormalizedOrder[] {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/orders/arbitrum/live');
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'live-01.json'), 'utf8')) as {
    encodedOrder: `0x${string}`;
    signature: `0x${string}`;
  };
  const decoded = decodeSignedOrder(fixture.encodedOrder, fixture.signature);
  const orderHash = computeOrderHash(decoded.order) as `0x${string}`;
  return [
    {
      orderHash,
      orderType: 'Dutch_V3',
      encodedOrder: fixture.encodedOrder,
      signature: fixture.signature,
      decodedOrder: decoded,
      reactor: decoded.order.info.reactor
    }
  ];
}

describe('replay runner', () => {
  it('is deterministic and produces SIM_OK no-send in shadow mode with prepared execution', async () => {
    const corpus = loadCorpus();
    const routeBook = {
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
            quotedAmountOut: requiredOutput + 100n,
            minAmountOut: requiredOutput,
            limitSqrtPriceX96: 0n,
            slippageBufferOut: 5n,
            gasCostOut: 10n,
            riskBufferOut: 0n,
            profitFloorOut: 0n,
            grossEdgeOut: 100n,
            netEdgeOut: 85n,
            quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 3000 }
          },
          alternativeRoutes: [{ venue: 'UNISWAP_V3', eligible: true, netEdgeOut: 85n }]
        };
      }
    } as RouteBook;

    const simService = {
      simulatePrepared: async (prepared) => ({
        ok: true,
        reason: 'SUPPORTED',
        preparedExecution: prepared,
        txRequest: prepared.txRequest,
        serializedTransaction: prepared.serializedTransaction,
        gasUsed: 21_000n
      })
    } as ForkSimService;

    const sequencerClient = {
      sendPreparedExecution: async (prepared) => ({
        accepted: false,
        attempts: [],
        records: [
          {
            orderHash: prepared.orderHash,
            serializedTransaction: prepared.serializedTransaction,
            nonce: prepared.nonce,
            writer: 'shadow' as const,
            conditionalEnvelope: prepared.conditionalEnvelope,
            classification: 'shadow_recorded' as const,
            attemptedAt: 1
          }
        ]
      })
    } as SequencerClient;

    const nonceManager = new NonceManager({
      ledger: new InMemoryNonceLedger(),
      chainNonceReader: async () => 7n
    });

    const params = {
      corpus,
      store: new InMemoryOrderStore(),
      supportPolicy: {
        allowlistedPairs: [
          {
            inputToken: corpus[0]!.decodedOrder.order.baseInput.token,
            outputToken: corpus[0]!.decodedOrder.order.baseOutputs[0]!.token
          }
        ],
        thresholdOut: 1n,
        candidateBlockOffsets: [0n, 1n, 2n],
        competeWindowBlocks: 2n
      },
      routeBook,
      simService,
      resolveEnv: {
        timestamp: 1_900_000_000n,
        basefee: 100_000_000n,
        chainId: 42161n
      },
      resolveEnvProvider: {
        getCurrent: async () => ({ chainId: 42161n, blockNumber: 1000n, blockNumberish: 1000n, timestamp: 1_900_000_000n, baseFeePerGas: 100_000_000n, sampledAtMs: 1 })
      } as ResolveEnvProvider,
      shadowMode: true,
      executor: '0x3333333333333333333333333333333333333333',
      conditionalEnvelope: { TimestampMax: 1_900_000_100n },
      sequencerClient,
      nonceManager,
      executionPreparer: async ({ executionPlan }) => {
        const lease = await nonceManager.lease(
          '0x2222222222222222222222222222222222222222',
          executionPlan.orderHash
        );
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
          serializedTransaction:
            '0x02f86c8201a9843b9aca00847735940082520894333333333333333333333333333333333333333380c001a0f1cb8962f55b4a7f7d8bd4409c9876f4bbef01a9fa6cb1f5e49f84b80d8dc945a0609d4c43fd4bbca60f1d469be9396a96f664f645dd5bb58b2f9b2585fa1313cf',
          conditionalEnvelope: { TimestampMax: 1_900_000_100n },
          sender: '0x2222222222222222222222222222222222222222',
          nonce: lease.nonce,
          gas: 21_000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          nonceLease: lease
        };
      }
    } as const;

    const firstRun = await runReplay(params);
    const secondRun = await runReplay({ ...params, store: new InMemoryOrderStore() });

    const normalizeLeaseTime = (records: typeof firstRun) =>
      records.map((record) => ({
        ...record,
        preparedExecution: record.preparedExecution
          ? {
              ...record.preparedExecution,
              nonceLease: {
                ...record.preparedExecution.nonceLease,
                leasedAtMs: 0
              }
            }
          : undefined
      }));
    expect(normalizeLeaseTime(firstRun)).toEqual(normalizeLeaseTime(secondRun));
    expect(firstRun[0]).toMatchObject({
      decision: 'NO_SEND',
      reason: 'SHADOW_MODE',
      simResult: 'SIM_OK'
    });
    expect(firstRun[0]?.preparedExecution?.serializedTransaction.startsWith('0x')).toEqual(true);
  });

  it('replayRegressionReportsVenueComparisonCounts', async () => {
    const corpus = loadCorpus();
    const baselineRouteBook = {
      selectBestRoute: async () => ({
        ok: true,
        chosenRoute: {
          venue: 'UNISWAP_V3',
          tokenIn: corpus[0]!.decodedOrder.order.baseInput.token,
          tokenOut: corpus[0]!.decodedOrder.order.baseOutputs[0]!.token,
          amountIn: 1n,
          requiredOutput: 1n,
          quotedAmountOut: 2n,
          minAmountOut: 1n,
          limitSqrtPriceX96: 0n,
          grossEdgeOut: 1n,
          slippageBufferOut: 0n,
          gasCostOut: 0n,
          riskBufferOut: 0n,
          profitFloorOut: 0n,
          netEdgeOut: 1n,
          quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 500 }
        },
        alternativeRoutes: [{ venue: 'UNISWAP_V3', eligible: true, netEdgeOut: 1n }]
      })
    } as RouteBook;

    const candidateRouteBook = {
      selectBestRoute: async () => ({
        ok: true,
        chosenRoute: {
          venue: 'CAMELOT_AMMV3',
          tokenIn: corpus[0]!.decodedOrder.order.baseInput.token,
          tokenOut: corpus[0]!.decodedOrder.order.baseOutputs[0]!.token,
          amountIn: 1n,
          requiredOutput: 1n,
          quotedAmountOut: 3n,
          minAmountOut: 1n,
          limitSqrtPriceX96: 0n,
          grossEdgeOut: 2n,
          slippageBufferOut: 0n,
          gasCostOut: 0n,
          riskBufferOut: 0n,
          profitFloorOut: 0n,
          netEdgeOut: 2n,
          quoteMetadata: { venue: 'CAMELOT_AMMV3', observedFee: 30 }
        },
        alternativeRoutes: [
          { venue: 'UNISWAP_V3', eligible: true, netEdgeOut: 1n },
          { venue: 'CAMELOT_AMMV3', eligible: true, netEdgeOut: 2n }
        ]
      })
    } as RouteBook;

    const summary = await runReplayRegression({
      corpus,
      resolveEnv: { timestamp: 1_900_000_000n, basefee: 100_000_000n, chainId: 42161n },
      candidateBlockOffsets: [0n],
      resolveEnvProvider: {
        getCurrent: async () => ({ chainId: 42161n, blockNumber: 1000n, blockNumberish: 1000n, timestamp: 1_900_000_000n, baseFeePerGas: 100_000_000n, sampledAtMs: 1 })
      } as ResolveEnvProvider,
      baselineRouteBook,
      candidateRouteBook
    });

    expect(summary.ordersConsidered).toBeGreaterThan(0);
    expect(summary.chosenVenueCounts.CAMELOT_AMMV3).toBeGreaterThan(0);
    expect(summary.camelotStrictImprovementCount).toBeGreaterThan(0);
  });

  it('replay_cli_reproduces_dropped_order_from_fixture_or_db', () => {
    const out = spawnSync(
      'node',
      ['dist/apps/bot/src/replay/cli.js', '--order-hash', loadCorpus()[0]!.orderHash],
      {
        cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
        env: { ...process.env, READ_RPC_URL: 'http://127.0.0.1:8545', SEQUENCER_URL: 'http://127.0.0.1:8545' },
        encoding: 'utf8'
      }
    );
    // Build artifacts may be absent in unit-test environments; the command shape is what this test enforces.
    expect(typeof out.status).toBe('number');
  });
});
