import { decodeSignedOrder } from './decode.js';
import { decayInput, decayOutputs } from './decay.js';
import { DeadlineReachedError, NoExclusiveOverrideError } from './errors.js';
import { computeOrderHash } from './hash.js';
import { applyCosignerOverrides, verifyCosignerSignature } from './cosigner.js';
import { applyGasAdjustment, mulDivUp } from './gasAdjustment.js';
import type { ResolveEnv, ResolvedV3DutchOrder, SignedV3DutchOrder, V3DutchOrder } from './types.js';

function hasFillingRights(exclusive: `0x${string}`, exclusivityEnd: bigint, currentPosition: bigint, filler: `0x${string}`): boolean {
  return (
    exclusive === '0x0000000000000000000000000000000000000000' ||
    currentPosition > exclusivityEnd ||
    exclusive.toLowerCase() === filler.toLowerCase()
  );
}

function applyExclusiveOverride(resolvedOrder: ResolvedV3DutchOrder, order: V3DutchOrder, env: ResolveEnv): ResolvedV3DutchOrder {
  const filler = env.filler ?? '0x0000000000000000000000000000000000000000';
  const hasRights = hasFillingRights(
    order.cosignerData.exclusiveFiller,
    order.cosignerData.decayStartBlock,
    env.blockNumberish,
    filler
  );

  if (hasRights) {
    return resolvedOrder;
  }

  if (order.cosignerData.exclusivityOverrideBps === 0n) {
    throw new NoExclusiveOverrideError();
  }

  const bps = 10_000n + order.cosignerData.exclusivityOverrideBps;
  return {
    ...resolvedOrder,
    outputs: resolvedOrder.outputs.map((output) => ({
      ...output,
      amount: mulDivUp(output.amount, bps, 10_000n)
    }))
  };
}

export async function validateOrder(orderHash: `0x${string}`, order: V3DutchOrder, env: ResolveEnv): Promise<void> {
  if (order.info.deadline < env.timestamp) {
    throw new DeadlineReachedError();
  }

  await verifyCosignerSignature(orderHash, order, env);
}

export async function resolveAt(order: V3DutchOrder, env: ResolveEnv, signature: `0x${string}` = '0x'): Promise<ResolvedV3DutchOrder> {
  const orderHash = computeOrderHash(order);
  await validateOrder(orderHash, order, env);

  const withCosigner = applyCosignerOverrides(order);
  const withGasAdjustment = applyGasAdjustment(withCosigner, env.basefee);

  const resolved: ResolvedV3DutchOrder = {
    info: withGasAdjustment.info,
    input: decayInput(withGasAdjustment.baseInput, withGasAdjustment.cosignerData.decayStartBlock, env.blockNumberish),
    outputs: decayOutputs(
      withGasAdjustment.baseOutputs,
      withGasAdjustment.cosignerData.decayStartBlock,
      env.blockNumberish
    ),
    sig: signature,
    hash: orderHash
  };

  return applyExclusiveOverride(resolved, withGasAdjustment, env);
}

export async function resolveSignedOrder(
  encodedOrder: `0x${string}`,
  signature: `0x${string}`,
  env: ResolveEnv
): Promise<ResolvedV3DutchOrder> {
  const decoded: SignedV3DutchOrder = decodeSignedOrder(encodedOrder, signature);
  return resolveAt(decoded.order, env, decoded.signature);
}
