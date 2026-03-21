import type { Address, PublicClient } from 'viem';
import { concatHex } from 'viem';
import { CAMELOT_AMMV3_FACTORY_ABI, CAMELOT_AMMV3_QUOTER_ABI } from './abi.js';
import { convertGasWeiToTokenOut } from '../univ3/gasValue.js';
import { classifyQuoteFailure } from '../univ3/quoter.js';
import type { RoutePlanningPolicy, UniV3FeeTier } from '../univ3/types.js';
import type { HedgeRoutePlan } from '../venues.js';
import type { VenueRouteAttemptSummary } from '../attemptTypes.js';
import { buildConstraintBreakdown } from '../constraintTypes.js';
import type { ExactOutputViability } from '../exactOutputTypes.js';
import { buildHedgeGapSummary } from '../hedgeGapTypes.js';
import { deriveRejectedCandidateClass } from '../rejectedCandidateTypes.js';

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
  bridgeTokens?: readonly Address[];
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

export type CamelotPathShape = {
  kind: 'DIRECT' | 'TWO_HOP';
  hopCount: 1 | 2;
  bridgeToken?: Address;
  pathDescriptor: string;
  encodedPath?: `0x${string}`;
};

function encodeCamelotPath(tokens: readonly Address[]): `0x${string}` {
  if (tokens.length < 2 || tokens.length > 3) {
    throw new Error('camelot path requires 2 or 3 tokens (1 or 2 hops)');
  }
  const parts: `0x${string}`[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    parts.push(tokens[i]!);
    if (i < tokens.length - 1) {
      parts.push('0x000000' as `0x${string}`);
    }
  }
  return concatHex(parts);
}

function encodeCamelotPathReverse(tokens: readonly Address[]): `0x${string}` {
  if (tokens.length < 2 || tokens.length > 3) {
    throw new Error('camelot path requires 2 or 3 tokens (1 or 2 hops)');
  }
  return encodeCamelotPath([...tokens].reverse() as Address[]);
}

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
    requiredInputForTargetOutput: availableInput,
    availableInput,
    reason: 'exact-output viability skipped'
  };
}

async function quoteExactOutputSingle(
  client: PublicClient,
  quoter: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountOut: bigint,
  limitSqrtPriceX96: bigint
): Promise<{ amountIn: bigint; observedFee?: number }> {
  const quoteResult = await client.readContract({
    address: quoter,
    abi: CAMELOT_AMMV3_QUOTER_ABI,
    functionName: 'quoteExactOutputSingle',
    args: [tokenIn, tokenOut, amountOut, limitSqrtPriceX96]
  });
  if (!Array.isArray(quoteResult)) {
    if (typeof quoteResult !== 'bigint') {
      throw new Error('unexpected Camelot exact-output quote scalar result');
    }
    return { amountIn: quoteResult };
  }
  if (typeof quoteResult[0] !== 'bigint') {
    throw new Error('unexpected Camelot exact-output quote shape');
  }
  return {
    amountIn: quoteResult[0],
    observedFee: quoteResult[1] === undefined ? undefined : Number(quoteResult[1])
  };
}

async function quoteExactInputPath(
  client: PublicClient,
  quoter: Address,
  encodedPath: `0x${string}`,
  amountIn: bigint
): Promise<bigint> {
  return client.readContract({
    address: quoter,
    abi: CAMELOT_AMMV3_QUOTER_ABI,
    functionName: 'quoteExactInput',
    args: [encodedPath, amountIn]
  }) as Promise<bigint>;
}

