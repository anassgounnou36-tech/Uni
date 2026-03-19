export type ConstraintRejectReason = 'MIN_AMOUNT_OUT' | 'REQUIRED_OUTPUT' | 'SLIPPAGE_FLOOR' | 'PROFITABILITY_FLOOR';

export type ConstraintBindingFloor = 'SLIPPAGE_FLOOR' | 'PROFITABILITY_FLOOR';

export type ConstraintBreakdown = {
  requiredOutput: bigint;
  quotedAmountOut: bigint;
  slippageBufferOut: bigint;
  gasCostOut: bigint;
  riskBufferOut: bigint;
  profitFloorOut: bigint;
  slippageFloorOut: bigint;
  profitabilityFloorOut: bigint;
  minAmountOut: bigint;
  requiredOutputShortfallOut: bigint;
  minAmountOutShortfallOut: bigint;
  bindingFloor: ConstraintBindingFloor;
  nearMiss: boolean;
  nearMissBps: bigint;
};

export type BuildConstraintBreakdownInput = {
  requiredOutput: bigint;
  quotedAmountOut: bigint;
  slippageBufferOut: bigint;
  gasCostOut: bigint;
  riskBufferOut: bigint;
  profitFloorOut: bigint;
  nearMissBps: bigint;
};

function maxZero(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

export function buildConstraintBreakdown(input: BuildConstraintBreakdownInput): ConstraintBreakdown {
  const slippageFloorOut = input.quotedAmountOut - input.slippageBufferOut;
  const profitabilityFloorOut =
    input.requiredOutput + input.gasCostOut + input.riskBufferOut + input.profitFloorOut;
  const bindingFloor: ConstraintBindingFloor =
    profitabilityFloorOut >= slippageFloorOut ? 'PROFITABILITY_FLOOR' : 'SLIPPAGE_FLOOR';
  const minAmountOut = bindingFloor === 'PROFITABILITY_FLOOR' ? profitabilityFloorOut : slippageFloorOut;
  const requiredOutputShortfallOut = maxZero(input.requiredOutput - input.quotedAmountOut);
  const minAmountOutShortfallOut = maxZero(minAmountOut - input.quotedAmountOut);
  const nearMiss =
    minAmountOutShortfallOut > 0n &&
    input.quotedAmountOut > 0n &&
    minAmountOutShortfallOut * 10_000n <= minAmountOut * input.nearMissBps;
  return {
    requiredOutput: input.requiredOutput,
    quotedAmountOut: input.quotedAmountOut,
    slippageBufferOut: input.slippageBufferOut,
    gasCostOut: input.gasCostOut,
    riskBufferOut: input.riskBufferOut,
    profitFloorOut: input.profitFloorOut,
    slippageFloorOut,
    profitabilityFloorOut,
    minAmountOut,
    requiredOutputShortfallOut,
    minAmountOutShortfallOut,
    bindingFloor,
    nearMiss,
    nearMissBps: input.nearMissBps
  };
}
