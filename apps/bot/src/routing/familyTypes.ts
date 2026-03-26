import type { Address } from 'viem';
import type { RoutePathKind } from './pathTypes.js';
import type { HedgeVenue } from './venues.js';
import type { ExactOutputViabilityStatus } from './exactOutputTypes.js';
import type { RejectedCandidateClass } from './rejectedCandidateTypes.js';

export type RouteFamilyKind = 'DIRECT' | 'TWO_HOP';

export type FamilyDominanceReason =
  | 'NON_DIRECT'
  | 'ROUTEABLE'
  | 'EXACT_OUTPUT_SATISFIABLE'
  | 'NEAR_MISS'
  | 'POLICY_BLOCKED'
  | 'LIQUIDITY_BLOCKED'
  | 'QUOTE_FAILED'
  | 'INFRA_BLOCKED'
  | 'LOW_COVERAGE'
  | 'SHORTFALL';

const MAX_SHORTFALL_PENALTY = 25;

export type RouteFamily = {
  venue: HedgeVenue;
  familyKind: RouteFamilyKind;
  tokenIn: Address;
  tokenOut: Address;
  bridgeToken?: Address;
  feeTier?: number;
  secondFeeTier?: number;
  pathKind: RoutePathKind;
  hopCount: 1 | 2;
  pathDescriptor: string;
  discovery: 'DIRECT_FEE_TIER' | 'DIRECT_PAIR' | 'TWO_HOP_BRIDGE_FEE' | 'LFJ_DIRECT_BIN_STEP_VERSION' | 'LFJ_TWO_HOP_BRIDGE_BIN_STEP_VERSION';
  probePriority: number;
  familyKey: string;
};

export type RouteFamilyProbeResult = {
  family: RouteFamily;
  discoveryOk: boolean;
  quoteInputTried: boolean;
  quoteOutputTried: boolean;
  candidateCount: number;
  revertedProbeCount: number;
  blocked: boolean;
  blockedReason?: string;
};

export type DirectFamilyDominanceSignals = {
  pathKind?: RoutePathKind;
  status?: string;
  outputCoverageBps?: bigint;
  exactOutputStatus?: ExactOutputViabilityStatus;
  candidateClass?: RejectedCandidateClass;
  nearMiss?: boolean;
  requiredShortfallOut?: bigint;
};

export type DirectFamilyDominance = {
  dominanceScore: number;
  dominanceReason: FamilyDominanceReason;
};

export function computeDirectFamilyDominance(signals: DirectFamilyDominanceSignals): DirectFamilyDominance {
  if (signals.pathKind !== 'DIRECT') {
    return { dominanceScore: 0, dominanceReason: 'NON_DIRECT' };
  }

  const coverage = Number(signals.outputCoverageBps ?? 0n);
  const shortfall = Number(signals.requiredShortfallOut ?? 0n);
  const candidateClass = signals.candidateClass ?? 'UNKNOWN';
  const status = signals.status ?? 'NOT_ROUTEABLE';

  let score = 0;
  let reason: FamilyDominanceReason = 'SHORTFALL';

  if (status === 'ROUTEABLE') {
    score += 120;
    reason = 'ROUTEABLE';
  } else if (signals.exactOutputStatus === 'SATISFIABLE') {
    score += 95;
    reason = 'EXACT_OUTPUT_SATISFIABLE';
  } else if (signals.nearMiss) {
    score += 75;
    reason = 'NEAR_MISS';
  } else if (candidateClass === 'POLICY_BLOCKED') {
    score += 55;
    reason = 'POLICY_BLOCKED';
  } else if (candidateClass === 'LIQUIDITY_BLOCKED') {
    score += 45;
    reason = 'LIQUIDITY_BLOCKED';
  } else if (candidateClass === 'INFRA_BLOCKED') {
    score += 15;
    reason = 'INFRA_BLOCKED';
  } else if (candidateClass === 'QUOTE_FAILED') {
    score += 10;
    reason = 'QUOTE_FAILED';
  }

  if (coverage >= 10_000) {
    score += 25;
  } else if (coverage >= 9_900) {
    score += 20;
  } else if (coverage >= 9_700) {
    score += 10;
  } else if (coverage > 0) {
    score -= 5;
    if (reason === 'SHORTFALL') {
      reason = 'LOW_COVERAGE';
    }
  }

  if (shortfall > 0) {
    score -= Math.min(MAX_SHORTFALL_PENALTY, shortfall);
  }

  if (signals.exactOutputStatus === 'QUOTE_FAILED') {
    score -= 10;
  }

  return {
    dominanceScore: Math.max(0, score),
    dominanceReason: reason
  };
}
