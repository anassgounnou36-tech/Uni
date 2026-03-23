import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { UniV3RoutePlanner } from '../src/routing/univ3/routePlanner.js';
import { reverseUniV3Path } from '../src/routing/univ3/quoter.js';

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
      effectiveGasPriceWei: 0n,
      riskBufferBps: 0n,
      riskBufferOut: 0n,
      profitFloorOut: 0n
    }
  };
}

describe('UniV3RoutePlanner fee-tier attempts', () => {
  it('uniswap_two_hop_candidate_is_generated_when_bridge_pools_exist', async () => {
    const bridge = '0x000000000000000000000000000000000000000b';
    const client = makeClient((call) => {
      if (call.functionName === 'getPool') return pool3000;
      if (call.functionName === 'liquidity') return 1n;
      if (call.functionName === 'slot0') return [1n] as const;
      if (call.functionName === 'quoteExactInputSingle') return [900n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      if (call.functionName === 'quoteExactOutputSingle') return [900n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      if (call.functionName === 'quoteExactInput') return [980n, [], [], 0n] as [bigint, bigint[], number[], bigint];
      if (call.functionName === 'quoteExactOutput') return [970n, [], [], 0n] as [bigint, bigint[], number[], bigint];
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new UniV3RoutePlanner({ client, factory, quoter, bridgeTokens: [bridge] });
    const result = await planner.planBestRoute(routeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.pathKind).toBe('TWO_HOP');
    expect(result.route.hopCount).toBe(2);
    expect(result.route.bridgeToken?.toLowerCase()).toBe(bridge.toLowerCase());
  });

  it('does not unlock two-hop when direct coverage is below configured threshold', async () => {
    const bridge = '0x000000000000000000000000000000000000000b';
    let twoHopQuoteCalls = 0;
    const client = makeClient((call) => {
      if (call.functionName === 'getPool') return pool3000;
      if (call.functionName === 'liquidity') return 1n;
      if (call.functionName === 'slot0') return [1n] as const;
      if (call.functionName === 'quoteExactInputSingle') return [800n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      if (call.functionName === 'quoteExactOutputSingle') return [1_100n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      if (call.functionName === 'quoteExactInput') {
        twoHopQuoteCalls += 1;
        return [1_050n, [], [], 0n] as [bigint, bigint[], number[], bigint];
      }
      if (call.functionName === 'quoteExactOutput') return [890n, [], [], 0n] as [bigint, bigint[], number[], bigint];
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new UniV3RoutePlanner({
      client,
      factory,
      quoter,
      bridgeTokens: [bridge],
      twoHopUnlockMinCoverageBps: 9_000n
    });
    const result = await planner.planBestRoute(routeInput());
    expect(result.ok).toBe(false);
    expect(twoHopQuoteCalls).toBe(0);
  });

  it('two_hop_rejected_candidates_preserve_constraint_reason_exact_output_viability_hedge_gap_and_candidate_class', async () => {
    const bridge = '0x000000000000000000000000000000000000000b';
    const client = makeClient((call) => {
      if (call.functionName === 'getPool') {
        const [a, b] = [call.args?.[0] as string, call.args?.[1] as string];
        if (
          (a?.toLowerCase() === tokenIn.toLowerCase() && b?.toLowerCase() === bridge.toLowerCase())
          || (a?.toLowerCase() === bridge.toLowerCase() && b?.toLowerCase() === tokenOut.toLowerCase())
        ) return pool3000;
        return '0x0000000000000000000000000000000000000000';
      }
      if (call.functionName === 'liquidity') return 1n;
      if (call.functionName === 'slot0') return [1n] as const;
      if (call.functionName === 'quoteExactInput') return [890n, [], [], 0n] as [bigint, bigint[], number[], bigint];
      if (call.functionName === 'quoteExactOutput') return [1_010n, [], [], 0n] as [bigint, bigint[], number[], bigint];
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new UniV3RoutePlanner({ client, factory, quoter, bridgeTokens: [bridge] });
    const result = await planner.planBestRoute(routeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('CONSTRAINT_REJECTED');
    expect(result.failure.summary.pathKind).toBe('TWO_HOP');
    expect(result.failure.summary.hopCount).toBe(2);
    expect(result.failure.summary.bridgeToken?.toLowerCase()).toBe(bridge.toLowerCase());
    expect(result.failure.summary.constraintReason).toBe('REQUIRED_OUTPUT');
    expect(result.failure.summary.exactOutputViability?.status).toBe('UNSATISFIABLE');
    expect(result.failure.summary.hedgeGap?.gapClass).toBeDefined();
    expect(result.failure.summary.candidateClass).toBeDefined();
  });

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
      if (call.functionName === 'quoteExactOutputSingle') {
        const param = call.args?.[0] as { fee: number; amount: bigint } | undefined;
        if (!param) throw new Error('missing exact-output quote params');
        if (param.fee === 3000) return [1_005n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
        if (param.fee === 10000) return [995n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
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
    const exactInputAttempts = result.summary.feeTierAttempts?.filter((attempt) => (attempt.executionMode ?? 'EXACT_INPUT') === 'EXACT_INPUT');
    expect(exactInputAttempts).toHaveLength(3);
    expect(exactInputAttempts?.map((attempt) => attempt.feeTier)).toEqual([500, 3000, 10000]);
    expect(result.summary.feeTierAttempts?.find((attempt) => attempt.feeTier === 500)?.reason).toBe('POOL_MISSING');
    expect(result.summary.feeTierAttempts?.find((attempt) => attempt.feeTier === 3000)?.status).toBe('CONSTRAINT_REJECTED');
    expect(result.summary.feeTierAttempts?.find((attempt) => attempt.feeTier === 10000)?.status).toBe('ROUTEABLE');
    const tier10000 = result.summary.feeTierAttempts?.find((attempt) => attempt.feeTier === 10000);
    expect(tier10000?.exactOutputViability).toBeDefined();
    expect(tier10000?.exactOutputViability?.targetOutput).toBe(900n);
    expect(tier10000?.exactOutputViability?.availableInput).toBe(1_000n);
    expect(tier10000?.hedgeGap).toBeDefined();
    expect(tier10000?.hedgeGap?.outputCoverageBps).toBe(10_555n);
    expect(tier10000?.hedgeGap?.requiredOutputShortfallOut).toBe(0n);
    expect(tier10000?.hedgeGap?.gapClass).toBe('EXACT');
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
        const param = call.args?.[0] as { amountIn: bigint } | undefined;
        if (param?.amountIn === 1_000n) return [900n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
        return [0n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      }
      if (call.functionName === 'quoteExactOutputSingle') {
        return [1_001n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
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
      if (call.functionName === 'quoteExactOutputSingle') {
        return [1_020n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      }
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new UniV3RoutePlanner({ client, factory, quoter });
    const result = await planner.planBestRoute({
      ...routeInput(),
      policy: {
        feeTiers: [3000] as const,
        slippageBufferBps: 0n,
        effectiveGasPriceWei: 0n,
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
    expect(result.failure.summary.exactOutputViability?.status).toBe('UNSATISFIABLE');
    expect((result.failure.summary.exactOutputViability?.inputDeficit ?? 0n) > 0n).toBe(true);
    expect(result.failure.summary.hedgeGap?.outputCoverageBps).toBe(9_888n);
    expect(result.failure.summary.hedgeGap?.requiredOutputShortfallOut).toBe(10n);
    expect(result.failure.summary.hedgeGap?.gapClass).toBe('MEDIUM');
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
        const param = call.args?.[0] as { amountIn: bigint } | undefined;
        if (param?.amountIn === 1_000n) return [920n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
        return [0n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      }
      if (call.functionName === 'quoteExactOutputSingle') {
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
        effectiveGasPriceWei: 0n,
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
    expect(result.failure.summary.exactOutputViability?.status).toBe('SATISFIABLE');
  });

  it('exact_output_satisfiable_candidate_generates_exact_output_execution_candidate', async () => {
    const client = makeClient((call) => {
      if (call.functionName === 'getPool') return pool3000;
      if (call.functionName === 'liquidity') return 1n;
      if (call.functionName === 'slot0') return [1n] as const;
      if (call.functionName === 'quoteExactInputSingle') {
        const param = call.args?.[0] as { amountIn: bigint } | undefined;
        if (param?.amountIn === 1_000n) return [905n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
        if (param?.amountIn === 100n) return [120n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      }
      if (call.functionName === 'quoteExactOutputSingle') return [900n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new UniV3RoutePlanner({ client, factory, quoter });
    const result = await planner.planBestRoute(routeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.executionMode).toBe('EXACT_OUTPUT');
    expect(result.route.targetOutput).toBe(900n);
    expect(result.route.maxAmountIn).toBe(1_000n);
    expect(result.route.quotedAmountOut).toBe(1_020n);
  });

  it('exact_output_candidate_profit_is_valued_from_leftover_input', async () => {
    const client = makeClient((call) => {
      if (call.functionName === 'getPool') return pool3000;
      if (call.functionName === 'liquidity') return 1n;
      if (call.functionName === 'slot0') return [1n] as const;
      if (call.functionName === 'quoteExactInputSingle') {
        const param = call.args?.[0] as { amountIn: bigint } | undefined;
        if (param?.amountIn === 1_000n) return [901n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
        if (param?.amountIn === 100n) return [50n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      }
      if (call.functionName === 'quoteExactOutputSingle') return [900n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new UniV3RoutePlanner({ client, factory, quoter });
    const result = await planner.planBestRoute({
      ...routeInput(),
      policy: {
        feeTiers: [3000] as const,
        slippageBufferBps: 0n,
        effectiveGasPriceWei: 0n,
        riskBufferBps: 0n,
        riskBufferOut: 0n,
        profitFloorOut: 0n
      }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.executionMode).toBe('EXACT_OUTPUT');
    expect(result.route.grossEdgeOut).toBe(50n);
    expect(result.route.netEdgeOut).toBe(50n);
  });

  it('uniswap_exact_output_two_hop_path_is_encoded_reversed', async () => {
    const bridge = '0x000000000000000000000000000000000000000b';
    let exactInputPath: string | undefined;
    let exactOutputPath: string | undefined;
    const client = makeClient((call) => {
      if (call.functionName === 'getPool') {
        const [a, b] = [call.args?.[0] as string, call.args?.[1] as string];
        if (
          (a?.toLowerCase() === tokenIn.toLowerCase() && b?.toLowerCase() === bridge.toLowerCase())
          || (a?.toLowerCase() === bridge.toLowerCase() && b?.toLowerCase() === tokenOut.toLowerCase())
        ) return pool3000;
        return '0x0000000000000000000000000000000000000000';
      }
      if (call.functionName === 'liquidity') return 1n;
      if (call.functionName === 'slot0') return [1n] as const;
      if (call.functionName === 'quoteExactInput') {
        exactInputPath = call.args?.[0] as string;
        return [905n, [], [], 0n] as [bigint, bigint[], number[], bigint];
      }
      if (call.functionName === 'quoteExactOutput') {
        exactOutputPath = call.args?.[0] as string;
        return [900n, [], [], 0n] as [bigint, bigint[], number[], bigint];
      }
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new UniV3RoutePlanner({ client, factory, quoter, bridgeTokens: [bridge] });
    const result = await planner.planBestRoute({
      ...routeInput(),
      policy: {
        feeTiers: [3000] as const,
        slippageBufferBps: 0n,
        effectiveGasPriceWei: 0n,
        riskBufferBps: 0n,
        riskBufferOut: 0n,
        profitFloorOut: 0n
      }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.pathKind).toBe('TWO_HOP');
    expect(result.route.executionMode).toBe('EXACT_OUTPUT');
    expect(result.route.pathDirection).toBe('REVERSE');
    expect(result.route.encodedPath).toBe(exactOutputPath);
    expect(exactOutputPath).toBeDefined();
    expect(exactInputPath).toBeDefined();
    expect(exactOutputPath).toBe(reverseUniV3Path(exactInputPath! as `0x${string}`));
  });

  it('gasCostOut_is_nonzero_when_gas_and_price_are_nonzero', async () => {
    const client = makeClient((call) => {
      if (call.functionName === 'getPool') {
        const [a, b] = [call.args?.[0] as string, call.args?.[1] as string];
        if (a?.toLowerCase() === tokenIn.toLowerCase() && b?.toLowerCase() === tokenOut.toLowerCase()) return pool3000;
        return pool500;
      }
      if (call.functionName === 'liquidity') return 1n;
      if (call.functionName === 'slot0') return [1n] as const;
      if (call.functionName === 'quoteExactInputSingle') {
        const param = call.args?.[0] as { tokenIn: string; tokenOut: string; amountIn: bigint } | undefined;
        if (param?.tokenIn.toLowerCase() === tokenIn.toLowerCase() && param?.tokenOut.toLowerCase() === tokenOut.toLowerCase()) {
          return [1_100n, 0n, 0, 200n] as [bigint, bigint, number, bigint];
        }
        return [50n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      }
      if (call.functionName === 'quoteExactOutputSingle') return [900n, 0n, 0, 0n] as [bigint, bigint, number, bigint];
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new UniV3RoutePlanner({ client, factory, quoter });
    const result = await planner.planBestRoute({
      ...routeInput(),
      policy: {
        feeTiers: [3000] as const,
        slippageBufferBps: 0n,
        effectiveGasPriceWei: 2n,
        riskBufferBps: 0n,
        riskBufferOut: 0n,
        profitFloorOut: 0n
      }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.gasCostOut).toBeGreaterThan(0n);
  });
});
