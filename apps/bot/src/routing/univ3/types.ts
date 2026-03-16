import type { Address, PublicClient } from 'viem';
import type { ResolvedV3DutchOrder } from '@uni/protocol';
import type { HedgeRoutePlan } from '../venues.js';

export type UniV3FeeTier = 500 | 3000 | 10000;

export type RoutePlanningPolicy = {
  feeTiers?: readonly UniV3FeeTier[];
  slippageBufferBps?: bigint;
  gasEstimateWei?: bigint;
  riskBufferBps?: bigint;
  riskBufferOut?: bigint;
  profitFloorOut?: bigint;
};

export type UniV3RoutePlan = HedgeRoutePlan & {
  venue: 'UNISWAP_V3';
  quoteMetadata: {
    venue: 'UNISWAP_V3';
    poolFee: UniV3FeeTier;
  };
};

export type RoutePlanningFailure = {
  reason: 'NOT_ROUTEABLE' | 'NO_POOL' | 'POOL_DEAD' | 'QUOTE_FAILED' | 'NOT_PROFITABLE' | 'NOT_PRICEABLE_GAS';
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
