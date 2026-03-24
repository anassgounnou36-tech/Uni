import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { loadRuntimeConfig } from '../src/runtime/config.js';

const baseEnv = {
  READ_RPC_URL: 'https://read.example',
  SEQUENCER_URL: 'https://sequencer.example'
} as const;

describe('runtime config', () => {
  it('normalizes checksum addresses for executorAddress, bridgeTokens, and canaryAllowlistedPairs', () => {
    const config = loadRuntimeConfig({
      ...baseEnv,
      EXECUTOR_ADDRESS: '0x3333333333333333333333333333333333333333',
      BRIDGE_TOKENS:
        '0x82af49447d8a07e3bd95bd0d56f35241523fbab1,0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
      CANARY_ALLOWLISTED_PAIRS:
        '0x82af49447d8a07e3bd95bd0d56f35241523fbab1:0xff970a61a04b1ca14834a43f5de4533ebddb5cc8'
    });
    expect(config.executorAddress).toBe(getAddress('0x3333333333333333333333333333333333333333'));
    expect(config.bridgeTokens).toEqual([
      getAddress('0x82af49447d8a07e3bd95bd0d56f35241523fbab1'),
      getAddress('0xff970a61a04b1ca14834a43f5de4533ebddb5cc8')
    ]);
    expect(config.canaryAllowlistedPairs).toEqual([{
      inputToken: getAddress('0x82af49447d8a07e3bd95bd0d56f35241523fbab1'),
      outputToken: getAddress('0xff970a61a04b1ca14834a43f5de4533ebddb5cc8')
    }]);
    expect(config.enableCamelotTwoHop).toBe(false);
    expect(config.twoHopUnlockMinCoverageBps).toBe(9_800n);
    expect(config.maxRevertedProbesPerOrder).toBe(3);
  });

  it('rejects invalid bridge token addresses clearly', () => {
    expect(() =>
      loadRuntimeConfig({
        ...baseEnv,
        BRIDGE_TOKENS: 'not-an-address'
      })
    ).toThrow('Invalid BRIDGE_TOKENS address');
  });
});
