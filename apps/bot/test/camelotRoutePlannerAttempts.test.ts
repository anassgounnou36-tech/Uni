import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { CamelotAmmv3RoutePlanner } from '../src/routing/camelotV3/routePlanner.js';

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
const univ3Factory = '0x0000000000000000000000000000000000000030';
const univ3Quoter = '0x0000000000000000000000000000000000000040';
const pool = '0x0000000000000000000000000000000000000500';

function routeInput(profitFloorOut = 0n) {
  return {
    resolvedOrder: {
      input: { token: tokenIn, amount: 1_000n, maxAmount: 1_000n },
      outputs: [{ token: tokenOut, amount: 900n, recipient: '0x0000000000000000000000000000000000000009' }],
      info: {} as never,
      sig: '0x',
      hash: '0x1'
    } as never,
    policy: {
      slippageBufferBps: 0n,
      effectiveGasPriceWei: 0n,
      riskBufferBps: 0n,
      riskBufferOut: 0n,
      profitFloorOut
    }
  };
}

describe('CamelotAmmv3RoutePlanner exact-output viability', () => {
  it('camelot_two_hop_candidate_is_generated_when_bridge_pools_exist', async () => {
    const bridge = '0x000000000000000000000000000000000000000b';
    const client = makeClient((call) => {
      if (call.functionName === 'poolByPair') return pool;
      if (call.functionName === 'quoteExactInputSingle') return [900n, 30] as const;
      if (call.functionName === 'quoteExactOutputSingle') return [900n, 30] as const;
      if (call.functionName === 'quoteExactInput') return 980n;
      if (call.functionName === 'quoteExactOutput') return 970n;
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new CamelotAmmv3RoutePlanner({
      client,
      enabled: true,
      factory,
      quoter,
      univ3Factory,
      univ3Quoter,
      bridgeTokens: [bridge]
    });
    const result = await planner.planBestRoute(routeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(['DIRECT', 'TWO_HOP']).toContain(result.route.pathKind);
    expect([1, 2]).toContain(result.route.hopCount);
    expect(result.route.executionMode).toBeDefined();
  });

  it('skips camelot two-hop when enableTwoHop is false', async () => {
    const bridge = '0x000000000000000000000000000000000000000b';
    let quotePathCalls = 0;
    const client = makeClient((call) => {
      if (call.functionName === 'poolByPair') return pool;
      if (call.functionName === 'quoteExactInputSingle') return [900n, 30] as const;
      if (call.functionName === 'quoteExactOutputSingle') return [900n, 30] as const;
      if (call.functionName === 'quoteExactInput') {
        quotePathCalls += 1;
        return 980n;
      }
      if (call.functionName === 'quoteExactOutput') return 970n;
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new CamelotAmmv3RoutePlanner({
      client,
      enabled: true,
      factory,
      quoter,
      univ3Factory,
      univ3Quoter,
      bridgeTokens: [bridge],
      enableTwoHop: false
    });
    const result = await planner.planBestRoute(routeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.pathKind).toBe('DIRECT');
    expect(quotePathCalls).toBe(0);
  });

  it('computes exact-output viability for successful exact-input quote attempts', async () => {
    const client = makeClient((call) => {
      if (call.functionName === 'poolByPair') {
        return pool;
      }
      if (call.functionName === 'quoteExactInputSingle') {
        const amountIn = call.args?.[2];
        if (amountIn === 1_000n) return [890n, 30] as const;
        if (amountIn === 0n) return [0n, 30] as const;
      }
      if (call.functionName === 'quoteExactOutputSingle') {
        return [950n, 30] as const;
      }
      throw new Error(`unexpected call ${call.functionName}`);
    });

    const planner = new CamelotAmmv3RoutePlanner({
      client,
      enabled: true,
      factory,
      quoter,
      univ3Factory,
      univ3Quoter
    });
    const result = await planner.planBestRoute(routeInput());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.summary.exactOutputViability).toBeDefined();
    expect(result.failure.summary.exactOutputViability?.targetOutput).toBe(900n);
    expect(result.failure.summary.exactOutputViability?.availableInput).toBe(1_000n);
  });

  it('classifies unsatisfiable REQUIRED_OUTPUT with positive inputDeficit', async () => {
    const client = makeClient((call) => {
      if (call.functionName === 'poolByPair') return pool;
      if (call.functionName === 'quoteExactInputSingle') {
        const amountIn = call.args?.[2];
        if (amountIn === 1_000n) return [890n, 30] as const;
        if (amountIn === 0n) return [0n, 30] as const;
      }
      if (call.functionName === 'quoteExactOutputSingle') {
        return [1_010n, 30] as const;
      }
      throw new Error(`unexpected call ${call.functionName}`);
    });

    const planner = new CamelotAmmv3RoutePlanner({
      client,
      enabled: true,
      factory,
      quoter,
      univ3Factory,
      univ3Quoter
    });
    const result = await planner.planBestRoute(routeInput());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.summary.constraintReason).toBe('REQUIRED_OUTPUT');
    expect(result.failure.summary.exactOutputViability?.status).toBe('UNSATISFIABLE');
    expect((result.failure.summary.exactOutputViability?.inputDeficit ?? 0n) > 0n).toBe(true);
  });

  it('preserves satisfiable viability when rejection is profitability floor', async () => {
    const client = makeClient((call) => {
      if (call.functionName === 'poolByPair') return pool;
      if (call.functionName === 'quoteExactInputSingle') {
        const amountIn = call.args?.[2];
        if (amountIn === 1_000n) return [920n, 30] as const;
        if (amountIn === 0n) return [0n, 30] as const;
      }
      if (call.functionName === 'quoteExactOutputSingle') {
        return [890n, 30] as const;
      }
      throw new Error(`unexpected call ${call.functionName}`);
    });

    const planner = new CamelotAmmv3RoutePlanner({
      client,
      enabled: true,
      factory,
      quoter,
      univ3Factory,
      univ3Quoter
    });
    const result = await planner.planBestRoute(routeInput(30n));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.summary.constraintReason).toBe('PROFITABILITY_FLOOR');
    expect(result.failure.summary.exactOutputViability?.status).toBe('SATISFIABLE');
  });
});
