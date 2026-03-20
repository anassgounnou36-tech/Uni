import type { Address, PublicClient } from 'viem';
import { CAMELOT_AMMV3_FACTORY_ABI, CAMELOT_AMMV3_QUOTER_ABI } from './abi.js';
import { convertGasWeiToTokenOut } from '../univ3/gasValue.js';
import type { RoutePlanningPolicy, UniV3FeeTier } from '../univ3/types.js';
import type { HedgeRoutePlan } from '../venues.js';
import type { VenueRouteAttemptSummary } from '../attemptTypes.js';
import { buildConstraintBreakdown } from '../constraintTypes.js';
import type { ExactOutputViability } from '../exactOutputTypes.js';
import { buildHedgeGapSummary } from '../hedgeGapTypes.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEFAULT_UNIV3_GAS_FEE_TIERS: readonly UniV3FeeTier[] = [500, 3000, 10000];
const DEFAULT_NEAR_MISS_BPS = 25n;

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
      summary: VenueRouteAttemptSummary;
    }
  | {
      ok: false;
      reason: 'NOT_ROUTEABLE' | 'QUOTE_FAILED' | 'NOT_PROFITABLE' | 'GAS_NOT_PRICEABLE' | 'CONSTRAINT_REJECTED';
      details?: string;
      summary: VenueRouteAttemptSummary;
    };

function applyBpsFloor(amount: bigint, bpsToKeep: bigint): bigint {
  return (amount * bpsToKeep) / 10_000n;
}

function sumRequiredOutput(outputs: ReadonlyArray<{ token: Address; amount: bigint }>): bigint {
  return outputs.reduce((sum, output) => sum + output.amount, 0n);
}

