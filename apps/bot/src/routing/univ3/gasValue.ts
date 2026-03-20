import type { Address, PublicClient } from 'viem';
import { discoverPool } from './poolDiscovery.js';
import { quoteExactInputSingle } from './quoter.js';
import type { UniV3FeeTier } from './types.js';

export const ARBITRUM_WETH: Address = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';

export type GasConversionParams = {
  client: PublicClient;
  factory: Address;
  quoter: Address;
  tokenOut: Address;
  gasCostWei: bigint;
  gasWei?: bigint;
  supportedFeeTiers: readonly UniV3FeeTier[];
};

export type GasConversionResult =
  | { ok: true; gasCostOut: bigint; feeTierUsed?: UniV3FeeTier }
  | { ok: false; reason: 'NOT_PRICEABLE_GAS' };

export async function convertGasWeiToTokenOut(params: GasConversionParams): Promise<GasConversionResult> {
  const gasCostWei = (params.gasCostWei > 0n ? params.gasCostWei : params.gasWei) ?? 0n;
  if (gasCostWei <= 0n) {
    return { ok: true, gasCostOut: 0n };
  }

  if (params.tokenOut.toLowerCase() === ARBITRUM_WETH.toLowerCase()) {
    return { ok: true, gasCostOut: gasCostWei };
  }

  let best: { amountOut: bigint; feeTier: UniV3FeeTier } | undefined;
  for (const feeTier of params.supportedFeeTiers) {
    const pool = await discoverPool(params.client, params.factory, ARBITRUM_WETH, params.tokenOut, feeTier);
    if (!pool) {
      continue;
    }

    try {
      const quote = await quoteExactInputSingle(
        params.client,
        params.quoter,
        ARBITRUM_WETH,
        params.tokenOut,
        feeTier,
        gasCostWei
      );
      if (!best || quote.amountOut > best.amountOut) {
        best = { amountOut: quote.amountOut, feeTier };
      }
    } catch {
      continue;
    }
  }

  if (!best) {
    return { ok: false, reason: 'NOT_PRICEABLE_GAS' };
  }

  return { ok: true, gasCostOut: best.amountOut, feeTierUsed: best.feeTier };
}
