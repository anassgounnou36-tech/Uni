import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { UniV3RoutePlanner } from '../src/routing/univ3/routePlanner.js';

type ContractCall = {
  functionName: string;
  args?: readonly unknown[];
};

function makeClient(resolver: (call: ContractCall) => unknown): PublicClient {
  return {
    readContract: async (request: ContractCall) => resolver(request)
  } as unknown as PublicClient;
}

const tokenIn = '0x0000000000000000000000000000000000000001';
const tokenOut = '0x0000000000000000000000000000000000000002';
const factory = '0x0000000000000000000000000000000000000010';
const quoter = '0x0000000000000000000000000000000000000020';
const pool500 = '0x0000000000000000000000000000000000000500';
const pool3000 = '0x0000000000000000000000000000000000003000';
const pool10000 = '0x0000000000000000000000000000000000001000';

function routeInput() {
  return {
    resolvedOrder: {
      input: { token: tokenIn, amount: 1_000n, maxAmount: 1_000n },
      outputs: [{ token: tokenOut, amount: 900n, recipient: '0x0000000000000000000000000000000000000009' }],
      info: {} as never,
      sig: '0x',
      hash: '0x1'
    } as never,
    policy: {
      feeTiers: [500, 3000, 10000] as const,
      slippageBufferBps: 0n,
      gasEstimateWei: 0n,
      riskBufferBps: 0n,
      riskBufferOut: 0n,
      profitFloorOut: 0n
    }
  };
}

describe('UniV3RoutePlanner fee-tier attempts', () => {
  it('preserves fee-tier attempts and picks best routeable tier', async () => {
    const client = makeClient((call) => {
      if (call.functionName === 'getPool') {
        const fee = call.args?.[2];
        if (fee === 500) return '0x0000000000000000000000000000000000000000';
        if (fee === 3000) return pool3000;
        return pool10000;
      }
      if (call.functionName === 'liquidity') return 1n;
      if (call.functionName === 'slot0') return [1n] as const;
      if (call.functionName === 'quoteExactInputSingle') {
        const param = call.args?.[0] as { fee: number; amountIn: bigint } | undefined;
        if (!param) throw new Error('missing quote params');
        if (param.fee === 3000) return [899n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
        if (param.fee === 10000) return [950n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      }
      throw new Error(`unexpected call ${call.functionName}`);
    });

    const planner = new UniV3RoutePlanner({ client, factory, quoter });
    const result = await planner.planBestRoute(routeInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.quoteMetadata.poolFee).toBe(10000);
    expect(result.summary.status).toBe('ROUTEABLE');
    expect(result.summary.selectedFeeTier).toBe(10000);
    expect(result.summary.feeTierAttempts).toHaveLength(3);
    expect(result.summary.feeTierAttempts?.map((attempt) => attempt.feeTier)).toEqual([500, 3000, 10000]);
    expect(result.summary.feeTierAttempts?.find((attempt) => attempt.feeTier === 500)?.reason).toBe('POOL_MISSING');
    expect(result.summary.feeTierAttempts?.find((attempt) => attempt.feeTier === 3000)?.status).toBe('CONSTRAINT_REJECTED');
    expect(result.summary.feeTierAttempts?.find((attempt) => attempt.feeTier === 10000)?.status).toBe('ROUTEABLE');
  });

  it('classifies successful but unprofitable quotes as NOT_PROFITABLE (not NOT_ROUTEABLE)', async () => {
    const client = makeClient((call) => {
      if (call.functionName === 'getPool') {
        const fee = call.args?.[2];
        if (fee === 500) return pool500;
        if (fee === 3000) return pool3000;
        return pool10000;
      }
      if (call.functionName === 'liquidity') return 1n;
      if (call.functionName === 'slot0') return [1n] as const;
      if (call.functionName === 'quoteExactInputSingle') {
        return [900n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      }
      throw new Error(`unexpected call ${call.functionName}`);
    });

    const planner = new UniV3RoutePlanner({ client, factory, quoter });
    const result = await planner.planBestRoute(routeInput());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('NOT_PROFITABLE');
    expect(result.failure.summary.status).toBe('NOT_PROFITABLE');
    expect(result.failure.summary.feeTierAttempts?.every((attempt) => attempt.quoteSucceeded)).toBe(true);
  });

  it('distinguishes REQUIRED_OUTPUT shortfall from minAmountOut floor shortfall', async () => {
    const client = makeClient((call) => {
      if (call.functionName === 'getPool') return pool3000;
      if (call.functionName === 'liquidity') return 1n;
      if (call.functionName === 'slot0') return [1n] as const;
      if (call.functionName === 'quoteExactInputSingle') {
        return [890n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      }
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new UniV3RoutePlanner({ client, factory, quoter });
    const result = await planner.planBestRoute({
      ...routeInput(),
      policy: {
        feeTiers: [3000] as const,
        slippageBufferBps: 0n,
        gasEstimateWei: 0n,
        riskBufferBps: 0n,
        riskBufferOut: 0n,
        profitFloorOut: 0n
      }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('CONSTRAINT_REJECTED');
    expect(result.failure.summary.status).toBe('CONSTRAINT_REJECTED');
    expect(result.failure.summary.constraintReason).toBe('REQUIRED_OUTPUT');
    expect(result.failure.summary.constraintBreakdown?.requiredOutputShortfallOut).toBeGreaterThan(0n);
    expect(
      (result.failure.summary.constraintBreakdown?.minAmountOutShortfallOut ?? 0n) >=
        (result.failure.summary.constraintBreakdown?.requiredOutputShortfallOut ?? 0n)
    ).toBe(true);
  });

  it('distinguishes binding floor rejection when required output is met', async () => {
    const client = makeClient((call) => {
      if (call.functionName === 'getPool') return pool3000;
      if (call.functionName === 'liquidity') return 1n;
      if (call.functionName === 'slot0') return [1n] as const;
      if (call.functionName === 'quoteExactInputSingle') {
        return [920n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      }
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new UniV3RoutePlanner({ client, factory, quoter });
    const result = await planner.planBestRoute({
      ...routeInput(),
      policy: {
        feeTiers: [3000] as const,
        slippageBufferBps: 0n,
        gasEstimateWei: 0n,
        riskBufferBps: 0n,
        riskBufferOut: 0n,
        profitFloorOut: 30n
      }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('CONSTRAINT_REJECTED');
    expect(result.failure.summary.constraintReason).toBe('PROFITABILITY_FLOOR');
    expect(result.failure.summary.constraintBreakdown?.bindingFloor).toBe('PROFITABILITY_FLOOR');
    expect(result.failure.summary.constraintBreakdown?.requiredOutputShortfallOut).toBe(0n);
    expect(result.failure.summary.constraintBreakdown?.minAmountOutShortfallOut).toBeGreaterThan(0n);
  });
});
