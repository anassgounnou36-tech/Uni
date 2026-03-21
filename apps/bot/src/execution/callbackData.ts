import { decodeAbiParameters, encodeAbiParameters } from 'viem';
import type { HedgeRoutePlan } from '../routing/venues.js';
import { fromExecutorVenueCode, toExecutorVenueCode } from './venueTypes.js';
import type { RoutePathKind } from '../routing/pathTypes.js';
import type { HedgeExecutionMode } from '../routing/executionModeTypes.js';

const ROUTE_PLAN_TUPLE = [
  {
    type: 'tuple',
    components: [
      { name: 'venue', type: 'uint8' },
      { name: 'executionMode', type: 'uint8' },
      { name: 'pathKind', type: 'uint8' },
      { name: 'hopCount', type: 'uint8' },
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
] as const;

const PATH_KIND_TO_CODE: Record<RoutePathKind, number> = {
  DIRECT: 0,
  TWO_HOP: 1
};
const EXECUTION_MODE_TO_CODE: Record<HedgeExecutionMode, number> = {
  EXACT_INPUT: 0,
  EXACT_OUTPUT: 1
};

function fromPathKindCode(code: number): RoutePathKind {
  if (code === 0) return 'DIRECT';
  if (code === 1) return 'TWO_HOP';
  throw new Error(`unsupported path kind code: ${code}`);
}

function fromExecutionModeCode(code: number): HedgeExecutionMode {
  if (code === 0) return 'EXACT_INPUT';
  if (code === 1) return 'EXACT_OUTPUT';
  throw new Error(`unsupported execution mode code: ${code}`);
}

export type ExecutorRoutePlan = {
  venue: 'UNISWAP_V3' | 'CAMELOT_AMMV3';
  executionMode: HedgeExecutionMode;
  pathKind: RoutePathKind;
  hopCount: 1 | 2;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  uniPoolFee: number;
  encodedPath: `0x${string}`;
  limitSqrtPriceX96: bigint;
  minAmountOut: bigint;
  targetOutput: bigint;
  maxAmountIn: bigint;
};

export type RoutePlanCallbackInput = Pick<
  HedgeRoutePlan,
  | 'venue'
  | 'executionMode'
  | 'pathKind'
  | 'hopCount'
  | 'tokenIn'
  | 'tokenOut'
  | 'encodedPath'
  | 'quoteMetadata'
  | 'limitSqrtPriceX96'
  | 'minAmountOut'
  | 'requiredOutput'
  | 'amountIn'
  | 'targetOutput'
  | 'maxAmountIn'
>;

export function assertValidExecutorRoutePlan(route: ExecutorRoutePlan): void {
  if (route.hopCount !== 1 && route.hopCount !== 2) {
    throw new Error('route hopCount must be 1 or 2');
  }
  if (route.pathKind === 'DIRECT' && route.hopCount !== 1) {
    throw new Error('DIRECT route requires hopCount=1');
  }
  if (route.pathKind === 'TWO_HOP' && route.hopCount !== 2) {
    throw new Error('TWO_HOP route requires hopCount=2');
  }
  if (route.venue === 'UNISWAP_V3' && route.pathKind === 'DIRECT' && route.uniPoolFee === 0) {
    throw new Error('UNISWAP_V3 route requires non-zero uniPoolFee');
  }
  if (route.venue === 'CAMELOT_AMMV3' && route.pathKind === 'DIRECT' && route.uniPoolFee !== 0) {
    throw new Error('CAMELOT_AMMV3 route requires uniPoolFee=0');
  }
  if (route.pathKind === 'TWO_HOP' && route.encodedPath === '0x') {
    throw new Error('TWO_HOP route requires encodedPath');
  }
  if (route.executionMode === 'EXACT_OUTPUT') {
    if (route.targetOutput <= 0n) {
      throw new Error('EXACT_OUTPUT route requires positive targetOutput');
    }
    if (route.maxAmountIn <= 0n) {
      throw new Error('EXACT_OUTPUT route requires positive maxAmountIn');
    }
  }
}

export function encodeRoutePlanCallbackData(route: RoutePlanCallbackInput): `0x${string}` {
  if (route.executionMode === 'EXACT_OUTPUT') {
    if (route.targetOutput === undefined || route.maxAmountIn === undefined) {
      throw new Error('EXACT_OUTPUT route requires explicit targetOutput and maxAmountIn');
    }
  }
  const routePlan: ExecutorRoutePlan = {
    venue: route.venue,
    executionMode: route.executionMode ?? 'EXACT_INPUT',
    pathKind: route.pathKind,
    hopCount: route.hopCount,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    uniPoolFee: route.pathKind === 'DIRECT' && route.quoteMetadata.venue === 'UNISWAP_V3' ? route.quoteMetadata.poolFee : 0,
    encodedPath: route.encodedPath ?? '0x',
    limitSqrtPriceX96: route.limitSqrtPriceX96,
    minAmountOut: route.minAmountOut,
    targetOutput: route.targetOutput ?? route.requiredOutput ?? 0n,
    maxAmountIn: route.maxAmountIn ?? route.amountIn ?? 0n
  };
  assertValidExecutorRoutePlan(routePlan);
  return encodeAbiParameters(ROUTE_PLAN_TUPLE, [
    {
      venue: toExecutorVenueCode(routePlan.venue),
      executionMode: EXECUTION_MODE_TO_CODE[routePlan.executionMode],
      pathKind: PATH_KIND_TO_CODE[routePlan.pathKind],
      hopCount: routePlan.hopCount,
      tokenIn: routePlan.tokenIn,
      tokenOut: routePlan.tokenOut,
      uniPoolFee: routePlan.uniPoolFee,
      encodedPath: routePlan.encodedPath,
      limitSqrtPriceX96: routePlan.limitSqrtPriceX96,
      minAmountOut: routePlan.minAmountOut,
      targetOutput: routePlan.targetOutput,
      maxAmountIn: routePlan.maxAmountIn
    }
  ]);
}

export function decodeRoutePlanCallbackData(callbackData: `0x${string}`): ExecutorRoutePlan {
  const [decoded] = decodeAbiParameters(ROUTE_PLAN_TUPLE, callbackData);
  const routePlan: ExecutorRoutePlan = {
    venue: fromExecutorVenueCode(Number(decoded.venue)),
    executionMode: fromExecutionModeCode(Number(decoded.executionMode)),
    pathKind: fromPathKindCode(Number(decoded.pathKind)),
    hopCount: Number(decoded.hopCount) as 1 | 2,
    tokenIn: decoded.tokenIn,
    tokenOut: decoded.tokenOut,
    uniPoolFee: Number(decoded.uniPoolFee),
    encodedPath: decoded.encodedPath,
    limitSqrtPriceX96: decoded.limitSqrtPriceX96,
    minAmountOut: decoded.minAmountOut,
    targetOutput: decoded.targetOutput,
    maxAmountIn: decoded.maxAmountIn
  };
  assertValidExecutorRoutePlan(routePlan);
  return routePlan;
}
