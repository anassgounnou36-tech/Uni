import type { Address } from 'viem';
import type { LfjLbPath, PathEncodingDirection, RoutePathKind } from './pathTypes.js';
import type { RejectedCandidateClass } from './rejectedCandidateTypes.js';
import type { ConstraintBreakdown, ConstraintRejectReason } from './constraintTypes.js';
import type { ExactOutputViability } from './exactOutputTypes.js';
import type { HedgeGapSummary } from './hedgeGapTypes.js';
import type { HedgeExecutionMode } from './executionModeTypes.js';
import type { RouteFamilyKind } from './familyTypes.js';
import type { FamilyDominanceReason } from './familyTypes.js';

export const HEDGE_VENUES = ['UNISWAP_V3', 'CAMELOT_AMMV3', 'LFJ_LB'] as const;
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
    }
  | {
      venue: 'LFJ_LB';
      observedFee?: number;
    };

export type HedgeRoutePlan = {
  venue: HedgeVenue;
  executionMode?: HedgeExecutionMode;
  pathKind: RoutePathKind;
  hopCount: 1 | 2;
  pathDirection?: PathEncodingDirection;
  pathDescriptor?: string;
  tokenIn: Address;
  tokenOut: Address;
  bridgeToken?: Address;
  encodedPath?: `0x${string}`;
  lfjPath?: LfjLbPath;
  amountIn: bigint;
  requiredOutput: bigint;
  targetOutput?: bigint;
  maxAmountIn?: bigint;
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
  | 'CONSTRAINT_REJECTED'
  | 'NO_POOL'
  | 'POOL_DEAD'
  | 'QUOTE_FAILED'
  | 'QUOTE_REVERTED'
  | 'RATE_LIMITED'
  | 'RPC_UNAVAILABLE'
  | 'RPC_FAILED'
  | 'NOT_PROFITABLE'
  | 'NOT_PRICEABLE_GAS'
  | 'CAMELOT_DISABLED'
  | 'CAMELOT_NOT_ROUTEABLE'
  | 'CAMELOT_GAS_NOT_PRICEABLE'
  | 'CAMELOT_QUOTE_FAILED';

export type RouteCandidateSummary = {
  venue: HedgeVenue;
  executionMode?: HedgeExecutionMode;
  familyKind?: RouteFamilyKind;
  probePriority?: number;
  familyKey?: string;
  dominanceScore?: number;
  dominanceReason?: FamilyDominanceReason;
  exactOutputPromotedFromFamily?: boolean;
  pathKind?: RoutePathKind;
  hopCount?: 1 | 2;
  bridgeToken?: Address;
  pathDescriptor?: string;
  lfjPath?: LfjLbPath;
  eligible: boolean;
  reason?: RouteCandidateFailureReason | 'BEAT_BY_HIGHER_NET_EDGE' | 'BEAT_BY_TIE_BREAK';
  details?: string;
  quotedAmountOut?: bigint;
  requiredOutput?: bigint;
  minAmountOut?: bigint;
  netEdgeOut?: bigint;
  gasCostOut?: bigint;
  candidateClass?: RejectedCandidateClass;
  constraintReason?: ConstraintRejectReason;
  constraintBreakdown?: ConstraintBreakdown;
  exactOutputViability?: ExactOutputViability;
  hedgeGap?: HedgeGapSummary;
};