function camelotExactOutputNotChecked(requiredOutput: bigint, availableInput: bigint): ExactOutputViability {
  return {
    status: 'NOT_CHECKED',
    targetOutput: requiredOutput,
    requiredInputForTargetOutput: 0n,
    availableInput,
    inputDeficit: 0n,
    inputSlack: availableInput > 0n ? availableInput : 0n,
    reason: 'exact-output diagnostic not implemented for camelot in this pr'
  };
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
      const requiredOutput = sumRequiredOutput(params.outputs);
      return {
        ok: false,
        reason: 'NOT_ROUTEABLE',
        summary: {
          venue: 'CAMELOT_AMMV3',
          status: 'NOT_ROUTEABLE',
          reason: 'CAMELOT_DISABLED',
          exactOutputViability: camelotExactOutputNotChecked(requiredOutput, params.amountIn)
        }
      };
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
      const requiredOutput = sumRequiredOutput(params.outputs);
      return {
        ok: false,
        reason: 'NOT_ROUTEABLE',
        summary: {
          venue: 'CAMELOT_AMMV3',
          status: 'NOT_ROUTEABLE',
          reason: 'POOL_LOOKUP_FAILED',
          exactOutputViability: camelotExactOutputNotChecked(requiredOutput, params.amountIn)
        }
      };
    }
    if (discoveredPool.toLowerCase() === ZERO_ADDRESS) {
      const requiredOutput = sumRequiredOutput(params.outputs);
      return {
        ok: false,
        reason: 'NOT_ROUTEABLE',
        summary: {
          venue: 'CAMELOT_AMMV3',
          status: 'NOT_ROUTEABLE',
          reason: 'POOL_MISSING',
          exactOutputViability: camelotExactOutputNotChecked(requiredOutput, params.amountIn)
        }
      };
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
        if (typeof quoteResult[0] !== 'bigint') {
          return {
            ok: false,
            reason: 'QUOTE_FAILED',
            details: 'unexpected Camelot quote shape',
            summary: {
              venue: 'CAMELOT_AMMV3',
              status: 'QUOTE_FAILED',
              reason: 'UNEXPECTED_QUOTE_SHAPE',
              exactOutputViability: camelotExactOutputNotChecked(sumRequiredOutput(params.outputs), params.amountIn)
            }
          };
        }
        quotedAmountOut = quoteResult[0];
        observedFee = quoteResult[1] === undefined ? undefined : Number(quoteResult[1]);
      } else {
        if (typeof quoteResult !== 'bigint') {
          return {
            ok: false,
            reason: 'QUOTE_FAILED',
            details: 'unexpected Camelot quote scalar result',
            summary: {
              venue: 'CAMELOT_AMMV3',
              status: 'QUOTE_FAILED',
              reason: 'UNEXPECTED_QUOTE_SCALAR',
              exactOutputViability: camelotExactOutputNotChecked(sumRequiredOutput(params.outputs), params.amountIn)
            }
          };
        }
        quotedAmountOut = quoteResult;
      }
    } catch (error) {
      return {
        ok: false,
        reason: 'QUOTE_FAILED',
        details: error instanceof Error ? error.message : String(error),
        summary: {
          venue: 'CAMELOT_AMMV3',
          status: 'QUOTE_FAILED',
          reason: 'QUOTE_CALL_FAILED',
          exactOutputViability: camelotExactOutputNotChecked(sumRequiredOutput(params.outputs), params.amountIn)
        }
      };
    }

    const requiredOutput = sumRequiredOutput(params.outputs);
    const policy = {
      slippageBufferBps: params.policy?.slippageBufferBps ?? 50n,
      gasEstimateWei: params.policy?.gasEstimateWei ?? 0n,
      riskBufferBps: params.policy?.riskBufferBps ?? 10n,
      riskBufferOut: params.policy?.riskBufferOut ?? 0n,
      profitFloorOut: params.policy?.profitFloorOut ?? 0n,
      nearMissBps: params.policy?.nearMissBps ?? DEFAULT_NEAR_MISS_BPS
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
      const exactOutputViability = camelotExactOutputNotChecked(requiredOutput, params.amountIn);
      return {
        ok: false,
        reason: 'GAS_NOT_PRICEABLE',
        summary: {
          venue: 'CAMELOT_AMMV3',
          status: 'GAS_NOT_PRICEABLE',
          reason: 'GAS_CONVERSION_FAILED',
          quotedAmountOut,
          grossEdgeOut: quotedAmountOut - requiredOutput,
          exactOutputViability,
          hedgeGap: buildHedgeGapSummary({
            requiredOutput,
            quotedAmountOut,
            exactOutputViability,
            nearMiss: false,
            nearMissBps: policy.nearMissBps
          })
        }
      };
    }

    const slippageBufferOut = quotedAmountOut - applyBpsFloor(quotedAmountOut, 10_000n - policy.slippageBufferBps);
    const gasCostOut = gasConversion.gasCostOut;
    const riskBufferOut = policy.riskBufferOut + (quotedAmountOut * policy.riskBufferBps) / 10_000n;
    const profitFloorOut = policy.profitFloorOut;
    const breakdown = buildConstraintBreakdown({
      requiredOutput,
      quotedAmountOut,
      slippageBufferOut,
      gasCostOut,
      riskBufferOut,
      profitFloorOut,
      nearMissBps: policy.nearMissBps
    });
    const grossEdgeOut = quotedAmountOut - breakdown.requiredOutput;
    const minAmountOut = breakdown.minAmountOut;
    const netEdgeOut =
      quotedAmountOut - breakdown.requiredOutput - breakdown.slippageBufferOut - gasCostOut - riskBufferOut - profitFloorOut;
    const exactOutputViability = camelotExactOutputNotChecked(requiredOutput, params.amountIn);
    const hedgeGap = buildHedgeGapSummary({
      requiredOutput,
      quotedAmountOut,
      minAmountOut,
      exactOutputViability,
      nearMiss: breakdown.nearMiss,
      nearMissBps: breakdown.nearMissBps
    });
    if (quotedAmountOut < breakdown.requiredOutput) {
      return {
        ok: false,
        reason: 'CONSTRAINT_REJECTED',
        summary: {
          venue: 'CAMELOT_AMMV3',
          status: 'CONSTRAINT_REJECTED',
          reason: 'REQUIRED_OUTPUT',
          quotedAmountOut,
          minAmountOut,
          grossEdgeOut,
          netEdgeOut,
          constraintReason: 'REQUIRED_OUTPUT',
          constraintBreakdown: breakdown,
          exactOutputViability,
          hedgeGap
        }
      };
    }
    if (quotedAmountOut < minAmountOut) {
      return {
        ok: false,
        reason: 'CONSTRAINT_REJECTED',
        summary: {
          venue: 'CAMELOT_AMMV3',
          status: 'CONSTRAINT_REJECTED',
          reason: breakdown.bindingFloor,
          quotedAmountOut,
          minAmountOut,
          grossEdgeOut,
          netEdgeOut,
          constraintReason: breakdown.bindingFloor,
          constraintBreakdown: breakdown,
          exactOutputViability,
          hedgeGap
        }
      };
    }
    if (netEdgeOut <= 0n) {
      return {
        ok: false,
        reason: 'NOT_PROFITABLE',
        summary: {
          venue: 'CAMELOT_AMMV3',
          status: 'NOT_PROFITABLE',
          reason: 'NET_EDGE_NON_POSITIVE',
          quotedAmountOut,
          minAmountOut,
          grossEdgeOut,
          netEdgeOut,
          exactOutputViability,
          hedgeGap
        }
      };
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
      },
      summary: {
        venue: 'CAMELOT_AMMV3',
        status: 'ROUTEABLE',
        reason: 'ROUTEABLE',
        quotedAmountOut,
        minAmountOut,
        grossEdgeOut,
        netEdgeOut,
        exactOutputViability,
        hedgeGap
      }
    };
  }
}
