import type { Address, OrderInfo } from '../v3dutch/types.js';

export type ReactorSignedOrder = {
  order: `0x${string}`;
  sig: `0x${string}`;
};

export type ReactorResolvedInput = {
  token: Address;
  amount: bigint;
  maxAmount: bigint;
};

export type ReactorResolvedOutput = {
  token: Address;
  amount: bigint;
  recipient: Address;
};

export type ReactorResolvedOrder = {
  info: OrderInfo;
  input: ReactorResolvedInput;
  outputs: ReactorResolvedOutput[];
  sig: `0x${string}`;
  hash: `0x${string}`;
};
