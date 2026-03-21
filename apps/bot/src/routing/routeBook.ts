import type { RoutePlannerInput } from './univ3/types.js';
import type { UniV3RoutePlanner } from './univ3/routePlanner.js';
import type { CamelotAmmv3RoutePlanner } from './camelotV3/routePlanner.js';
import type { HedgeRoutePlan, HedgeVenue, RouteCandidateSummary } from './venues.js';
import type { VenueRouteAttemptSummary } from './attemptTypes.js';
import type { ExactOutputViabilityStatus } from './exactOutputTypes.js';
import { deriveRejectedCandidateClass, rejectedCandidateClassPriority } from './rejectedCandidateTypes.js';

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
      reason: 'NOT_ROUTEABLE' | 'CONSTRAINT_REJECTED' | 'NOT_PROFITABLE' | 'QUOTE_FAILED' | 'GAS_NOT_PRICEABLE';
      venueAttempts: VenueRouteAttemptSummary[];
      bestRejectedSummary?: VenueRouteAttemptSummary;
      alternativeRoutes: RouteCandidateSummary[];
    };

function venueTieBreak(a: HedgeVenue, b: HedgeVenue): number {
  if (a === b) {
    return 0;
  }
  return a === 'UNISWAP_V3' ? -1 : 1;
}

function toSummary(route: HedgeRoutePlan): RouteCandidateSummary {
  return {
    venue: route.venue,
    pathKind: route.pathKind,
    hopCount: route.hopCount,
    bridgeToken: route.bridgeToken,
    pathDescriptor:
      route.pathKind === 'TWO_HOP' && route.bridgeToken
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

function sumRequiredOutput(outputs: ReadonlyArray<{ amount: bigint }>): bigint {
  return outputs.reduce((sum, output) => sum + output.amount, 0n);
}

function ensureCandidateClass(summary: VenueRouteAttemptSummary): VenueRouteAttemptSummary {
  if (summary.status === 'ROUTEABLE' || summary.candidateClass) {
    return summary;
  }
  return {
    ...summary,
    candidateClass: deriveRejectedCandidateClass(summary)
  };
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
    return venueTieBreak(a.venue, b.venue);
  });
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
    && !(summary.hedgeGap?.nearMiss ?? summary.constraintBreakdown?.nearMiss ?? false)
    && summary.constraintReason === 'REQUIRED_OUTPUT';
}

