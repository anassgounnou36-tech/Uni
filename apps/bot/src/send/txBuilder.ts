import type { SimulatedTransaction } from '../sim/forkSimService.js';

export type BuiltTransaction = {
  from: `0x${string}`;
  to: `0x${string}`;
  data: `0x${string}`;
  value: `0x${string}`;
  nonce: `0x${string}`;
  chainId: `0x${string}`;
  gas: `0x${string}`;
  maxFeePerGas: `0x${string}`;
  maxPriorityFeePerGas: `0x${string}`;
};

export type BuildTxParams = {
  from: `0x${string}`;
  chainId: bigint;
  nonce: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  simulationTx: SimulatedTransaction;
  maxGasCeiling?: bigint;
};

function asHex(value: bigint): `0x${string}` {
  return `0x${value.toString(16)}` as `0x${string}`;
}

export function buildTransaction(params: BuildTxParams): BuiltTransaction {
  if (params.maxGasCeiling !== undefined && params.gas > params.maxGasCeiling) {
    throw new Error('gas exceeds configured ceiling');
  }
  if (params.maxPriorityFeePerGas > params.maxFeePerGas) {
    throw new Error('maxPriorityFeePerGas cannot exceed maxFeePerGas');
  }

  return {
    from: params.from,
    to: params.simulationTx.to,
    data: params.simulationTx.data,
    value: asHex(params.simulationTx.value),
    nonce: asHex(params.nonce),
    chainId: asHex(params.chainId),
    gas: asHex(params.gas),
    maxFeePerGas: asHex(params.maxFeePerGas),
    maxPriorityFeePerGas: asHex(params.maxPriorityFeePerGas)
  };
}
