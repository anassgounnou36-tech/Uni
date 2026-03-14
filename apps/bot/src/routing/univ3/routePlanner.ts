import type { Address } from 'viem';
import { discoverPool } from './poolDiscovery.js';
import { quoteExactInputSingle } from './quoter.js';
import { convertGasWeiToTokenOut } from './gasValue.js';
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
    riskBufferOut: policy?.riskBufferOut ?? 0n,
    profitFloorOut: policy?.profitFloorOut ?? 0n
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
    let quoteFailures = 0;
    let profitabilityRejects = 0;

    for (const feeTier of policy.feeTiers) {
      consideredFees.push(feeTier);
      const discovered = await discoverPool(this.context.client, this.context.factory, tokenIn, tokenOut, feeTier);
      if (!discovered) {
        continue;
      }

      try {
        const quote = await quoteExactInputSingle(this.context.client, this.context.quoter, tokenIn, tokenOut, feeTier, amountIn);
        const quotedAmountOut = quote.amountOut;
        const slippageBufferOut = quotedAmountOut - applyBpsFloor(quotedAmountOut, 10_000n - policy.slippageBufferBps);
        const gasWei = policy.gasEstimateWei > 0n ? policy.gasEstimateWei : quote.gasEstimate;
        const gasConversion = await convertGasWeiToTokenOut({
          client: this.context.client,
          factory: this.context.factory,
          quoter: this.context.quoter,
          tokenOut,
          gasWei,
          supportedFeeTiers: policy.feeTiers
        });
        if (!gasConversion.ok) {
          return {
            ok: false,
            failure: { reason: 'NOT_PRICEABLE_GAS' },
            consideredFees
          };
        }
        const gasCostOut = gasConversion.gasCostOut;
        const riskBufferOut = policy.riskBufferOut + (quotedAmountOut * policy.riskBufferBps) / 10_000n;
        const profitFloorOut = policy.profitFloorOut;
        const grossEdgeOut = quotedAmountOut - requiredOutput;
        const slippageFloorOut = quotedAmountOut - slippageBufferOut;
        const profitabilityFloorOut = requiredOutput + gasCostOut + riskBufferOut + profitFloorOut;
        const minAmountOut = slippageFloorOut > profitabilityFloorOut ? slippageFloorOut : profitabilityFloorOut;
        const netEdgeOut = quotedAmountOut - requiredOutput - slippageBufferOut - gasCostOut - riskBufferOut - profitFloorOut;

        if (quotedAmountOut < minAmountOut || netEdgeOut <= 0n) {
          profitabilityRejects += 1;
          continue;
        }

        candidates.push({
          tokenIn,
          tokenOut,
          amountIn,
          requiredOutput,
          quotedAmountOut,
          poolFee: feeTier,
          minAmountOut,
          slippageBufferOut,
          gasCostOut,
          riskBufferOut,
          profitFloorOut,
          grossEdgeOut,
          netEdgeOut
        });
      } catch (error) {
        // Per-fee quote failures are tolerated so other fee tiers can still produce a route.
        // We still track failure count and surface it when no candidate route is produced.
        quoteFailures += 1;
        void error;
      }
    }

    if (candidates.length === 0) {
      return {
        ok: false,
        failure: {
          reason: 'NOT_ROUTEABLE',
          details: `no fee tier produced a valid route (quote failures=${quoteFailures}, profitabilityRejects=${profitabilityRejects})`
        },
        consideredFees
      };
    }

    const sorted = [...candidates].sort((a, b) => (a.netEdgeOut > b.netEdgeOut ? -1 : a.netEdgeOut < b.netEdgeOut ? 1 : 0));
    const best = sorted[0]!;
    if (best.netEdgeOut <= 0n) {
      return { ok: false, failure: { reason: 'NOT_PROFITABLE' }, consideredFees };
    }

    return {
      ok: true,
      route: best,
      consideredFees
    };
  }
}
