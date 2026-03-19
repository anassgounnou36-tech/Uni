import type { HedgeVenue } from './venues.js';
import type { ConstraintBreakdown, ConstraintRejectReason } from './constraintTypes.js';

export type RouteAttemptStatus =
  | 'ROUTEABLE'
  | 'NOT_ROUTEABLE'
  | 'NOT_PROFITABLE'
  | 'QUOTE_FAILED'
  | 'GAS_NOT_PRICEABLE'
  | 'CONSTRAINT_REJECTED';

export type FeeTierAttemptSummary = {
  feeTier: number;
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
};

export type VenueRouteAttemptSummary = {
  venue: HedgeVenue;
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
};
