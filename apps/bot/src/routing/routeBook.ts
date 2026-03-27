import type { RoutePlannerInput } from './univ3/types.js';
import type { UniV3RoutePlanner } from './univ3/routePlanner.js';
import type { CamelotAmmv3RoutePlanner } from './camelotV3/routePlanner.js';
import type { LfjLbRoutePlanner } from './lfjLb/routePlanner.js';
import type { HedgeRoutePlan, HedgeVenue, RouteCandidateSummary } from './venues.js';
import type { RejectedVenueRouteAttemptSummary, VenueRouteAttemptSummary } from './attemptTypes.js';
import type { ExactOutputViabilityStatus } from './exactOutputTypes.js';
import { ensureRejectedCandidateClass, rejectedCandidateClassPriority } from './rejectedCandidateTypes.js';
import { computeDirectFamilyDominance, type FamilyDominanceConfidence } from './familyTypes.js';

export type RouteBookSelection =
  | {
      ok: true;
      chosenRoute: HedgeRoutePlan;
      chosenSummary: VenueRouteAttemptSummary;
      venueAttempts: VenueRouteAttemptSummary[];
      alternativeRoutes: RouteCandidateSummary[];
    }
  | {
      ok: false;
      reason:
        | 'NOT_ROUTEABLE'
        | 'CONSTRAINT_REJECTED'
        | 'NOT_PROFITABLE'
        | 'QUOTE_FAILED'
        | 'QUOTE_REVERTED'
        | 'GAS_NOT_PRICEABLE'
        | 'RATE_LIMITED'
        | 'RPC_UNAVAILABLE'
        | 'RPC_FAILED';
      infraBlocked?: boolean;
      revertedProbeCount?: number;
      revertedProbeBudgetExhausted?: boolean;
      venueAttempts: VenueRouteAttemptSummary[];
      bestRejectedSummary?: VenueRouteAttemptSummary;
      alternativeRoutes: RouteCandidateSummary[];
    };

function venueTieBreak(a: HedgeVenue, b: HedgeVenue): number {
  if (a === b) {
    return 0;
  }
  const rank: Record<HedgeVenue, number> = {
    UNISWAP_V3: 0,
    CAMELOT_AMMV3: 1,
    LFJ_LB: 2
  };
  return rank[a] - rank[b];
}

function toSummary(route: HedgeRoutePlan): RouteCandidateSummary {
  const dominance = computeDirectFamilyDominance({
    pathKind: route.pathKind,
    status: 'ROUTEABLE',
    outputCoverageBps: route.requiredOutput > 0n ? (route.quotedAmountOut * 10_000n) / route.requiredOutput : 10_000n,
    exactOutputStatus: route.executionMode === 'EXACT_OUTPUT' ? 'SATISFIABLE' : 'NOT_CHECKED',
    nearMiss: false,
    requiredShortfallOut: 0n
  });
  return {
    venue: route.venue,
    executionMode: route.executionMode,
    familyKind: route.pathKind,
    probePriority: route.pathKind === 'DIRECT' ? 0 : 100,
    familyKey:
      route.pathKind === 'DIRECT'
        ? `${route.venue}:DIRECT:${route.tokenIn.toLowerCase()}:${route.tokenOut.toLowerCase()}`
        : `${route.venue}:TWO_HOP:${route.tokenIn.toLowerCase()}:${(route.bridgeToken ?? '').toLowerCase()}:${route.tokenOut.toLowerCase()}`,
    dominanceScore: dominance.dominanceScore,
    dominanceMargin: dominance.dominanceMargin,
    dominanceConfidence: dominance.dominanceConfidence,
    dominanceReason: dominance.dominanceReason,
    exactOutputPromotedFromFamily: route.executionMode === 'EXACT_OUTPUT',
    pathKind: route.pathKind,
    hopCount: route.hopCount,
    bridgeToken: route.bridgeToken,
    lfjPath: route.lfjPath,
    pathDescriptor:
      route.pathDescriptor
        ? route.pathDescriptor
        : route.pathKind === 'TWO_HOP' && route.bridgeToken
        ? `TWO_HOP: ${route.tokenIn} -> ${route.bridgeToken} -> ${route.tokenOut}`
        : `DIRECT: ${route.tokenIn} -> ${route.tokenOut}`,
    eligible: route.quotedAmountOut >= route.minAmountOut && route.netEdgeOut > 0n,
    quotedAmountOut: route.quotedAmountOut,
    requiredOutput: route.requiredOutput,
    minAmountOut: route.minAmountOut,
    netEdgeOut: route.netEdgeOut,
    gasCostOut: route.gasCostOut
  };
}

function deriveDominanceConfidence(
  route: HedgeRoutePlan,
  summary: RouteCandidateSummary | VenueRouteAttemptSummary | undefined,
  margin: number,
  minMargin: number
): FamilyDominanceConfidence {
  const candidateClass = summary?.candidateClass;
  const constraintReason = summary?.constraintReason;
  const nearMiss = summary?.constraintBreakdown?.nearMiss ?? summary?.hedgeGap?.nearMiss ?? false;
  const unsat = summary?.exactOutputViability?.status === 'UNSATISFIABLE';
  if (
    candidateClass === 'LIQUIDITY_BLOCKED'
    || constraintReason === 'REQUIRED_OUTPUT'
    || nearMiss
    || unsat
  ) {
    return margin >= minMargin ? 'MEDIUM' : 'LOW';
  }
  if (margin >= minMargin * 2) {
    return 'HIGH';
  }
  if (margin >= minMargin) {
    return 'MEDIUM';
  }
  return route.pathKind === 'DIRECT' ? 'MEDIUM' : 'LOW';
}

