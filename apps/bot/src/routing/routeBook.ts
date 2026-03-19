import type { RoutePlannerInput } from './univ3/types.js';
import type { UniV3RoutePlanner } from './univ3/routePlanner.js';
import type { CamelotAmmv3RoutePlanner } from './camelotV3/routePlanner.js';
import type { HedgeRoutePlan, HedgeVenue, RouteCandidateSummary } from './venues.js';
import type { VenueRouteAttemptSummary } from './attemptTypes.js';

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

function toCandidateFailureReason(summary: VenueRouteAttemptSummary): RouteCandidateSummary['reason'] {
  if (summary.status === 'NOT_PROFITABLE') {
    return 'NOT_PROFITABLE';
  }
  if (summary.status === 'CONSTRAINT_REJECTED') {
    return 'NOT_PROFITABLE';
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
      venueAttempts.push(uniswapResult.failure.summary);
      alternatives.push({
        venue: 'UNISWAP_V3',
        eligible: false,
        reason: toCandidateFailureReason(uniswapResult.failure.summary),
        details: uniswapResult.failure.summary.reason
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
        venueAttempts.push(camelotResult.failure.summary);
        alternatives.push({
          venue: 'CAMELOT_AMMV3',
          eligible: false,
          reason: toCandidateFailureReason(camelotResult.failure.summary),
          details: camelotResult.failure.summary.reason
        });
      }
    } else if (!this.planners.enableCamelotAmmv3) {
      const requiredOutput = sumRequiredOutput(input.resolvedOrder.outputs as ReadonlyArray<{ amount: bigint }>);
      venueAttempts.push({
        venue: 'CAMELOT_AMMV3',
        status: 'NOT_ROUTEABLE',
        reason: 'CAMELOT_DISABLED',
        exactOutputViability: {
          status: 'NOT_CHECKED',
          targetOutput: requiredOutput,
          requiredInputForTargetOutput: 0n,
          availableInput: input.resolvedOrder.input.amount,
          inputDeficit: 0n,
          inputSlack: input.resolvedOrder.input.amount,
          reason: 'exact-output diagnostic not implemented for camelot in this pr'
        }
      });
      alternatives.push({
        venue: 'CAMELOT_AMMV3',
        eligible: false,
        reason: 'CAMELOT_DISABLED'
      });
    }

    if (eligible.length === 0) {
      const bestRejectedSummary = [...venueAttempts]
        .sort((a, b) => {
          const aHasQuote = a.quotedAmountOut !== undefined;
          const bHasQuote = b.quotedAmountOut !== undefined;
          if (aHasQuote !== bHasQuote) {
            return aHasQuote ? -1 : 1;
          }
          const aEdge = a.netEdgeOut ?? -1n;
          const bEdge = b.netEdgeOut ?? -1n;
          if (aEdge !== bEdge) {
            return aEdge > bEdge ? -1 : 1;
          }
          return venueTieBreak(a.venue, b.venue);
        })[0];
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
          : bestRejectedSummary?.status === 'CONSTRAINT_REJECTED'
            ? 'CONSTRAINT_REJECTED'
            : bestRejectedSummary?.status === 'NOT_PROFITABLE'
              ? 'NOT_PROFITABLE'
              : hasGasNotPriceable
                ? 'GAS_NOT_PRICEABLE'
                : 'NOT_ROUTEABLE';
      return {
        ok: false,
        reason,
        venueAttempts,
        bestRejectedSummary,
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
