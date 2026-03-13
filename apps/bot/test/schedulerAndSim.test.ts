import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeOrderHash, decodeSignedOrder, resolveAt } from '@uni/protocol';
import { describe, expect, it } from 'vitest';
import { findFirstProfitableBlock } from '../src/scheduler/firstProfitableBlock.js';
import { runHotLaneStep } from '../src/scheduler/hotLane.js';
import { Univ3QuoteModel } from '../src/routing/univ3QuoteModel.js';
import { ForkSimService } from '../src/sim/forkSimService.js';

function loadSigned() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/orders/arbitrum/live');
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'live-01.json'), 'utf8')) as {
    encodedOrder: `0x${string}`;
    signature: `0x${string}`;
  };
  return decodeSignedOrder(fixture.encodedOrder, fixture.signature);
}

describe('scheduler + sim gate', () => {
  it('finds first profitable block and only would-send after successful simulation', async () => {
    const signed = loadSigned();
    const quoteModel = new Univ3QuoteModel([
      {
        inputToken: signed.order.baseInput.token,
        outputToken: signed.order.baseOutputs[0]!.token
      }
    ]);

    const schedule = await findFirstProfitableBlock({
      order: signed.order,
      baseEnv: {
        timestamp: 1_900_000_000n,
        basefee: 100_000_000n,
        chainId: 42161n
      },
      quoteModel,
      candidateBlocks: [1000n, 1001n, 1002n],
      threshold: 1n,
      competeWindowBlocks: 2n
    });

    expect(schedule?.scheduledBlock).toEqual(1000n);
    const finalEval = schedule!.evaluations.at(-1)!;
    expect(finalEval.netEdge).toBeGreaterThanOrEqual(1n);

    const resolved = await resolveAt(signed.order, {
      blockNumberish: schedule!.scheduledBlock,
      timestamp: 1_900_000_000n,
      basefee: 100_000_000n,
      chainId: 42161n
    });

    const simService = new ForkSimService({
      reactor: signed.order.info.reactor,
      executor: async () => {
        return;
      }
    });

    const decision = await runHotLaneStep({
      entry: {
        orderHash: computeOrderHash(signed.order) as `0x${string}`,
        scheduledBlock: schedule!.scheduledBlock,
        competeWindowEnd: schedule!.competeWindowEnd,
        predictedEdge: finalEval.netEdge
      },
      currentBlock: schedule!.scheduledBlock,
      latestResolved: resolved,
      threshold: 1n,
      quoteRefresher: () => finalEval.netEdge,
      simService,
      shadowMode: false
    });

    expect(decision.action).toEqual('WOULD_SEND');
  });
});
