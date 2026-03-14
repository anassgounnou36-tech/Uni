import type { ConditionalEnvelope } from '../send/conditional.js';
import type { NonceLease } from '../send/nonceManager.js';
import type { BuiltTransaction } from '../send/types.js';
import type { ExecutionPlan } from './types.js';

export type PreparedExecution = {
  orderHash: `0x${string}`;
  executionPlan: ExecutionPlan;
  txRequest: BuiltTransaction['preparedRequest'];
  serializedTransaction: `0x${string}`;
  conditionalEnvelope: ConditionalEnvelope;
  sender: `0x${string}`;
  nonce: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonceLease: NonceLease;
};
