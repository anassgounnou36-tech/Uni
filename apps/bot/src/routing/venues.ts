import type { Address } from 'viem';

export const HEDGE_VENUES = ['UNISWAP_V3', 'CAMELOT_AMMV3'] as const;
export type HedgeVenue = (typeof HEDGE_VENUES)[number];

export type RouteQuoteMetadata =
  | {
      venue: 'UNISWAP_V3';
      poolFee: number;
    }
  | {
      venue: 'CAMELOT_AMMV3';
      observedFee?: number;
      sqrtPriceAfterX96?: bigint;
    };

export type HedgeRoutePlan = {
  venue: HedgeVenue;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  requiredOutput: bigint;
  quotedAmountOut: bigint;
  minAmountOut: bigint;
  limitSqrtPriceX96: bigint;
  grossEdgeOut: bigint;
  slippageBufferOut: bigint;
  gasCostOut: bigint;
  riskBufferOut: bigint;
  profitFloorOut: bigint;
  netEdgeOut: bigint;
  quoteMetadata: RouteQuoteMetadata;
};

export type RouteCandidateFailureReason =
  | 'NOT_ROUTEABLE'
  | 'NO_POOL'
  | 'POOL_DEAD'
  | 'QUOTE_FAILED'
  | 'NOT_PROFITABLE'
  | 'NOT_PRICEABLE_GAS'
  | 'CAMELOT_DISABLED'
  | 'CAMELOT_NOT_ROUTEABLE'
  | 'CAMELOT_GAS_NOT_PRICEABLE'
  | 'CAMELOT_QUOTE_FAILED';

export type RouteCandidateSummary = {
  venue: HedgeVenue;
  eligible: boolean;
  reason?: RouteCandidateFailureReason | 'BEAT_BY_HIGHER_NET_EDGE' | 'BEAT_BY_TIE_BREAK';
  details?: string;
  quotedAmountOut?: bigint;
  requiredOutput?: bigint;
  minAmountOut?: bigint;
  netEdgeOut?: bigint;
  gasCostOut?: bigint;
};
