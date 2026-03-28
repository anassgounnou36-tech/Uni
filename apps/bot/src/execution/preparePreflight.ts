import type { PublicClient } from 'viem';
import type { ExecutionPlan } from './types.js';
import { decodeExecutionError } from './errorDecode.js';
import type { PrepareFailureContext } from './prepareFailureTypes.js';
import { validateExecutionPlanStatic } from './planValidators.js';

type PreflightParams = {
  executionPlan: ExecutionPlan;
  account: `0x${string}`;
  publicClient: PublicClient;
};

type PreparePreflightResult =
  | { ok: true; estimatedGas: bigint }
  | { ok: false; failure: PrepareFailureContext };

export async function runPreparePreflight(params: PreflightParams): Promise<PreparePreflightResult> {
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
