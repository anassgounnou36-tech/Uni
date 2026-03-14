import type { Address, PublicClient, TestClient, WalletClient } from 'viem';
import type { PreparedExecution } from '../execution/preparedExecution.js';
import type { OrderReasonCode } from '../store/types.js';

export type ForkClients = {
  publicClient: PublicClient;
  walletClient: WalletClient;
  testClient: TestClient;
  sender: Address;
};

export type SimTxRequest = {
  chainId: bigint;
  from: Address;
  to: Address;
  nonce: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  value: bigint;
  data: `0x${string}`;
};

export type ForkSimResult = {
  ok: boolean;
  reason: OrderReasonCode;
  preparedExecution: PreparedExecution;
  txRequest: SimTxRequest;
  serializedTransaction: `0x${string}`;
  gasUsed?: bigint;
  details?: string;
  receipt?: {
    status: 'success' | 'reverted';
    transactionHash: `0x${string}`;
    gasUsed: bigint;
  };
};