function isPoolMissingOrNotRouteable(attempt: VenueRouteAttemptSummary | undefined): boolean {
  if (!attempt) return false;
  return attempt.status === 'NOT_ROUTEABLE'
    || attempt.reason === 'POOL_MISSING'
    || attempt.reason === 'POOL_OR_QUOTE_UNAVAILABLE';
}

function isActionabilityRisk(summary: VenueRouteAttemptSummary | RouteCandidateSummary | undefined): boolean {
  if (!summary) return false;
  const nearMiss = summary.constraintBreakdown?.nearMiss ?? summary.hedgeGap?.nearMiss ?? false;
  return (summary.candidateClass === 'LIQUIDITY_BLOCKED'
    || summary.constraintReason === 'REQUIRED_OUTPUT'
    || nearMiss
    || summary.exactOutputViability?.status === 'UNSATISFIABLE');
}

type FamilyWinStats = {
  evaluated: number;
  bestRejected: number;
  chosen: number;
};

const MIN_EVALUATIONS_FOR_WIN_RATE_PENALTY = 3;
const WIN_RATE_PENALTY_SCALE_FACTOR = 100;

function familyStatsKey(summary: Pick<RouteCandidateSummary, 'venue' | 'familyKey' | 'familyKind' | 'pathKind'>): string {
  if (summary.familyKey) {
    return summary.familyKey;
  }
  return `${summary.venue}:${summary.familyKind ?? summary.pathKind ?? 'UNKNOWN'}`;
}

function winRatePenalty(
  statsMap: Map<string, FamilyWinStats>,
  summary: Pick<RouteCandidateSummary, 'venue' | 'familyKey' | 'familyKind' | 'pathKind'>
): number {
  const stats = statsMap.get(familyStatsKey(summary));
  if (!stats || stats.evaluated < MIN_EVALUATIONS_FOR_WIN_RATE_PENALTY) {
    return 0;
  }
  const winRate = stats.chosen / stats.evaluated;
  const bestRejectedRate = stats.bestRejected / stats.evaluated;
  return Math.max(0, Math.floor((bestRejectedRate - winRate) * WIN_RATE_PENALTY_SCALE_FACTOR));
}

function bumpFamilyStats(
  statsMap: Map<string, FamilyWinStats>,
  summary: Pick<RouteCandidateSummary, 'venue' | 'familyKey' | 'familyKind' | 'pathKind'>,
  field: keyof FamilyWinStats
): void {
  const key = familyStatsKey(summary);
  const current = statsMap.get(key) ?? { evaluated: 0, bestRejected: 0, chosen: 0 };
  current[field] += 1;
  statsMap.set(key, current);
}

function sumRequiredOutput(outputs: ReadonlyArray<{ amount: bigint }>): bigint {
  return outputs.reduce((sum, output) => sum + output.amount, 0n);
}

function ensureCandidateClass(summary: RejectedVenueRouteAttemptSummary | VenueRouteAttemptSummary): RejectedVenueRouteAttemptSummary {
  if (summary.status === 'ROUTEABLE') {
    throw new Error('routeBook ensureCandidateClass received ROUTEABLE summary');
  }
  return ensureRejectedCandidateClass(summary) as RejectedVenueRouteAttemptSummary;
}

function toCandidateFailureReason(summary: VenueRouteAttemptSummary): RouteCandidateSummary['reason'] {
  if (summary.status === 'NOT_PROFITABLE') {
    return 'NOT_PROFITABLE';
  }
  if (summary.status === 'CONSTRAINT_REJECTED') {
    return 'CONSTRAINT_REJECTED';
  }
  if (summary.status === 'QUOTE_FAILED') {
    return 'QUOTE_FAILED';
  }
  if (summary.status === 'QUOTE_REVERTED') {
    return 'QUOTE_REVERTED';
  }
  if (summary.status === 'RATE_LIMITED') {
    return 'RATE_LIMITED';
  }
  if (summary.status === 'RPC_UNAVAILABLE') {
    return 'RPC_UNAVAILABLE';
  }
  if (summary.status === 'RPC_FAILED') {
    return 'RPC_FAILED';
  }
  if (summary.status === 'GAS_NOT_PRICEABLE') {
    return 'NOT_PRICEABLE_GAS';
  }
  return 'NOT_ROUTEABLE';
}

function sortByBestEdge(routes: HedgeRoutePlan[]): HedgeRoutePlan[] {
  return [...routes].sort((a, b) => {
    if (a.netEdgeOut !== b.netEdgeOut) {
      return a.netEdgeOut > b.netEdgeOut ? -1 : 1;
    }
    if (a.quotedAmountOut !== b.quotedAmountOut) {
      return a.quotedAmountOut > b.quotedAmountOut ? -1 : 1;
    }
    if (a.gasCostOut !== b.gasCostOut) {
      return a.gasCostOut < b.gasCostOut ? -1 : 1;
    }
    if (a.executionMode !== b.executionMode) {
      return a.executionMode === 'EXACT_OUTPUT' ? -1 : 1;
    }
    return venueTieBreak(a.venue, b.venue);
  });
}

function routeFamilyKey(route: HedgeRoutePlan): string {
  return route.pathKind === 'DIRECT'
    ? `${route.venue}:DIRECT:${route.tokenIn.toLowerCase()}:${route.tokenOut.toLowerCase()}`
    : `${route.venue}:TWO_HOP:${route.tokenIn.toLowerCase()}:${(route.bridgeToken ?? '').toLowerCase()}:${route.tokenOut.toLowerCase()}`;
}