function isActionablePolicyBlocked(summary: VenueRouteAttemptSummary): boolean {
  return (summary.candidateClass ?? 'UNKNOWN') === 'POLICY_BLOCKED'
    && (summary.constraintBreakdown?.nearMiss ?? summary.hedgeGap?.nearMiss ?? false);
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
  const aNearMiss = a.constraintBreakdown?.nearMiss ?? a.hedgeGap?.nearMiss ?? false;
  const bNearMiss = b.constraintBreakdown?.nearMiss ?? b.hedgeGap?.nearMiss ?? false;
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
  const aClassPriority = rejectedCandidateClassPriority(a.candidateClass ?? 'UNKNOWN');
  const bClassPriority = rejectedCandidateClassPriority(b.candidateClass ?? 'UNKNOWN');

  const aDisfavored = (a.candidateClass ?? 'UNKNOWN') === 'QUOTE_FAILED' || isHugeGapNonNearMiss(a);
  const bDisfavored = (b.candidateClass ?? 'UNKNOWN') === 'QUOTE_FAILED' || isHugeGapNonNearMiss(b);
  const aActionable = isActionablePolicyBlocked(a) || (a.candidateClass ?? 'UNKNOWN') === 'LIQUIDITY_BLOCKED';
  const bActionable = isActionablePolicyBlocked(b) || (b.candidateClass ?? 'UNKNOWN') === 'LIQUIDITY_BLOCKED';
  if (aActionable !== bActionable) {
    return aActionable ? -1 : 1;
  }
  if (aDisfavored !== bDisfavored) {
    return aDisfavored ? 1 : -1;
  }

  if (aClassPriority !== bClassPriority) {
    return aClassPriority - bClassPriority;
  }

  if ((a.candidateClass ?? 'UNKNOWN') === 'POLICY_BLOCKED' && (b.candidateClass ?? 'UNKNOWN') === 'POLICY_BLOCKED') {
    const comparison = comparePolicyBlocked(a, b);
    if (comparison !== 0) return comparison;
  }

  if ((a.candidateClass ?? 'UNKNOWN') === 'LIQUIDITY_BLOCKED' && (b.candidateClass ?? 'UNKNOWN') === 'LIQUIDITY_BLOCKED') {
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
  constructor(
    private readonly planners: {
      uniswapV3: UniV3RoutePlanner;
      camelotAmmv3?: CamelotAmmv3RoutePlanner;
      enableCamelotAmmv3: boolean;
    }
  ) {}

  async selectBestRoute(input: RoutePlannerInput): Promise<RouteBookSelection> {
    const [uniswapResult, camelotResult] = await Promise.all([
      this.planners.uniswapV3.planBestRoute(input),
      this.planners.enableCamelotAmmv3 && this.planners.camelotAmmv3
        ? this.planners.camelotAmmv3.planBestRoute(input)
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
      const failureSummary = ensureCandidateClass(uniswapResult.failure.summary);
      venueAttempts.push(failureSummary);
      alternatives.push({
        venue: 'UNISWAP_V3',
        eligible: false,
        pathKind: failureSummary.pathKind,
        hopCount: failureSummary.hopCount,
        bridgeToken: failureSummary.bridgeToken,
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
        const failureSummary = ensureCandidateClass(camelotResult.failure.summary);
        venueAttempts.push(failureSummary);
        alternatives.push({
          venue: 'CAMELOT_AMMV3',
          eligible: false,
          pathKind: failureSummary.pathKind,
          hopCount: failureSummary.hopCount,
          bridgeToken: failureSummary.bridgeToken,
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
        candidateClass: deriveRejectedCandidateClass({
          venue: 'CAMELOT_AMMV3',
          status: 'NOT_ROUTEABLE',
          reason: 'CAMELOT_DISABLED'
        }),
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

    if (eligible.length === 0) {
      const rejectedCandidates = venueAttempts
        .filter((attempt) => attempt.status !== 'ROUTEABLE')
        .map((attempt) => ensureCandidateClass(attempt));
      const bestRejectedSummary = [...rejectedCandidates].sort(rejectedCandidateSort)[0];
      const bestRejectedWithClass = bestRejectedSummary
        ? {
            ...bestRejectedSummary,
            candidateClass: bestRejectedSummary.candidateClass ?? deriveRejectedCandidateClass(bestRejectedSummary)
          }
        : undefined;
      const statuses = venueAttempts.map((attempt) => attempt.status);
      const allNotRouteableOrQuoteFailed = statuses.every(
        (status) => status === 'NOT_ROUTEABLE' || status === 'QUOTE_FAILED'
      );
      const hasGasNotPriceable = statuses.includes('GAS_NOT_PRICEABLE');
      const reason: 'NOT_ROUTEABLE' | 'CONSTRAINT_REJECTED' | 'NOT_PROFITABLE' | 'QUOTE_FAILED' | 'GAS_NOT_PRICEABLE' =
        allNotRouteableOrQuoteFailed
          ? statuses.includes('QUOTE_FAILED') && !statuses.includes('NOT_ROUTEABLE')
            ? 'QUOTE_FAILED'
            : 'NOT_ROUTEABLE'
          : bestRejectedWithClass?.status === 'CONSTRAINT_REJECTED'
            ? 'CONSTRAINT_REJECTED'
            : bestRejectedWithClass?.status === 'NOT_PROFITABLE'
              ? 'NOT_PROFITABLE'
              : hasGasNotPriceable
                ? 'GAS_NOT_PRICEABLE'
                : 'NOT_ROUTEABLE';
      return {
        ok: false,
        reason,
        venueAttempts,
        bestRejectedSummary: bestRejectedWithClass,
        alternativeRoutes: alternatives
      };
    }

    const [chosenRoute, ...otherRoutes] = sortByBestEdge(eligible);
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
