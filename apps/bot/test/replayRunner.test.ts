import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeOrderHash, decodeSignedOrder } from '@uni/protocol';
import { describe, expect, it } from 'vitest';
import { runReplay } from '../src/replay/replayRunner.js';
import { Univ3QuoteModel } from '../src/routing/univ3QuoteModel.js';
import { ForkSimService } from '../src/sim/forkSimService.js';
import { InMemoryOrderStore } from '../src/store/memory/inMemoryOrderStore.js';
import type { NormalizedOrder } from '../src/store/types.js';

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
      decodedOrder: decoded
    }
  ];
}

describe('replay runner', () => {
  it('is deterministic and produces SIM_OK no-send in shadow mode', async () => {
    const corpus = loadCorpus();
    const quoteModel = new Univ3QuoteModel([
      {
        inputToken: corpus[0]!.decodedOrder.order.baseInput.token,
        outputToken: corpus[0]!.decodedOrder.order.baseOutputs[0]!.token
      }
    ]);
    const simService = new ForkSimService({
      reactor: corpus[0]!.decodedOrder.order.info.reactor,
      executor: async () => {
        return;
      }
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
        threshold: 1n,
        candidateBlocks: [1000n, 1001n, 1002n],
        competeWindowBlocks: 2n
      },
      quoteModel,
      simService,
      resolveEnv: {
        timestamp: 1_900_000_000n,
        basefee: 100_000_000n,
        chainId: 42161n
      },
      shadowMode: true
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
