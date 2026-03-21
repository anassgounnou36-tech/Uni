import type { HedgeVenue } from './venues.js';
import type { ConstraintBreakdown, ConstraintRejectReason } from './constraintTypes.js';
import type { ExactOutputViability } from './exactOutputTypes.js';
import type { HedgeGapSummary } from './hedgeGapTypes.js';
import type { RejectedCandidateClass } from './rejectedCandidateTypes.js';
import type { RoutePathKind } from './pathTypes.js';
import type { HedgeExecutionMode } from './executionModeTypes.js';
import type { Address } from 'viem';

export type RouteAttemptStatus =
  | 'ROUTEABLE'
  | 'NOT_ROUTEABLE'
  | 'NOT_PROFITABLE'
  | 'QUOTE_FAILED'
  | 'GAS_NOT_PRICEABLE'
  | 'CONSTRAINT_REJECTED';

export type RejectedRouteAttemptStatus = Exclude<RouteAttemptStatus, 'ROUTEABLE'>;

export type FeeTierAttemptSummary = {
  feeTier: number;
  secondFeeTier?: number;
  executionMode?: HedgeExecutionMode;
  pathKind?: RoutePathKind;
  hopCount?: 1 | 2;
  bridgeToken?: Address;
  pathDescriptor?: string;
  poolExists: boolean;
  quoteSucceeded: boolean;
  quotedAmountOut?: bigint;
  minAmountOut?: bigint;
  grossEdgeOut?: bigint;
  netEdgeOut?: bigint;
  status: RouteAttemptStatus;
  reason: string;
  constraintReason?: ConstraintRejectReason;
  constraintBreakdown?: ConstraintBreakdown;
  exactOutputViability?: ExactOutputViability;
  hedgeGap?: HedgeGapSummary;
  candidateClass?: RejectedCandidateClass;
};

export type VenueRouteAttemptSummary = {
  venue: HedgeVenue;
  executionMode?: HedgeExecutionMode;
  pathKind?: RoutePathKind;
  hopCount?: 1 | 2;
  bridgeToken?: Address;
  pathDescriptor?: string;
  status: RouteAttemptStatus;
  reason: string;
  quotedAmountOut?: bigint;
  minAmountOut?: bigint;
  grossEdgeOut?: bigint;
  netEdgeOut?: bigint;
  selectedFeeTier?: number;
  feeTierAttempts?: FeeTierAttemptSummary[];
  quoteCount?: number;
  metadata?: Record<string, string | number | boolean | null | undefined>;
  constraintReason?: ConstraintRejectReason;
  constraintBreakdown?: ConstraintBreakdown;
  exactOutputViability?: ExactOutputViability;
  hedgeGap?: HedgeGapSummary;
  candidateClass?: RejectedCandidateClass;
};

export type RejectedFeeTierAttemptSummary = FeeTierAttemptSummary & {
  status: RejectedRouteAttemptStatus;
  candidateClass: RejectedCandidateClass;
};

export type RejectedVenueRouteAttemptSummary = VenueRouteAttemptSummary & {
  status: RejectedRouteAttemptStatus;
  candidateClass: RejectedCandidateClass;
};
