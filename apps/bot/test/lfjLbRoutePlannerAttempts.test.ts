import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { LfjLbRoutePlanner } from '../src/routing/lfjLb/routePlanner.js';
import { RouteEvalReadCache } from '../src/routing/rpc/readCache.js';

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
const bridge = '0x000000000000000000000000000000000000000b';
const factory = '0x0000000000000000000000000000000000000010';
const quoter = '0x0000000000000000000000000000000000000020';
const router = '0x0000000000000000000000000000000000000030';
const pool = '0x0000000000000000000000000000000000000500';

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
      slippageBufferBps: 0n,
      effectiveGasPriceWei: 0n,
      riskBufferBps: 0n,
      riskBufferOut: 0n,
      profitFloorOut: 0n
    }
  };
}

describe('LfjLbRoutePlanner', () => {
  it('lfj_direct_family_is_generated_and_evaluated', async () => {
    const client = makeClient((call) => {
      if (call.functionName === 'getLBPairInformation') return [pool, 20n, 0, false] as const;
      if (call.functionName === 'findBestPathFromAmountIn') return [920n, [], [], [20n], [1n]] as const;
      if (call.functionName === 'findBestPathFromAmountOut') return [890n, [], [], [20n], [1n]] as const;
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new LfjLbRoutePlanner({
      client,
      enabled: true,
      factory,
      quoter,
      router
    });
    const result = await planner.planBestRoute(routeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.venue).toBe('LFJ_LB');
    expect(result.route.pathKind).toBe('DIRECT');
    expect(result.route.lfjPath?.tokenPath).toEqual([tokenIn, tokenOut]);
  });

  it('lfj_exact_output_candidate_can_be_produced_from_near_miss_family', async () => {
    const client = makeClient((call) => {
      if (call.functionName === 'getLBPairInformation') return [pool, 20n, 0, false] as const;
      if (call.functionName === 'findBestPathFromAmountIn') return [901n, [], [], [20n], [1n]] as const;
      if (call.functionName === 'findBestPathFromAmountOut') return [890n, [], [], [20n], [1n]] as const;
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new LfjLbRoutePlanner({
      client,
      enabled: true,
      factory,
      quoter,
      router
    });
    const result = await planner.planBestRoute(routeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.executionMode).toBe('EXACT_OUTPUT');
  });

  it('lfj_two_hop_family_is_bounded_by_max_lfj_two_hop_families_per_order', async () => {
    let twoHopQuoteCalls = 0;
    const client = makeClient((call) => {
      if (call.functionName === 'getLBPairInformation') return [pool, 20n, 0, false] as const;
      if (call.functionName === 'findBestPathFromAmountIn') {
        const route = call.args?.[0] as { tokenPath?: string[] } | undefined;
        if (route?.tokenPath?.length === 3) twoHopQuoteCalls += 1;
        return [920n, [], [], [20n, 20n], [1n, 1n]] as const;
      }
      if (call.functionName === 'findBestPathFromAmountOut') return [890n, [], [], [20n], [1n]] as const;
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new LfjLbRoutePlanner({
      client,
      enabled: true,
      factory,
      quoter,
      router,
      bridgeTokens: [bridge, '0x000000000000000000000000000000000000000c', '0x000000000000000000000000000000000000000d'],
      enableTwoHop: true
    });
    const result = await planner.planBestRoute({
      ...routeInput(),
      policy: {
        ...routeInput().policy,
        maxLfjTwoHopFamiliesPerOrder: 2
      }
    });
    expect(result.ok).toBe(true);
    expect(twoHopQuoteCalls).toBe(2);
  });

  it('lfj_negative_result_memoization_works_within_block_snapshot', async () => {
    let revertedCalls = 0;
    const client = makeClient((call) => {
      if (call.functionName === 'getLBPairInformation') return [pool, 20n, 0, false] as const;
      if (call.functionName === 'findBestPathFromAmountIn') {
        revertedCalls += 1;
        throw new Error('execution reverted: no liquidity');
      }
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new LfjLbRoutePlanner({
      client,
      enabled: true,
      factory,
      quoter,
      router
    });
    const readCache = new RouteEvalReadCache();
    const input = {
      ...routeInput(),
      routeEval: {
        chainId: 42161n,
        blockNumberish: 100n,
        readCache
      }
    };
    await planner.planBestRoute(input);
    await planner.planBestRoute(input);
    expect(revertedCalls).toBe(1);
  });

  it('lfj_two_hop_stays_disabled_by_default', async () => {
    let twoHopQuoteCalls = 0;
    const client = makeClient((call) => {
      if (call.functionName === 'getLBPairInformation') return [pool, 20n, 0, false] as const;
      if (call.functionName === 'findBestPathFromAmountIn') {
        const route = call.args?.[0] as { tokenPath?: string[] } | undefined;
        if (route?.tokenPath?.length === 3) twoHopQuoteCalls += 1;
        return [920n, [], [], [20n], [1n]] as const;
      }
      if (call.functionName === 'findBestPathFromAmountOut') return [890n, [], [], [20n], [1n]] as const;
      throw new Error(`unexpected call ${call.functionName}`);
    });
    const planner = new LfjLbRoutePlanner({
      client,
      enabled: true,
      factory,
      quoter,
      router,
      bridgeTokens: [bridge]
    });
    const result = await planner.planBestRoute(routeInput());
    expect(result.ok).toBe(true);
    expect(twoHopQuoteCalls).toBe(0);
  });
});
