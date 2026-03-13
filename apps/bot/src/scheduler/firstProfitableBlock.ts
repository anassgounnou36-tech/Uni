import type { ResolveEnv, ResolvedV3DutchOrder, V3DutchOrder } from '@uni/protocol';
import { resolveAt } from '@uni/protocol';
import type { Univ3QuoteModel } from '../routing/univ3QuoteModel.js';

export type BlockEvaluation = {
  block: bigint;
  grossEdge: bigint;
  gasCost: bigint;
  riskBuffer: bigint;
  netEdge: bigint;
  hedgeOutput: bigint;
};

export type FirstProfitableSchedule = {
  scheduledBlock: bigint;
  competeWindowStart: bigint;
  competeWindowEnd: bigint;
  evaluations: BlockEvaluation[];
};

export type FirstProfitableBlockParams = {
  order: V3DutchOrder;
  baseEnv: Omit<ResolveEnv, 'blockNumberish'>;
  quoteModel: Univ3QuoteModel;
  candidateBlocks: readonly bigint[];
  threshold: bigint;
  competeWindowBlocks: bigint;
  gasCostEstimator?: (resolved: ResolvedV3DutchOrder, block: bigint) => bigint;
  riskBufferEstimator?: (resolved: ResolvedV3DutchOrder, block: bigint) => bigint;
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
    const hedgeOutput = params.quoteModel.estimateHedgeOutput(resolved);
    const grossEdge = hedgeOutput - totalOutputAmount(resolved);
    const gasCost = params.gasCostEstimator?.(resolved, block) ?? 0n;
    const riskBuffer = params.riskBufferEstimator?.(resolved, block) ?? 0n;
    const netEdge = grossEdge - gasCost - riskBuffer;

    const evaluation: BlockEvaluation = {
      block,
      grossEdge,
      gasCost,
      riskBuffer,
      netEdge,
      hedgeOutput
    };
    evaluations.push(evaluation);

    if (netEdge >= params.threshold) {
      return {
        scheduledBlock: block,
        competeWindowStart: block,
        competeWindowEnd: block + params.competeWindowBlocks,
        evaluations
      };
    }
  }

  return undefined;
}
