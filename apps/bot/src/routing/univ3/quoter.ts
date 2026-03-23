import type { Address, PublicClient } from 'viem';
import { encodePacked } from 'viem';
import { UNIV3_QUOTER_V2_ABI } from './abi.js';
import type { UniV3FeeTier } from './types.js';
import { normalizeRouteEvalRpcError } from '../rpc/errors.js';
import type { RouteEvalReadCache } from '../rpc/readCache.js';
import type { RouteEvalRpcGate } from '../rpc/rpcGate.js';

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

export type QuoteFailureCategory =
  | 'RATE_LIMITED'
  | 'RPC_UNAVAILABLE'
  | 'RPC_FAILED'
  | 'QUOTE_REVERTED'
  | 'INSUFFICIENT_INPUT'
  | 'REVERTED'
  | 'TIMEOUT';

export function classifyQuoteFailure(error: unknown): QuoteFailureCategory {
  const normalized = normalizeRouteEvalRpcError(error);
  if (normalized.category === 'RATE_LIMITED') {
    return 'RATE_LIMITED';
  }
  if (normalized.category === 'RPC_UNAVAILABLE') {
    return 'RPC_UNAVAILABLE';
  }
  if (normalized.category === 'QUOTE_REVERTED') {
    return 'QUOTE_REVERTED';
  }
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
    return 'RPC_FAILED';
  }
  return 'RPC_FAILED';
}

type QuoteReadContext = {
  chainId?: bigint;
  blockNumberish?: bigint;
  readCache?: RouteEvalReadCache;
  rpcGate?: RouteEvalRpcGate;
  onCacheAccess?: (hit: boolean) => void;
  onNegativeCacheAccess?: (hit: boolean) => void;
};

async function runQuoteRead<T>(
  params: {
    client: PublicClient;
    quoter: Address;
    fn: 'quoteExactInputSingle' | 'quoteExactOutputSingle' | 'quoteExactInput' | 'quoteExactOutput';
    args: readonly unknown[];
    context?: QuoteReadContext;
    extraKey?: string;
  }
): Promise<T> {
  const chainId = params.context?.chainId ?? 42161n;
  const blockNumberish = params.context?.blockNumberish ?? 0n;
  const loader = async () =>
    params.client.readContract({
      address: params.quoter,
      abi: UNIV3_QUOTER_V2_ABI,
      functionName: params.fn,
      args: params.args
    }) as Promise<T>;
  const run = () => (params.context?.rpcGate ? params.context.rpcGate.run(loader) : loader());
  if (!params.context?.readCache) {
    return run();
  }
  const shouldMemoizeNegative = (error: unknown): boolean => {
    const failure = classifyQuoteFailure(error);
    return failure === 'QUOTE_REVERTED' || failure === 'INSUFFICIENT_INPUT' || failure === 'REVERTED';
  };
  const cached = await params.context.readCache.getOrSetNegative<T>(
    {
      chainId,
      blockNumberish,
      target: params.quoter,
      fn: params.fn,
      args: params.args,
      extraKey: params.extraKey
    },
    run,
    shouldMemoizeNegative,
    params.context.onCacheAccess,
    params.context.onNegativeCacheAccess
  );
  return cached.value;
}

export async function quoteExactInputSingle(
  client: PublicClient,
  quoter: Address,
  tokenIn: Address,
  tokenOut: Address,
  feeTier: UniV3FeeTier,
  amountIn: bigint,
  context?: QuoteReadContext
): Promise<QuotedExactInputSingle> {
  const quoteInput = {
    tokenIn,
    tokenOut,
    amountIn,
    fee: feeTier,
    sqrtPriceLimitX96: 0n
  };
  const result = await runQuoteRead<[bigint, bigint, number, bigint]>({
    client,
    quoter,
    fn: 'quoteExactInputSingle',
    args: [quoteInput],
    context
  });
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
  limitSqrtPriceX96: bigint = 0n,
  context?: QuoteReadContext
): Promise<QuotedExactOutputSingle> {
  const quoteOutputInput = {
    tokenIn,
    tokenOut,
    amount: amountOut,
    fee: feeTier,
    sqrtPriceLimitX96: limitSqrtPriceX96
  };
  const result = await runQuoteRead<[bigint, bigint, number, bigint]>({
    client,
    quoter,
    fn: 'quoteExactOutputSingle',
    args: [quoteOutputInput],
    context
  });
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

export function reverseUniV3Path(encodedPath: `0x${string}`): `0x${string}` {
  if (encodedPath.length <= 2) {
    throw new Error('UniV3 path must be non-empty');
  }
  const body = encodedPath.slice(2);
  const bodyLength = body.length / 2;
  if (bodyLength <= 20 || ((bodyLength - 20) % 23) !== 0) {
    throw new Error('UniV3 path must be token(20) + N*(fee(3)+token(20))');
  }
  const hopCount = (bodyLength - 20) / 23;
  if (hopCount > 2) {
    throw new Error('UniV3 path must have 1 or 2 hops');
  }
  const tokenCount = hopCount + 1;
  const tokens: Address[] = [];
  const fees: string[] = [];
  let offset = 0;
  for (let i = 0; i < tokenCount; i += 1) {
    const tokenHex = body.slice(offset, offset + 40);
    tokens.push(`0x${tokenHex}` as Address);
    offset += 40;
    if (i < hopCount) {
      const feeHex = body.slice(offset, offset + 6);
      fees.push(`0x${feeHex}`);
      offset += 6;
    }
  }
  const reversedTokens = tokens.slice().reverse();
  const reversedFees = fees.slice().reverse();
  const parts: Array<`0x${string}`> = [];
  for (let i = 0; i < reversedTokens.length; i += 1) {
    if (i === 0) {
      parts.push(reversedTokens[i]!);
    }
    if (i < reversedFees.length) {
      parts.push(reversedFees[i]! as `0x${string}`);
      parts.push(reversedTokens[i + 1]!);
    }
  }
  return encodePacked(Array.from({ length: parts.length }, () => 'bytes'), parts);
}

export async function quoteExactInputPath(
  client: PublicClient,
  quoter: Address,
  encodedPath: `0x${string}`,
  amountIn: bigint,
  context?: QuoteReadContext
): Promise<QuotedExactInputPath> {
  const result = await runQuoteRead<[bigint, bigint[], number[], bigint]>({
    client,
    quoter,
    fn: 'quoteExactInput',
    args: [encodedPath, amountIn],
    context,
    extraKey: encodedPath
  });
  const [amountOut, , , gasUnitsEstimate] = result;
  return { amountOut, gasUnitsEstimate };
}

export async function quoteExactOutputPath(
  client: PublicClient,
  quoter: Address,
  encodedPath: `0x${string}`,
  amountOut: bigint,
  context?: QuoteReadContext
): Promise<QuotedExactOutputPath> {
  const result = await runQuoteRead<[bigint, bigint[], number[], bigint]>({
    client,
    quoter,
    fn: 'quoteExactOutput',
    args: [encodedPath, amountOut],
    context,
    extraKey: encodedPath
  });
  const [amountIn, , , gasUnitsEstimate] = result;
  return { amountIn, gasUnitsEstimate };
}
