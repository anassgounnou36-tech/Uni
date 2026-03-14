import type { ResolveEnv, ResolvedV3DutchOrder, V3DutchOrder } from '@uni/protocol';
import { resolveAt } from '@uni/protocol';
import type { UniV3RoutePlanner } from '../routing/univ3/routePlanner.js';
import type { UniV3RoutePlan } from '../routing/univ3/types.js';

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
  route?: UniV3RoutePlan;
};

export type FirstProfitableSchedule = {
  scheduledBlock: bigint;
  competeWindowStart: bigint;
  competeWindowEnd: bigint;
  chosenRoute: UniV3RoutePlan;
  evaluations: BlockEvaluation[];
  /**
   * Candidate blocks are resolved from off-chain reactor semantics, while route quotes
   * are mark-to-market observations of current AMM state at quote time.
   */
  quoteModel: 'MARK_TO_MARKET_AMM';
};

export type FirstProfitableBlockParams = {
  order: V3DutchOrder;
  baseEnv: Omit<ResolveEnv, 'blockNumberish'>;
  routePlanner: UniV3RoutePlanner;
  candidateBlocks: readonly bigint[];
  threshold: bigint;
  competeWindowBlocks: bigint;
};

function totalOutputAmount(resolved: ResolvedV3DutchOrder): bigint {
  return resolved.outputs.reduce((sum, output) => sum + output.amount, 0n);
}

export async function findFirstProfitableBlock(params: FirstProfitableBlockParams): Promise<FirstProfitableSchedule | undefined> {
  const evaluations: BlockEvaluation[] = [];

  for (const block of [...params.candidateBlocks].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const resolved = await resolveAt(params.order, {
      ...params.baseEnv,
      blockNumberish: block
    });

    const routeResult = await params.routePlanner.planBestRoute({ resolvedOrder: resolved });
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
        netEdgeOut: -1n
      });
      continue;
    }

    const route = routeResult.route;
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
      route
    };
    evaluations.push(evaluation);

    if (route.netEdgeOut >= params.threshold) {
      return {
        scheduledBlock: block,
        competeWindowStart: block,
        competeWindowEnd: block + params.competeWindowBlocks,
        chosenRoute: evaluation.route!,
        evaluations,
        quoteModel: 'MARK_TO_MARKET_AMM'
      };
    }
  }

  return undefined;
}