function exactOutputStatusRank(status: ExactOutputViabilityStatus | undefined): number {
  // REQUIRED_OUTPUT rejected-candidate ordering prioritizes known exact-output satisfiability
  // before output-side shortfall heuristics so cross-venue comparisons stay symmetric.
  if (status === 'SATISFIABLE') return 0;
  if (status === 'UNSATISFIABLE') return 1;
  if (status === 'QUOTE_FAILED') return 2;
  if (status === 'NOT_CHECKED') return 3;
  if (status === 'POOL_MISSING') return 4;
  return 5;
}

function isHugeGapNonNearMiss(summary: VenueRouteAttemptSummary): boolean {
  return summary.hedgeGap?.gapClass === 'HUGE'
    && !hasNearMiss(summary)
    && summary.constraintReason === 'REQUIRED_OUTPUT';
}

function hasNearMiss(summary: VenueRouteAttemptSummary): boolean {
  return summary.hedgeGap?.nearMiss ?? summary.constraintBreakdown?.nearMiss ?? false;
}

function isActionablePolicyBlocked(summary: VenueRouteAttemptSummary): boolean {
  return (summary.candidateClass ?? 'UNKNOWN') === 'POLICY_BLOCKED';
}

function hasInputDeficit(summary: VenueRouteAttemptSummary): bigint | undefined {
  return summary.hedgeGap?.inputDeficit ?? summary.exactOutputViability?.inputDeficit;
}

function hasOutputCoverageBps(summary: VenueRouteAttemptSummary): bigint | undefined {
  return summary.hedgeGap?.outputCoverageBps;
}

function hasRequiredShortfall(summary: VenueRouteAttemptSummary): bigint | undefined {
  return summary.hedgeGap?.requiredOutputShortfallOut ?? summary.constraintBreakdown?.requiredOutputShortfallOut;
}

function hasFloorShortfall(summary: VenueRouteAttemptSummary): bigint | undefined {
  return summary.constraintBreakdown?.minAmountOutShortfallOut ?? hasRequiredShortfall(summary);
}

function comparePolicyBlocked(a: VenueRouteAttemptSummary, b: VenueRouteAttemptSummary): number {
  const aNearMiss = hasNearMiss(a);
  const bNearMiss = hasNearMiss(b);
  if (aNearMiss !== bNearMiss) return aNearMiss ? -1 : 1;
  const aFloorShortfall = hasFloorShortfall(a);
  const bFloorShortfall = hasFloorShortfall(b);
  if (aFloorShortfall !== undefined && bFloorShortfall !== undefined && aFloorShortfall !== bFloorShortfall) {
    return aFloorShortfall < bFloorShortfall ? -1 : 1;
  }
  const aCoverage = hasOutputCoverageBps(a);
  const bCoverage = hasOutputCoverageBps(b);
  if (aCoverage !== undefined && bCoverage !== undefined && aCoverage !== bCoverage) {
    return aCoverage > bCoverage ? -1 : 1;
  }
  const aQuoted = a.quotedAmountOut ?? -1n;
  const bQuoted = b.quotedAmountOut ?? -1n;
  if (aQuoted !== bQuoted) return aQuoted > bQuoted ? -1 : 1;
  const aGasCostOut = a.constraintBreakdown?.gasCostOut ?? 0n;
  const bGasCostOut = b.constraintBreakdown?.gasCostOut ?? 0n;
  if (aGasCostOut !== bGasCostOut) return aGasCostOut < bGasCostOut ? -1 : 1;
  return 0;
}

function compareLiquidityBlocked(a: VenueRouteAttemptSummary, b: VenueRouteAttemptSummary): number {
  const aInputDeficit = hasInputDeficit(a);
  const bInputDeficit = hasInputDeficit(b);
  if (aInputDeficit !== undefined && bInputDeficit !== undefined && aInputDeficit !== bInputDeficit) {
    return aInputDeficit < bInputDeficit ? -1 : 1;
  }
  if ((aInputDeficit !== undefined) !== (bInputDeficit !== undefined)) {
    return aInputDeficit !== undefined ? -1 : 1;
  }
  const aCoverage = hasOutputCoverageBps(a);
  const bCoverage = hasOutputCoverageBps(b);
  if (aCoverage !== undefined && bCoverage !== undefined && aCoverage !== bCoverage) {
    return aCoverage > bCoverage ? -1 : 1;
  }
  const aRequiredShortfall = hasRequiredShortfall(a);
  const bRequiredShortfall = hasRequiredShortfall(b);
  if (aRequiredShortfall !== undefined && bRequiredShortfall !== undefined && aRequiredShortfall !== bRequiredShortfall) {
    return aRequiredShortfall < bRequiredShortfall ? -1 : 1;
  }
  const aQuoted = a.quotedAmountOut ?? -1n;
  const bQuoted = b.quotedAmountOut ?? -1n;
  if (aQuoted !== bQuoted) return aQuoted > bQuoted ? -1 : 1;
  return 0;
}

