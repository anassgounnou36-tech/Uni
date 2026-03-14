import type { Address, PublicClient } from 'viem';
import type { ResolvedV3DutchOrder } from '@uni/protocol';

export type UniV3FeeTier = 500 | 3000 | 10000;

export type RoutePlanningPolicy = {
  feeTiers?: readonly UniV3FeeTier[];
  slippageBufferBps?: bigint;
  gasEstimateWei?: bigint;
  riskBufferBps?: bigint;
  riskBufferWei?: bigint;
};

export type UniV3RoutePlan = {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  requiredOutput: bigint;
  quotedAmountOut: bigint;
  poolFee: UniV3FeeTier;
  minAmountOut: bigint;
  grossEdge: bigint;
  gasCostWei: bigint;
  riskBufferWei: bigint;
  netEdge: bigint;
};

export type RoutePlanningFailure = {
  reason: 'NOT_ROUTEABLE' | 'NO_POOL' | 'POOL_DEAD' | 'QUOTE_FAILED' | 'NOT_PROFITABLE';
  details?: string;
};

export type RoutePlanningResult =
  | {
      ok: true;
      route: UniV3RoutePlan;
      consideredFees: UniV3FeeTier[];
    }
  | {
      ok: false;
      failure: RoutePlanningFailure;
      consideredFees: UniV3FeeTier[];
    };

export type UniV3RoutingContext = {
  client: PublicClient;
  factory: Address;
  quoter: Address;
};

export type RoutePlannerInput = {
  resolvedOrder: ResolvedV3DutchOrder;
  policy?: RoutePlanningPolicy;
};
