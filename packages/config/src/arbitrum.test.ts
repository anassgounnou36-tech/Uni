import { describe, expect, it } from 'vitest';

import {
  ARBITRUM_DUTCH_REACTOR_SUPPORT,
  ARB1_SEQUENCER_ENDPOINT,
  CAMELOT_AMMV3_FACTORY,
  CAMELOT_AMMV3_QUOTER,
  CAMELOT_AMMV3_SWAP_ROUTER,
  PERMIT2,
  UNISWAPX_DUTCH_V3_REACTOR
} from './arbitrum.js';

describe('arbitrum protocol lock constants', () => {
  it('keeps known locked addresses', () => {
    expect(UNISWAPX_DUTCH_V3_REACTOR).toBe('0xB274d5F4b833b61B340b654d600A864fB604a87c');
    expect(PERMIT2).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3');
    expect(CAMELOT_AMMV3_FACTORY).toBe('0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B');
    expect(CAMELOT_AMMV3_QUOTER).toBe('0x0Fc73040b26E9bC8514fA028D998E73A254Fa76E');
    expect(CAMELOT_AMMV3_SWAP_ROUTER).toBe('0x1F721E2E82F6676FCE4eA07A5958cF098D339e18');
  });

  it('keeps arb1 sequencer endpoint and dutch v2 unsupported marker', () => {
    expect(ARB1_SEQUENCER_ENDPOINT).toBe('https://arb1-sequencer.arbitrum.io/rpc');
    expect(ARBITRUM_DUTCH_REACTOR_SUPPORT.dutch_v2_deprecated_unsupported).toBe('unsupported');
  });
});
