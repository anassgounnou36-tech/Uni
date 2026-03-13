import { describe, expect, it } from 'vitest';

import {
  ARBITRUM_DUTCH_REACTOR_SUPPORT,
  ARB1_SEQUENCER_ENDPOINT,
  PERMIT2,
  UNISWAPX_DUTCH_V3_REACTOR
} from './arbitrum.js';

describe('arbitrum protocol lock constants', () => {
  it('keeps known locked addresses', () => {
    expect(UNISWAPX_DUTCH_V3_REACTOR).toBe('0xB274d5F4b833b61B340b654d600A864fB604a87c');
    expect(PERMIT2).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3');
  });

  it('keeps arb1 sequencer endpoint and dutch v2 unsupported marker', () => {
    expect(ARB1_SEQUENCER_ENDPOINT).toBe('https://arb1-sequencer.arbitrum.io/rpc');
    expect(ARBITRUM_DUTCH_REACTOR_SUPPORT.dutch_v2_deprecated_unsupported).toBe('unsupported');
  });
});
