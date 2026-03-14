import type { ResolveEnv, V3DutchOrder } from '@uni/protocol';
import { resolveAt } from '@uni/protocol';
import { buildExecutionPlan, type BuildExecutionPlanParams } from '../execution/planBuilder.js';
import type { ExecutionPlan } from '../execution/types.js';
import type { UniV3RoutePlanner } from '../routing/univ3/routePlanner.js';
import type { ForkSimResult, ForkSimService } from '../sim/forkSimService.js';
import type { ConditionalEnvelope } from '../send/conditional.js';
import type { NormalizedOrder } from '../store/types.js';

export type HotLaneEntry = {
  orderHash: `0x${string}`;
  scheduledBlock: bigint;
  competeWindowEnd: bigint;
  predictedEdge: bigint;
};

export type HotLaneDecision =
  | { action: 'WAIT'; reason: 'NOT_IN_HOT_WINDOW' }
  | { action: 'DROP'; reason: 'EDGE_DISAPPEARED' | 'SIM_FAIL' | 'WINDOW_EXPIRED' | 'PLAN_BUILD_FAILED'; simResult?: ForkSimResult }
  | { action: 'NO_SEND'; reason: 'SHADOW_MODE'; simResult: ForkSimResult; plan: ExecutionPlan }
  | { action: 'WOULD_SEND'; simResult: ForkSimResult; plan: ExecutionPlan };

export type HotLaneStepParams = {
  entry: HotLaneEntry;
  currentBlock: bigint;
  threshold: bigint;
  normalizedOrder: NormalizedOrder;
  order: V3DutchOrder;
  routePlanner: UniV3RoutePlanner;
  resolveEnv: Omit<ResolveEnv, 'blockNumberish'>;
  conditionalEnvelope: ConditionalEnvelope;
  executor: `0x${string}`;
  simService: ForkSimService;
  shadowMode: boolean;
  leadBlocks?: bigint;
};

export function shouldMoveToHotLane(currentBlock: bigint, scheduledBlock: bigint, leadBlocks: bigint = 2n): boolean {
  return currentBlock >= scheduledBlock - leadBlocks;
}

export async function runHotLaneStep(params: HotLaneStepParams): Promise<HotLaneDecision> {
  if (!shouldMoveToHotLane(params.currentBlock, params.entry.scheduledBlock, params.leadBlocks ?? 2n)) {
    return { action: 'WAIT', reason: 'NOT_IN_HOT_WINDOW' };
  }
  if (params.currentBlock > params.entry.competeWindowEnd) {
    return { action: 'DROP', reason: 'WINDOW_EXPIRED' };
  }

  const resolved = await resolveAt(params.order, {
    ...params.resolveEnv,
    blockNumberish: params.currentBlock
  });
  const route = await params.routePlanner.planBestRoute({ resolvedOrder: resolved });
  if (!route.ok || route.route.netEdge < params.threshold) {
    return { action: 'DROP', reason: 'EDGE_DISAPPEARED' };
  }

  const result = await buildExecutionPlan({
    normalizedOrder: params.normalizedOrder,
    planner: params.routePlanner,
    executor: params.executor,
    blockNumberish: params.currentBlock,
    resolveEnv: params.resolveEnv,
    conditionalEnvelope: params.conditionalEnvelope
  } satisfies BuildExecutionPlanParams);

  if (!result.ok) {
    return { action: 'DROP', reason: 'PLAN_BUILD_FAILED' };
  }

  const simResult = await params.simService.simulateFinal(result.plan);
  if (!simResult.ok) {
    return { action: 'DROP', reason: 'SIM_FAIL', simResult };
  }

  if (params.shadowMode) {
    return { action: 'NO_SEND', reason: 'SHADOW_MODE', simResult, plan: result.plan };
  }

  return { action: 'WOULD_SEND', simResult, plan: result.plan };
}
