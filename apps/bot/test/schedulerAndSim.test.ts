import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeOrderHash, decodeSignedOrder } from '@uni/protocol';
import { describe, expect, it } from 'vitest';
import { findFirstProfitableBlock } from '../src/scheduler/firstProfitableBlock.js';
import { runHotLaneStep } from '../src/scheduler/hotLane.js';
import type { UniV3RoutePlanner } from '../src/routing/univ3/routePlanner.js';
import type { ForkSimService } from '../src/sim/forkSimService.js';

function loadSigned() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/orders/arbitrum/live');
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'live-01.json'), 'utf8')) as {
    encodedOrder: `0x${string}`;
    signature: `0x${string}`;
  };
  return decodeSignedOrder(fixture.encodedOrder, fixture.signature);
}

function makeRoutePlanner(netEdge: bigint): UniV3RoutePlanner {
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
        grossEdge: quotedAmountOut - requiredOutput,
        gasCostWei: 10n,
        riskBufferWei: 5n,
        netEdge
      } as const;
      return netEdge > 0n ? { ok: true, route, consideredFees: [500] } : { ok: false, failure: { reason: 'NOT_ROUTEABLE' }, consideredFees: [500] };
    }
  } as UniV3RoutePlanner;
}

describe('scheduler + execution-plan gate', () => {
  it('finds first profitable block and only would-send after successful simulation', async () => {
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
    expect(finalEval.netEdge).toBeGreaterThanOrEqual(1n);

    const simService = {
      simulateFinal: async (plan) => ({
        ok: true,
        reason: 'SUPPORTED',
        executionPlan: plan,
        txRequest: {
          chainId: 42161n,
          from: '0x0000000000000000000000000000000000000001',
          to: plan.executor,
          nonce: 0n,
          gas: 21_000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
          value: 0n,
          data: plan.executeCalldata
        },
        serializedTransaction: '0x02',
        gasUsed: 21_000n
      })
    } as ForkSimService;

    const decision = await runHotLaneStep({
      entry: {
        orderHash: computeOrderHash(signed.order) as `0x${string}`,
        scheduledBlock: schedule!.scheduledBlock,
        competeWindowEnd: schedule!.competeWindowEnd,
        predictedEdge: finalEval.netEdge
      },
      currentBlock: schedule!.scheduledBlock,
      threshold: 1n,
      normalizedOrder: {
        orderHash: computeOrderHash(signed.order) as `0x${string}`,
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
      shadowMode: false
    });

    expect(decision.action).toEqual('WOULD_SEND');
  });

  it('drops when route planner has no valid route', async () => {
    const signed = loadSigned();
    const routePlanner = makeRoutePlanner(-1n);
    const schedule = await findFirstProfitableBlock({
      order: signed.order,
      baseEnv: {
        timestamp: 1_900_000_000n,
        basefee: 100_000_000n,
        chainId: 42161n
      },
      routePlanner,
      candidateBlocks: [1000n],
      threshold: 1n,
      competeWindowBlocks: 1n
    });
    expect(schedule).toBeUndefined();
  });
});
