import type { ResolvedV3DutchOrder } from '@uni/protocol';
import type { ForkSimResult, ForkSimService } from '../sim/forkSimService.js';

export type HotLaneEntry = {
  orderHash: `0x${string}`;
  scheduledBlock: bigint;
  competeWindowEnd: bigint;
  predictedEdge: bigint;
};

export type HotLaneDecision =
  | { action: 'WAIT'; reason: 'NOT_IN_HOT_WINDOW' }
  | { action: 'DROP'; reason: 'EDGE_DISAPPEARED' | 'SIM_FAIL' | 'WINDOW_EXPIRED'; simResult?: ForkSimResult }
  | { action: 'NO_SEND'; reason: 'SHADOW_MODE'; simResult: ForkSimResult }
  | { action: 'WOULD_SEND'; simResult: ForkSimResult };

export type HotLaneStepParams = {
  entry: HotLaneEntry;
  currentBlock: bigint;
  latestResolved: ResolvedV3DutchOrder;
  threshold: bigint;
  quoteRefresher: (resolved: ResolvedV3DutchOrder) => bigint;
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

  const refreshedEdge = params.quoteRefresher(params.latestResolved);
  if (refreshedEdge < params.threshold) {
    return { action: 'DROP', reason: 'EDGE_DISAPPEARED' };
  }

  const simResult = await params.simService.simulateFinal(params.latestResolved);
  if (!simResult.ok) {
    return { action: 'DROP', reason: 'SIM_FAIL', simResult };
  }

  if (params.shadowMode) {
    return { action: 'NO_SEND', reason: 'SHADOW_MODE', simResult };
  }

  return { action: 'WOULD_SEND', simResult };
}
