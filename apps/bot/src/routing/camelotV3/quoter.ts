import type { Address, PublicClient } from 'viem';
import { CAMELOT_AMMV3_FACTORY_ABI, CAMELOT_AMMV3_QUOTER_ABI } from './abi.js';
import { convertGasWeiToTokenOut } from '../univ3/gasValue.js';
import type { RoutePlanningPolicy, UniV3FeeTier } from '../univ3/types.js';
import type { HedgeRoutePlan, RouteCandidateFailureReason } from '../venues.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEFAULT_UNIV3_GAS_FEE_TIERS: readonly UniV3FeeTier[] = [500, 3000, 10000];

export type CamelotAmmv3QuoterContext = {
  client: PublicClient;
  enabled: boolean;
  factory: Address;
  quoter: Address;
  univ3Factory: Address;
  univ3Quoter: Address;
};

export type CamelotAmmv3QuoteResult =
  | {
      ok: true;
      route: HedgeRoutePlan & {
        venue: 'CAMELOT_AMMV3';
        quoteMetadata: {
          venue: 'CAMELOT_AMMV3';
          observedFee?: number;
        };
      };
    }
  | {
      ok: false;
      reason: RouteCandidateFailureReason;
      details?: string;
    };

function applyBpsFloor(amount: bigint, bpsToKeep: bigint): bigint {
  return (amount * bpsToKeep) / 10_000n;
}

function sumRequiredOutput(outputs: ReadonlyArray<{ token: Address; amount: bigint }>): bigint {
  return outputs.reduce((sum, output) => sum + output.amount, 0n);
}

export class CamelotAmmv3Quoter {
  constructor(private readonly context: CamelotAmmv3QuoterContext) {}

  async quoteExactInputSingle(params: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    outputs: ReadonlyArray<{ token: Address; amount: bigint }>;
    policy?: RoutePlanningPolicy;
  }): Promise<CamelotAmmv3QuoteResult> {
    if (!this.context.enabled) {
      return { ok: false, reason: 'CAMELOT_DISABLED' };
    }

    let discoveredPool: Address;
    try {
      discoveredPool = await this.context.client.readContract({
        address: this.context.factory,
        abi: CAMELOT_AMMV3_FACTORY_ABI,
        functionName: 'poolByPair',
        args: [params.tokenIn, params.tokenOut]
      });
    } catch {
      return { ok: false, reason: 'CAMELOT_NOT_ROUTEABLE' };
    }
    if (discoveredPool.toLowerCase() === ZERO_ADDRESS) {
      return { ok: false, reason: 'CAMELOT_NOT_ROUTEABLE' };
    }

    let quotedAmountOut: bigint;
    let observedFee: number | undefined;
    try {
      const quoteResult = await this.context.client.readContract({
        address: this.context.quoter,
        abi: CAMELOT_AMMV3_QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [params.tokenIn, params.tokenOut, params.amountIn, 0n]
      });
      if (Array.isArray(quoteResult)) {
        quotedAmountOut = quoteResult[0] as bigint;
        observedFee = quoteResult[1] === undefined ? undefined : Number(quoteResult[1]);
      } else {
        quotedAmountOut = quoteResult as bigint;
      }
    } catch (error) {
      return {
        ok: false,
        reason: 'CAMELOT_QUOTE_FAILED',
        details: error instanceof Error ? error.message : String(error)
      };
    }

    const requiredOutput = sumRequiredOutput(params.outputs);
    const policy = {
      slippageBufferBps: params.policy?.slippageBufferBps ?? 50n,
      gasEstimateWei: params.policy?.gasEstimateWei ?? 0n,
      riskBufferBps: params.policy?.riskBufferBps ?? 10n,
      riskBufferOut: params.policy?.riskBufferOut ?? 0n,
      profitFloorOut: params.policy?.profitFloorOut ?? 0n
    };

    const gasConversion = await convertGasWeiToTokenOut({
      client: this.context.client,
      factory: this.context.univ3Factory,
      quoter: this.context.univ3Quoter,
      tokenOut: params.tokenOut,
      gasWei: policy.gasEstimateWei,
      supportedFeeTiers: DEFAULT_UNIV3_GAS_FEE_TIERS
    });
    if (!gasConversion.ok) {
      return { ok: false, reason: 'CAMELOT_GAS_NOT_PRICEABLE' };
    }

    const slippageBufferOut = quotedAmountOut - applyBpsFloor(quotedAmountOut, 10_000n - policy.slippageBufferBps);
    const gasCostOut = gasConversion.gasCostOut;
    const riskBufferOut = policy.riskBufferOut + (quotedAmountOut * policy.riskBufferBps) / 10_000n;
    const profitFloorOut = policy.profitFloorOut;
    const grossEdgeOut = quotedAmountOut - requiredOutput;
    const slippageFloorOut = quotedAmountOut - slippageBufferOut;
    const profitabilityFloorOut = requiredOutput + gasCostOut + riskBufferOut + profitFloorOut;
    const minAmountOut = slippageFloorOut > profitabilityFloorOut ? slippageFloorOut : profitabilityFloorOut;
    const netEdgeOut = quotedAmountOut - requiredOutput - slippageBufferOut - gasCostOut - riskBufferOut - profitFloorOut;
    if (quotedAmountOut < minAmountOut || netEdgeOut <= 0n) {
      return { ok: false, reason: 'NOT_PROFITABLE' };
    }

    return {
      ok: true,
      route: {
        venue: 'CAMELOT_AMMV3',
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn,
        requiredOutput,
        quotedAmountOut,
        minAmountOut,
        limitSqrtPriceX96: 0n,
        grossEdgeOut,
        slippageBufferOut,
        gasCostOut,
        riskBufferOut,
        profitFloorOut,
        netEdgeOut,
        quoteMetadata: {
          venue: 'CAMELOT_AMMV3',
          observedFee
        }
      }
    };
  }
}
