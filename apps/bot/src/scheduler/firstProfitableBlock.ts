import type { ResolveEnv, ResolvedV3DutchOrder, V3DutchOrder } from '@uni/protocol';
import { resolveAt } from '@uni/protocol';
import type { RouteBook } from '../routing/routeBook.js';
import type { HedgeRoutePlan } from '../routing/venues.js';
import type { VenueRouteAttemptSummary } from '../routing/attemptTypes.js';
import type { ResolveEnvProvider } from '../runtime/resolveEnvProvider.js';
import type { HedgeExecutionMode } from '../routing/executionModeTypes.js';
import { RouteEvalReadCache } from '../routing/rpc/readCache.js';

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
  chosenExecutionMode?: HedgeExecutionMode;
  selectionOk: boolean;
  selectionReason?:
    | 'NOT_ROUTEABLE'
    | 'CONSTRAINT_REJECTED'
    | 'NOT_PROFITABLE'
    | 'QUOTE_FAILED'
    | 'GAS_NOT_PRICEABLE'
    | 'RATE_LIMITED'
    | 'RPC_UNAVAILABLE'
    | 'RPC_FAILED';
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
      reason: 'NO_EDGE' | 'INCONCLUSIVE';
      evaluations: BlockEvaluation[];
      bestObservedEvaluation?: BlockEvaluation;
    };

export type FirstProfitableBlockParams = {
  order: V3DutchOrder;
  resolveEnvProvider?: ResolveEnvProvider;
  baseEnv?: Omit<ResolveEnv, 'blockNumberish'>;
  routeBook: RouteBook;
  candidateBlockOffsets?: readonly bigint[];
  candidateBlocks?: readonly bigint[];
  threshold: bigint;
  competeWindowBlocks: bigint;
};

function totalOutputAmount(resolved: ResolvedV3DutchOrder): bigint {
  return resolved.outputs.reduce((sum, output) => sum + output.amount, 0n);
}

export async function findFirstProfitableBlock(params: FirstProfitableBlockParams): Promise<FirstProfitableBlockResult> {
  const evaluations: BlockEvaluation[] = [];
  const currentEnv = params.resolveEnvProvider ? await params.resolveEnvProvider.getCurrent() : undefined;
  const baseEnv: Omit<ResolveEnv, 'blockNumberish'> = currentEnv
    ? {
        timestamp: currentEnv.timestamp,
        basefee: currentEnv.baseFeePerGas,
        chainId: currentEnv.chainId
      }
    : (params.baseEnv ?? { timestamp: 0n, basefee: 0n, chainId: 42161n });
  const candidateBlocks = currentEnv
    ? (params.candidateBlockOffsets ?? [0n, 1n, 2n]).map((offset) => currentEnv.blockNumberish + offset)
    : (params.candidateBlocks ?? []);

  for (const block of [...candidateBlocks].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const readCache = new RouteEvalReadCache();
    const resolved = await resolveAt(params.order, {
      ...baseEnv,
      blockNumberish: block
    });

    const routeResult = await params.routeBook.selectBestRoute({
      resolvedOrder: resolved,
      routeEval: {
        chainId: baseEnv.chainId ?? 42161n,
        blockNumberish: block,
        readCache
      }
    });
    if (!routeResult.ok) {
      const bestRejectedSummary = routeResult.bestRejectedSummary ? { ...routeResult.bestRejectedSummary } : undefined;
      const bestRejectedQuotedAmountOut = bestRejectedSummary?.quotedAmountOut ?? 0n;
      const bestRejectedMinAmountOut = bestRejectedSummary?.minAmountOut ?? 0n;
      const bestRejectedGasCostOut = bestRejectedSummary?.constraintBreakdown?.gasCostOut ?? 0n;
      const bestRejectedRiskBufferOut = bestRejectedSummary?.constraintBreakdown?.riskBufferOut ?? 0n;
      const bestRejectedProfitFloorOut = bestRejectedSummary?.constraintBreakdown?.profitFloorOut ?? 0n;
      const bestRejectedSlippageBufferOut = bestRejectedSummary?.constraintBreakdown?.slippageBufferOut ?? 0n;
      const bestRejectedGrossEdgeOut =
        bestRejectedSummary?.grossEdgeOut
        ?? (bestRejectedSummary?.quotedAmountOut !== undefined
          ? bestRejectedSummary.quotedAmountOut - totalOutputAmount(resolved)
          : 0n);
      evaluations.push({
        block,
        requiredOutput: totalOutputAmount(resolved),
        quotedAmountOut: bestRejectedQuotedAmountOut,
        minAmountOut: bestRejectedMinAmountOut,
        slippageBufferOut: bestRejectedSlippageBufferOut,
        gasCostOut: bestRejectedGasCostOut,
        riskBufferOut: bestRejectedRiskBufferOut,
        profitFloorOut: bestRejectedProfitFloorOut,
        grossEdgeOut: bestRejectedGrossEdgeOut,
        netEdgeOut: bestRejectedSummary?.netEdgeOut ?? -1n,
        selectionOk: false,
        selectionReason: routeResult.reason,
        venueAttempts: routeResult.venueAttempts,
        bestRejectedSummary
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
      chosenExecutionMode: route.executionMode,
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
  let hasInfraBlocked = false;
  for (const evaluation of evaluations) {
    if (
      evaluation.selectionReason === 'RATE_LIMITED'
      || evaluation.selectionReason === 'RPC_UNAVAILABLE'
      || evaluation.selectionReason === 'RPC_FAILED'
    ) {
      hasInfraBlocked = true;
    }
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
    reason: hasInfraBlocked ? 'INCONCLUSIVE' : 'NO_EDGE',
    evaluations,
    bestObservedEvaluation
  };
}
