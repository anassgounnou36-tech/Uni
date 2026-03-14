import type { Address, Hex } from 'viem';

export type BuiltTransaction = {
  preparedRequest: {
    from: Address;
    to: Address;
    data: Hex;
    value: bigint;
    nonce: bigint;
    gas: bigint;
    chainId: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    type: 'eip1559';
  };
  serializedTransaction: Hex;
  sender: Address;
  nonce: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  target: Address;
  data: Hex;
  value: bigint;
  txHash?: Hex;
};

export type TxBuildPolicy = {
  gasHeadroomBps: bigint;
  maxGasCeiling: bigint;
  maxFeePerGasOverride?: bigint;
  maxPriorityFeePerGasOverride?: bigint;
};
