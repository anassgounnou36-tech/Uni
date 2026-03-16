import { describe, expect, it } from 'vitest';
import { encodeAbiParameters } from 'viem';
import { decodeRoutePlanCallbackData, encodeRoutePlanCallbackData } from '../src/execution/callbackData.js';

describe('venue-aware callback data', () => {
  it('callbackDataRoundTripsVenueAwareRoutePlan', () => {
    const uniswap = decodeRoutePlanCallbackData(
      encodeRoutePlanCallbackData({
        venue: 'UNISWAP_V3',
        tokenIn: '0x0000000000000000000000000000000000000001',
        tokenOut: '0x0000000000000000000000000000000000000002',
        quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 3000 },
        limitSqrtPriceX96: 0n,
        minAmountOut: 123n
      })
    );
    expect(uniswap).toEqual({
      venue: 'UNISWAP_V3',
      tokenIn: '0x0000000000000000000000000000000000000001',
      tokenOut: '0x0000000000000000000000000000000000000002',
      uniPoolFee: 3000,
      limitSqrtPriceX96: 0n,
      minAmountOut: 123n
    });

    const camelot = decodeRoutePlanCallbackData(
      encodeRoutePlanCallbackData({
        venue: 'CAMELOT_AMMV3',
        tokenIn: '0x0000000000000000000000000000000000000001',
        tokenOut: '0x0000000000000000000000000000000000000002',
        quoteMetadata: { venue: 'CAMELOT_AMMV3', observedFee: 42 },
        limitSqrtPriceX96: 0n,
        minAmountOut: 777n
      })
    );
    expect(camelot).toEqual({
      venue: 'CAMELOT_AMMV3',
      tokenIn: '0x0000000000000000000000000000000000000001',
      tokenOut: '0x0000000000000000000000000000000000000002',
      uniPoolFee: 0,
      limitSqrtPriceX96: 0n,
      minAmountOut: 777n
    });
  });

  it('camelotRouteRequiresUniFeeZero', () => {
    const malformedCamelot = encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'venue', type: 'uint8' },
            { name: 'tokenIn', type: 'address' },
            { name: 'tokenOut', type: 'address' },
            { name: 'uniPoolFee', type: 'uint24' },
            { name: 'limitSqrtPriceX96', type: 'uint160' },
            { name: 'minAmountOut', type: 'uint256' }
          ]
        }
      ],
      [
        {
          venue: 1,
          tokenIn: '0x0000000000000000000000000000000000000001',
          tokenOut: '0x0000000000000000000000000000000000000002',
          uniPoolFee: 500,
          limitSqrtPriceX96: 0n,
          minAmountOut: 1n
        }
      ]
    );
    expect(() =>
      decodeRoutePlanCallbackData(malformedCamelot)
    ).toThrow('CAMELOT_AMMV3 route requires uniPoolFee=0');
  });
});
