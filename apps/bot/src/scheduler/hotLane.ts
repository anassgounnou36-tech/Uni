import type { ResolveEnv, V3DutchOrder } from '@uni/protocol';
import { resolveAt } from '@uni/protocol';
import { RouteEvalReadCache } from '../routing/rpc/readCache.js';
import { buildExecutionPlan, type BuildExecutionPlanParams } from '../execution/planBuilder.js';
import type { PreparedExecution } from '../execution/preparedExecution.js';
import type { ExecutionPlan } from '../execution/types.js';
import type { RouteBook } from '../routing/routeBook.js';
import type { RouteCandidateSummary } from '../routing/venues.js';
import type { RoutePathKind } from '../routing/pathTypes.js';
import type { HedgeExecutionMode } from '../routing/executionModeTypes.js';
import type { RejectedCandidateClass } from '../routing/rejectedCandidateTypes.js';
import type { ConstraintRejectReason } from '../routing/constraintTypes.js';
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
      reason: 'EDGE_DISAPPEARED' | 'SIM_FAIL' | 'WINDOW_EXPIRED' | 'PLAN_BUILD_FAILED' | 'PREPARE_FAILED' | 'SEND_REJECTED' | 'INFRA_BLOCKED';
      simResult?: ForkSimResult;
      preparedExecution?: PreparedExecution;
      sendResult?: SequencerClientResult;
      chosenRouteVenue?: 'UNISWAP_V3' | 'CAMELOT_AMMV3';
      pathKind?: RoutePathKind;
      hopCount?: 1 | 2;
      bridgeToken?: `0x${string}`;
      executionMode?: HedgeExecutionMode;
      pathDescriptor?: string;
      chosenRouteCandidateClass?: RejectedCandidateClass;
      chosenRouteConstraintReason?: ConstraintRejectReason;
      prepareError?: string;
      prepareMessage?: string;
      routeAlternatives?: RouteCandidateSummary[];
    }
  | {
      action: 'NO_SEND';
      reason: 'SHADOW_MODE';
      simResult: ForkSimResult;
      preparedExecution: PreparedExecution;
      sendResult?: SequencerClientResult;
      chosenRouteVenue: 'UNISWAP_V3' | 'CAMELOT_AMMV3';
      routeAlternatives: RouteCandidateSummary[];
    }
  | {
      action: 'WOULD_SEND';
      simResult: ForkSimResult;
      preparedExecution: PreparedExecution;
      sendResult: SequencerClientResult;
      chosenRouteVenue: 'UNISWAP_V3' | 'CAMELOT_AMMV3';
      routeAlternatives: RouteCandidateSummary[];
    };

export type HotLaneStepParams = {
  entry: HotLaneEntry;
  currentBlock: bigint;
  thresholdOut: bigint;
  normalizedOrder: NormalizedOrder;
  order: V3DutchOrder;
  routeBook: RouteBook;
  resolveEnv: Omit<ResolveEnv, 'blockNumberish'>;
  conditionalEnvelope: ConditionalEnvelope;
  executor: `0x${string}`;
  simService: ForkSimService;
  sequencerClient: SequencerClient;
  nonceManager: NonceManager;
  executionPreparer: (input: { executionPlan: ExecutionPlan }) => Promise<PreparedExecution>;
  shadowMode: boolean;
  leadBlocks?: bigint;
  routeEvalReadCache?: RouteEvalReadCache;
};

export function shouldMoveToHotLane(currentBlock: bigint, scheduledBlock: bigint, leadBlocks: bigint = 2n): boolean {
  return currentBlock >= scheduledBlock - leadBlocks;
}

function toPrepareErrorContext(error: unknown): { prepareError: string; prepareMessage: string } {
  if (error instanceof Error) {
    const cause = error.cause === undefined ? undefined : String(error.cause);
    return {
      prepareError: cause ? `${error.name} (cause=${cause})` : error.name,
      prepareMessage: error.message
    };
  }
  const normalized = String(error);
  return {
    prepareError: 'UnknownError',
    prepareMessage: normalized
  };
}

function toPathDescriptor(pathKind: 'DIRECT' | 'TWO_HOP', tokenIn: string, tokenOut: string, bridgeToken?: string): string {
  if (pathKind === 'DIRECT') {
    return `DIRECT: ${tokenIn} -> ${tokenOut}`;
  }
  return `TWO_HOP: ${tokenIn} -> ${bridgeToken ?? 'unknown'} -> ${tokenOut}`;
}

