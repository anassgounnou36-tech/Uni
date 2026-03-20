import type { ResolveEnv, ResolvedV3DutchOrder, V3DutchOrder } from '@uni/protocol';
import { resolveAt } from '@uni/protocol';
import type { RouteBook } from '../routing/routeBook.js';
import type { HedgeRoutePlan } from '../routing/venues.js';
import type { VenueRouteAttemptSummary } from '../routing/attemptTypes.js';

export type BlockEvaluation = {
  block: bigint;
  requiredOutput: bigint;
  quotedAmountOut: bigint;
  minAmountOut: bigint;
  slippageBufferOut: bigint;
  gasCostOut: bigint;
  riskBufferOut: bigint;
  profitFloorOut: bigint;
  grossEdgeOut: bigint;
  netEdgeOut: bigint;
  chosenRouteVenue?: HedgeRoutePlan['venue'];
  selectionOk: boolean;
  selectionReason?: 'NOT_ROUTEABLE' | 'CONSTRAINT_REJECTED' | 'NOT_PROFITABLE' | 'QUOTE_FAILED' | 'GAS_NOT_PRICEABLE';
  venueAttempts: VenueRouteAttemptSummary[];
  bestRejectedSummary?: VenueRouteAttemptSummary;
};

export type FirstProfitableSchedule = {
  scheduledBlock: bigint;
  competeWindowStart: bigint;
  competeWindowEnd: bigint;
  chosenRoute: HedgeRoutePlan;
  evaluations: BlockEvaluation[];
  /**
   * Candidate blocks are resolved from off-chain reactor semantics, while route quotes
   * are mark-to-market observations of current AMM state at quote time.
   */
  quoteModel: 'MARK_TO_MARKET_AMM';
};

export type FirstProfitableBlockResult =
  | {
      ok: true;
      schedule: FirstProfitableSchedule;
      evaluations: BlockEvaluation[];
    }
  | {
      ok: false;
      reason: 'NO_EDGE';
      evaluations: BlockEvaluation[];
      bestObservedEvaluation?: BlockEvaluation;
    };

export type FirstProfitableBlockParams = {
  order: V3DutchOrder;
  baseEnv: Omit<ResolveEnv, 'blockNumberish'>;
  routeBook: RouteBook;
  candidateBlocks: readonly bigint[];
  threshold: bigint;
  competeWindowBlocks: bigint;
};

function totalOutputAmount(resolved: ResolvedV3DutchOrder): bigint {
  return resolved.outputs.reduce((sum, output) => sum + output.amount, 0n);
}

export async function findFirstProfitableBlock(params: FirstProfitableBlockParams): Promise<FirstProfitableBlockResult> {
  const evaluations: BlockEvaluation[] = [];

  for (const block of [...params.candidateBlocks].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const resolved = await resolveAt(params.order, {
      ...params.baseEnv,
      blockNumberish: block
    });

    const routeResult = await params.routeBook.selectBestRoute({ resolvedOrder: resolved });
    if (!routeResult.ok) {
      evaluations.push({
        block,
        requiredOutput: totalOutputAmount(resolved),
        quotedAmountOut: 0n,
        minAmountOut: 0n,
        slippageBufferOut: 0n,
        gasCostOut: 0n,
        riskBufferOut: 0n,
        profitFloorOut: 0n,
        grossEdgeOut: 0n,
        netEdgeOut: -1n,
        selectionOk: false,
        selectionReason: routeResult.reason,
        venueAttempts: routeResult.venueAttempts,
        bestRejectedSummary: routeResult.bestRejectedSummary
      });
      continue;
    }

    const route = routeResult.chosenRoute;
    const requiredOutput = route.requiredOutput;
    const quotedAmountOut = route.quotedAmountOut;
    const evaluation: BlockEvaluation = {
      block,
      requiredOutput,
      quotedAmountOut,
      minAmountOut: route.minAmountOut,
      slippageBufferOut: route.slippageBufferOut,
      gasCostOut: route.gasCostOut,
      riskBufferOut: route.riskBufferOut,
      profitFloorOut: route.profitFloorOut,
      grossEdgeOut: route.grossEdgeOut,
      netEdgeOut: route.netEdgeOut,
      chosenRouteVenue: route.venue,
      selectionOk: true,
      venueAttempts: routeResult.venueAttempts
    };
    evaluations.push(evaluation);

    if (route.netEdgeOut >= params.threshold) {
      return {
        ok: true,
        schedule: {
          scheduledBlock: block,
          competeWindowStart: block,
          competeWindowEnd: block + params.competeWindowBlocks,
          chosenRoute: route,
          evaluations,
          quoteModel: 'MARK_TO_MARKET_AMM'
        },
        evaluations,
      };
    }
  }

  let bestObservedEvaluation: BlockEvaluation | undefined;
  for (const evaluation of evaluations) {
    if (!bestObservedEvaluation || evaluation.netEdgeOut > bestObservedEvaluation.netEdgeOut) {
      bestObservedEvaluation = evaluation;
      continue;
    }
    if (evaluation.netEdgeOut === bestObservedEvaluation.netEdgeOut) {
      const currentHasBestRejected = bestObservedEvaluation.bestRejectedSummary !== undefined;
      const candidateHasBestRejected = evaluation.bestRejectedSummary !== undefined;
      if (!currentHasBestRejected && candidateHasBestRejected) {
        bestObservedEvaluation = evaluation;
      }
    }
  }

  return {
    ok: false,
    reason: 'NO_EDGE',
    evaluations,
    bestObservedEvaluation
  };
}
