import type { ConstraintRejectReason } from './constraintTypes.js';
import type { ExactOutputViabilityStatus } from './exactOutputTypes.js';
import type { VenueRouteAttemptSummary } from './attemptTypes.js';

export type RejectedCandidateClass =
  | 'POLICY_BLOCKED'
  | 'LIQUIDITY_BLOCKED'
  | 'ROUTE_MISSING'
  | 'QUOTE_FAILED'
  | 'GAS_NOT_PRICEABLE'
  | 'UNKNOWN';

export function deriveRejectedCandidateClass(summary: VenueRouteAttemptSummary): RejectedCandidateClass {
  if (summary.status === 'GAS_NOT_PRICEABLE') {
    return 'GAS_NOT_PRICEABLE';
  }
  if (summary.status === 'QUOTE_FAILED') {
    return 'QUOTE_FAILED';
  }
  if (summary.reason === 'POOL_MISSING') {
    return 'ROUTE_MISSING';
  }

  const hasQuote = summary.quotedAmountOut !== undefined;
  const nearSatisfiable = summary.constraintBreakdown?.nearMiss ?? false;
  const satisfiable = summary.exactOutputViability?.status === 'SATISFIABLE';
  if (
    hasQuote
    && (satisfiable || nearSatisfiable)
    && (
      summary.constraintReason === 'PROFITABILITY_FLOOR'
      || summary.constraintReason === 'SLIPPAGE_FLOOR'
    )
  ) {
    return 'POLICY_BLOCKED';
  }
  if (
    summary.constraintReason === 'REQUIRED_OUTPUT'
    && summary.exactOutputViability?.status === 'UNSATISFIABLE'
  ) {
    return 'LIQUIDITY_BLOCKED';
  }
  if (
    summary.status === 'NOT_ROUTEABLE'
    && (
      summary.reason.includes('POOL')
      || summary.reason.includes('NOT_ROUTEABLE')
      || summary.reason === 'CAMELOT_DISABLED'
    )
  ) {
    return 'ROUTE_MISSING';
  }
  return 'UNKNOWN';
}

export function classifyRejectedCandidate(params: {
  status: string;
  reason: string;
  constraintReason?: ConstraintRejectReason;
  exactOutputViabilityStatus?: ExactOutputViabilityStatus;
  quotedAmountOut?: bigint;
}): RejectedCandidateClass {
  return deriveRejectedCandidateClass({
    venue: 'UNISWAP_V3',
    status: params.status as VenueRouteAttemptSummary['status'],
    reason: params.reason,
    quotedAmountOut: params.quotedAmountOut,
    constraintReason: params.constraintReason,
    exactOutputViability: params.exactOutputViabilityStatus
      ? {
          status: params.exactOutputViabilityStatus,
          targetOutput: 0n,
          requiredInputForTargetOutput: 0n,
          availableInput: 0n,
          reason: 'derived from classifyRejectedCandidate compatibility helper'
        }
      : undefined
  });
}

export function rejectedCandidateClassPriority(candidateClass: RejectedCandidateClass): number {
  if (candidateClass === 'POLICY_BLOCKED') return 0;
  if (candidateClass === 'LIQUIDITY_BLOCKED') return 1;
  if (candidateClass === 'GAS_NOT_PRICEABLE') return 2;
  if (candidateClass === 'QUOTE_FAILED') return 3;
  if (candidateClass === 'ROUTE_MISSING') return 4;
  return 5;
}
