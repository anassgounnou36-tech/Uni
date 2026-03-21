import type { ExactOutputViability } from './exactOutputTypes.js';
import type { Address } from 'viem';
import type { RoutePathKind } from './pathTypes.js';

export type HedgeGapClass = 'EXACT' | 'TINY' | 'SMALL' | 'MEDIUM' | 'LARGE' | 'HUGE' | 'NOT_APPLICABLE';

export type HedgeGapSummary = {
  pathKind?: RoutePathKind;
  hopCount?: 1 | 2;
  bridgeToken?: Address;
  pathDescriptor?: string;
  requiredOutput: bigint;
  quotedAmountOut: bigint;
  outputCoverageBps: bigint;
  requiredOutputShortfallOut: bigint;
  minAmountOutShortfallOut?: bigint;
  inputDeficit?: bigint;
  inputSlack?: bigint;
  gapClass: HedgeGapClass;
  nearMiss: boolean;
  nearMissBps: bigint;
};

export type BuildHedgeGapSummaryInput = {
  pathKind?: RoutePathKind;
  hopCount?: 1 | 2;
  bridgeToken?: Address;
  pathDescriptor?: string;
  requiredOutput: bigint;
  quotedAmountOut: bigint;
  minAmountOut?: bigint;
  exactOutputViability?: ExactOutputViability;
  nearMiss?: boolean;
  nearMissBps?: bigint;
};

function maxZero(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

export function computeOutputCoverageBps(requiredOutput: bigint, quotedAmountOut: bigint): bigint {
  if (requiredOutput <= 0n) {
    return 10_000n;
  }
  return (quotedAmountOut * 10_000n) / requiredOutput;
}

export function classifyHedgeGap(input: {
  requiredOutputShortfallOut: bigint;
  outputCoverageBps: bigint;
  nearMiss: boolean;
}): HedgeGapClass {
  if (input.requiredOutputShortfallOut === 0n) {
    return 'EXACT';
  }
  if (input.nearMiss && input.outputCoverageBps >= 9_990n) {
    return 'TINY';
  }
  if (input.outputCoverageBps >= 9_950n) {
    return 'SMALL';
  }
  if (input.outputCoverageBps >= 9_800n) {
    return 'MEDIUM';
  }
  if (input.outputCoverageBps >= 9_000n) {
    return 'LARGE';
  }
  if (input.outputCoverageBps >= 0n) {
    return 'HUGE';
  }
  return 'NOT_APPLICABLE';
}

export function buildHedgeGapSummary(input: BuildHedgeGapSummaryInput): HedgeGapSummary {
  const outputCoverageBps = computeOutputCoverageBps(input.requiredOutput, input.quotedAmountOut);
  const requiredOutputShortfallOut = maxZero(input.requiredOutput - input.quotedAmountOut);
  const minAmountOutShortfallOut =
    input.minAmountOut === undefined ? undefined : maxZero(input.minAmountOut - input.quotedAmountOut);
  const nearMiss = input.nearMiss ?? false;
  const nearMissBps = input.nearMissBps ?? 0n;
  return {
    pathKind: input.pathKind,
    hopCount: input.hopCount,
    bridgeToken: input.bridgeToken,
    pathDescriptor: input.pathDescriptor,
    requiredOutput: input.requiredOutput,
    quotedAmountOut: input.quotedAmountOut,
    outputCoverageBps,
    requiredOutputShortfallOut,
    minAmountOutShortfallOut,
    inputDeficit: input.exactOutputViability?.inputDeficit,
    inputSlack: input.exactOutputViability?.inputSlack,
    gapClass: classifyHedgeGap({ requiredOutputShortfallOut, outputCoverageBps, nearMiss }),
    nearMiss,
    nearMissBps
  };
}
