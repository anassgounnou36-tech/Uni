import type { PublicClient } from 'viem';
import type { ExecutionPlan } from './types.js';
import { decodeExecutionError } from './errorDecode.js';
import type { PrepareFailureContext } from './prepareFailureTypes.js';
import { validateExecutionPlanStatic } from './planValidators.js';

type PreflightParams = {
  executionPlan: ExecutionPlan;
  account: `0x${string}`;
  publicClient: PublicClient;
  runtimeSessionId: string;
  currentBlockNumber?: bigint;
  nowMs?: number;
  maxPrepareStalenessBlocks?: bigint;
  maxPrepareStalenessMs?: number;
  staleRetryCount?: number;
};

type PreparePreflightResult =
  | { ok: true; estimatedGas: bigint }
  | { ok: false; failure: PrepareFailureContext };

export async function runPreparePreflight(params: PreflightParams): Promise<PreparePreflightResult> {
  if (!params.executionPlan.runtimeSessionId || params.executionPlan.runtimeSessionId !== params.runtimeSessionId) {
    return {
      ok: false,
      failure: {
        reason: 'PREPARE_INVALID_PLAN_ANCHOR',
        errorCategory: 'INVALID_PLAN_ANCHOR',
        errorMessage: `invalid_plan_anchor: runtime session mismatch (plan=${params.executionPlan.runtimeSessionId ?? 'missing'} runtime=${params.runtimeSessionId})`,
        preflightStage: 'anchor',
        venue: params.executionPlan.route.venue,
        pathKind: params.executionPlan.route.pathKind,
        executionMode: params.executionPlan.selectedExecutionMode,
        runtimeSessionId: params.executionPlan.runtimeSessionId,
        plannedAtBlockNumber: params.executionPlan.plannedAtBlockNumber ?? params.executionPlan.resolvedAtBlockNumber,
        candidateBlockNumberish: params.executionPlan.candidateBlockNumberish
      }
    };
  }
  if (
    params.executionPlan.plannedAtBlockNumber === undefined
    || params.executionPlan.plannedAtTimestampMs === undefined
    || params.executionPlan.candidateBlockNumberish === undefined
  ) {
    return {
      ok: false,
      failure: {
        reason: 'PREPARE_INVALID_PLAN_ANCHOR',
        errorCategory: 'INVALID_PLAN_ANCHOR',
        errorMessage: 'invalid_plan_anchor: missing planned block/time/candidate metadata',
        preflightStage: 'anchor',
        venue: params.executionPlan.route.venue,
        pathKind: params.executionPlan.route.pathKind,
        executionMode: params.executionPlan.selectedExecutionMode,
        runtimeSessionId: params.executionPlan.runtimeSessionId,
        plannedAtBlockNumber: params.executionPlan.plannedAtBlockNumber,
        candidateBlockNumberish: params.executionPlan.candidateBlockNumberish
      }
    };
  }

  if (
    params.currentBlockNumber !== undefined
    && params.nowMs !== undefined
    && params.maxPrepareStalenessBlocks !== undefined
    && params.maxPrepareStalenessMs !== undefined
  ) {
    const plannedAtBlock = params.executionPlan.plannedAtBlockNumber;
    const blockDelta = params.currentBlockNumber - plannedAtBlock;
    const timeDeltaMs = params.nowMs - params.executionPlan.plannedAtTimestampMs;

    if (blockDelta < 0n) {
      return {
        ok: false,
        failure: {
          reason: 'PREPARE_INVALID_PLAN_ANCHOR',
          errorCategory: 'INVALID_PLAN_ANCHOR',
          errorMessage: `invalid_plan_anchor: negative block delta (current=${params.currentBlockNumber.toString()} planned=${plannedAtBlock.toString()} delta=${blockDelta.toString()})`,
          preflightStage: 'anchor',
          venue: params.executionPlan.route.venue,
          pathKind: params.executionPlan.route.pathKind,
          executionMode: params.executionPlan.selectedExecutionMode,
          runtimeSessionId: params.executionPlan.runtimeSessionId,
          plannedAtBlockNumber: plannedAtBlock,
          candidateBlockNumberish: params.executionPlan.candidateBlockNumberish,
          blockDelta,
          timeDeltaMs,
          staleRetryCount: params.staleRetryCount
        }
      };
    }

    if (blockDelta > params.maxPrepareStalenessBlocks || timeDeltaMs > params.maxPrepareStalenessMs) {
      return {
        ok: false,
        failure: {
          reason: 'PREPARE_STALE_PLAN',
          errorCategory: 'STALE_PLAN',
          errorMessage: `stale_plan: plan exceeded freshness window (block_delta=${blockDelta.toString()} time_delta_ms=${timeDeltaMs})`,
          preflightStage: 'staleness',
          venue: params.executionPlan.route.venue,
          pathKind: params.executionPlan.route.pathKind,
          executionMode: params.executionPlan.selectedExecutionMode,
          runtimeSessionId: params.executionPlan.runtimeSessionId,
          plannedAtBlockNumber: plannedAtBlock,
          candidateBlockNumberish: params.executionPlan.candidateBlockNumberish,
          blockDelta,
          timeDeltaMs,
          staleRetryCount: params.staleRetryCount
        }
      };
    }
  }

  const chainId = await params.publicClient.getChainId();
  const staticValidation = validateExecutionPlanStatic(params.executionPlan, BigInt(chainId));
  if (!staticValidation.ok) {
    return {
      ok: false,
      failure: {
        ...staticValidation.failure,
        preflightStage: 'validate',
        venue: params.executionPlan.route.venue,
        pathKind: params.executionPlan.route.pathKind,
        executionMode: params.executionPlan.selectedExecutionMode
      }
    };
  }

  try {
    await params.publicClient.call({
      account: params.account,
      to: params.executionPlan.executor,
      data: params.executionPlan.executeCalldata,
      value: 0n
    });
  } catch (error) {
    const decoded = decodeExecutionError(error);
    return {
      ok: false,
      failure: {
        reason: 'PREPARE_CALL_REVERTED',
        errorCategory: decoded.errorCategory,
        errorMessage: decoded.errorMessage,
        errorSelector: decoded.errorSelector,
        decodedErrorName: decoded.decodedErrorName,
        preflightStage: 'call',
        venue: params.executionPlan.route.venue,
        pathKind: params.executionPlan.route.pathKind,
        executionMode: params.executionPlan.selectedExecutionMode
      }
    };
  }

  try {
    const estimatedGas = await params.publicClient.estimateGas({
      account: params.account,
      to: params.executionPlan.executor,
      data: params.executionPlan.executeCalldata,
      value: 0n
    });
    return { ok: true, estimatedGas };
  } catch (error) {
    const decoded = decodeExecutionError(error);
    return {
      ok: false,
      failure: {
        reason: 'PREPARE_ESTIMATE_GAS_FAILED',
        errorCategory: decoded.errorCategory,
        errorMessage: decoded.errorMessage,
        errorSelector: decoded.errorSelector,
        decodedErrorName: decoded.decodedErrorName,
        preflightStage: 'estimate_gas',
        venue: params.executionPlan.route.venue,
        pathKind: params.executionPlan.route.pathKind,
        executionMode: params.executionPlan.selectedExecutionMode
      }
    };
  }
}
