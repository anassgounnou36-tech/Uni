import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { ViemResolveEnvProvider } from '../src/runtime/resolveEnvProvider.js';

describe('resolve env provider', () => {
  it('resolveEnvProvider_usesArbSysOn42161', async () => {
    const client = {
      getChainId: async () => 42161,
      getBlock: async () => ({
        number: 1000n,
        timestamp: 1_900_000_000n,
        baseFeePerGas: 123n
      }),
      readContract: async () => 2000n
    } as unknown as PublicClient;
    const provider = new ViemResolveEnvProvider(client);
    const snapshot = await provider.getCurrent();
    expect(snapshot.chainId).toBe(42161n);
    expect(snapshot.blockNumber).toBe(1000n);
    expect(snapshot.blockNumberish).toBe(2000n);
    expect(snapshot.baseFeePerGas).toBe(123n);
  });
});
