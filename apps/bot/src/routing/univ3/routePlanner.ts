import type { Address } from 'viem';
import { discoverPool } from './poolDiscovery.js';
import { classifyQuoteFailure, quoteExactInputSingle } from './quoter.js';
import { convertGasWeiToTokenOut } from './gasValue.js';
import type {
  RoutePlannerInput,
  RoutePlanningPolicy,
  RoutePlanningResult,
  UniV3FeeTier,
  UniV3RoutePlan,
  UniV3RoutingContext
} from './types.js';
import type { FeeTierAttemptSummary, RouteAttemptStatus, VenueRouteAttemptSummary } from '../attemptTypes.js';

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

function makeFailure(
  reason: 'NOT_ROUTEABLE' | 'QUOTE_FAILED' | 'NOT_PROFITABLE' | 'GAS_NOT_PRICEABLE' | 'CONSTRAINT_REJECTED',
  details: string,
  summary: VenueRouteAttemptSummary
): RoutePlanningResult {
  return {
    ok: false,
    failure: {
      reason,
      details,
      summary
    }
  };
}

type Candidate = {
  route: UniV3RoutePlan;
  feeTierAttempt: FeeTierAttemptSummary;
  status: RouteAttemptStatus;
  reason: string;
};

export class UniV3RoutePlanner {
  constructor(private readonly context: UniV3RoutingContext) {}

