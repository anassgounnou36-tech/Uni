import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeOrderHash, decodeSignedOrder } from '@uni/protocol';
import { describe, expect, it } from 'vitest';
import { findFirstProfitableBlock } from '../src/scheduler/firstProfitableBlock.js';
import { runHotLaneStep } from '../src/scheduler/hotLane.js';
import type { PreparedExecution } from '../src/execution/preparedExecution.js';
import type { UniV3RoutePlanner } from '../src/routing/univ3/routePlanner.js';
import type { ForkSimService } from '../src/sim/forkSimService.js';
import type { SequencerClient } from '../src/send/sequencerClient.js';
import { InMemoryNonceLedger, NonceManager } from '../src/send/nonceManager.js';

function loadSigned() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/orders/arbitrum/live');
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'live-01.json'), 'utf8')) as {
    encodedOrder: `0x${string}`;
    signature: `0x${string}`;
  };
  return decodeSignedOrder(fixture.encodedOrder, fixture.signature);
}

function makeRoutePlanner(netEdgeOut: bigint): UniV3RoutePlanner {
  return {
    planBestRoute: async ({ resolvedOrder }) => {
      const requiredOutput = resolvedOrder.outputs.reduce((sum, output) => sum + output.amount, 0n);
      const quotedAmountOut = requiredOutput + 100n;
      const route = {
        tokenIn: resolvedOrder.input.token,
        tokenOut: resolvedOrder.outputs[0]!.token,
        amountIn: resolvedOrder.input.amount,
        requiredOutput,
        quotedAmountOut,
        poolFee: 500,
        minAmountOut: requiredOutput,
        slippageBufferOut: 5n,
        gasCostOut: 10n,
        riskBufferOut: 0n,
        profitFloorOut: 0n,
        grossEdgeOut: 100n,
        netEdgeOut
      } as const;
      return netEdgeOut > 0n
        ? { ok: true, route, consideredFees: [500] }
        : { ok: false, failure: { reason: 'NOT_ROUTEABLE' }, consideredFees: [500] };
    }
  } as UniV3RoutePlanner;
}

describe('scheduler + prepared-execution gate', () => {
  it('finds first profitable block using output-unit edges', async () => {
    const signed = loadSigned();
    const routePlanner = makeRoutePlanner(50n);

    const schedule = await findFirstProfitableBlock({
      order: signed.order,
      baseEnv: {
        timestamp: 1_900_000_000n,
        basefee: 100_000_000n,
        chainId: 42161n
      },
      routePlanner,
      candidateBlocks: [1000n, 1001n, 1002n],
      threshold: 1n,
      competeWindowBlocks: 2n
    });

    expect(schedule?.scheduledBlock).toEqual(1000n);
    const finalEval = schedule!.evaluations.at(-1)!;
    expect(finalEval.netEdgeOut).toBeGreaterThanOrEqual(1n);
  });

  it('uses the exact same serialized tx for simulation and live send', async () => {
    const signed = loadSigned();
    const routePlanner = makeRoutePlanner(50n);
    const orderHash = computeOrderHash(signed.order) as `0x${string}`;
    const nonceManager = new NonceManager({
      ledger: new InMemoryNonceLedger(),
      chainNonceReader: async () => 7n
    });

    const seen: string[] = [];
    const simService = {
      simulatePrepared: async (prepared: PreparedExecution) => {
        seen.push(`sim:${prepared.serializedTransaction}`);
        return {
          ok: true,
          reason: 'SUPPORTED',
          preparedExecution: prepared,
          txRequest: prepared.txRequest,
          serializedTransaction: prepared.serializedTransaction,
          gasUsed: 21_000n,
          receipt: {
            status: 'success',
            transactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            gasUsed: 21_000n
          }
        };
      }
    } as ForkSimService;

    const sequencerClient = {
      sendPreparedExecution: async (prepared: PreparedExecution) => {
        seen.push(`send:${prepared.serializedTransaction}`);
        return {
          accepted: true,
          attempts: [{ writer: 'sequencer', classification: 'accepted' as const }],
          records: [
            {
              orderHash: prepared.orderHash,
              serializedTransaction: prepared.serializedTransaction,
              nonce: prepared.nonce,
              writer: 'sequencer' as const,
              conditionalEnvelope: prepared.conditionalEnvelope,
              classification: 'accepted' as const,
              attemptedAt: 1
            }
          ]
        };
      }
    } as SequencerClient;

    const decision = await runHotLaneStep({
      entry: {
        orderHash,
        scheduledBlock: 1000n,
        competeWindowEnd: 1002n,
        predictedEdgeOut: 50n
      },
      currentBlock: 1000n,
      thresholdOut: 1n,
      normalizedOrder: {
        orderHash,
        orderType: 'Dutch_V3',
        encodedOrder: signed.encodedOrder,
        signature: signed.signature,
        decodedOrder: signed,
        reactor: signed.order.info.reactor
      },
      order: signed.order,
      routePlanner,
      resolveEnv: {
        timestamp: 1_900_000_000n,
        basefee: 100_000_000n,
        chainId: 42161n
      },
      conditionalEnvelope: { TimestampMax: 1_900_000_100n },
      executor: '0x3333333333333333333333333333333333333333',
      simService,
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
      },
      shadowMode: false
    });

    expect(decision.action).toEqual('WOULD_SEND');
    expect(seen).toHaveLength(2);
    expect(seen[0]!.replace('sim:', '')).toEqual(seen[1]!.replace('send:', ''));
  });
});
