import type { RoutePlannerInput } from './univ3/types.js';
import type { UniV3RoutePlanner } from './univ3/routePlanner.js';
import type { CamelotAmmv3RoutePlanner } from './camelotV3/routePlanner.js';
import type { HedgeRoutePlan, HedgeVenue, RouteCandidateSummary } from './venues.js';

export type RouteBookSelection =
  | {
      ok: true;
      chosenRoute: HedgeRoutePlan;
      alternativeRoutes: RouteCandidateSummary[];
    }
  | {
      ok: false;
      reason: 'NOT_ROUTEABLE';
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
    const eligible: HedgeRoutePlan[] = [];

    if (uniswapResult.ok) {
      const summary = toSummary(uniswapResult.route);
      alternatives.push(summary);
      if (summary.eligible) {
        eligible.push(uniswapResult.route);
      }
    } else {
      alternatives.push({
        venue: 'UNISWAP_V3',
        eligible: false,
        reason: uniswapResult.failure.reason,
        details: uniswapResult.failure.details
      });
    }

    if (camelotResult) {
      if (camelotResult.ok) {
        const summary = toSummary(camelotResult.route);
        alternatives.push(summary);
        if (summary.eligible) {
          eligible.push(camelotResult.route);
        }
      } else {
        alternatives.push({
          venue: 'CAMELOT_AMMV3',
          eligible: false,
          reason: camelotResult.failure.reason,
          details: camelotResult.failure.details
        });
      }
    } else if (!this.planners.enableCamelotAmmv3) {
      alternatives.push({
        venue: 'CAMELOT_AMMV3',
        eligible: false,
        reason: 'CAMELOT_DISABLED'
      });
    }

    if (eligible.length === 0) {
      return {
        ok: false,
        reason: 'NOT_ROUTEABLE',
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

    return {
      ok: true,
      chosenRoute,
      alternativeRoutes
    };
  }
}
