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
    expect(config.enableLfjLb).toBe(true);
    expect(config.enableLfjTwoHop).toBe(false);
    expect(config.maxLfjTwoHopFamiliesPerOrder).toBe(2);
    expect(config.twoHopUnlockMinCoverageBps).toBe(9_800n);
    expect(config.maxTwoHopFamiliesPerOrder).toBe(2);
    expect(config.maxExtraFamiliesAfterDominantDirect).toBe(1);
    expect(config.dominanceMinScoreMargin).toBe(10);
    expect(config.maxExtraSameVenueChallengersAfterOtherVenuesMissing).toBe(2);
    expect(config.routeEvalCacheMaxEntries).toBe(4096);
    expect(config.routeEvalNegativeCacheMaxEntries).toBe(2048);
    expect(config.maxCandidateBlocksPerOrder).toBe(7);
    expect(config.maxRevertedProbesPerOrder).toBe(3);
    expect(config.maxPrepareStaleRetries).toBe(1);
  });

  it('rejects invalid bridge token addresses clearly', () => {
    expect(() =>
      loadRuntimeConfig({
        ...baseEnv,
        BRIDGE_TOKENS: 'not-an-address'
      })
    ).toThrow('Invalid BRIDGE_TOKENS address');
  });

  it('normalizes LFJ addresses and env toggles', () => {
    const config = loadRuntimeConfig({
      ...baseEnv,
      LFJ_LB_ROUTER: '0xb4315e873dbcf96ffd0acd8ea43f689d8c20fb30',
      LFJ_LB_QUOTER: '0x64b57f4249aa99a812212cee7daefedc40b203cd',
      LFJ_LB_FACTORY: '0x8e42f2f4101563bf679975178e880fd87d3efd4e',
      ENABLE_LFJ_LB: 'true',
      ENABLE_LFJ_TWO_HOP: 'true',
      MAX_LFJ_TWO_HOP_FAMILIES_PER_ORDER: '3'
    });
    expect(config.lfjLbRouter).toBe(getAddress('0xb4315e873dbcf96ffd0acd8ea43f689d8c20fb30'));
    expect(config.lfjLbQuoter).toBe(getAddress('0x64b57f4249aa99a812212cee7daefedc40b203cd'));
    expect(config.lfjLbFactory).toBe(getAddress('0x8e42f2f4101563bf679975178e880fd87d3efd4e'));
    expect(config.enableLfjLb).toBe(true);
    expect(config.enableLfjTwoHop).toBe(true);
    expect(config.maxLfjTwoHopFamiliesPerOrder).toBe(3);
  });
});
