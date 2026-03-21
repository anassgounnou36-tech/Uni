import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../src/runtime/config.js';

const baseEnv = {
  READ_RPC_URL: 'https://read.example',
  SEQUENCER_URL: 'https://sequencer.example'
} as const;

describe('runtime config', () => {
  it('parses bridge tokens list', () => {
    const config = loadRuntimeConfig({
      ...baseEnv,
      BRIDGE_TOKENS:
        '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1,0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'
    });
    expect(config.bridgeTokens).toEqual([
      '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'
    ]);
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