  async planBestRoute(input: RoutePlannerInput): Promise<RoutePlanningResult> {
    const policy = normalizePolicy(input.policy);
    const { resolvedOrder } = input;

    if (resolvedOrder.outputs.length === 0) {
      const summary: VenueRouteAttemptSummary = {
        venue: 'UNISWAP_V3',
        status: 'NOT_ROUTEABLE',
        reason: 'ORDER_HAS_NO_OUTPUTS',
        feeTierAttempts: []
      };
      return makeFailure('NOT_ROUTEABLE', 'order has no outputs', summary);
    }

    const tokenIn = resolvedOrder.input.token;
    const tokenOut = resolvedOrder.outputs[0]!.token;
    const sameOutputToken = resolvedOrder.outputs.every((output) => output.token.toLowerCase() === tokenOut.toLowerCase());
    if (!sameOutputToken) {
      const summary: VenueRouteAttemptSummary = {
        venue: 'UNISWAP_V3',
        status: 'NOT_ROUTEABLE',
        reason: 'OUTPUT_TOKEN_MISMATCH',
        feeTierAttempts: []
      };
      return makeFailure('NOT_ROUTEABLE', 'output token mismatch', summary);
    }

    const amountIn = resolvedOrder.input.amount;
    const requiredOutput = sumRequiredOutput(resolvedOrder.outputs as ReadonlyArray<{ token: Address; amount: bigint }>);
    const attempts: FeeTierAttemptSummary[] = [];
    const candidates: Candidate[] = [];
    let quoteCount = 0;

    for (const feeTier of policy.feeTiers) {
      const discovered = await discoverPool(this.context.client, this.context.factory, tokenIn, tokenOut, feeTier);
      if (!discovered) {
        attempts.push({
          feeTier,
          poolExists: false,
          quoteSucceeded: false,
          status: 'NOT_ROUTEABLE',
          reason: 'POOL_MISSING'
        });
        continue;
      }

      let quotedAmountOut: bigint;
      let gasEstimate: bigint;
      try {
        const quote = await quoteExactInputSingle(this.context.client, this.context.quoter, tokenIn, tokenOut, feeTier, amountIn);
        quotedAmountOut = quote.amountOut;
        gasEstimate = quote.gasEstimate;
      } catch (error) {
        attempts.push({
          feeTier,
          poolExists: true,
          quoteSucceeded: false,
          status: 'QUOTE_FAILED',
          reason: classifyQuoteFailure(error)
        });
        continue;
      }

      quoteCount += 1;
      const slippageBufferOut = quotedAmountOut - applyBpsFloor(quotedAmountOut, 10_000n - policy.slippageBufferBps);
      const gasWei = policy.gasEstimateWei > 0n ? policy.gasEstimateWei : gasEstimate;
      const gasConversion = await convertGasWeiToTokenOut({
        client: this.context.client,
        factory: this.context.factory,
        quoter: this.context.quoter,
        tokenOut,
        gasWei,
        supportedFeeTiers: policy.feeTiers
      });

      if (!gasConversion.ok) {
        const requiredFloor = requiredOutput + (quotedAmountOut * policy.riskBufferBps) / 10_000n + policy.riskBufferOut + policy.profitFloorOut;
        attempts.push({
          feeTier,
          poolExists: true,
          quoteSucceeded: true,
          quotedAmountOut,
          minAmountOut: requiredFloor,
          grossEdgeOut: quotedAmountOut - requiredOutput,
          status: 'GAS_NOT_PRICEABLE',
          reason: 'GAS_CONVERSION_FAILED'
        });
        continue;
      }

      const gasCostOut = gasConversion.gasCostOut;
      const riskBufferOut = policy.riskBufferOut + (quotedAmountOut * policy.riskBufferBps) / 10_000n;
      const profitFloorOut = policy.profitFloorOut;
      const grossEdgeOut = quotedAmountOut - requiredOutput;
      const slippageFloorOut = quotedAmountOut - slippageBufferOut;
      const profitabilityFloorOut = requiredOutput + gasCostOut + riskBufferOut + profitFloorOut;
      const minAmountOut = slippageFloorOut > profitabilityFloorOut ? slippageFloorOut : profitabilityFloorOut;
      const netEdgeOut = quotedAmountOut - requiredOutput - slippageBufferOut - gasCostOut - riskBufferOut - profitFloorOut;

      let status: RouteAttemptStatus = 'ROUTEABLE';
      let reason = 'ROUTE_SELECTED';
      if (quotedAmountOut < minAmountOut) {
        status = 'CONSTRAINT_REJECTED';
        reason = 'MIN_AMOUNT_OUT';
      } else if (netEdgeOut <= 0n) {
        status = 'NOT_PROFITABLE';
        reason = 'NET_EDGE_NON_POSITIVE';
      }

      const attemptSummary: FeeTierAttemptSummary = {
        feeTier,
        poolExists: true,
        quoteSucceeded: true,
        quotedAmountOut,
        minAmountOut,
        grossEdgeOut,
        netEdgeOut,
        status,
        reason
      };
      attempts.push(attemptSummary);

      const route: UniV3RoutePlan = {
        venue: 'UNISWAP_V3',
        tokenIn,
        tokenOut,
        amountIn,
        requiredOutput,
        quotedAmountOut,
        minAmountOut,
        limitSqrtPriceX96: 0n,
        slippageBufferOut,
        gasCostOut,
        riskBufferOut,
        profitFloorOut,
        grossEdgeOut,
        netEdgeOut,
        quoteMetadata: {
          venue: 'UNISWAP_V3',
          poolFee: feeTier
        }
      };
      candidates.push({
        route,
        feeTierAttempt: attemptSummary,
        status,
        reason
      });
    }

    const successfulQuotes = candidates.filter((candidate) => candidate.feeTierAttempt.quoteSucceeded);
    const routeableCandidates = candidates.filter((candidate) => candidate.status === 'ROUTEABLE');
    if (routeableCandidates.length > 0) {
      const sorted = [...routeableCandidates].sort((a, b) => (a.route.netEdgeOut > b.route.netEdgeOut ? -1 : a.route.netEdgeOut < b.route.netEdgeOut ? 1 : 0));
      const best = sorted[0]!;
      const summary: VenueRouteAttemptSummary = {
        venue: 'UNISWAP_V3',
        status: 'ROUTEABLE',
        reason: 'ROUTEABLE',
        quotedAmountOut: best.route.quotedAmountOut,
        minAmountOut: best.route.minAmountOut,
        grossEdgeOut: best.route.grossEdgeOut,
        netEdgeOut: best.route.netEdgeOut,
        selectedFeeTier: best.feeTierAttempt.feeTier,
        feeTierAttempts: attempts,
        quoteCount
      };
      return {
        ok: true,
        route: best.route,
        summary
      };
    }

    const gasOnly = successfulQuotes.length > 0 && successfulQuotes.every((candidate) => candidate.status === 'GAS_NOT_PRICEABLE');
    if (gasOnly) {
      const summary: VenueRouteAttemptSummary = {
        venue: 'UNISWAP_V3',
        status: 'GAS_NOT_PRICEABLE',
        reason: 'GAS_CONVERSION_FAILED',
        feeTierAttempts: attempts,
        quoteCount
      };
      return makeFailure('GAS_NOT_PRICEABLE', 'gas conversion failed for all successful quotes', summary);
    }

    if (successfulQuotes.length > 0) {
      const bestRejected = [...successfulQuotes].sort((a, b) => (a.route.netEdgeOut > b.route.netEdgeOut ? -1 : a.route.netEdgeOut < b.route.netEdgeOut ? 1 : 0))[0]!;
      const hasConstraintReject = successfulQuotes.some((candidate) => candidate.status === 'CONSTRAINT_REJECTED');
      const summary: VenueRouteAttemptSummary = {
        venue: 'UNISWAP_V3',
        status: hasConstraintReject ? 'CONSTRAINT_REJECTED' : 'NOT_PROFITABLE',
        reason: hasConstraintReject ? 'MIN_AMOUNT_OUT' : 'NET_EDGE_NON_POSITIVE',
        quotedAmountOut: bestRejected.route.quotedAmountOut,
        minAmountOut: bestRejected.route.minAmountOut,
        grossEdgeOut: bestRejected.route.grossEdgeOut,
        netEdgeOut: bestRejected.route.netEdgeOut,
        feeTierAttempts: attempts,
        quoteCount
      };
      return makeFailure(
        hasConstraintReject ? 'CONSTRAINT_REJECTED' : 'NOT_PROFITABLE',
        hasConstraintReject ? 'quoted amount below min amount out' : 'all successful quotes are not profitable',
        summary
      );
    }

    const summary: VenueRouteAttemptSummary = {
      venue: 'UNISWAP_V3',
      status: 'NOT_ROUTEABLE',
      reason: attempts.some((attempt) => attempt.status === 'QUOTE_FAILED') ? 'POOL_OR_QUOTE_UNAVAILABLE' : 'POOL_MISSING',
      feeTierAttempts: attempts,
      quoteCount
    };
    return makeFailure('NOT_ROUTEABLE', 'no fee tier produced a successful quote', summary);
  }
}
