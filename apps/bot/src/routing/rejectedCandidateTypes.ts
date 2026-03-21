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

function isQuoteFailedLike(summary: VenueRouteAttemptSummary): boolean {
  const quoteFailureReasons = new Set([
    'QUOTE_FAILED',
    'QUOTE_CALL_FAILED',
    'POOL_OR_QUOTE_UNAVAILABLE',
    'UNEXPECTED_QUOTE_SHAPE',
    'UNEXPECTED_QUOTE_SCALAR'
  ]);
  return summary.status === 'QUOTE_FAILED'
    || summary.exactOutputViability?.status === 'QUOTE_FAILED'
    || quoteFailureReasons.has(summary.reason);
}

export function deriveRejectedCandidateClass(summary: VenueRouteAttemptSummary): RejectedCandidateClass {
  if (summary.status === 'GAS_NOT_PRICEABLE') {
    return 'GAS_NOT_PRICEABLE';
  }
  if (isQuoteFailedLike(summary)) {
    return 'QUOTE_FAILED';
  }
  if (summary.reason === 'POOL_MISSING') {
    return 'ROUTE_MISSING';
  }
  if (summary.status === 'NOT_ROUTEABLE') {
    return 'ROUTE_MISSING';
  }

  const hasQuote = summary.quotedAmountOut !== undefined;
  const nearSatisfiable = summary.constraintBreakdown?.nearMiss ?? summary.hedgeGap?.nearMiss ?? false;
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
    && (
      (summary.hedgeGap?.requiredOutputShortfallOut ?? summary.constraintBreakdown?.requiredOutputShortfallOut ?? 0n) > 0n
      || summary.exactOutputViability === undefined
      || summary.exactOutputViability?.status === 'UNSATISFIABLE'
      || summary.exactOutputViability?.status === 'QUOTE_FAILED'
      || (
        summary.exactOutputViability?.status === 'SATISFIABLE'
        && (summary.hedgeGap?.requiredOutputShortfallOut ?? summary.constraintBreakdown?.requiredOutputShortfallOut ?? 0n) > 0n
      )
    )
  ) {
    return 'LIQUIDITY_BLOCKED';
  }
  if (summary.reason.includes('POOL') || summary.reason.includes('NOT_ROUTEABLE') || summary.reason === 'CAMELOT_DISABLED') {
    return 'ROUTE_MISSING';
  }
  return 'UNKNOWN';
}

/** @deprecated Use deriveRejectedCandidateClass(summary) instead. */
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