function rejectedCandidateSort(a: VenueRouteAttemptSummary, b: VenueRouteAttemptSummary): number {
  const aClass = a.candidateClass ?? 'UNKNOWN';
  const bClass = b.candidateClass ?? 'UNKNOWN';
  const aClassPriority = rejectedCandidateClassPriority(aClass);
  const bClassPriority = rejectedCandidateClassPriority(bClass);

  const aDisfavored = aClass === 'QUOTE_FAILED' || isHugeGapNonNearMiss(a);
  const bDisfavored = bClass === 'QUOTE_FAILED' || isHugeGapNonNearMiss(b);
  const aActionable = isActionablePolicyBlocked(a) || aClass === 'LIQUIDITY_BLOCKED';
  const bActionable = isActionablePolicyBlocked(b) || bClass === 'LIQUIDITY_BLOCKED';
  if (aActionable !== bActionable) {
    return aActionable ? -1 : 1;
  }
  if (aDisfavored !== bDisfavored) {
    return aDisfavored ? 1 : -1;
  }

  if (aClassPriority !== bClassPriority) {
    return aClassPriority - bClassPriority;
  }

  if (aClass === 'POLICY_BLOCKED' && bClass === 'POLICY_BLOCKED') {
    const comparison = comparePolicyBlocked(a, b);
    if (comparison !== 0) return comparison;
  }

  if (aClass === 'LIQUIDITY_BLOCKED' && bClass === 'LIQUIDITY_BLOCKED') {
    const comparison = compareLiquidityBlocked(a, b);
    if (comparison !== 0) return comparison;
  }

  const aHasQuote = a.quotedAmountOut !== undefined;
  const bHasQuote = b.quotedAmountOut !== undefined;
  if (aHasQuote !== bHasQuote) {
    return aHasQuote ? -1 : 1;
  }

  const aRequiredOutput = a.constraintReason === 'REQUIRED_OUTPUT';
  const bRequiredOutput = b.constraintReason === 'REQUIRED_OUTPUT';
  if (aRequiredOutput && bRequiredOutput) {
    const aNearMiss = a.constraintBreakdown?.nearMiss ?? false;
    const bNearMiss = b.constraintBreakdown?.nearMiss ?? false;
    if (aNearMiss !== bNearMiss) {
      return aNearMiss ? -1 : 1;
    }
    const aStatusRank = exactOutputStatusRank(a.exactOutputViability?.status);
    const bStatusRank = exactOutputStatusRank(b.exactOutputViability?.status);
    if (aStatusRank !== bStatusRank) {
      return aStatusRank - bStatusRank;
    }
    const aFloorShortfall = hasFloorShortfall(a);
    const bFloorShortfall = hasFloorShortfall(b);
    if (aFloorShortfall !== undefined && bFloorShortfall !== undefined && aFloorShortfall !== bFloorShortfall) {
      return aFloorShortfall < bFloorShortfall ? -1 : 1;
    }

    const aInputDeficit = hasInputDeficit(a);
    const bInputDeficit = hasInputDeficit(b);
    if (aInputDeficit !== undefined && bInputDeficit !== undefined && aInputDeficit !== bInputDeficit) {
      return aInputDeficit < bInputDeficit ? -1 : 1;
    }
    if ((aInputDeficit !== undefined) !== (bInputDeficit !== undefined)) {
      return aInputDeficit !== undefined ? -1 : 1;
    }

    const aCoverage = hasOutputCoverageBps(a);
    const bCoverage = hasOutputCoverageBps(b);
    if (aCoverage !== undefined && bCoverage !== undefined && aCoverage !== bCoverage) {
      return aCoverage > bCoverage ? -1 : 1;
    }

    const aRequiredShortfall = hasRequiredShortfall(a);
    const bRequiredShortfall = hasRequiredShortfall(b);
    if (aRequiredShortfall !== undefined && bRequiredShortfall !== undefined && aRequiredShortfall !== bRequiredShortfall) {
      return aRequiredShortfall < bRequiredShortfall ? -1 : 1;
    }

    const aQuoted = a.quotedAmountOut ?? -1n;
    const bQuoted = b.quotedAmountOut ?? -1n;
    if (aQuoted !== bQuoted) {
      return aQuoted > bQuoted ? -1 : 1;
    }
    const aGasCostOut = a.constraintBreakdown?.gasCostOut ?? 0n;
    const bGasCostOut = b.constraintBreakdown?.gasCostOut ?? 0n;
    if (aGasCostOut !== bGasCostOut) {
      return aGasCostOut < bGasCostOut ? -1 : 1;
    }
  }

  const aEdge = a.netEdgeOut ?? -1n;
  const bEdge = b.netEdgeOut ?? -1n;
  if (aEdge !== bEdge) {
    return aEdge > bEdge ? -1 : 1;
  }
  return venueTieBreak(a.venue, b.venue);
}

export class RouteBook {
  private readonly familyWinStats = new Map<string, FamilyWinStats>();

  constructor(
    private readonly planners: {
      uniswapV3: UniV3RoutePlanner;
      camelotAmmv3?: CamelotAmmv3RoutePlanner;
      lfjLb?: LfjLbRoutePlanner;
      enableCamelotAmmv3: boolean;
      enableLfjLb?: boolean;
      maxExtraFamiliesAfterDominantDirect?: number;
      dominanceMinScoreMargin?: number;
      maxExtraSameVenueChallengersAfterOtherVenuesMissing?: number;
      maxRevertedProbesPerOrder?: number;
      onRouteEvalFamilyDominant?: (venue: HedgeVenue, pathKind: 'DIRECT' | 'TWO_HOP') => void;
      onRouteEvalFamilyDemoted?: (venue: HedgeVenue, pathKind: 'DIRECT' | 'TWO_HOP') => void;
      onRouteEvalFamilyBestRejected?: (venue: HedgeVenue, pathKind: 'DIRECT' | 'TWO_HOP') => void;
      onRouteEvalFamilyProvisionalWinner?: (
        venue: HedgeVenue,
        pathKind: 'DIRECT' | 'TWO_HOP',
        executionMode: 'EXACT_INPUT' | 'EXACT_OUTPUT'
      ) => void;
      onRouteEvalFamilyChosen?: (
        venue: HedgeVenue,
        pathKind: 'DIRECT' | 'TWO_HOP',
        executionMode: 'EXACT_INPUT' | 'EXACT_OUTPUT'
      ) => void;
      onRouteEvalFamilyFalseDominant?: (
        venue: HedgeVenue,
        pathKind: 'DIRECT' | 'TWO_HOP',
        executionMode: 'EXACT_INPUT' | 'EXACT_OUTPUT'
      ) => void;
      onRouteEvalFamilyDominanceMargin?: (
        venue: HedgeVenue,
        pathKind: 'DIRECT' | 'TWO_HOP',
        margin: number
      ) => void;
      onRouteEvalFamilyRegistrySize?: (size: number) => void;
    }
  ) {}

