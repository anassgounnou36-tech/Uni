import type { Address, PublicClient } from 'viem';
import { UNIV3_QUOTER_V2_ABI } from './abi.js';
import type { UniV3FeeTier } from './types.js';

export type QuotedExactInputSingle = {
  amountOut: bigint;
  gasEstimate: bigint;
};

export type QuotedExactOutputSingle = {
  amountIn: bigint;
  gasEstimate: bigint;
};

export function classifyQuoteFailure(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('execution reverted')) {
      return 'REVERTED';
    }
    if (message.includes('timeout')) {
      return 'TIMEOUT';
    }
    return 'READ_ERROR';
  }
  return 'UNKNOWN_ERROR';
}

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

export async function quoteExactOutputSingle(
  client: PublicClient,
  quoter: Address,
  tokenIn: Address,
  tokenOut: Address,
  feeTier: UniV3FeeTier,
  amountOut: bigint,
  limitSqrtPriceX96: bigint = 0n
): Promise<QuotedExactOutputSingle> {
  const result = (await client.readContract({
    address: quoter,
    abi: UNIV3_QUOTER_V2_ABI,
    functionName: 'quoteExactOutputSingle',
    args: [
      {
        tokenIn,
        tokenOut,
        amount: amountOut,
        fee: feeTier,
        sqrtPriceLimitX96: limitSqrtPriceX96
      }
    ]
  })) as [bigint, bigint, number, bigint];
  const [amountIn, , , gasEstimate] = result;
  return {
    amountIn,
    gasEstimate
  };
}
