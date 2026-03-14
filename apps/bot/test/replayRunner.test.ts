import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeOrderHash, decodeSignedOrder } from '@uni/protocol';
import { describe, expect, it } from 'vitest';
import { runReplay } from '../src/replay/replayRunner.js';
import { InMemoryOrderStore } from '../src/store/memory/inMemoryOrderStore.js';
import type { NormalizedOrder } from '../src/store/types.js';
import type { UniV3RoutePlanner } from '../src/routing/univ3/routePlanner.js';
import type { ForkSimService } from '../src/sim/forkSimService.js';
import type { SequencerClient } from '../src/send/sequencerClient.js';
import { InMemoryNonceLedger, NonceManager } from '../src/send/nonceManager.js';

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
    const routePlanner = {
      planBestRoute: async ({ resolvedOrder }) => {
        const requiredOutput = resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n);
        return {
          ok: true,
          consideredFees: [3000],
          route: {
            tokenIn: resolvedOrder.input.token,
            tokenOut: resolvedOrder.outputs[0]!.token,
            amountIn: resolvedOrder.input.amount,
            requiredOutput,
            quotedAmountOut: requiredOutput + 100n,
            poolFee: 3000,
            minAmountOut: requiredOutput,
            slippageBufferOut: 5n,
            gasCostOut: 10n,
            riskBufferOut: 0n,
            profitFloorOut: 0n,
            grossEdgeOut: 100n,
            netEdgeOut: 85n
          }
        };
      }
    } as UniV3RoutePlanner;

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
        candidateBlocks: [1000n, 1001n, 1002n],
        competeWindowBlocks: 2n
      },
      routePlanner,
      simService,
      resolveEnv: {
        timestamp: 1_900_000_000n,
        basefee: 100_000_000n,
        chainId: 42161n
      },
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
});
