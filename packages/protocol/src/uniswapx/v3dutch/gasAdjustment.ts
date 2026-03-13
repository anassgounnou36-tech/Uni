import { ArithmeticOverflowError } from './errors.js';
import type { V3DutchOrder } from './types.js';

const INT256_MIN = -(1n << 255n);
const UINT256_MAX = (1n << 256n) - 1n;

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function mulDivDown(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b) / denominator;
}

export function mulDivUp(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b + denominator - 1n) / denominator;
}

export function bound(value: bigint, minValue: bigint, maxValue: bigint): bigint {
  return min(max(value, minValue), maxValue);
}

export function boundedSub(a: bigint, b: bigint, minValue: bigint, maxValue: bigint): bigint {
  if (b === INT256_MIN) {
    throw new ArithmeticOverflowError();
  }

  let result: bigint;
  if (b < 0n) {
    const absB = -b;
    if (UINT256_MAX - absB < a) {
      return maxValue;
    }
    result = a + absB;
  } else {
    if (a < b) {
      return minValue;
    }
    result = a - b;
  }

  return bound(result, minValue, maxValue);
}

export function boundedAdd(a: bigint, b: bigint, minValue: bigint, maxValue: bigint): bigint {
  if (b === INT256_MIN) {
    throw new ArithmeticOverflowError();
  }
  return boundedSub(a, -b, minValue, maxValue);
}

export function computeGasDeltaWei(startingBaseFee: bigint, basefee: bigint): bigint {
  return basefee - startingBaseFee;
}

export function computeDelta(adjustmentPerGweiBaseFee: bigint, gasDeltaWei: bigint): bigint {
  if (gasDeltaWei >= 0n) {
    return mulDivDown(adjustmentPerGweiBaseFee, gasDeltaWei, 1_000_000_000n);
  }
  return -mulDivUp(adjustmentPerGweiBaseFee, -gasDeltaWei, 1_000_000_000n);
}

export function applyGasAdjustment(order: V3DutchOrder, basefee: bigint): V3DutchOrder {
  const gasDeltaWei = computeGasDeltaWei(order.startingBaseFee, basefee);
  const nextOrder: V3DutchOrder = {
    ...order,
    baseInput: { ...order.baseInput },
    baseOutputs: order.baseOutputs.map((output) => ({ ...output }))
  };

  if (nextOrder.baseInput.adjustmentPerGweiBaseFee !== 0n) {
    const inputDelta = computeDelta(nextOrder.baseInput.adjustmentPerGweiBaseFee, gasDeltaWei);
    nextOrder.baseInput.startAmount = boundedAdd(
      nextOrder.baseInput.startAmount,
      inputDelta,
      0n,
      nextOrder.baseInput.maxAmount
    );
  }

  for (let i = 0; i < nextOrder.baseOutputs.length; i += 1) {
    const output = nextOrder.baseOutputs[i];
    if (output.adjustmentPerGweiBaseFee !== 0n) {
      const outputDelta = computeDelta(output.adjustmentPerGweiBaseFee, gasDeltaWei);
      nextOrder.baseOutputs[i] = {
        ...output,
        startAmount: boundedSub(output.startAmount, outputDelta, output.minAmount, UINT256_MAX)
      };
    }
  }

  return nextOrder;
}
