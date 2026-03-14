import { decodeAbiParameters, encodeAbiParameters } from 'viem';
import type { HedgeRoutePlan } from '../routing/venues.js';
import { fromExecutorVenueCode, toExecutorVenueCode } from './venueTypes.js';

const ROUTE_PLAN_TUPLE = [
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
] as const;

export type ExecutorRoutePlan = {
  venue: 'UNISWAP_V3' | 'CAMELOT_AMMV3';
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  uniPoolFee: number;
  limitSqrtPriceX96: bigint;
  minAmountOut: bigint;
};

export type RoutePlanCallbackInput = Pick<
  HedgeRoutePlan,
  'venue' | 'tokenIn' | 'tokenOut' | 'quoteMetadata' | 'limitSqrtPriceX96' | 'minAmountOut'
>;

export function assertValidExecutorRoutePlan(route: ExecutorRoutePlan): void {
  if (route.venue === 'UNISWAP_V3' && route.uniPoolFee === 0) {
    throw new Error('UNISWAP_V3 route requires non-zero uniPoolFee');
  }
  if (route.venue === 'CAMELOT_AMMV3' && route.uniPoolFee !== 0) {
    throw new Error('CAMELOT_AMMV3 route requires uniPoolFee=0');
  }
}

export function encodeRoutePlanCallbackData(route: RoutePlanCallbackInput): `0x${string}` {
  const routePlan: ExecutorRoutePlan = {
    venue: route.venue,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    uniPoolFee: route.quoteMetadata.venue === 'UNISWAP_V3' ? route.quoteMetadata.poolFee : 0,
    limitSqrtPriceX96: route.limitSqrtPriceX96,
    minAmountOut: route.minAmountOut
  };
  assertValidExecutorRoutePlan(routePlan);
  return encodeAbiParameters(ROUTE_PLAN_TUPLE, [
    {
      venue: toExecutorVenueCode(routePlan.venue),
      tokenIn: routePlan.tokenIn,
      tokenOut: routePlan.tokenOut,
      uniPoolFee: routePlan.uniPoolFee,
      limitSqrtPriceX96: routePlan.limitSqrtPriceX96,
      minAmountOut: routePlan.minAmountOut
    }
  ]);
}

export function decodeRoutePlanCallbackData(callbackData: `0x${string}`): ExecutorRoutePlan {
  const [decoded] = decodeAbiParameters(ROUTE_PLAN_TUPLE, callbackData);
  const routePlan: ExecutorRoutePlan = {
    venue: fromExecutorVenueCode(Number(decoded.venue)),
    tokenIn: decoded.tokenIn,
    tokenOut: decoded.tokenOut,
    uniPoolFee: Number(decoded.uniPoolFee),
    limitSqrtPriceX96: decoded.limitSqrtPriceX96,
    minAmountOut: decoded.minAmountOut
  };
  assertValidExecutorRoutePlan(routePlan);
  return routePlan;
}