  async selectBestRoute(input: RoutePlannerInput): Promise<RouteBookSelection> {
    const [uniswapResult, camelotResult, lfjResult] = await Promise.all([
      this.planners.uniswapV3.planBestRoute(input),
      this.planners.enableCamelotAmmv3 && this.planners.camelotAmmv3
        ? this.planners.camelotAmmv3.planBestRoute(input)
        : Promise.resolve(undefined),
      (this.planners.enableLfjLb ?? false) && this.planners.lfjLb
        ? this.planners.lfjLb.planBestRoute(input)
        : Promise.resolve(undefined)
    ]);

    const alternatives: RouteCandidateSummary[] = [];
    const venueAttempts: VenueRouteAttemptSummary[] = [];
    const eligible: HedgeRoutePlan[] = [];

    if (uniswapResult.ok) {
      const summary = toSummary(uniswapResult.route);
      alternatives.push(summary);
      venueAttempts.push(uniswapResult.summary);
      if (summary.eligible) {
        eligible.push(uniswapResult.route);
      }
    } else {
      const failureSummary = ensureCandidateClass(uniswapResult.failure.summary as RejectedVenueRouteAttemptSummary);
      const dominance = computeDirectFamilyDominance({
        pathKind: failureSummary.pathKind,
        status: failureSummary.status,
        outputCoverageBps: failureSummary.hedgeGap?.outputCoverageBps,
        exactOutputStatus: failureSummary.exactOutputViability?.status,
        candidateClass: failureSummary.candidateClass,
        nearMiss: failureSummary.constraintBreakdown?.nearMiss ?? failureSummary.hedgeGap?.nearMiss,
        requiredShortfallOut: failureSummary.hedgeGap?.requiredOutputShortfallOut ?? failureSummary.constraintBreakdown?.requiredOutputShortfallOut
      });
      venueAttempts.push(failureSummary);
        alternatives.push({
          venue: 'UNISWAP_V3',
          eligible: false,
          familyKind: failureSummary.familyKind,
          probePriority: failureSummary.probePriority,
          familyKey: failureSummary.familyKey,
          dominanceScore: failureSummary.dominanceScore ?? dominance.dominanceScore,
          dominanceMargin: failureSummary.dominanceMargin ?? dominance.dominanceMargin,
          dominanceConfidence: failureSummary.dominanceConfidence ?? dominance.dominanceConfidence,
          dominanceReason: failureSummary.dominanceReason ?? dominance.dominanceReason,
          exactOutputPromotedFromFamily: failureSummary.exactOutputPromotedFromFamily,
          pathKind: failureSummary.pathKind,
        hopCount: failureSummary.hopCount,
          bridgeToken: failureSummary.bridgeToken,
          lfjPath: failureSummary.lfjPath,
          pathDescriptor: failureSummary.pathDescriptor,
          candidateClass: failureSummary.candidateClass,
          constraintReason: failureSummary.constraintReason,
          constraintBreakdown: failureSummary.constraintBreakdown,
          exactOutputViability: failureSummary.exactOutputViability,
          hedgeGap: failureSummary.hedgeGap,
          reason: toCandidateFailureReason(failureSummary),
          details: failureSummary.reason
        });
    }

    if (camelotResult) {
      if (camelotResult.ok) {
        const summary = toSummary(camelotResult.route);
        alternatives.push(summary);
        venueAttempts.push(camelotResult.summary);
        if (summary.eligible) {
          eligible.push(camelotResult.route);
        }
      } else {
        const failureSummary = ensureCandidateClass(camelotResult.failure.summary as RejectedVenueRouteAttemptSummary);
        const dominance = computeDirectFamilyDominance({
          pathKind: failureSummary.pathKind,
          status: failureSummary.status,
          outputCoverageBps: failureSummary.hedgeGap?.outputCoverageBps,
          exactOutputStatus: failureSummary.exactOutputViability?.status,
          candidateClass: failureSummary.candidateClass,
          nearMiss: failureSummary.constraintBreakdown?.nearMiss ?? failureSummary.hedgeGap?.nearMiss,
          requiredShortfallOut: failureSummary.hedgeGap?.requiredOutputShortfallOut ?? failureSummary.constraintBreakdown?.requiredOutputShortfallOut
        });
        venueAttempts.push(failureSummary);
        alternatives.push({
          venue: 'CAMELOT_AMMV3',
          eligible: false,
          familyKind: failureSummary.familyKind,
          probePriority: failureSummary.probePriority,
          familyKey: failureSummary.familyKey,
          dominanceScore: failureSummary.dominanceScore ?? dominance.dominanceScore,
          dominanceMargin: failureSummary.dominanceMargin ?? dominance.dominanceMargin,
          dominanceConfidence: failureSummary.dominanceConfidence ?? dominance.dominanceConfidence,
          dominanceReason: failureSummary.dominanceReason ?? dominance.dominanceReason,
          exactOutputPromotedFromFamily: failureSummary.exactOutputPromotedFromFamily,
          pathKind: failureSummary.pathKind,
          hopCount: failureSummary.hopCount,
          bridgeToken: failureSummary.bridgeToken,
          lfjPath: failureSummary.lfjPath,
          pathDescriptor: failureSummary.pathDescriptor,
          candidateClass: failureSummary.candidateClass,
          constraintReason: failureSummary.constraintReason,
          constraintBreakdown: failureSummary.constraintBreakdown,
          exactOutputViability: failureSummary.exactOutputViability,
          hedgeGap: failureSummary.hedgeGap,
          reason: toCandidateFailureReason(failureSummary),
          details: failureSummary.reason
        });
      }
    } else if (!this.planners.enableCamelotAmmv3) {
      const requiredOutput = sumRequiredOutput(input.resolvedOrder.outputs as ReadonlyArray<{ amount: bigint }>);
      venueAttempts.push({
        venue: 'CAMELOT_AMMV3',
        status: 'NOT_ROUTEABLE',
        reason: 'CAMELOT_DISABLED',
        candidateClass: ensureRejectedCandidateClass({
          venue: 'CAMELOT_AMMV3',
          status: 'NOT_ROUTEABLE',
          reason: 'CAMELOT_DISABLED'
        }).candidateClass,
        exactOutputViability: {
          status: 'NOT_CHECKED',
          targetOutput: requiredOutput,
          requiredInputForTargetOutput: input.resolvedOrder.input.amount,
          availableInput: input.resolvedOrder.input.amount,
          reason: 'camelot disabled'
        }
      });
      alternatives.push({
        venue: 'CAMELOT_AMMV3',
        eligible: false,
        reason: 'CAMELOT_DISABLED'
      });
    }

    if (lfjResult) {
      if (lfjResult.ok) {
        const summary = toSummary(lfjResult.route);
        alternatives.push(summary);
        venueAttempts.push(lfjResult.summary);
        if (summary.eligible) {
          eligible.push(lfjResult.route);
        }
      } else {
        const failureSummary = ensureCandidateClass(lfjResult.failure.summary as RejectedVenueRouteAttemptSummary);
        const dominance = computeDirectFamilyDominance({
          pathKind: failureSummary.pathKind,
          status: failureSummary.status,
          outputCoverageBps: failureSummary.hedgeGap?.outputCoverageBps,
          exactOutputStatus: failureSummary.exactOutputViability?.status,
          candidateClass: failureSummary.candidateClass,
          nearMiss: failureSummary.constraintBreakdown?.nearMiss ?? failureSummary.hedgeGap?.nearMiss,
          requiredShortfallOut: failureSummary.hedgeGap?.requiredOutputShortfallOut ?? failureSummary.constraintBreakdown?.requiredOutputShortfallOut
        });
        venueAttempts.push(failureSummary);
        alternatives.push({
          venue: 'LFJ_LB',
          eligible: false,
          familyKind: failureSummary.familyKind,
          probePriority: failureSummary.probePriority,
          familyKey: failureSummary.familyKey,
          dominanceScore: failureSummary.dominanceScore ?? dominance.dominanceScore,
          dominanceMargin: failureSummary.dominanceMargin ?? dominance.dominanceMargin,
          dominanceConfidence: failureSummary.dominanceConfidence ?? dominance.dominanceConfidence,
          dominanceReason: failureSummary.dominanceReason ?? dominance.dominanceReason,
          exactOutputPromotedFromFamily: failureSummary.exactOutputPromotedFromFamily,
          pathKind: failureSummary.pathKind,
          hopCount: failureSummary.hopCount,
          bridgeToken: failureSummary.bridgeToken,
          lfjPath: failureSummary.lfjPath,
          pathDescriptor: failureSummary.pathDescriptor,
          candidateClass: failureSummary.candidateClass,
          constraintReason: failureSummary.constraintReason,
          constraintBreakdown: failureSummary.constraintBreakdown,
          exactOutputViability: failureSummary.exactOutputViability,
          hedgeGap: failureSummary.hedgeGap,
          reason: toCandidateFailureReason(failureSummary),
          details: failureSummary.reason
        });
      }
    }

    if (eligible.length === 0) {
      const revertedProbeCount = venueAttempts.reduce((sum, attempt) => {
        const tierAttempts = attempt.feeTierAttempts ?? [];
        if (tierAttempts.length > 0) {
          return sum + tierAttempts.filter((tier) => tier.status === 'QUOTE_REVERTED').length;
        }
        return sum + (attempt.status === 'QUOTE_REVERTED' ? 1 : 0);
      }, 0);
      const revertedProbeBudget = this.planners.maxRevertedProbesPerOrder ?? Number.MAX_SAFE_INTEGER;
      const revertedProbeBudgetExhausted = revertedProbeCount > revertedProbeBudget;
      const rejectedCandidates = venueAttempts
        .filter((attempt): attempt is RejectedVenueRouteAttemptSummary => attempt.status !== 'ROUTEABLE')
        .map((attempt) => ensureCandidateClass(attempt));
      const bestRejectedSummary = [...rejectedCandidates].sort(rejectedCandidateSort)[0];
      const bestRejectedWithClass = bestRejectedSummary
        ? {
            ...bestRejectedSummary,
            candidateClass: ensureCandidateClass(bestRejectedSummary).candidateClass
          }
        : undefined;
      if (bestRejectedWithClass) {
        this.planners.onRouteEvalFamilyBestRejected?.(
          bestRejectedWithClass.venue,
          bestRejectedWithClass.pathKind ?? 'DIRECT'
        );
        bumpFamilyStats(
          this.familyWinStats,
          {
            venue: bestRejectedWithClass.venue,
            familyKey: bestRejectedWithClass.familyKey,
            familyKind: bestRejectedWithClass.familyKind,
            pathKind: bestRejectedWithClass.pathKind
          },
          'bestRejected'
        );
      }
      const statuses = venueAttempts.map((attempt) => attempt.status);
      const allNotRouteableOrQuoteFailed = statuses.every(
        (status) =>
          status === 'NOT_ROUTEABLE'
          || status === 'QUOTE_FAILED'
          || status === 'QUOTE_REVERTED'
          || status === 'RATE_LIMITED'
          || status === 'RPC_UNAVAILABLE'
          || status === 'RPC_FAILED'
      );
      const hasQuoteReverted = statuses.includes('QUOTE_REVERTED');
      const hasRateLimited = statuses.includes('RATE_LIMITED');
      const hasRpcUnavailable = statuses.includes('RPC_UNAVAILABLE');
      const hasRpcFailed = statuses.includes('RPC_FAILED');
      const hasGasNotPriceable = statuses.includes('GAS_NOT_PRICEABLE');
      const blockedCount = statuses.filter(
        (status) =>
          status === 'RATE_LIMITED'
          || status === 'RPC_UNAVAILABLE'
          || status === 'RPC_FAILED'
          || status === 'QUOTE_REVERTED'
      ).length;
      const reason:
        | 'NOT_ROUTEABLE'
        | 'CONSTRAINT_REJECTED'
        | 'NOT_PROFITABLE'
        | 'QUOTE_FAILED'
        | 'QUOTE_REVERTED'
        | 'GAS_NOT_PRICEABLE'
        | 'RATE_LIMITED'
        | 'RPC_UNAVAILABLE'
        | 'RPC_FAILED' =
        revertedProbeBudgetExhausted
          ? 'QUOTE_REVERTED'
          : allNotRouteableOrQuoteFailed
          ? hasRateLimited
            ? 'RATE_LIMITED'
            : hasRpcUnavailable
              ? 'RPC_UNAVAILABLE'
              : hasRpcFailed
                ? 'RPC_FAILED'
                : hasQuoteReverted
                  ? 'QUOTE_REVERTED'
                : statuses.includes('QUOTE_FAILED') && !statuses.includes('NOT_ROUTEABLE')
                  ? 'QUOTE_FAILED'
                  : 'NOT_ROUTEABLE'
          : bestRejectedWithClass?.status === 'CONSTRAINT_REJECTED'
            ? 'CONSTRAINT_REJECTED'
            : bestRejectedWithClass?.status === 'NOT_PROFITABLE'
              ? 'NOT_PROFITABLE'
              : bestRejectedWithClass?.status === 'RATE_LIMITED'
                ? 'RATE_LIMITED'
                : bestRejectedWithClass?.status === 'RPC_UNAVAILABLE'
                  ? 'RPC_UNAVAILABLE'
                  : bestRejectedWithClass?.status === 'RPC_FAILED'
                    ? 'RPC_FAILED'
                    : bestRejectedWithClass?.status === 'QUOTE_REVERTED'
                      ? 'QUOTE_REVERTED'
                    : hasGasNotPriceable
                      ? 'GAS_NOT_PRICEABLE'
                      : 'NOT_ROUTEABLE';
      return {
        ok: false,
        reason,
        infraBlocked:
          reason === 'RATE_LIMITED'
          || reason === 'RPC_UNAVAILABLE'
          || reason === 'RPC_FAILED'
          || reason === 'QUOTE_REVERTED'
          || revertedProbeBudgetExhausted
          || blockedCount >= Math.max(1, Math.floor(venueAttempts.length / 2)),
        revertedProbeCount,
        revertedProbeBudgetExhausted,
        venueAttempts,
        bestRejectedSummary: bestRejectedWithClass,
        alternativeRoutes: alternatives
      };
    }

    const familyBest = new Map<string, HedgeRoutePlan>();
    for (const route of sortByBestEdge(eligible)) {
      const key = routeFamilyKey(route);
      if (!familyBest.has(key)) {
        familyBest.set(key, route);
      }
    }
    this.planners.onRouteEvalFamilyRegistrySize?.(familyBest.size);
    const candidates = [...familyBest.values()];
    for (const route of candidates) {
      bumpFamilyStats(
        this.familyWinStats,
        {
          venue: route.venue,
          familyKey: routeFamilyKey(route),
          familyKind: route.pathKind,
          pathKind: route.pathKind
        },
        'evaluated'
      );
    }
    const withDominance = candidates.map((route) => {
      const summary = toSummary(route);
      return {
        route,
        summary,
        score: (summary.dominanceScore ?? 0) - winRatePenalty(this.familyWinStats, summary)
      };
    });
    withDominance.sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      const sorted = sortByBestEdge([a.route, b.route]);
      return sorted[0] === a.route ? -1 : 1;
    });
    const dominantDirect = withDominance.find((entry) => entry.route.pathKind === 'DIRECT');
    const nextBest = withDominance.find((entry) => entry !== dominantDirect);
    const dominanceMargin = dominantDirect ? Math.max(0, dominantDirect.score - (nextBest?.score ?? 0)) : 0;
    const dominanceMinScoreMargin = this.planners.dominanceMinScoreMargin ?? 10;
    if (dominantDirect) {
      dominantDirect.summary.dominanceMargin = dominanceMargin;
      dominantDirect.summary.dominanceConfidence = deriveDominanceConfidence(
        dominantDirect.route,
        venueAttempts.find((attempt) => attempt.venue === dominantDirect.route.venue),
        dominanceMargin,
        dominanceMinScoreMargin
      );
      this.planners.onRouteEvalFamilyDominanceMargin?.(
        dominantDirect.route.venue,
        dominantDirect.route.pathKind,
        dominanceMargin
      );
    }
    const maxExtraFamilies = this.planners.maxExtraFamiliesAfterDominantDirect ?? 1;
    const dominantTrusted = dominantDirect
      && dominanceMargin >= dominanceMinScoreMargin
      && dominantDirect.summary.dominanceConfidence !== 'LOW';
    let filtered = dominantTrusted
      ? [
          dominantDirect,
          ...withDominance
            .filter((entry) => entry !== dominantDirect)
            .slice(0, maxExtraFamilies)
        ]
      : withDominance;
    if (dominantDirect) {
      const dominantAttempt = venueAttempts.find(
        (attempt) => attempt.venue === dominantDirect.route.venue && (attempt.pathKind ?? dominantDirect.route.pathKind) === dominantDirect.route.pathKind
      );
      const retainChallengers = isActionabilityRisk(dominantAttempt);
      if (retainChallengers) {
        const sameVenueDifferentPath = withDominance.find(
          (entry) =>
            entry !== dominantDirect
            && entry.route.venue === dominantDirect.route.venue
            && entry.route.pathKind !== dominantDirect.route.pathKind
        );
        const bestCamelotDirect = withDominance.find(
          (entry) => entry !== dominantDirect && entry.route.venue === 'CAMELOT_AMMV3' && entry.route.pathKind === 'DIRECT'
        );
        const bestLfjDirect = withDominance.find(
          (entry) => entry !== dominantDirect && entry.route.venue === 'LFJ_LB' && entry.route.pathKind === 'DIRECT'
        );
        for (const candidate of [sameVenueDifferentPath, bestCamelotDirect, bestLfjDirect]) {
          if (candidate && !filtered.includes(candidate)) {
            filtered.push(candidate);
          }
        }
      }

      const nonDominantAttempts = venueAttempts.filter((attempt) => attempt.venue !== dominantDirect.route.venue);
      const allOtherVenuesMissing = nonDominantAttempts.length > 0 && nonDominantAttempts.every((attempt) => isPoolMissingOrNotRouteable(attempt));
      if (allOtherVenuesMissing) {
        const extraSameVenue = this.planners.maxExtraSameVenueChallengersAfterOtherVenuesMissing ?? 2;
        const sameVenueCandidates = withDominance
          .filter((entry) => entry !== dominantDirect && entry.route.venue === dominantDirect.route.venue)
          .slice(0, extraSameVenue);
        for (const candidate of sameVenueCandidates) {
          if (!filtered.includes(candidate)) {
            filtered.push(candidate);
          }
        }
      }
    }
    if (dominantTrusted && dominantDirect) {
      this.planners.onRouteEvalFamilyDominant?.(dominantDirect.route.venue, dominantDirect.route.pathKind);
      withDominance
        .filter((entry) => !filtered.includes(entry))
        .forEach((entry) => this.planners.onRouteEvalFamilyDemoted?.(entry.route.venue, entry.route.pathKind));
    }
    const provisional = filtered[0]?.route ?? dominantDirect?.route ?? withDominance[0]!.route;
    this.planners.onRouteEvalFamilyProvisionalWinner?.(
      provisional.venue,
      provisional.pathKind,
      (provisional.executionMode ?? 'EXACT_INPUT') as
        | 'EXACT_INPUT'
        | 'EXACT_OUTPUT'
    );
    const [chosenRoute, ...otherRoutes] = sortByBestEdge(filtered.map((entry) => entry.route));
    bumpFamilyStats(
      this.familyWinStats,
      {
        venue: chosenRoute.venue,
        familyKey: routeFamilyKey(chosenRoute),
        familyKind: chosenRoute.pathKind,
        pathKind: chosenRoute.pathKind
      },
      'chosen'
    );
    const alternativeRoutes = alternatives.map((candidate) => {
      if (candidate.venue === chosenRoute.venue && candidate.eligible) {
        return candidate;
      }
      const beatenByTieBreak =
        otherRoutes.find((route) => route.venue === candidate.venue) !== undefined
          && candidate.netEdgeOut === chosenRoute.netEdgeOut
          && candidate.quotedAmountOut === chosenRoute.quotedAmountOut
          && candidate.gasCostOut === chosenRoute.gasCostOut;
      if (candidate.eligible && !candidate.reason) {
        const reason: 'BEAT_BY_HIGHER_NET_EDGE' | 'BEAT_BY_TIE_BREAK'
          = beatenByTieBreak ? 'BEAT_BY_TIE_BREAK' : 'BEAT_BY_HIGHER_NET_EDGE';
        return {
          ...candidate,
          reason
        };
      }
      return candidate;
    });

    const chosenSummary = venueAttempts.find((summary) => summary.venue === chosenRoute.venue) ?? {
      venue: chosenRoute.venue,
      executionMode: chosenRoute.executionMode,
      pathKind: chosenRoute.pathKind,
      hopCount: chosenRoute.hopCount,
      bridgeToken: chosenRoute.bridgeToken,
      familyKind: chosenRoute.pathKind,
      probePriority: chosenRoute.pathKind === 'DIRECT' ? 0 : 100,
      familyKey: routeFamilyKey(chosenRoute),
      dominanceScore: toSummary(chosenRoute).dominanceScore,
      dominanceMargin: toSummary(chosenRoute).dominanceMargin,
      dominanceConfidence: toSummary(chosenRoute).dominanceConfidence,
      dominanceReason: toSummary(chosenRoute).dominanceReason,
      status: 'ROUTEABLE',
      reason: 'ROUTEABLE',
      quotedAmountOut: chosenRoute.quotedAmountOut,
      minAmountOut: chosenRoute.minAmountOut,
      grossEdgeOut: chosenRoute.grossEdgeOut,
      netEdgeOut: chosenRoute.netEdgeOut
    };
    return {
      ok: true,
      chosenRoute,
      chosenSummary,
      venueAttempts,
      alternativeRoutes
    };
  }
}
