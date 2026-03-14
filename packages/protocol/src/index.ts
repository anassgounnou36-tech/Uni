export type UniswapXOrderEnvelope = {
  chainId: number;
  reactor: string;
  payload: string;
};

export { decodeSignedOrder } from './uniswapx/v3dutch/decode.js';
export {
  computeCosignerDigest,
  computeOrderHash,
  encodeCosignerData,
  hashNonlinearDutchDecay,
  hashOrderInfo,
  hashV3DutchInput,
  hashV3DutchOutput,
  hashV3DutchOutputs
} from './uniswapx/v3dutch/hash.js';
export { applyCosignerOverrides, verifyCosignerSignature } from './uniswapx/v3dutch/cosigner.js';
export {
  applyGasAdjustment,
  bound,
  boundedAdd,
  boundedSub,
  computeDelta,
  computeGasDeltaWei,
  mulDivDown,
  mulDivUp
} from './uniswapx/v3dutch/gasAdjustment.js';
export { decayInput, decayOutput, decayOutputs, locateCurvePosition } from './uniswapx/v3dutch/decay.js';
export { classifySupport } from './uniswapx/v3dutch/supportPolicy.js';
export { resolveAt, resolveSignedOrder, validateOrder } from './uniswapx/v3dutch/resolve.js';
export {
  REACTOR_ABI,
  encodeExecute,
  encodeExecuteBatchWithCallback,
  encodeExecuteWithCallback,
  toReactorSignedOrder
} from './uniswapx/reactor/abi.js';
export {
  ArithmeticOverflowError,
  DeadlineReachedError,
  InvalidCosignerInputError,
  InvalidCosignerOutputError,
  InvalidCosignatureError,
  InvalidDecayCurveError,
  NoExclusiveOverrideError
} from './uniswapx/v3dutch/errors.js';
export type {
  Address,
  CosignerData,
  NonlinearDutchDecay,
  OrderInfo,
  ResolveEnv,
  ResolvedInput,
  ResolvedOutput,
  ResolvedV3DutchOrder,
  SignedV3DutchOrder,
  SupportClassification,
  SupportPolicyV1,
  SupportReason,
  V3DutchInput,
  V3DutchOrder,
  V3DutchOutput
} from './uniswapx/v3dutch/types.js';
export type {
  ReactorResolvedInput,
  ReactorResolvedOrder,
  ReactorResolvedOutput,
  ReactorSignedOrder
} from './uniswapx/reactor/types.js';
