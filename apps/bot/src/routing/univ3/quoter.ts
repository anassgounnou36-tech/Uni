import type { Address, PublicClient } from 'viem';
import { UNIV3_QUOTER_V2_ABI } from './abi.js';
import type { UniV3FeeTier } from './types.js';

export type QuotedExactInputSingle = {
  amountOut: bigint;
  gasEstimate: bigint;
};

export async function quoteExactInputSingle(
  client: PublicClient,
  quoter: Address,
  tokenIn: Address,
  tokenOut: Address,
  feeTier: UniV3FeeTier,
  amountIn: bigint
): Promise<QuotedExactInputSingle> {
  const result = (await client.readContract({
    address: quoter,
    abi: UNIV3_QUOTER_V2_ABI,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        tokenIn,
        tokenOut,
        amountIn,
        fee: feeTier,
        sqrtPriceLimitX96: 0n
      }
    ]
  })) as [bigint, bigint, number, bigint];
  const [amountOut, , , gasEstimate] = result;

  return {
    amountOut,
    gasEstimate
  };
}
