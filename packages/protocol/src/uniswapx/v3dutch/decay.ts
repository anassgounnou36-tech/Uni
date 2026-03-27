import { InvalidDecayCurveError } from './errors.js';
import { bound, boundedSub, mulDivDown, mulDivUp } from './gasAdjustment.js';
import type {
  NonlinearDutchDecay,
  ResolvedInput,
  ResolvedOutput,
  V3DutchInput,
  V3DutchOrder,
  V3DutchOutput
} from './types.js';

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function getPackedUint16(value: bigint, index: number): bigint {
  return (value >> BigInt(index * 16)) & 0xffffn;
}

export function getCurvePoints(curve: NonlinearDutchDecay): bigint[] {
  return curve.relativeAmounts.map((_, index) => getPackedUint16(curve.relativeBlocks, index));
}

export function getCurveEndRelativeBlock(curve: NonlinearDutchDecay): bigint {
  const points = getCurvePoints(curve);
  if (points.length === 0) {
    return 0n;
  }
  return points.reduce((max, point) => (point > max ? point : max), 0n);
}

export function getOrderDecayEndBlock(order: V3DutchOrder): bigint {
  const inputEnd = getCurveEndRelativeBlock(order.baseInput.curve);
  const outputEnd = order.baseOutputs.reduce((max, output) => {
    const end = getCurveEndRelativeBlock(output.curve);
    return end > max ? end : max;
  }, 0n);
  const maxRelative = inputEnd > outputEnd ? inputEnd : outputEnd;
  return order.cosignerData.decayStartBlock + maxRelative;
}

export function locateCurvePosition(
  curve: NonlinearDutchDecay,
  currentRelativeBlock: bigint
): {
  startPoint: bigint;
  endPoint: bigint;
  startAmount: bigint;
  endAmount: bigint;
} {
  const firstPoint = getPackedUint16(curve.relativeBlocks, 0);
  if (firstPoint >= currentRelativeBlock) {
    return {
      startPoint: 0n,
      endPoint: firstPoint,
      startAmount: 0n,
      endAmount: curve.relativeAmounts[0] ?? 0n
    };
  }

  const lastIndex = curve.relativeAmounts.length - 1;
  for (let i = 1; i <= lastIndex; i += 1) {
    const point = getPackedUint16(curve.relativeBlocks, i);
    if (point >= currentRelativeBlock) {
      return {
        startPoint: getPackedUint16(curve.relativeBlocks, i - 1),
        endPoint: point,
        startAmount: curve.relativeAmounts[i - 1] ?? 0n,
        endAmount: curve.relativeAmounts[i] ?? 0n
      };
    }
  }

  const lastPoint = getPackedUint16(curve.relativeBlocks, lastIndex);
  const lastAmount = curve.relativeAmounts[lastIndex] ?? 0n;
  return {
    startPoint: lastPoint,
    endPoint: lastPoint,
    startAmount: lastAmount,
    endAmount: lastAmount
  };
}

function v3LinearInputDecay(
  startPoint: bigint,
  endPoint: bigint,
  currentPoint: bigint,
  startAmount: bigint,
  endAmount: bigint
): bigint {
  if (currentPoint >= endPoint) {
    return endAmount;
  }

  const elapsed = currentPoint - startPoint;
  const duration = endPoint - startPoint;

  const delta =
    endAmount < startAmount
      ? -mulDivDown(startAmount - endAmount, elapsed, duration)
      : mulDivUp(endAmount - startAmount, elapsed, duration);

  return startAmount + delta;
}

function v3LinearOutputDecay(
  startPoint: bigint,
  endPoint: bigint,
  currentPoint: bigint,
  startAmount: bigint,
  endAmount: bigint
): bigint {
  if (currentPoint >= endPoint) {
    return endAmount;
  }

  const elapsed = currentPoint - startPoint;
  const duration = endPoint - startPoint;

  const delta =
    endAmount < startAmount
      ? -mulDivUp(startAmount - endAmount, elapsed, duration)
      : mulDivDown(endAmount - startAmount, elapsed, duration);

  return startAmount + delta;
}

function decayAmount(
  curve: NonlinearDutchDecay,
  startAmount: bigint,
  decayStartBlock: bigint,
  blockNumberish: bigint,
  minAmount: bigint,
  maxAmount: bigint,
  decayFn: (startPoint: bigint, endPoint: bigint, currentPoint: bigint, start: bigint, end: bigint) => bigint
): bigint {
  if (curve.relativeAmounts.length > 16) {
    throw new InvalidDecayCurveError();
  }

  if (decayStartBlock >= blockNumberish || curve.relativeAmounts.length === 0) {
    return bound(startAmount, minAmount, maxAmount);
  }

  const blockDelta = min(blockNumberish - decayStartBlock, 65535n);
  const { startPoint, endPoint, startAmount: relStart, endAmount: relEnd } = locateCurvePosition(curve, blockDelta);
  const curveDelta = decayFn(startPoint, endPoint, blockDelta, relStart, relEnd);

  return boundedSub(startAmount, curveDelta, minAmount, maxAmount);
}

export function decayInput(input: V3DutchInput, decayStartBlock: bigint, blockNumberish: bigint): ResolvedInput {
  return {
    token: input.token,
    amount: decayAmount(
      input.curve,
      input.startAmount,
      decayStartBlock,
      blockNumberish,
      0n,
      input.maxAmount,
      v3LinearInputDecay
    ),
    maxAmount: input.maxAmount
  };
}

export function decayOutput(output: V3DutchOutput, decayStartBlock: bigint, blockNumberish: bigint): ResolvedOutput {
  return {
    token: output.token,
    amount: decayAmount(
      output.curve,
      output.startAmount,
      decayStartBlock,
      blockNumberish,
      output.minAmount,
      (1n << 256n) - 1n,
      v3LinearOutputDecay
    ),
    recipient: output.recipient
  };
}

export function decayOutputs(outputs: V3DutchOutput[], decayStartBlock: bigint, blockNumberish: bigint): ResolvedOutput[] {
  return outputs.map((output) => decayOutput(output, decayStartBlock, blockNumberish));
}