async function quoteExactOutputPath(
  client: PublicClient,
  quoter: Address,
  encodedPath: `0x${string}`,
  amountOut: bigint
): Promise<bigint> {
  return client.readContract({
    address: quoter,
    abi: CAMELOT_AMMV3_QUOTER_ABI,
    functionName: 'quoteExactOutput',
    args: [encodedPath, amountOut]
  }) as Promise<bigint>;
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
          candidateClass: deriveRejectedCandidateClass({
            venue: 'CAMELOT_AMMV3',
            status: 'NOT_ROUTEABLE',
            reason: 'CAMELOT_DISABLED'
          }),
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
          candidateClass: deriveRejectedCandidateClass({
            venue: 'CAMELOT_AMMV3',
            status: 'NOT_ROUTEABLE',
            reason: 'POOL_LOOKUP_FAILED'
          }),
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
          candidateClass: deriveRejectedCandidateClass({
            venue: 'CAMELOT_AMMV3',
            status: 'NOT_ROUTEABLE',
            reason: 'POOL_MISSING'
          }),
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
              pathKind: 'DIRECT',
              hopCount: 1,
              pathDescriptor: `DIRECT: ${params.tokenIn} -> ${params.tokenOut}`,
              status: 'QUOTE_FAILED',
              reason: 'UNEXPECTED_QUOTE_SHAPE',
              candidateClass: deriveRejectedCandidateClass({
                venue: 'CAMELOT_AMMV3',
                status: 'QUOTE_FAILED',
                reason: 'UNEXPECTED_QUOTE_SHAPE'
              }),
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
              pathKind: 'DIRECT',
              hopCount: 1,
              pathDescriptor: `DIRECT: ${params.tokenIn} -> ${params.tokenOut}`,
              status: 'QUOTE_FAILED',
              reason: 'UNEXPECTED_QUOTE_SCALAR',
              candidateClass: deriveRejectedCandidateClass({
                venue: 'CAMELOT_AMMV3',
                status: 'QUOTE_FAILED',
                reason: 'UNEXPECTED_QUOTE_SCALAR'
              }),
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
          pathKind: 'DIRECT',
          hopCount: 1,
          pathDescriptor: `DIRECT: ${params.tokenIn} -> ${params.tokenOut}`,
          status: 'QUOTE_FAILED',
          reason: 'QUOTE_CALL_FAILED',
          candidateClass: deriveRejectedCandidateClass({
            venue: 'CAMELOT_AMMV3',
            status: 'QUOTE_FAILED',
            reason: 'QUOTE_CALL_FAILED'
          }),
          exactOutputViability: camelotExactOutputNotChecked(sumRequiredOutput(params.outputs), params.amountIn)
        }
      };
    }

    const requiredOutput = sumRequiredOutput(params.outputs);
    const policy = {
      slippageBufferBps: params.policy?.slippageBufferBps ?? 50n,
      effectiveGasPriceWei: params.policy?.effectiveGasPriceWei ?? 0n,
      riskBufferBps: params.policy?.riskBufferBps ?? 10n,
      riskBufferOut: params.policy?.riskBufferOut ?? 0n,
      profitFloorOut: params.policy?.profitFloorOut ?? 0n,
      nearMissBps: params.policy?.nearMissBps ?? DEFAULT_NEAR_MISS_BPS
    };

    const gasUnitsEstimate = 0n;
    const effectiveGasPriceWei = policy.effectiveGasPriceWei;
    const gasCostWei = gasUnitsEstimate * effectiveGasPriceWei;
    const gasConversion = await convertGasWeiToTokenOut({
      client: this.context.client,
      factory: this.context.univ3Factory,
      quoter: this.context.univ3Quoter,
      tokenOut: params.tokenOut,
      gasCostWei,
      supportedFeeTiers: DEFAULT_UNIV3_GAS_FEE_TIERS
    });
    if (!gasConversion.ok) {
      const exactOutputViability = camelotExactOutputNotChecked(requiredOutput, params.amountIn);
      return {
        ok: false,
        reason: 'GAS_NOT_PRICEABLE',
        summary: {
          venue: 'CAMELOT_AMMV3',
          pathKind: 'DIRECT',
          hopCount: 1,
          pathDescriptor: `DIRECT: ${params.tokenIn} -> ${params.tokenOut}`,
          status: 'GAS_NOT_PRICEABLE',
          reason: 'GAS_CONVERSION_FAILED',
          candidateClass: deriveRejectedCandidateClass({
            venue: 'CAMELOT_AMMV3',
            status: 'GAS_NOT_PRICEABLE',
            reason: 'GAS_CONVERSION_FAILED',
            quotedAmountOut,
            exactOutputViability
          }),
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
    let exactOutputViability: ExactOutputViability;
    try {
      const exactOutputQuote = await quoteExactOutputSingle(
        this.context.client,
        this.context.quoter,
        params.tokenIn,
        params.tokenOut,
        requiredOutput,
        0n
      );
      const requiredInputForTargetOutput = exactOutputQuote.amountIn;
      const inputDeficit = requiredInputForTargetOutput > params.amountIn ? requiredInputForTargetOutput - params.amountIn : 0n;
      const inputSlack = params.amountIn > requiredInputForTargetOutput ? params.amountIn - requiredInputForTargetOutput : 0n;
      exactOutputViability = {
        status: requiredInputForTargetOutput <= params.amountIn ? 'SATISFIABLE' : 'UNSATISFIABLE',
        targetOutput: requiredOutput,
        requiredInputForTargetOutput,
        availableInput: params.amountIn,
        inputDeficit,
        inputSlack,
        pathKind: 'DIRECT',
        hopCount: 1,
        pathDescriptor: `DIRECT: ${params.tokenIn} -> ${params.tokenOut}`,
        reason:
          requiredInputForTargetOutput <= params.amountIn
            ? 'required output satisfiable with available input'
            : 'required output unsatisfiable with available input'
      };
    } catch (error) {
      exactOutputViability = {
        status: classifyQuoteFailure(error) === 'POOL_MISSING' ? 'POOL_MISSING' : 'QUOTE_FAILED',
        targetOutput: requiredOutput,
        requiredInputForTargetOutput: params.amountIn,
        availableInput: params.amountIn,
        pathKind: 'DIRECT',
        hopCount: 1,
        pathDescriptor: `DIRECT: ${params.tokenIn} -> ${params.tokenOut}`,
        reason: `exact-output quote failed: ${classifyQuoteFailure(error)}`
      };
    }
    const hedgeGap = buildHedgeGapSummary({
      pathKind: 'DIRECT',
      hopCount: 1,
      pathDescriptor: `DIRECT: ${params.tokenIn} -> ${params.tokenOut}`,
      requiredOutput,
      quotedAmountOut,
      minAmountOut,
      exactOutputViability,
      nearMiss: breakdown.nearMiss,
      nearMissBps: breakdown.nearMissBps
    });
    if (
      exactOutputViability.status === 'SATISFIABLE'
      && exactOutputViability.requiredInputForTargetOutput <= params.amountIn
    ) {
      const targetOutput = requiredOutput;
      const maxAmountIn = params.amountIn;
      const leftoverInput = maxAmountIn - exactOutputViability.requiredInputForTargetOutput;
      let leftoverInputValueOut = 0n;
      if (leftoverInput > 0n) {
        try {
          const leftoverQuote = await this.context.client.readContract({
            address: this.context.quoter,
            abi: CAMELOT_AMMV3_QUOTER_ABI,
            functionName: 'quoteExactInputSingle',
            args: [params.tokenIn, params.tokenOut, leftoverInput, 0n]
          });
          if (typeof leftoverQuote === 'bigint') {
            leftoverInputValueOut = leftoverQuote;
          } else if (Array.isArray(leftoverQuote) && typeof leftoverQuote[0] === 'bigint') {
            leftoverInputValueOut = leftoverQuote[0];
          }
        } catch {
          leftoverInputValueOut = 0n;
        }
      }
      const grossEdgeOutExactOutput = leftoverInputValueOut;
      const riskBufferOutExactOutput = policy.riskBufferOut + (grossEdgeOutExactOutput * policy.riskBufferBps) / 10_000n;
      const breakdownExactOutput = buildConstraintBreakdown({
        requiredOutput: targetOutput,
        quotedAmountOut: targetOutput + leftoverInputValueOut,
        slippageBufferOut: 0n,
        gasCostOut,
        riskBufferOut: riskBufferOutExactOutput,
        profitFloorOut,
        nearMissBps: policy.nearMissBps
      });
      const netEdgeOutExactOutput = grossEdgeOutExactOutput - gasCostOut - riskBufferOutExactOutput - profitFloorOut;
      if (netEdgeOutExactOutput > netEdgeOut && netEdgeOutExactOutput > 0n) {
        return {
          ok: true,
          route: {
            venue: 'CAMELOT_AMMV3',
            executionMode: 'EXACT_OUTPUT',
            pathKind: 'DIRECT',
            hopCount: 1,
            tokenIn: params.tokenIn,
            tokenOut: params.tokenOut,
            amountIn: maxAmountIn,
            requiredOutput: targetOutput,
            targetOutput,
            maxAmountIn,
            quotedAmountOut: targetOutput + leftoverInputValueOut,
            minAmountOut: targetOutput,
            limitSqrtPriceX96: 0n,
            grossEdgeOut: grossEdgeOutExactOutput,
            slippageBufferOut: 0n,
            gasCostOut,
            riskBufferOut: riskBufferOutExactOutput,
            profitFloorOut,
            netEdgeOut: netEdgeOutExactOutput,
            quoteMetadata: {
              venue: 'CAMELOT_AMMV3',
              observedFee
            }
          },
          summary: {
            venue: 'CAMELOT_AMMV3',
            executionMode: 'EXACT_OUTPUT',
            pathKind: 'DIRECT',
            hopCount: 1,
            pathDescriptor: `DIRECT: ${params.tokenIn} -> ${params.tokenOut}`,
            status: 'ROUTEABLE',
            reason: 'ROUTEABLE',
            quotedAmountOut: targetOutput + leftoverInputValueOut,
            minAmountOut: targetOutput,
            grossEdgeOut: grossEdgeOutExactOutput,
            netEdgeOut: netEdgeOutExactOutput,
            constraintReason: undefined,
            constraintBreakdown: undefined,
            exactOutputViability,
            hedgeGap: buildHedgeGapSummary({
              pathKind: 'DIRECT',
              hopCount: 1,
              pathDescriptor: `DIRECT: ${params.tokenIn} -> ${params.tokenOut}`,
              requiredOutput: targetOutput,
              quotedAmountOut: targetOutput + leftoverInputValueOut,
              minAmountOut: targetOutput,
              exactOutputViability,
              nearMiss: breakdownExactOutput.nearMiss,
              nearMissBps: breakdownExactOutput.nearMissBps
            })
          }
        };
      }
    }
    if (quotedAmountOut < breakdown.requiredOutput) {
      return {
        ok: false,
        reason: 'CONSTRAINT_REJECTED',
        summary: {
          venue: 'CAMELOT_AMMV3',
          pathKind: 'DIRECT',
          hopCount: 1,
          pathDescriptor: `DIRECT: ${params.tokenIn} -> ${params.tokenOut}`,
          status: 'CONSTRAINT_REJECTED',
          reason: 'REQUIRED_OUTPUT',
          quotedAmountOut,
          minAmountOut,
          grossEdgeOut,
          netEdgeOut,
          constraintReason: 'REQUIRED_OUTPUT',
          constraintBreakdown: breakdown,
          exactOutputViability,
          hedgeGap,
          candidateClass: deriveRejectedCandidateClass({
            venue: 'CAMELOT_AMMV3',
            status: 'CONSTRAINT_REJECTED',
            reason: 'REQUIRED_OUTPUT',
            quotedAmountOut,
            constraintReason: 'REQUIRED_OUTPUT',
            constraintBreakdown: breakdown,
            exactOutputViability
          })
        }
      };
    }
    if (quotedAmountOut < minAmountOut) {
      return {
        ok: false,
        reason: 'CONSTRAINT_REJECTED',
        summary: {
          venue: 'CAMELOT_AMMV3',
          pathKind: 'DIRECT',
          hopCount: 1,
          pathDescriptor: `DIRECT: ${params.tokenIn} -> ${params.tokenOut}`,
          status: 'CONSTRAINT_REJECTED',
          reason: breakdown.bindingFloor,
          quotedAmountOut,
          minAmountOut,
          grossEdgeOut,
          netEdgeOut,
          constraintReason: breakdown.bindingFloor,
          constraintBreakdown: breakdown,
          exactOutputViability,
          hedgeGap,
          candidateClass: deriveRejectedCandidateClass({
            venue: 'CAMELOT_AMMV3',
            status: 'CONSTRAINT_REJECTED',
            reason: breakdown.bindingFloor,
            quotedAmountOut,
            constraintReason: breakdown.bindingFloor,
            constraintBreakdown: breakdown,
            exactOutputViability
          })
        }
      };
    }
    if (netEdgeOut <= 0n) {
      return {
        ok: false,
        reason: 'NOT_PROFITABLE',
        summary: {
          venue: 'CAMELOT_AMMV3',
          pathKind: 'DIRECT',
          hopCount: 1,
          pathDescriptor: `DIRECT: ${params.tokenIn} -> ${params.tokenOut}`,
          status: 'NOT_PROFITABLE',
          reason: 'NET_EDGE_NON_POSITIVE',
          quotedAmountOut,
          minAmountOut,
          grossEdgeOut,
          netEdgeOut,
          exactOutputViability,
          hedgeGap,
          candidateClass: deriveRejectedCandidateClass({
            venue: 'CAMELOT_AMMV3',
            status: 'NOT_PROFITABLE',
            reason: 'NET_EDGE_NON_POSITIVE',
            quotedAmountOut,
            exactOutputViability
          })
        }
      };
    }

    return {
      ok: true,
      route: {
        venue: 'CAMELOT_AMMV3',
        executionMode: 'EXACT_INPUT',
        pathKind: 'DIRECT',
        hopCount: 1,
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
        executionMode: 'EXACT_INPUT',
        pathKind: 'DIRECT',
        hopCount: 1,
        pathDescriptor: `DIRECT: ${params.tokenIn} -> ${params.tokenOut}`,
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

  async quoteExactInputPath(params: {
    tokenIn: Address;
    tokenOut: Address;
    bridgeToken: Address;
    amountIn: bigint;
    outputs: ReadonlyArray<{ token: Address; amount: bigint }>;
    policy?: RoutePlanningPolicy;
  }): Promise<CamelotAmmv3QuoteResult> {
    const pathDescriptor = `TWO_HOP: ${params.tokenIn} -> ${params.bridgeToken} -> ${params.tokenOut}`;
    if (!this.context.enabled) {
      const requiredOutput = sumRequiredOutput(params.outputs);
      return {
        ok: false,
        reason: 'NOT_ROUTEABLE',
        summary: {
          venue: 'CAMELOT_AMMV3',
          pathKind: 'TWO_HOP',
          hopCount: 2,
          bridgeToken: params.bridgeToken,
          pathDescriptor,
          status: 'NOT_ROUTEABLE',
          reason: 'CAMELOT_DISABLED',
          candidateClass: deriveRejectedCandidateClass({
            venue: 'CAMELOT_AMMV3',
            status: 'NOT_ROUTEABLE',
            reason: 'CAMELOT_DISABLED'
          }),
          exactOutputViability: camelotExactOutputNotChecked(requiredOutput, params.amountIn)
        }
      };
    }

    const [firstPool, secondPool] = await Promise.all([
      this.context.client.readContract({
        address: this.context.factory,
        abi: CAMELOT_AMMV3_FACTORY_ABI,
        functionName: 'poolByPair',
        args: [params.tokenIn, params.bridgeToken]
      }),
      this.context.client.readContract({
        address: this.context.factory,
        abi: CAMELOT_AMMV3_FACTORY_ABI,
        functionName: 'poolByPair',
        args: [params.bridgeToken, params.tokenOut]
      })
    ]);
    const requiredOutput = sumRequiredOutput(params.outputs);
    if (firstPool.toLowerCase() === ZERO_ADDRESS || secondPool.toLowerCase() === ZERO_ADDRESS) {
      return {
        ok: false,
        reason: 'NOT_ROUTEABLE',
        summary: {
          venue: 'CAMELOT_AMMV3',
          pathKind: 'TWO_HOP',
          hopCount: 2,
          bridgeToken: params.bridgeToken,
          pathDescriptor,
          status: 'NOT_ROUTEABLE',
          reason: 'POOL_MISSING',
          candidateClass: deriveRejectedCandidateClass({
            venue: 'CAMELOT_AMMV3',
            status: 'NOT_ROUTEABLE',
            reason: 'POOL_MISSING'
          }),
          exactOutputViability: camelotExactOutputNotChecked(requiredOutput, params.amountIn)
        }
      };
    }

    const encodedPath = encodeCamelotPath([params.tokenIn, params.bridgeToken, params.tokenOut]);
    let quotedAmountOut: bigint;
    try {
      quotedAmountOut = await quoteExactInputPath(this.context.client, this.context.quoter, encodedPath, params.amountIn);
    } catch (error) {
      return {
        ok: false,
        reason: 'QUOTE_FAILED',
        summary: {
          venue: 'CAMELOT_AMMV3',
          pathKind: 'TWO_HOP',
          hopCount: 2,
          bridgeToken: params.bridgeToken,
          pathDescriptor,
          status: 'QUOTE_FAILED',
          reason: classifyQuoteFailure(error),
          candidateClass: 'QUOTE_FAILED',
          exactOutputViability: camelotExactOutputNotChecked(requiredOutput, params.amountIn)
        }
      };
    }

    const policy = {
      slippageBufferBps: params.policy?.slippageBufferBps ?? 50n,
      effectiveGasPriceWei: params.policy?.effectiveGasPriceWei ?? 0n,
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
      gasCostWei: 0n,
      supportedFeeTiers: DEFAULT_UNIV3_GAS_FEE_TIERS
    });
    if (!gasConversion.ok) {
      const exactOutputViability = camelotExactOutputNotChecked(requiredOutput, params.amountIn);
      return {
        ok: false,
        reason: 'GAS_NOT_PRICEABLE',
        summary: {
          venue: 'CAMELOT_AMMV3',
          pathKind: 'TWO_HOP',
          hopCount: 2,
          bridgeToken: params.bridgeToken,
          pathDescriptor,
          status: 'GAS_NOT_PRICEABLE',
          reason: 'GAS_CONVERSION_FAILED',
          quotedAmountOut,
          exactOutputViability,
          hedgeGap: buildHedgeGapSummary({ requiredOutput, quotedAmountOut, exactOutputViability, nearMiss: false, nearMissBps: policy.nearMissBps }),
          candidateClass: deriveRejectedCandidateClass({
            venue: 'CAMELOT_AMMV3',
            status: 'GAS_NOT_PRICEABLE',
            reason: 'GAS_CONVERSION_FAILED',
            quotedAmountOut,
            exactOutputViability
          })
        }
      };
    }

    let exactOutputViability: ExactOutputViability;
    try {
      const requiredInputForTargetOutput = await quoteExactOutputPath(
        this.context.client,
        this.context.quoter,
        encodeCamelotPathReverse([params.tokenIn, params.bridgeToken, params.tokenOut]),
        requiredOutput
      );
      const inputDeficit = requiredInputForTargetOutput > params.amountIn ? requiredInputForTargetOutput - params.amountIn : 0n;
      const inputSlack = params.amountIn > requiredInputForTargetOutput ? params.amountIn - requiredInputForTargetOutput : 0n;
      exactOutputViability = {
        status: requiredInputForTargetOutput <= params.amountIn ? 'SATISFIABLE' : 'UNSATISFIABLE',
        targetOutput: requiredOutput,
        requiredInputForTargetOutput,
        availableInput: params.amountIn,
        inputDeficit,
        inputSlack,
        pathKind: 'TWO_HOP',
        hopCount: 2,
        bridgeToken: params.bridgeToken,
        pathDescriptor,
        reason: requiredInputForTargetOutput <= params.amountIn ? 'required output satisfiable with available input' : 'required output unsatisfiable with available input'
      };
    } catch (error) {
      exactOutputViability = {
        status: 'QUOTE_FAILED',
        targetOutput: requiredOutput,
        requiredInputForTargetOutput: params.amountIn,
        availableInput: params.amountIn,
        pathKind: 'TWO_HOP',
        hopCount: 2,
        bridgeToken: params.bridgeToken,
        pathDescriptor,
        reason: `exact-output quote failed: ${classifyQuoteFailure(error)}`
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
    const minAmountOut = breakdown.minAmountOut;
    const grossEdgeOut = quotedAmountOut - breakdown.requiredOutput;
    const netEdgeOut = quotedAmountOut - breakdown.requiredOutput - breakdown.slippageBufferOut - gasCostOut - riskBufferOut - profitFloorOut;
    const hedgeGap = buildHedgeGapSummary({
      pathKind: 'TWO_HOP',
      hopCount: 2,
      bridgeToken: params.bridgeToken,
      pathDescriptor,
      requiredOutput,
      quotedAmountOut,
      minAmountOut,
      exactOutputViability,
      nearMiss: breakdown.nearMiss,
      nearMissBps: breakdown.nearMissBps
    });
    const summaryBase = {
      venue: 'CAMELOT_AMMV3' as const,
      executionMode: 'EXACT_INPUT' as const,
      pathKind: 'TWO_HOP' as const,
      hopCount: 2 as const,
      bridgeToken: params.bridgeToken,
      pathDescriptor,
      quotedAmountOut,
      minAmountOut,
      grossEdgeOut,
      netEdgeOut,
      exactOutputViability,
      hedgeGap
    };
    if (quotedAmountOut < breakdown.requiredOutput) {
      return {
        ok: false,
        reason: 'CONSTRAINT_REJECTED',
        summary: {
          ...summaryBase,
          status: 'CONSTRAINT_REJECTED',
          reason: 'REQUIRED_OUTPUT',
          constraintReason: 'REQUIRED_OUTPUT',
          constraintBreakdown: breakdown,
          candidateClass: deriveRejectedCandidateClass({
            venue: 'CAMELOT_AMMV3',
            status: 'CONSTRAINT_REJECTED',
            reason: 'REQUIRED_OUTPUT',
            constraintReason: 'REQUIRED_OUTPUT',
            quotedAmountOut,
            constraintBreakdown: breakdown,
            exactOutputViability
          })
        }
      };
    }
    if (quotedAmountOut < minAmountOut) {
      return {
        ok: false,
        reason: 'CONSTRAINT_REJECTED',
        summary: {
          ...summaryBase,
          status: 'CONSTRAINT_REJECTED',
          reason: breakdown.bindingFloor,
          constraintReason: breakdown.bindingFloor,
          constraintBreakdown: breakdown,
          candidateClass: deriveRejectedCandidateClass({
            venue: 'CAMELOT_AMMV3',
            status: 'CONSTRAINT_REJECTED',
            reason: breakdown.bindingFloor,
            constraintReason: breakdown.bindingFloor,
            quotedAmountOut,
            constraintBreakdown: breakdown,
            exactOutputViability
          })
        }
      };
    }
    if (netEdgeOut <= 0n) {
      return {
        ok: false,
        reason: 'NOT_PROFITABLE',
        summary: {
          ...summaryBase,
          status: 'NOT_PROFITABLE',
          reason: 'NET_EDGE_NON_POSITIVE',
          candidateClass: deriveRejectedCandidateClass({
            venue: 'CAMELOT_AMMV3',
            status: 'NOT_PROFITABLE',
            reason: 'NET_EDGE_NON_POSITIVE',
            quotedAmountOut,
            exactOutputViability
          })
        }
      };
    }
    return {
      ok: true,
      route: {
        venue: 'CAMELOT_AMMV3',
        executionMode: 'EXACT_INPUT',
        pathKind: 'TWO_HOP',
        hopCount: 2,
        bridgeToken: params.bridgeToken,
        encodedPath,
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
        quoteMetadata: { venue: 'CAMELOT_AMMV3' }
      },
      summary: {
        ...summaryBase,
        executionMode: 'EXACT_INPUT',
        status: 'ROUTEABLE',
        reason: 'ROUTEABLE'
      }
    };
  }
}
