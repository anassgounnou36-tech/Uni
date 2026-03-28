import type { V3DutchOrder } from '@uni/protocol';
import { describe, expect, it } from 'vitest';
import { planCandidateBlocks } from '../src/scheduler/firstProfitableBlock.js';
import { RouteEvalReadCache } from '../src/routing/rpc/readCache.js';

function makeOrder() {
  const order: V3DutchOrder = {
    info: {
      reactor: '0xB274d5F4b833b61B340b654d600A864fB604a87c',
      swapper: '0x1111111111111111111111111111111111111111',
      nonce: 1n,
      deadline: 2_000_000_000n,
      additionalValidationContract: '0x0000000000000000000000000000000000000000',
      additionalValidationData: '0x'
    },
    cosigner: '0x0000000000000000000000000000000000000000',
    startingBaseFee: 100_000_000n,
    baseInput: {
      token: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
      startAmount: 1_000_000n,
      curve: {
        relativeBlocks: (10n << 0n) | (30n << 16n),
        relativeAmounts: [100_000n, 350_000n]
      },
      maxAmount: 1_300_000n,
      adjustmentPerGweiBaseFee: 1_000n
    },
    baseOutputs: [
      {
        token: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        startAmount: 1_800_000n,
        curve: {
          relativeBlocks: (6n << 0n) | (40n << 16n),
          relativeAmounts: [100_000n, 500_000n]
        },
        recipient: '0x1111111111111111111111111111111111111111',
        minAmount: 1_500_000n,
        adjustmentPerGweiBaseFee: 2_000n
      }
    ],
    cosignerData: {
      decayStartBlock: 1_000n,
      exclusiveFiller: '0x0000000000000000000000000000000000000000',
      exclusivityOverrideBps: 0n,
      inputAmount: 0n,
      outputAmounts: [0n]
    },
    cosignature: '0x'
  };
  return order;
}

describe('scheduler candidate planning', () => {
  it('includes offsets, decay boundaries, and stays capped', () => {
    const order = makeOrder();
    const blocks = planCandidateBlocks({
      order,
      currentBlockNumberish: 1000n,
      defaultOffsets: [0n, 1n, 2n],
      maxBlocks: 7
    });
    expect(blocks[0]).toBe(1000n);
    expect(blocks.includes(order.cosignerData.decayStartBlock + 1n)).toBe(true);
    expect(blocks.length).toBeLessThanOrEqual(7);
    const sorted = [...blocks].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(blocks).toEqual(sorted);
  });

  it('applies deadline cap while planning', () => {
    const order = makeOrder();
    const blocks = planCandidateBlocks({
      order,
      currentBlockNumberish: 1000n,
      defaultOffsets: [0n, 1n, 2n, 50n],
      maxBlocks: 7,
      deadlineBlockCap: 1002n
    });
    expect(blocks.every((block) => block <= 1002n)).toBe(true);
  });

  it('cache remains reusable and bounded while candidate list grows', async () => {
    const cache = new RouteEvalReadCache({ maxEntries: 3, maxNegativeEntries: 2, maxSnapshots: 3 });
    await cache.getOrSet({ chainId: 1, blockNumberish: 1, target: '0x1', fn: 'a' }, async () => 'a');
    await cache.getOrSet({ chainId: 1, blockNumberish: 2, target: '0x1', fn: 'b' }, async () => 'b');
    await cache.getOrSet({ chainId: 1, blockNumberish: 3, target: '0x1', fn: 'c' }, async () => 'c');
    await cache.getOrSet({ chainId: 1, blockNumberish: 4, target: '0x1', fn: 'd' }, async () => 'd');
    expect(cache.getEntryCount()).toBeLessThanOrEqual(3);
    expect(cache.getSnapshotCount()).toBeLessThanOrEqual(3);
  });
});
