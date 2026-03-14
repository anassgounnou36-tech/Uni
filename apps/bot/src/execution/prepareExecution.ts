import type { Address, PublicClient, WalletClient } from 'viem';
import { buildFreshnessGuard, deriveTimestampMax, type ConditionalEnvelope } from '../send/conditional.js';
import { NonceManager } from '../send/nonceManager.js';
import { buildTransaction, validateSerializedTransactionShape } from '../send/txBuilder.js';
import type { TxBuildPolicy } from '../send/types.js';
import type { PreparedExecution } from './preparedExecution.js';
import type { ExecutionPlan } from './types.js';

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
    blockNumberMax?: bigint;
  };
};

export async function prepareExecution(params: PrepareExecutionParams): Promise<PreparedExecution> {
  const lease = await params.nonceManager.lease(params.account, params.executionPlan.orderHash);
  try {
    const builtTx = await buildTransaction({
      plan: params.executionPlan,
      publicClient: params.publicClient,
      walletClient: params.walletClient,
      sender: params.account,
      leasedNonce: lease.nonce,
      simulationGasUsed: params.simulationGasUsed,
      policy: params.txPolicy
    });

    validateSerializedTransactionShape(builtTx.serializedTransaction, {
      executor: params.executionPlan.executor,
      nonce: lease.nonce,
      data: params.executionPlan.executeCalldata,
      chainId: params.executionPlan.txRequestDraft.chainId
    });

    const timestampMax = deriveTimestampMax({
      currentL2TimestampSec: params.conditionalPolicy.currentL2TimestampSec,
      scheduledWindowBlocks: params.conditionalPolicy.scheduledWindowBlocks,
      avgBlockTimeSec: params.conditionalPolicy.avgBlockTimeSec,
      maxStalenessSec: params.conditionalPolicy.maxStalenessSec
    });

    const conditionalEnvelope: ConditionalEnvelope = buildFreshnessGuard(
      timestampMax,
      params.conditionalPolicy.blockNumberMax
    );

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
