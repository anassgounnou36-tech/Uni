import type { Address } from 'viem';
import { discoverPool } from './poolDiscovery.js';
import { quoteExactInputSingle } from './quoter.js';
import type {
  RoutePlannerInput,
  RoutePlanningPolicy,
  RoutePlanningResult,
  UniV3FeeTier,
  UniV3RoutePlan,
  UniV3RoutingContext
} from './types.js';

const DEFAULT_FEE_TIERS: readonly UniV3FeeTier[] = [500, 3000, 10000];

function sumRequiredOutput(outputs: ReadonlyArray<{ token: Address; amount: bigint }>): bigint {
  return outputs.reduce((sum, output) => sum + output.amount, 0n);
}

function applyBpsFloor(amount: bigint, bpsToKeep: bigint): bigint {
  return (amount * bpsToKeep) / 10_000n;
}

function normalizePolicy(policy: RoutePlanningPolicy | undefined): Required<RoutePlanningPolicy> {
  return {
    feeTiers: policy?.feeTiers ?? DEFAULT_FEE_TIERS,
    slippageBufferBps: policy?.slippageBufferBps ?? 50n,
    gasEstimateWei: policy?.gasEstimateWei ?? 0n,
    riskBufferBps: policy?.riskBufferBps ?? 10n,
    riskBufferWei: policy?.riskBufferWei ?? 0n
  };
}

export class UniV3RoutePlanner {
  constructor(private readonly context: UniV3RoutingContext) {}

  async planBestRoute(input: RoutePlannerInput): Promise<RoutePlanningResult> {
    const policy = normalizePolicy(input.policy);
    const { resolvedOrder } = input;

    if (resolvedOrder.outputs.length === 0) {
      return { ok: false, failure: { reason: 'NOT_ROUTEABLE', details: 'order has no outputs' }, consideredFees: [] };
    }

    const tokenIn = resolvedOrder.input.token;
    const tokenOut = resolvedOrder.outputs[0]!.token;
    const sameOutputToken = resolvedOrder.outputs.every((output) => output.token.toLowerCase() === tokenOut.toLowerCase());
    if (!sameOutputToken) {
      return { ok: false, failure: { reason: 'NOT_ROUTEABLE', details: 'output token mismatch' }, consideredFees: [] };
    }

    const amountIn = resolvedOrder.input.amount;
    const requiredOutput = sumRequiredOutput(resolvedOrder.outputs as ReadonlyArray<{ token: Address; amount: bigint }>);
    const candidates: UniV3RoutePlan[] = [];
    const consideredFees: UniV3FeeTier[] = [];

    for (const feeTier of policy.feeTiers) {
      consideredFees.push(feeTier);
      const discovered = await discoverPool(this.context.client, this.context.factory, tokenIn, tokenOut, feeTier);
      if (!discovered) {
        continue;
      }

      try {
        const quote = await quoteExactInputSingle(this.context.client, this.context.quoter, tokenIn, tokenOut, feeTier, amountIn);
        const quotedAmountOut = quote.amountOut;
        const bpsToKeep = 10_000n - policy.slippageBufferBps;
        const slippageFloor = applyBpsFloor(quotedAmountOut, bpsToKeep);
        const riskBufferWei = policy.riskBufferWei + (quotedAmountOut * policy.riskBufferBps) / 10_000n;
        const minAmountOut = slippageFloor - riskBufferWei;
        if (minAmountOut < requiredOutput) {
          continue;
        }
        const grossEdge = quotedAmountOut - requiredOutput;
        const gasCostWei = policy.gasEstimateWei > 0n ? policy.gasEstimateWei : quote.gasEstimate;
        const netEdge = grossEdge - gasCostWei - riskBufferWei;
        candidates.push({
          tokenIn,
          tokenOut,
          amountIn,
          requiredOutput,
          quotedAmountOut,
          poolFee: feeTier,
          minAmountOut,
          grossEdge,
          gasCostWei,
          riskBufferWei,
          netEdge
        });
      } catch (error) {
        // Per-fee quote failures are tolerated so other fee tiers can still produce a route.
        void error;
      }
    }

    if (candidates.length === 0) {
      return {
        ok: false,
        failure: {
          reason: 'NOT_ROUTEABLE',
          details: 'no fee tier produced a valid minAmountOut >= requiredOutput'
        },
        consideredFees
      };
    }

    const sorted = [...candidates].sort((a, b) => (a.netEdge > b.netEdge ? -1 : a.netEdge < b.netEdge ? 1 : 0));
    const best = sorted[0]!;
    if (best.netEdge <= 0n) {
      return { ok: false, failure: { reason: 'NOT_PROFITABLE' }, consideredFees };
    }

    return {
      ok: true,
      route: best,
      consideredFees
    };
  }
}
