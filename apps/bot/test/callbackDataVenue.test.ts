import { describe, expect, it } from 'vitest';
import { encodeAbiParameters } from 'viem';
import { decodeRoutePlanCallbackData, encodeRoutePlanCallbackData } from '../src/execution/callbackData.js';

describe('venue-aware callback data', () => {
  it('callbackDataRoundTripsVenueAwareRoutePlan', () => {
    const uniswap = decodeRoutePlanCallbackData(
      encodeRoutePlanCallbackData({
        venue: 'UNISWAP_V3',
        pathKind: 'DIRECT',
        hopCount: 1,
        tokenIn: '0x0000000000000000000000000000000000000001',
        tokenOut: '0x0000000000000000000000000000000000000002',
        quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 3000 },
        limitSqrtPriceX96: 0n,
        minAmountOut: 123n
      })
    );
    expect(uniswap).toEqual({
      venue: 'UNISWAP_V3',
      pathKind: 'DIRECT',
      hopCount: 1,
      tokenIn: '0x0000000000000000000000000000000000000001',
      tokenOut: '0x0000000000000000000000000000000000000002',
      uniPoolFee: 3000,
      encodedPath: '0x',
      limitSqrtPriceX96: 0n,
      minAmountOut: 123n
    });

    const camelot = decodeRoutePlanCallbackData(
      encodeRoutePlanCallbackData({
        venue: 'CAMELOT_AMMV3',
        pathKind: 'DIRECT',
        hopCount: 1,
        tokenIn: '0x0000000000000000000000000000000000000001',
        tokenOut: '0x0000000000000000000000000000000000000002',
        quoteMetadata: { venue: 'CAMELOT_AMMV3', observedFee: 42 },
        limitSqrtPriceX96: 0n,
        minAmountOut: 777n
      })
    );
    expect(camelot).toEqual({
      venue: 'CAMELOT_AMMV3',
      pathKind: 'DIRECT',
      hopCount: 1,
      tokenIn: '0x0000000000000000000000000000000000000001',
      tokenOut: '0x0000000000000000000000000000000000000002',
      uniPoolFee: 0,
      encodedPath: '0x',
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
              { name: 'pathKind', type: 'uint8' },
              { name: 'hopCount', type: 'uint8' },
              { name: 'tokenIn', type: 'address' },
              { name: 'tokenOut', type: 'address' },
              { name: 'uniPoolFee', type: 'uint24' },
              { name: 'encodedPath', type: 'bytes' },
              { name: 'limitSqrtPriceX96', type: 'uint160' },
              { name: 'minAmountOut', type: 'uint256' }
            ]
        }
      ],
      [
        {
          venue: 1,
          pathKind: 0,
          hopCount: 1,
          tokenIn: '0x0000000000000000000000000000000000000001',
          tokenOut: '0x0000000000000000000000000000000000000002',
          uniPoolFee: 500,
          encodedPath: '0x',
          limitSqrtPriceX96: 0n,
          minAmountOut: 1n
        }
      ]
    );
    expect(() =>
      decodeRoutePlanCallbackData(malformedCamelot)
    ).toThrow('CAMELOT_AMMV3 route requires uniPoolFee=0');
  });

  it('callback_data_round_trips_two_hop_route', () => {
    const decoded = decodeRoutePlanCallbackData(
      encodeRoutePlanCallbackData({
        venue: 'UNISWAP_V3',
        pathKind: 'TWO_HOP',
        hopCount: 2,
        tokenIn: '0x0000000000000000000000000000000000000001',
        tokenOut: '0x0000000000000000000000000000000000000003',
        encodedPath: '0x0000000000000000000000000000000000000001000bb80000000000000000000000000000000000000002000bb80000000000000000000000000000000000000003',
        quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 3000 },
        limitSqrtPriceX96: 0n,
        minAmountOut: 456n
      })
    );
    expect(decoded.pathKind).toBe('TWO_HOP');
    expect(decoded.hopCount).toBe(2);
    expect(decoded.uniPoolFee).toBe(0);
    expect(decoded.encodedPath).not.toBe('0x');
  });
});
