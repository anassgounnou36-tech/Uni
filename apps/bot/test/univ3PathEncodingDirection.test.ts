import { describe, expect, it } from 'vitest';
import { encodeUniV3Path, reverseUniV3Path } from '../src/routing/univ3/quoter.js';

describe('uniswap path encoding direction', () => {
  it('uniswap_exact_output_direct_path_is_encoded_reversed', () => {
    const tokenIn = '0x0000000000000000000000000000000000000001';
    const tokenOut = '0x0000000000000000000000000000000000000002';
    const forward = encodeUniV3Path([{ tokenIn, fee: 3000, tokenOut }]);
    const reversed = reverseUniV3Path(forward);
    const expected = encodeUniV3Path([{ tokenIn: tokenOut, fee: 3000, tokenOut: tokenIn }]);
    expect(reversed).toBe(expected);
  });

  it('uniswap_exact_output_two_hop_path_is_encoded_reversed', () => {
    const tokenIn = '0x0000000000000000000000000000000000000001';
    const bridge = '0x000000000000000000000000000000000000000b';
    const tokenOut = '0x0000000000000000000000000000000000000002';
    const forward = encodeUniV3Path([
      { tokenIn, fee: 500, tokenOut: bridge },
      { tokenIn: bridge, fee: 3000, tokenOut }
    ]);
    const reversed = reverseUniV3Path(forward);
    const expected = encodeUniV3Path([
      { tokenIn: tokenOut, fee: 3000, tokenOut: bridge },
      { tokenIn: bridge, fee: 500, tokenOut: tokenIn }
    ]);
    expect(reversed).toBe(expected);
  });
});
