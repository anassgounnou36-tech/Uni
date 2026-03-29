import type { Address, PublicClient, WalletClient } from 'viem';
import { deriveFreshnessEnvelopeFromSchedule, type ConditionalEnvelope } from '../send/conditional.js';
import { NonceManager } from '../send/nonceManager.js';
import { buildTransaction, validateSerializedTransactionShape } from '../send/txBuilder.js';
import type { TxBuildPolicy } from '../send/types.js';
import type { PreparedExecution } from './preparedExecution.js';
import type { ExecutionPlan } from './types.js';
import { runPreparePreflight } from './preparePreflight.js';
import { PrepareFailureError } from './prepareFailureTypes.js';
import { decodeExecutionError } from './errorDecode.js';

export type PrepareExecutionParams = {
  executionPlan: ExecutionPlan;
  account: Address;
  nonceManager: NonceManager;
  publicClient: PublicClient;
  walletClient: WalletClient;
  txPolicy: TxBuildPolicy;
  simulationGasUsed?: bigint;
  conditionalPolicy: {
    currentL2TimestampSec: bigint;
    scheduledWindowBlocks: bigint;
    avgBlockTimeSec: bigint;
    maxStalenessSec: bigint;
    enableConditionalBlockBounds?: boolean;
    blockNumberMin?: bigint;
    blockNumberMax?: bigint;
  };
  stalePolicy: {
    maxPrepareStalenessBlocks: bigint;
    maxPrepareStalenessMs: number;
    currentBlockNumber: bigint;
    nowMs: number;
  };
  runtimeSessionId: string;
  staleRetryCount?: number;
};

export async function prepareExecution(params: PrepareExecutionParams): Promise<PreparedExecution> {
  const preflight = await runPreparePreflight({
    executionPlan: params.executionPlan,
    account: params.account,
    publicClient: params.publicClient,
    runtimeSessionId: params.runtimeSessionId,
    currentBlockNumber: params.stalePolicy.currentBlockNumber,
    nowMs: params.stalePolicy.nowMs,
    maxPrepareStalenessBlocks: params.stalePolicy.maxPrepareStalenessBlocks,
    maxPrepareStalenessMs: params.stalePolicy.maxPrepareStalenessMs,
    staleRetryCount: params.staleRetryCount
  });
  if (!preflight.ok) {
    throw new PrepareFailureError(preflight.failure);
  }

  const lease = await params.nonceManager.lease(params.account, params.executionPlan.orderHash);
  try {
    let builtTx;
    try {
      builtTx = await buildTransaction({
        plan: params.executionPlan,
        publicClient: params.publicClient,
        walletClient: params.walletClient,
        sender: params.account,
        leasedNonce: lease.nonce,
        simulationGasUsed: params.simulationGasUsed,
        estimatedGas: preflight.estimatedGas,
        policy: params.txPolicy
      });
    } catch (error) {
      const decoded = decodeExecutionError(error);
      const reason = error instanceof Error && error.name === 'SignTransactionError'
        ? 'PREPARE_SIGN_FAILED'
        : 'PREPARE_TX_BUILD_FAILED';
      throw new PrepareFailureError({
        reason,
        errorCategory: decoded.errorCategory,
        errorMessage: decoded.errorMessage,
        errorSelector: decoded.errorSelector,
        decodedErrorName: decoded.decodedErrorName,
        preflightStage: reason === 'PREPARE_SIGN_FAILED' ? 'sign' : 'tx_build',
        venue: params.executionPlan.route.venue,
        pathKind: params.executionPlan.route.pathKind,
        executionMode: params.executionPlan.selectedExecutionMode
      });
    }

    validateSerializedTransactionShape(builtTx.serializedTransaction, {
      executor: params.executionPlan.executor,
      nonce: lease.nonce,
      data: params.executionPlan.executeCalldata,
      chainId: params.executionPlan.txRequestDraft.chainId
    });

    const conditionalEnvelope: ConditionalEnvelope = deriveFreshnessEnvelopeFromSchedule({
      currentL2TimestampSec: params.conditionalPolicy.currentL2TimestampSec,
      scheduledWindowBlocks: params.conditionalPolicy.scheduledWindowBlocks,
      avgBlockTimeSec: params.conditionalPolicy.avgBlockTimeSec,
      maxStalenessSec: params.conditionalPolicy.maxStalenessSec,
      enableConditionalBlockBounds: params.conditionalPolicy.enableConditionalBlockBounds ?? false,
      blockNumberMin: params.conditionalPolicy.blockNumberMin,
      blockNumberMax: params.conditionalPolicy.blockNumberMax
    });

    return {
      orderHash: params.executionPlan.orderHash,
      executionPlan: params.executionPlan,
      txRequest: builtTx.preparedRequest,
      serializedTransaction: builtTx.serializedTransaction,
      conditionalEnvelope,
      sender: builtTx.sender,
      nonce: builtTx.nonce,
      gas: builtTx.gas,
      maxFeePerGas: builtTx.maxFeePerGas,
      maxPriorityFeePerGas: builtTx.maxPriorityFeePerGas,
      nonceLease: lease
    };
  } catch (error) {
    await params.nonceManager.release(lease, 'RELEASED');
    throw error;
  }
}
