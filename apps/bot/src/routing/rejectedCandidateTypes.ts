import type { ConstraintRejectReason } from './constraintTypes.js';
import type { ExactOutputViabilityStatus } from './exactOutputTypes.js';

export type RejectedCandidateClass =
  | 'POLICY_BLOCKED'
  | 'LIQUIDITY_BLOCKED'
  | 'ROUTE_MISSING'
  | 'QUOTE_FAILED'
  | 'GAS_NOT_PRICEABLE'
  | 'UNKNOWN';

export function classifyRejectedCandidate(params: {
  status: string;
  reason: string;
  constraintReason?: ConstraintRejectReason;
  exactOutputViabilityStatus?: ExactOutputViabilityStatus;
  quotedAmountOut?: bigint;
}): RejectedCandidateClass {
  if (params.status === 'GAS_NOT_PRICEABLE') {
    return 'GAS_NOT_PRICEABLE';
  }
  if (params.status === 'QUOTE_FAILED') {
    return 'QUOTE_FAILED';
  }
  if (params.reason === 'POOL_MISSING') {
    return 'ROUTE_MISSING';
  }
  if (
    params.constraintReason === 'PROFITABILITY_FLOOR'
    || params.constraintReason === 'SLIPPAGE_FLOOR'
  ) {
    return 'POLICY_BLOCKED';
  }
  if (
    params.constraintReason === 'REQUIRED_OUTPUT'
    && params.exactOutputViabilityStatus === 'UNSATISFIABLE'
  ) {
    return 'LIQUIDITY_BLOCKED';
  }
  if (params.status === 'NOT_ROUTEABLE' && params.reason.includes('POOL')) {
    return 'ROUTE_MISSING';
  }
  if (params.status === 'CONSTRAINT_REJECTED' && params.quotedAmountOut !== undefined) {
    return 'POLICY_BLOCKED';
  }
  return 'UNKNOWN';
}

export function rejectedCandidateClassPriority(candidateClass: RejectedCandidateClass): number {
  if (candidateClass === 'POLICY_BLOCKED') return 0;
  if (candidateClass === 'LIQUIDITY_BLOCKED') return 1;
  if (candidateClass === 'GAS_NOT_PRICEABLE') return 2;
  if (candidateClass === 'QUOTE_FAILED') return 3;
  if (candidateClass === 'ROUTE_MISSING') return 4;
  return 5;
}
