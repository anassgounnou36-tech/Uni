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
      executionMode: 'EXACT_INPUT',
      pathKind: 'DIRECT',
      hopCount: 1,
      pathDirection: 'FORWARD',
      tokenIn: '0x0000000000000000000000000000000000000001',
      tokenOut: '0x0000000000000000000000000000000000000002',
      uniPoolFee: 3000,
      encodedPath: '0x',
      limitSqrtPriceX96: 0n,
      minAmountOut: 123n,
      targetOutput: 0n,
      maxAmountIn: 0n
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
      executionMode: 'EXACT_INPUT',
      pathKind: 'DIRECT',
      hopCount: 1,
      pathDirection: 'FORWARD',
      tokenIn: '0x0000000000000000000000000000000000000001',
      tokenOut: '0x0000000000000000000000000000000000000002',
      uniPoolFee: 0,
      encodedPath: '0x',
      limitSqrtPriceX96: 0n,
      minAmountOut: 777n,
      targetOutput: 0n,
      maxAmountIn: 0n
    });
  });

  it('camelotRouteRequiresUniFeeZero', () => {
    const malformedCamelot = encodeAbiParameters(
      [
        {
          type: 'tuple',
            components: [
              { name: 'venue', type: 'uint8' },
              { name: 'executionMode', type: 'uint8' },
              { name: 'pathKind', type: 'uint8' },
              { name: 'hopCount', type: 'uint8' },
              { name: 'pathDirection', type: 'uint8' },
              { name: 'tokenIn', type: 'address' },
              { name: 'tokenOut', type: 'address' },
              { name: 'uniPoolFee', type: 'uint24' },
              { name: 'encodedPath', type: 'bytes' },
              { name: 'limitSqrtPriceX96', type: 'uint160' },
              { name: 'minAmountOut', type: 'uint256' },
              { name: 'targetOutput', type: 'uint256' },
              { name: 'maxAmountIn', type: 'uint256' }
            ]
        }
      ],
      [
        {
          venue: 1,
          executionMode: 0,
          pathKind: 0,
          hopCount: 1,
          pathDirection: 0,
          tokenIn: '0x0000000000000000000000000000000000000001',
          tokenOut: '0x0000000000000000000000000000000000000002',
          uniPoolFee: 500,
          encodedPath: '0x',
          limitSqrtPriceX96: 0n,
          minAmountOut: 1n,
          targetOutput: 1n,
          maxAmountIn: 1n
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
        pathDirection: 'FORWARD',
        tokenIn: '0x0000000000000000000000000000000000000001',
        tokenOut: '0x0000000000000000000000000000000000000003',
        encodedPath: '0x0000000000000000000000000000000000000001000bb80000000000000000000000000000000000000002000bb80000000000000000000000000000000000000003',
        quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 3000 },
        limitSqrtPriceX96: 0n,
        minAmountOut: 456n
      })
    );
    expect(decoded.pathKind).toBe('TWO_HOP');
    expect(decoded.executionMode).toBe('EXACT_INPUT');
    expect(decoded.hopCount).toBe(2);
    expect(decoded.uniPoolFee).toBe(0);
    expect(decoded.encodedPath).not.toBe('0x');
  });

  it('callback_data_round_trips_exact_output_direct_and_two_hop_routes', () => {
    const direct = decodeRoutePlanCallbackData(
      encodeRoutePlanCallbackData({
        venue: 'UNISWAP_V3',
        executionMode: 'EXACT_OUTPUT',
        pathKind: 'DIRECT',
        hopCount: 1,
        pathDirection: 'FORWARD',
        tokenIn: '0x0000000000000000000000000000000000000001',
        tokenOut: '0x0000000000000000000000000000000000000002',
        quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 500 },
        limitSqrtPriceX96: 0n,
        minAmountOut: 900n,
        requiredOutput: 900n,
        targetOutput: 900n,
        amountIn: 1_000n,
        maxAmountIn: 1_000n
      })
    );
    expect(direct.executionMode).toBe('EXACT_OUTPUT');
    expect(direct.targetOutput).toBe(900n);
    expect(direct.maxAmountIn).toBe(1_000n);

    const twoHop = decodeRoutePlanCallbackData(
      encodeRoutePlanCallbackData({
        venue: 'UNISWAP_V3',
        executionMode: 'EXACT_OUTPUT',
        pathKind: 'TWO_HOP',
        hopCount: 2,
        pathDirection: 'REVERSE',
        tokenIn: '0x0000000000000000000000000000000000000001',
        tokenOut: '0x0000000000000000000000000000000000000003',
        encodedPath: '0x00000000000000000000000000000000000000010001f400000000000000000000000000000000000000020001f40000000000000000000000000000000000000003',
        quoteMetadata: { venue: 'UNISWAP_V3', poolFee: 500 },
        limitSqrtPriceX96: 0n,
        minAmountOut: 900n,
        requiredOutput: 900n,
        targetOutput: 900n,
        amountIn: 1_000n,
        maxAmountIn: 1_000n
      })
    );
    expect(twoHop.executionMode).toBe('EXACT_OUTPUT');
    expect(twoHop.pathKind).toBe('TWO_HOP');
    expect(twoHop.maxAmountIn).toBe(1_000n);
    expect(twoHop.pathDirection).toBe('REVERSE');
  });
});
