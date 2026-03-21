import type { Address, PublicClient } from 'viem';
import type { ResolvedV3DutchOrder } from '@uni/protocol';
import type { HedgeRoutePlan } from '../venues.js';
import type { VenueRouteAttemptSummary } from '../attemptTypes.js';

export type UniV3FeeTier = 500 | 3000 | 10000;

export type RoutePlanningPolicy = {
  feeTiers?: readonly UniV3FeeTier[];
  bridgeTokens?: readonly Address[];
  slippageBufferBps?: bigint;
  effectiveGasPriceWei?: bigint;
  riskBufferBps?: bigint;
  riskBufferOut?: bigint;
  profitFloorOut?: bigint;
  nearMissBps?: bigint;
};

export type UniV3RoutePlan = HedgeRoutePlan & {
  venue: 'UNISWAP_V3';
  quoteMetadata: {
    venue: 'UNISWAP_V3';
    poolFee: UniV3FeeTier;
  };
};

export type RoutePlanningFailure = {
  reason: 'NOT_ROUTEABLE' | 'QUOTE_FAILED' | 'NOT_PROFITABLE' | 'GAS_NOT_PRICEABLE' | 'CONSTRAINT_REJECTED';
  details?: string;
  summary: VenueRouteAttemptSummary;
};

export type RoutePlanningResult =
  | {
      ok: true;
      route: UniV3RoutePlan;
      summary: VenueRouteAttemptSummary;
    }
  | {
      ok: false;
      failure: RoutePlanningFailure;
    };

export type UniV3RoutingContext = {
  client: PublicClient;
  factory: Address;
  quoter: Address;
  bridgeTokens?: readonly Address[];
};

export type RoutePlannerInput = {
  resolvedOrder: ResolvedV3DutchOrder;
  policy?: RoutePlanningPolicy;
};
