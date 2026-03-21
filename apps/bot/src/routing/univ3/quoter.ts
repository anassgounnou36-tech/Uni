import type { Address, PublicClient } from 'viem';
import { encodePacked } from 'viem';
import { UNIV3_QUOTER_V2_ABI } from './abi.js';
import type { UniV3FeeTier } from './types.js';

export type QuotedExactInputSingle = {
  amountOut: bigint;
  gasUnitsEstimate: bigint;
};

export type QuotedExactOutputSingle = {
  amountIn: bigint;
  gasUnitsEstimate: bigint;
};

export type QuotedExactInputPath = {
  amountOut: bigint;
  gasUnitsEstimate: bigint;
};

export type QuotedExactOutputPath = {
  amountIn: bigint;
  gasUnitsEstimate: bigint;
};

export function classifyQuoteFailure(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('too much requested') || message.includes('insufficient input amount')) {
      return 'INSUFFICIENT_INPUT';
    }
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
  const [amountOut, , , gasUnitsEstimate] = result;

  return {
    amountOut,
    gasUnitsEstimate
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
  const [amountIn, , , gasUnitsEstimate] = result;
  return {
    amountIn,
    gasUnitsEstimate
  };
}

export function encodeUniV3Path(legs: ReadonlyArray<{ tokenIn: Address; fee: UniV3FeeTier; tokenOut: Address }>): `0x${string}` {
  if (legs.length === 0 || legs.length > 2) {
    throw new Error('UniV3 path must have 1 or 2 legs (direct or 2-hop)');
  }
  const parts: Array<`0x${string}`> = [];
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i]!;
    if (i === 0) {
      parts.push(leg.tokenIn);
    }
    const feeHex = `0x${leg.fee.toString(16).padStart(6, '0')}` as `0x${string}`;
    parts.push(feeHex);
    parts.push(leg.tokenOut);
  }
  return encodePacked(Array.from({ length: parts.length }, () => 'bytes'), parts);
}

export async function quoteExactInputPath(
  client: PublicClient,
  quoter: Address,
  encodedPath: `0x${string}`,
  amountIn: bigint
): Promise<QuotedExactInputPath> {
  const result = (await client.readContract({
    address: quoter,
    abi: UNIV3_QUOTER_V2_ABI,
    functionName: 'quoteExactInput',
    args: [encodedPath, amountIn]
  })) as [bigint, bigint[], number[], bigint];
  const [amountOut, , , gasUnitsEstimate] = result;
  return { amountOut, gasUnitsEstimate };
}

export async function quoteExactOutputPath(
  client: PublicClient,
  quoter: Address,
  encodedPath: `0x${string}`,
  amountOut: bigint
): Promise<QuotedExactOutputPath> {
  const result = (await client.readContract({
    address: quoter,
    abi: UNIV3_QUOTER_V2_ABI,
    functionName: 'quoteExactOutput',
    args: [encodedPath, amountOut]
  })) as [bigint, bigint[], number[], bigint];
  const [amountIn, , , gasUnitsEstimate] = result;
  return { amountIn, gasUnitsEstimate };
}
