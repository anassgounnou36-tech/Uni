import type { ResolveEnv, V3DutchOrder } from '@uni/protocol';
import { resolveAt } from '@uni/protocol';
import { buildExecutionPlan, type BuildExecutionPlanParams } from '../execution/planBuilder.js';
import type { PreparedExecution } from '../execution/preparedExecution.js';
import type { ExecutionPlan } from '../execution/types.js';
import type { UniV3RoutePlanner } from '../routing/univ3/routePlanner.js';
import type { ForkSimResult, ForkSimService } from '../sim/forkSimService.js';
import type { SequencerClient, SequencerClientResult } from '../send/sequencerClient.js';
import { NonceManager } from '../send/nonceManager.js';
import type { ConditionalEnvelope } from '../send/conditional.js';
import type { NormalizedOrder } from '../store/types.js';

export type HotLaneEntry = {
  orderHash: `0x${string}`;
  scheduledBlock: bigint;
  competeWindowEnd: bigint;
  predictedEdgeOut: bigint;
};

export type HotLaneDecision =
  | { action: 'WAIT'; reason: 'NOT_IN_HOT_WINDOW' }
  | {
      action: 'DROP';
      reason: 'EDGE_DISAPPEARED' | 'SIM_FAIL' | 'WINDOW_EXPIRED' | 'PLAN_BUILD_FAILED' | 'PREPARE_FAILED' | 'SEND_REJECTED';
      simResult?: ForkSimResult;
      preparedExecution?: PreparedExecution;
      sendResult?: SequencerClientResult;
    }
  | {
      action: 'NO_SEND';
      reason: 'SHADOW_MODE';
      simResult: ForkSimResult;
      preparedExecution: PreparedExecution;
      sendResult: SequencerClientResult;
    }
  | {
      action: 'WOULD_SEND';
      simResult: ForkSimResult;
      preparedExecution: PreparedExecution;
      sendResult: SequencerClientResult;
    };

export type HotLaneStepParams = {
  entry: HotLaneEntry;
  currentBlock: bigint;
  thresholdOut: bigint;
  normalizedOrder: NormalizedOrder;
  order: V3DutchOrder;
  routePlanner: UniV3RoutePlanner;
  resolveEnv: Omit<ResolveEnv, 'blockNumberish'>;
  conditionalEnvelope: ConditionalEnvelope;
  executor: `0x${string}`;
  simService: ForkSimService;
  sequencerClient: SequencerClient;
  nonceManager: NonceManager;
  executionPreparer: (input: { executionPlan: ExecutionPlan }) => Promise<PreparedExecution>;
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
  if (!route.ok || route.route.netEdgeOut < params.thresholdOut) {
    return { action: 'DROP', reason: 'EDGE_DISAPPEARED' };
  }

  const planInput = {
    normalizedOrder: params.normalizedOrder,
    planner: params.routePlanner,
    executor: params.executor,
    blockNumberish: params.currentBlock,
    resolveEnv: params.resolveEnv,
    conditionalEnvelope: params.conditionalEnvelope
  } satisfies BuildExecutionPlanParams;
  const result = await buildExecutionPlan(planInput);

  if (!result.ok) {
    return { action: 'DROP', reason: 'PLAN_BUILD_FAILED' };
  }

  let preparedExecution: PreparedExecution;
  try {
    preparedExecution = await params.executionPreparer({
      executionPlan: result.plan
    });
  } catch {
    return { action: 'DROP', reason: 'PREPARE_FAILED' };
  }

  const simResult = await params.simService.simulatePrepared(preparedExecution);
  if (!simResult.ok) {
    await params.nonceManager.release(preparedExecution.nonceLease, 'RELEASED');
    return { action: 'DROP', reason: 'SIM_FAIL', simResult, preparedExecution };
  }

  const sendResult = await params.sequencerClient.sendPreparedExecution(preparedExecution);
  if (params.shadowMode) {
    await params.nonceManager.release(preparedExecution.nonceLease, 'RELEASED');
    return { action: 'NO_SEND', reason: 'SHADOW_MODE', simResult, preparedExecution, sendResult };
  }

  if (!sendResult.accepted) {
    await params.nonceManager.release(preparedExecution.nonceLease, 'RELEASED');
    return { action: 'DROP', reason: 'SEND_REJECTED', simResult, preparedExecution, sendResult };
  }

  await params.nonceManager.markBroadcastAccepted(preparedExecution.nonceLease);
  return { action: 'WOULD_SEND', simResult, preparedExecution, sendResult };
}
