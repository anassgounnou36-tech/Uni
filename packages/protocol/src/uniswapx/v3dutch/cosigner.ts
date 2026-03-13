import { recoverAddress } from 'viem';
import { InvalidCosignerInputError, InvalidCosignerOutputError, InvalidCosignatureError } from './errors.js';
import { computeCosignerDigest } from './hash.js';
import type { ResolveEnv, V3DutchOrder } from './types.js';

export function applyCosignerOverrides(order: V3DutchOrder): V3DutchOrder {
  const nextOrder: V3DutchOrder = {
    ...order,
    baseInput: { ...order.baseInput },
    baseOutputs: order.baseOutputs.map((output) => ({ ...output }))
  };

  if (nextOrder.cosignerData.inputAmount !== 0n) {
    if (nextOrder.cosignerData.inputAmount > nextOrder.baseInput.startAmount) {
      throw new InvalidCosignerInputError();
    }
    nextOrder.baseInput.startAmount = nextOrder.cosignerData.inputAmount;
  }

  if (nextOrder.cosignerData.outputAmounts.length !== nextOrder.baseOutputs.length) {
    throw new InvalidCosignerOutputError();
  }

  for (let i = 0; i < nextOrder.baseOutputs.length; i += 1) {
    const outputAmount = nextOrder.cosignerData.outputAmounts[i] ?? 0n;
    if (outputAmount !== 0n) {
      if (outputAmount < nextOrder.baseOutputs[i].startAmount) {
        throw new InvalidCosignerOutputError();
      }
      nextOrder.baseOutputs[i] = { ...nextOrder.baseOutputs[i], startAmount: outputAmount };
    }
  }

  return nextOrder;
}

export async function verifyCosignerSignature(orderHash: `0x${string}`, order: V3DutchOrder, env: ResolveEnv): Promise<void> {
  const chainId = env.chainId ?? 42161n;
  const digest = computeCosignerDigest(orderHash, chainId, order.cosignerData);
  try {
    const signer = await recoverAddress({ hash: digest, signature: order.cosignature });
    if (signer.toLowerCase() !== order.cosigner.toLowerCase()) {
      throw new InvalidCosignatureError();
    }
  } catch {
    throw new InvalidCosignatureError();
  }
}
