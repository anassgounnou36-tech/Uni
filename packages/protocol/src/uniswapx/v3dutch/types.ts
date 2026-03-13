import type { Hex } from 'viem';

export type Address = `0x${string}`;

export type NonlinearDutchDecay = {
  relativeBlocks: bigint;
  relativeAmounts: bigint[];
};

export type V3DutchInput = {
  token: Address;
  startAmount: bigint;
  curve: NonlinearDutchDecay;
  maxAmount: bigint;
  adjustmentPerGweiBaseFee: bigint;
};

export type V3DutchOutput = {
  token: Address;
  startAmount: bigint;
  curve: NonlinearDutchDecay;
  recipient: Address;
  minAmount: bigint;
  adjustmentPerGweiBaseFee: bigint;
};

export type CosignerData = {
  decayStartBlock: bigint;
  exclusiveFiller: Address;
  exclusivityOverrideBps: bigint;
  inputAmount: bigint;
  outputAmounts: bigint[];
};

export type OrderInfo = {
  reactor: Address;
  swapper: Address;
  nonce: bigint;
  deadline: bigint;
  additionalValidationContract: Address;
  additionalValidationData: Hex;
};

export type V3DutchOrder = {
  info: OrderInfo;
  cosigner: Address;
  startingBaseFee: bigint;
  baseInput: V3DutchInput;
  baseOutputs: V3DutchOutput[];
  cosignerData: CosignerData;
  cosignature: Hex;
};

export type SignedV3DutchOrder = {
  order: V3DutchOrder;
  signature: Hex;
  encodedOrder: Hex;
};

export type ResolvedInput = {
  token: Address;
  amount: bigint;
  maxAmount: bigint;
};

export type ResolvedOutput = {
  token: Address;
  amount: bigint;
  recipient: Address;
};

export type ResolvedV3DutchOrder = {
  info: OrderInfo;
  input: ResolvedInput;
  outputs: ResolvedOutput[];
  sig: Hex;
  hash: Hex;
};

export type ResolveEnv = {
  blockNumberish: bigint;
  timestamp: bigint;
  basefee: bigint;
  chainId?: bigint;
  filler?: Address;
};

export type SupportReason =
  | 'SUPPORTED'
  | 'NOT_DUTCH_V3'
  | 'EXOTIC_OUTPUT_SHAPE'
  | 'OUTPUT_TOKEN_MISMATCH'
  | 'TOKEN_PAIR_NOT_ALLOWLISTED';

export type SupportPolicyV1 = {
  kind: 'v1';
  orderType: 'Dutch_V3' | string;
  allowlistedPairs: ReadonlyArray<{ inputToken: Address; outputToken: Address }>;
};

export type SupportClassification = {
  supported: boolean;
  reason: SupportReason;
};
