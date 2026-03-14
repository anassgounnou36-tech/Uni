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
  it('is deterministic and produces SIM_OK no-send in shadow mode', async () => {
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
            grossEdge: 100n,
            gasCostWei: 10n,
            riskBufferWei: 5n,
            netEdge: 85n
          }
        };
      }
    } as UniV3RoutePlanner;

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
        threshold: 1n,
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
      conditionalEnvelope: { TimestampMax: 1_900_000_100n }
    } as const;

    const firstRun = await runReplay(params);
    const secondRun = await runReplay({ ...params, store: new InMemoryOrderStore() });

    expect(firstRun).toEqual(secondRun);
    expect(firstRun[0]).toMatchObject({
      decision: 'NO_SEND',
      reason: 'SHADOW_MODE',
      simResult: 'SIM_OK'
    });
  });
});
