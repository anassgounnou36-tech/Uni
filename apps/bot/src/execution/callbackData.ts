import { decodeAbiParameters, encodeAbiParameters } from 'viem';
import type { UniV3RoutePlan } from '../routing/univ3/types.js';

const ROUTE_PLAN_TUPLE = [
  {
    type: 'tuple',
    components: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'poolFee', type: 'uint24' },
      { name: 'minAmountOut', type: 'uint256' }
    ]
  }
] as const;

export type ExecutorRoutePlan = {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  poolFee: number;
  minAmountOut: bigint;
};

export type RoutePlanCallbackInput = Pick<UniV3RoutePlan, 'tokenIn' | 'tokenOut' | 'poolFee' | 'minAmountOut'>;

export function encodeRoutePlanCallbackData(route: RoutePlanCallbackInput): `0x${string}` {
  return encodeAbiParameters(ROUTE_PLAN_TUPLE, [
    {
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
      poolFee: route.poolFee,
      minAmountOut: route.minAmountOut
    }
  ]);
}

export function decodeRoutePlanCallbackData(callbackData: `0x${string}`): ExecutorRoutePlan {
  const [decoded] = decodeAbiParameters(ROUTE_PLAN_TUPLE, callbackData);
  return {
    tokenIn: decoded.tokenIn,
    tokenOut: decoded.tokenOut,
    poolFee: Number(decoded.poolFee),
    minAmountOut: decoded.minAmountOut
  };
}