function chooseRouteContextCandidate(
  routeAlternatives: RouteCandidateSummary[] | undefined,
  venue: 'UNISWAP_V3' | 'CAMELOT_AMMV3'
): RouteCandidateSummary | undefined {
  if (!routeAlternatives || routeAlternatives.length === 0) {
    return undefined;
  }
  return routeAlternatives.find((candidate) => candidate.venue === venue && candidate.eligible) ?? routeAlternatives[0];
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
  const route = await params.routeBook.selectBestRoute({
    resolvedOrder: resolved,
    routeEval: {
      chainId: params.resolveEnv.chainId ?? 42161n,
      blockNumberish: params.currentBlock,
      readCache: params.routeEvalReadCache ?? new RouteEvalReadCache()
    }
  });
  if (!route.ok) {
    if (
      route.reason === 'RATE_LIMITED'
      || route.reason === 'RPC_UNAVAILABLE'
      || route.reason === 'RPC_FAILED'
      || route.reason === 'QUOTE_REVERTED'
    ) {
      return { action: 'DROP', reason: 'INFRA_BLOCKED' };
    }
    return { action: 'DROP', reason: 'EDGE_DISAPPEARED' };
  }
  if (route.chosenRoute.netEdgeOut < params.thresholdOut) {
    return { action: 'DROP', reason: 'EDGE_DISAPPEARED' };
  }

  const planInput = {
    normalizedOrder: params.normalizedOrder,
    routeBook: params.routeBook,
    executor: params.executor,
    blockNumberish: params.currentBlock,
    resolveEnv: params.resolveEnv,
    conditionalEnvelope: params.conditionalEnvelope,
    routeEvalReadCache: params.routeEvalReadCache
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
  } catch (error) {
    const prepareErrorContext = toPrepareErrorContext(error);
    const route = result.plan.route;
    const routeContextCandidate = chooseRouteContextCandidate(result.plan.routeAlternatives, route.venue);
    return {
      action: 'DROP',
      reason: 'PREPARE_FAILED',
      prepareError: prepareErrorContext.prepareError,
      prepareMessage: prepareErrorContext.prepareMessage,
      chosenRouteVenue: route.venue,
      pathKind: route.pathKind,
      hopCount: route.hopCount,
      bridgeToken: route.bridgeToken,
      executionMode: route.executionMode ?? result.plan.selectedExecutionMode,
      pathDescriptor: toPathDescriptor(route.pathKind, route.tokenIn, route.tokenOut, route.bridgeToken),
      chosenRouteCandidateClass: routeContextCandidate?.candidateClass,
      chosenRouteConstraintReason: routeContextCandidate?.constraintReason,
      routeAlternatives: result.plan.routeAlternatives
    };
  }

  const simResult = await params.simService.simulatePrepared(preparedExecution);
  if (!simResult.ok) {
    await params.nonceManager.release(preparedExecution.nonceLease, 'RELEASED');
    return {
      action: 'DROP',
      reason: 'SIM_FAIL',
      simResult,
      preparedExecution,
      chosenRouteVenue: result.plan.route.venue,
      routeAlternatives: result.plan.routeAlternatives
    };
  }

  if (params.shadowMode) {
    await params.nonceManager.release(preparedExecution.nonceLease, 'RELEASED');
    return {
      action: 'NO_SEND',
      reason: 'SHADOW_MODE',
      simResult,
      preparedExecution,
      chosenRouteVenue: result.plan.route.venue,
      routeAlternatives: result.plan.routeAlternatives
    };
  }

  const sendResult = await params.sequencerClient.sendPreparedExecution(preparedExecution);
  if (!sendResult.accepted) {
    await params.nonceManager.release(preparedExecution.nonceLease, 'RELEASED');
    return {
      action: 'DROP',
      reason: 'SEND_REJECTED',
      simResult,
      preparedExecution,
      sendResult,
      chosenRouteVenue: result.plan.route.venue,
      routeAlternatives: result.plan.routeAlternatives
    };
  }

  await params.nonceManager.markBroadcastAccepted(preparedExecution.nonceLease);
  return {
    action: 'WOULD_SEND',
    simResult,
    preparedExecution,
    sendResult,
    chosenRouteVenue: result.plan.route.venue,
    routeAlternatives: result.plan.routeAlternatives
  };
}
