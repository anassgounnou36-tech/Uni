import { keccak256, parseTransaction, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import type { ExecutionPlan } from '../execution/types.js';
import type { BuiltTransaction, TxBuildPolicy } from './types.js';

export type BuildTxParams = {
  plan: ExecutionPlan;
  publicClient: PublicClient;
  walletClient: WalletClient;
  sender: Address;
  leasedNonce: bigint;
  simulationGasUsed?: bigint;
  policy: TxBuildPolicy;
};

function applyGasHeadroom(baseGas: bigint, headroomBps: bigint): bigint {
  return (baseGas * (10_000n + headroomBps)) / 10_000n;
}

function nonceToNumber(nonce: bigint): number {
  // viem prepareTransactionRequest currently expects nonce as number.
  // We guard conversion to prevent precision loss outside safe integer range.
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  if (nonce > maxSafe) {
    throw new Error(`nonce ${nonce} exceeds MAX_SAFE_INTEGER for transaction preparation`);
  }
  return Number(nonce);
}

export function validateSerializedTransactionShape(
  serializedTransaction: Hex,
  expected: { executor: Address; nonce: bigint; data: Hex; chainId: bigint }
): void {
  const parsed = parseTransaction(serializedTransaction);
  if (!parsed.to || parsed.to.toLowerCase() !== expected.executor.toLowerCase()) {
    throw new Error('serialized tx destination mismatch');
  }
  const parsedNonce = parsed.nonce === undefined ? undefined : BigInt(parsed.nonce);
  if (parsedNonce !== expected.nonce) {
    throw new Error('serialized tx nonce mismatch');
  }
  if (parsed.data?.toLowerCase() !== expected.data.toLowerCase()) {
    throw new Error('serialized tx calldata mismatch');
  }
  const parsedChainId = parsed.chainId === undefined ? undefined : BigInt(parsed.chainId);
  if (parsedChainId !== expected.chainId) {
    throw new Error('serialized tx chainId mismatch');
  }
  if (parsed.gas === undefined || parsed.maxFeePerGas === undefined || parsed.maxPriorityFeePerGas === undefined) {
    throw new Error('serialized tx missing gas or fee fields');
  }
}

export async function buildTransaction(params: BuildTxParams): Promise<BuiltTransaction> {
  const baseGas = params.simulationGasUsed ??
    (await params.publicClient.estimateGas({
      account: params.sender,
      to: params.plan.executor,
      data: params.plan.executeCalldata,
      value: 0n
    }));
  const gas = applyGasHeadroom(baseGas, params.policy.gasHeadroomBps);
  if (gas > params.policy.maxGasCeiling) {
    throw new Error(`gas ${gas} exceeds configured ceiling ${params.policy.maxGasCeiling}`);
  }

  const feeEstimate = await params.publicClient.estimateFeesPerGas();
  const maxFeePerGas = params.policy.maxFeePerGasOverride ?? feeEstimate.maxFeePerGas ?? 0n;
  const maxPriorityFeePerGas = params.policy.maxPriorityFeePerGasOverride ?? feeEstimate.maxPriorityFeePerGas ?? 0n;
  if (maxFeePerGas <= 0n || maxPriorityFeePerGas <= 0n) {
    throw new Error('fee estimates must be greater than zero');
  }
  if (maxPriorityFeePerGas > maxFeePerGas) {
    throw new Error('maxPriorityFeePerGas cannot exceed maxFeePerGas');
  }

  const prepared = await params.walletClient.prepareTransactionRequest({
    account: params.walletClient.account!,
    chain: params.walletClient.chain,
    to: params.plan.executor,
    data: params.plan.executeCalldata,
    value: 0n,
    nonce: nonceToNumber(params.leasedNonce),
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    type: 'eip1559'
  });

  const serializedTransaction = await params.walletClient.signTransaction({
    account: params.walletClient.account!,
    chain: params.walletClient.chain,
    nonce: prepared.nonce!,
    to: prepared.to!,
    data: prepared.data!,
    value: prepared.value ?? 0n,
    gas: prepared.gas!,
    maxFeePerGas: prepared.maxFeePerGas!,
    maxPriorityFeePerGas: prepared.maxPriorityFeePerGas!,
    type: 'eip1559'
  });

  validateSerializedTransactionShape(serializedTransaction, {
    executor: params.plan.executor,
    nonce: params.leasedNonce,
    data: params.plan.executeCalldata,
    chainId: params.plan.txRequestDraft.chainId
  });

  return {
    preparedRequest: {
      from: params.sender,
      to: prepared.to!,
      data: prepared.data!,
      value: prepared.value ?? 0n,
      nonce: BigInt(prepared.nonce!),
      gas: prepared.gas!,
      chainId: BigInt(prepared.chainId!),
      maxFeePerGas: prepared.maxFeePerGas!,
      maxPriorityFeePerGas: prepared.maxPriorityFeePerGas!,
      type: 'eip1559'
    },
    serializedTransaction,
    sender: params.sender,
    nonce: BigInt(prepared.nonce!),
    gas: prepared.gas!,
    maxFeePerGas: prepared.maxFeePerGas!,
    maxPriorityFeePerGas: prepared.maxPriorityFeePerGas!,
    target: prepared.to!,
    data: prepared.data!,
    value: prepared.value ?? 0n,
    txHash: keccak256(serializedTransaction)
  };
}
