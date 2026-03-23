import type { Address } from 'viem';
import { discoverPoolWithStatus } from './poolDiscovery.js';
import {
  classifyQuoteFailure,
  encodeUniV3Path,
  reverseUniV3Path,
  quoteExactInputPath,
  quoteExactInputSingle,
  quoteExactOutputPath,
  quoteExactOutputSingle
} from './quoter.js';
import { convertGasWeiToTokenOut } from './gasValue.js';
import type {
  RoutePlannerInput,
  RoutePlanningPolicy,
  RoutePlanningResult,
  UniV3FeeTier,
  UniV3RoutePlan,
  UniV3RoutingContext
} from './types.js';
import type { FeeTierAttemptSummary, RejectedVenueRouteAttemptSummary, RouteAttemptStatus, VenueRouteAttemptSummary } from '../attemptTypes.js';
import { buildConstraintBreakdown, type ConstraintBreakdown, type ConstraintRejectReason } from '../constraintTypes.js';
import type { ExactOutputViability } from '../exactOutputTypes.js';
import { buildHedgeGapSummary } from '../hedgeGapTypes.js';
import { deriveRejectedCandidateClass, ensureRejectedCandidateClass } from '../rejectedCandidateTypes.js';
import type { RoutePathKind } from '../pathTypes.js';
import type { HedgeExecutionMode } from '../executionModeTypes.js';

const DEFAULT_FEE_TIERS: readonly UniV3FeeTier[] = [500, 3000, 10000];
const DEFAULT_NEAR_MISS_BPS = 25n;

function sumRequiredOutput(outputs: ReadonlyArray<{ token: Address; amount: bigint }>): bigint {
  return outputs.reduce((sum, output) => sum + output.amount, 0n);
}

function applyBpsFloor(amount: bigint, bpsToKeep: bigint): bigint {
  return (amount * bpsToKeep) / 10_000n;
}

function normalizePolicy(policy: RoutePlanningPolicy | undefined): Required<RoutePlanningPolicy> {
  return {
    feeTiers: policy?.feeTiers ?? DEFAULT_FEE_TIERS,
    bridgeTokens: policy?.bridgeTokens ?? [],
    slippageBufferBps: policy?.slippageBufferBps ?? 50n,
    effectiveGasPriceWei: policy?.effectiveGasPriceWei ?? 0n,
    riskBufferBps: policy?.riskBufferBps ?? 10n,
    riskBufferOut: policy?.riskBufferOut ?? 0n,
    profitFloorOut: policy?.profitFloorOut ?? 0n,
    nearMissBps: policy?.nearMissBps ?? DEFAULT_NEAR_MISS_BPS
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

function deriveAttemptCandidateClass(summary: Pick<
  VenueRouteAttemptSummary,
  'venue' | 'status' | 'reason' | 'constraintReason' | 'constraintBreakdown' | 'exactOutputViability' | 'quotedAmountOut'
>): VenueRouteAttemptSummary['candidateClass'] {
  if (summary.status === 'ROUTEABLE') {
    return undefined;
  }
  return deriveRejectedCandidateClass(summary as VenueRouteAttemptSummary);
}

type Candidate = {
  route: UniV3RoutePlan;
  feeTierAttempt: FeeTierAttemptSummary;
  status: RouteAttemptStatus;
  reason: string;
  constraintReason?: ConstraintRejectReason;
  constraintBreakdown?: ConstraintBreakdown;
};

type PathShape = {
  kind: RoutePathKind;
  hopCount: 1 | 2;
  bridgeToken?: Address;
  feeTier: number;
  secondFeeTier?: number;
  encodedPath?: `0x${string}`;
};

function riskBufferFromEdge(edgeOut: bigint, policy: Required<RoutePlanningPolicy>): bigint {
  return policy.riskBufferOut + (edgeOut * policy.riskBufferBps) / 10_000n;
}

function buildPathDescriptor(kind: RoutePathKind, tokenIn: Address, tokenOut: Address, bridgeToken?: Address): string {
  if (kind === 'TWO_HOP' && bridgeToken) {
    return `TWO_HOP: ${tokenIn} -> ${bridgeToken} -> ${tokenOut}`;
  }
  return `DIRECT: ${tokenIn} -> ${tokenOut}`;
}

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
        candidateClass: ensureRejectedCandidateClass({
          venue: 'UNISWAP_V3',
          status: 'NOT_ROUTEABLE',
          reason: 'ORDER_HAS_NO_OUTPUTS'
        }).candidateClass,
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
        candidateClass: ensureRejectedCandidateClass({
          venue: 'UNISWAP_V3',
          status: 'NOT_ROUTEABLE',
          reason: 'OUTPUT_TOKEN_MISMATCH'
        }).candidateClass,
        feeTierAttempts: []
      };
      return makeFailure('NOT_ROUTEABLE', 'output token mismatch', summary);
    }

    const amountIn = resolvedOrder.input.amount;
    const requiredOutput = sumRequiredOutput(resolvedOrder.outputs as ReadonlyArray<{ token: Address; amount: bigint }>);
    const attempts: FeeTierAttemptSummary[] = [];
    const candidates: Candidate[] = [];
    let quoteCount = 0;

    const evaluatePathCandidate = async (shape: PathShape): Promise<void> => {
      const pathDescriptor = buildPathDescriptor(shape.kind, tokenIn, tokenOut, shape.bridgeToken);
      if (shape.kind === 'DIRECT') {
        const discovery = await discoverPoolWithStatus(this.context.client, this.context.factory, tokenIn, tokenOut, shape.feeTier as UniV3FeeTier);
        if (!discovery.pool) {
          attempts.push({
            feeTier: shape.feeTier,
            secondFeeTier: shape.secondFeeTier,
            pathKind: shape.kind,
            hopCount: shape.hopCount,
            pathDescriptor,
            poolExists: false,
            quoteSucceeded: false,
            status: 'NOT_ROUTEABLE',
            reason: discovery.status === 'POOL_MISSING' ? 'POOL_MISSING' : 'POOL_INACTIVE',
            exactOutputViability: {
              status: discovery.status === 'POOL_MISSING' ? 'POOL_MISSING' : 'NOT_CHECKED',
              targetOutput: requiredOutput,
              requiredInputForTargetOutput: 0n,
              availableInput: amountIn,
              inputDeficit: 0n,
              inputSlack: amountIn > 0n ? amountIn : 0n,
              checkedFeeTier: shape.feeTier,
              reason: 'pool missing'
            },
            candidateClass: discovery.status === 'POOL_MISSING' ? 'ROUTE_MISSING' : 'UNKNOWN'
          });
          return;
        }
      } else {
        const bridge = shape.bridgeToken!;
        const first = await discoverPoolWithStatus(this.context.client, this.context.factory, tokenIn, bridge, shape.feeTier as UniV3FeeTier);
        const second = await discoverPoolWithStatus(
          this.context.client,
          this.context.factory,
          bridge,
          tokenOut,
          shape.secondFeeTier as UniV3FeeTier
        );
        if (!first.pool || !second.pool) {
          attempts.push({
            feeTier: shape.feeTier,
            secondFeeTier: shape.secondFeeTier,
            pathKind: shape.kind,
            hopCount: shape.hopCount,
            bridgeToken: bridge,
            pathDescriptor,
            poolExists: false,
            quoteSucceeded: false,
            status: 'NOT_ROUTEABLE',
            reason: 'POOL_MISSING',
            exactOutputViability: {
              status: 'POOL_MISSING',
              targetOutput: requiredOutput,
              requiredInputForTargetOutput: 0n,
              availableInput: amountIn,
              inputDeficit: 0n,
              inputSlack: amountIn > 0n ? amountIn : 0n,
              checkedFeeTier: shape.feeTier,
              reason: 'bridge pool missing'
            },
            candidateClass: 'ROUTE_MISSING'
          });
          return;
        }
      }

      let quote: { amountOut: bigint; gasUnitsEstimate: bigint };
      let exactOutputViability: ExactOutputViability;
      try {
        quote = shape.kind === 'DIRECT'
          ? await quoteExactInputSingle(
            this.context.client,
            this.context.quoter,
            tokenIn,
            tokenOut,
            shape.feeTier as UniV3FeeTier,
            amountIn
          )
          : await quoteExactInputPath(this.context.client, this.context.quoter, shape.encodedPath!, amountIn);
      } catch (error) {
        attempts.push({
          feeTier: shape.feeTier,
          secondFeeTier: shape.secondFeeTier,
          pathKind: shape.kind,
          hopCount: shape.hopCount,
          bridgeToken: shape.bridgeToken,
          pathDescriptor,
          poolExists: true,
          quoteSucceeded: false,
          status: 'QUOTE_FAILED',
          reason: classifyQuoteFailure(error),
          exactOutputViability: {
            status: 'NOT_CHECKED',
            targetOutput: requiredOutput,
            requiredInputForTargetOutput: 0n,
            availableInput: amountIn,
            inputDeficit: 0n,
            inputSlack: amountIn > 0n ? amountIn : 0n,
            checkedFeeTier: shape.feeTier,
            reason: 'exact-output viability skipped because exact-input quote failed'
          },
          candidateClass: 'QUOTE_FAILED'
        });
        return;
      }

      try {
        const exactOutputPath = shape.kind === 'TWO_HOP' ? reverseUniV3Path(shape.encodedPath!) : undefined;
        const exactOutputQuote = shape.kind === 'DIRECT'
          ? await quoteExactOutputSingle(
            this.context.client,
            this.context.quoter,
            tokenIn,
            tokenOut,
            shape.feeTier as UniV3FeeTier,
            requiredOutput,
            0n
          )
          : await quoteExactOutputPath(this.context.client, this.context.quoter, exactOutputPath!, requiredOutput);
        const requiredInputForTargetOutput = exactOutputQuote.amountIn;
        const inputDeficit = requiredInputForTargetOutput > amountIn ? requiredInputForTargetOutput - amountIn : 0n;
        const inputSlack = amountIn > requiredInputForTargetOutput ? amountIn - requiredInputForTargetOutput : 0n;
        exactOutputViability = {
          status: requiredInputForTargetOutput <= amountIn ? 'SATISFIABLE' : 'UNSATISFIABLE',
          targetOutput: requiredOutput,
          requiredInputForTargetOutput,
          availableInput: amountIn,
          inputDeficit,
          inputSlack,
          checkedFeeTier: shape.feeTier,
          pathKind: shape.kind,
          hopCount: shape.hopCount,
          bridgeToken: shape.bridgeToken,
          pathDescriptor,
          reason:
            requiredInputForTargetOutput <= amountIn
              ? 'required output satisfiable with available input'
              : 'required output unsatisfiable with available input'
        };
      } catch (error) {
        exactOutputViability = {
          status: 'QUOTE_FAILED',
          targetOutput: requiredOutput,
          requiredInputForTargetOutput: 0n,
          availableInput: amountIn,
          inputDeficit: 0n,
          inputSlack: amountIn > 0n ? amountIn : 0n,
          checkedFeeTier: shape.feeTier,
          pathKind: shape.kind,
          hopCount: shape.hopCount,
          bridgeToken: shape.bridgeToken,
          pathDescriptor,
          reason: `exact-output quote failed: ${classifyQuoteFailure(error)}`
        };
      }

      quoteCount += 1;
      const quotedAmountOut = quote.amountOut;
      const slippageBufferOut = quotedAmountOut - applyBpsFloor(quotedAmountOut, 10_000n - policy.slippageBufferBps);
      const gasCostWei = quote.gasUnitsEstimate * policy.effectiveGasPriceWei;
      const gasConversion = await convertGasWeiToTokenOut({
        client: this.context.client,
        factory: this.context.factory,
        quoter: this.context.quoter,
        tokenOut,
        gasCostWei,
        supportedFeeTiers: policy.feeTiers
      });
      if (!gasConversion.ok) {
        const requiredFloor = requiredOutput + (quotedAmountOut * policy.riskBufferBps) / 10_000n + policy.riskBufferOut + policy.profitFloorOut;
        attempts.push({
          feeTier: shape.feeTier,
          secondFeeTier: shape.secondFeeTier,
          pathKind: shape.kind,
          hopCount: shape.hopCount,
          bridgeToken: shape.bridgeToken,
          pathDescriptor,
          poolExists: true,
          quoteSucceeded: true,
          quotedAmountOut,
          minAmountOut: requiredFloor,
          grossEdgeOut: quotedAmountOut - requiredOutput,
          status: 'GAS_NOT_PRICEABLE',
          reason: 'GAS_CONVERSION_FAILED',
          exactOutputViability,
          hedgeGap: buildHedgeGapSummary({
            pathKind: shape.kind,
            hopCount: shape.hopCount,
            bridgeToken: shape.bridgeToken,
            pathDescriptor,
            requiredOutput,
            quotedAmountOut,
            minAmountOut: requiredFloor,
            exactOutputViability,
            nearMiss: false,
            nearMissBps: policy.nearMissBps
          }),
          candidateClass: 'GAS_NOT_PRICEABLE'
        });
        return;
      }

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
      const netEdgeOut = quotedAmountOut - breakdown.requiredOutput - breakdown.slippageBufferOut - gasCostOut - riskBufferOut - profitFloorOut;
      let status: RouteAttemptStatus = 'ROUTEABLE';
      let reason = 'ROUTE_SELECTED';
      let constraintReason: ConstraintRejectReason | undefined;
      let constraintBreakdown: ConstraintBreakdown | undefined;
      if (quotedAmountOut < breakdown.requiredOutput) {
        status = 'CONSTRAINT_REJECTED';
        constraintReason = 'REQUIRED_OUTPUT';
        reason = constraintReason;
        constraintBreakdown = breakdown;
      } else if (quotedAmountOut < minAmountOut) {
        status = 'CONSTRAINT_REJECTED';
        constraintReason = breakdown.bindingFloor;
        reason = constraintReason;
        constraintBreakdown = breakdown;
      } else if (netEdgeOut <= 0n) {
        status = 'NOT_PROFITABLE';
        reason = 'NET_EDGE_NON_POSITIVE';
      }
      const attemptSummary: FeeTierAttemptSummary = {
        feeTier: shape.feeTier,
        secondFeeTier: shape.secondFeeTier,
        executionMode: 'EXACT_INPUT',
        pathKind: shape.kind,
        hopCount: shape.hopCount,
        bridgeToken: shape.bridgeToken,
        pathDescriptor,
        poolExists: true,
        quoteSucceeded: true,
        quotedAmountOut,
        minAmountOut,
        grossEdgeOut,
        netEdgeOut,
        status,
        reason,
        constraintReason,
        constraintBreakdown,
        exactOutputViability,
        hedgeGap: buildHedgeGapSummary({
          pathKind: shape.kind,
          hopCount: shape.hopCount,
          bridgeToken: shape.bridgeToken,
          pathDescriptor,
          requiredOutput,
          quotedAmountOut,
          minAmountOut,
          exactOutputViability,
          nearMiss: breakdown.nearMiss,
          nearMissBps: breakdown.nearMissBps
        }),
        candidateClass: deriveAttemptCandidateClass({
          venue: 'UNISWAP_V3',
          status,
          reason,
          constraintReason,
          constraintBreakdown,
          exactOutputViability,
          quotedAmountOut
        })
      };
      attempts.push(attemptSummary);
      const route: UniV3RoutePlan = {
        venue: 'UNISWAP_V3',
        executionMode: 'EXACT_INPUT',
        pathKind: shape.kind,
        hopCount: shape.hopCount,
        pathDirection: 'FORWARD',
        bridgeToken: shape.bridgeToken,
        encodedPath: shape.encodedPath,
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
          poolFee: shape.feeTier as UniV3FeeTier
        }
      };
      candidates.push({ route, feeTierAttempt: attemptSummary, status, reason, constraintReason, constraintBreakdown });

      if (
        exactOutputViability.status !== 'SATISFIABLE'
        || exactOutputViability.requiredInputForTargetOutput > amountIn
      ) {
        return;
      }

      const targetOutput = requiredOutput;
      const maxAmountIn = amountIn;
      const requiredInputForTargetOutput = exactOutputViability.requiredInputForTargetOutput;
      const leftoverInput = maxAmountIn - requiredInputForTargetOutput;
      let leftoverInputValueOut = 0n;
      if (leftoverInput > 0n) {
        try {
          const leftoverQuote = shape.kind === 'DIRECT'
            ? await quoteExactInputSingle(
              this.context.client,
              this.context.quoter,
              tokenIn,
              tokenOut,
              shape.feeTier as UniV3FeeTier,
              leftoverInput
            )
            : await quoteExactInputPath(this.context.client, this.context.quoter, shape.encodedPath!, leftoverInput);
          leftoverInputValueOut = leftoverQuote.amountOut;
        } catch (error) {
          attempts.push({
            feeTier: shape.feeTier,
            secondFeeTier: shape.secondFeeTier,
            executionMode: 'EXACT_OUTPUT',
            pathKind: shape.kind,
            hopCount: shape.hopCount,
            bridgeToken: shape.bridgeToken,
            pathDescriptor,
            poolExists: true,
            quoteSucceeded: false,
            status: 'QUOTE_FAILED',
            reason: `EXACT_OUTPUT_LEFTOVER_QUOTE_FAILED:${classifyQuoteFailure(error)}`,
            exactOutputViability,
            candidateClass: 'QUOTE_FAILED'
          });
          return;
        }
      }

      const quotedAmountOutExactOutput = targetOutput + leftoverInputValueOut;
      const slippageBufferOutExactOutput = 0n;
      const grossEdgeOutExactOutput = leftoverInputValueOut;
      const riskBufferOutExactOutput = riskBufferFromEdge(grossEdgeOutExactOutput, policy);
      const breakdownExactOutput = buildConstraintBreakdown({
        requiredOutput: targetOutput,
        quotedAmountOut: quotedAmountOutExactOutput,
        slippageBufferOut: slippageBufferOutExactOutput,
        gasCostOut,
        riskBufferOut: riskBufferOutExactOutput,
        profitFloorOut,
        nearMissBps: policy.nearMissBps
      });
      const minAmountOutExactOutput = targetOutput;
      const netEdgeOutExactOutput =
        grossEdgeOutExactOutput - gasCostOut - riskBufferOutExactOutput - profitFloorOut;
      const exactOutputRouteable = netEdgeOutExactOutput > 0n;
      const exactOutputStatus: RouteAttemptStatus = exactOutputRouteable ? 'ROUTEABLE' : 'CONSTRAINT_REJECTED';
      const exactOutputReason = exactOutputRouteable ? 'ROUTE_SELECTED' : breakdownExactOutput.bindingFloor;
      const exactOutputConstraintReason: ConstraintRejectReason | undefined = exactOutputRouteable
        ? undefined
        : breakdownExactOutput.bindingFloor;
      const exactOutputConstraintBreakdown = exactOutputRouteable ? undefined : breakdownExactOutput;

      const exactOutputAttemptSummary: FeeTierAttemptSummary = {
        feeTier: shape.feeTier,
        secondFeeTier: shape.secondFeeTier,
        executionMode: 'EXACT_OUTPUT',
        pathKind: shape.kind,
        hopCount: shape.hopCount,
        bridgeToken: shape.bridgeToken,
        pathDescriptor,
        poolExists: true,
        quoteSucceeded: true,
        quotedAmountOut: quotedAmountOutExactOutput,
        minAmountOut: minAmountOutExactOutput,
        grossEdgeOut: grossEdgeOutExactOutput,
        netEdgeOut: netEdgeOutExactOutput,
        status: exactOutputStatus,
        reason: exactOutputReason,
        constraintReason: exactOutputConstraintReason,
        constraintBreakdown: exactOutputConstraintBreakdown,
        exactOutputViability,
        hedgeGap: buildHedgeGapSummary({
          pathKind: shape.kind,
          hopCount: shape.hopCount,
          bridgeToken: shape.bridgeToken,
          pathDescriptor,
          requiredOutput: targetOutput,
          quotedAmountOut: quotedAmountOutExactOutput,
          minAmountOut: minAmountOutExactOutput,
          exactOutputViability,
          nearMiss: breakdownExactOutput.nearMiss,
          nearMissBps: breakdownExactOutput.nearMissBps
        }),
        candidateClass: deriveAttemptCandidateClass({
          venue: 'UNISWAP_V3',
          status: exactOutputStatus,
          reason: exactOutputReason,
          constraintReason: exactOutputConstraintReason,
          constraintBreakdown: exactOutputConstraintBreakdown,
          exactOutputViability,
          quotedAmountOut: quotedAmountOutExactOutput
        })
      };
      attempts.push(exactOutputAttemptSummary);
      const exactOutputRoute: UniV3RoutePlan = {
        venue: 'UNISWAP_V3',
        executionMode: 'EXACT_OUTPUT',
        pathKind: shape.kind,
        hopCount: shape.hopCount,
        pathDirection: shape.kind === 'TWO_HOP' ? 'REVERSE' : 'FORWARD',
        bridgeToken: shape.bridgeToken,
        encodedPath: shape.kind === 'TWO_HOP' ? reverseUniV3Path(shape.encodedPath!) : shape.encodedPath,
        tokenIn,
        tokenOut,
        amountIn: maxAmountIn,
        requiredOutput: targetOutput,
        targetOutput,
        maxAmountIn,
        quotedAmountOut: quotedAmountOutExactOutput,
        minAmountOut: minAmountOutExactOutput,
        limitSqrtPriceX96: 0n,
        slippageBufferOut: slippageBufferOutExactOutput,
        gasCostOut,
        riskBufferOut: riskBufferOutExactOutput,
        profitFloorOut,
        grossEdgeOut: grossEdgeOutExactOutput,
        netEdgeOut: netEdgeOutExactOutput,
        quoteMetadata: {
          venue: 'UNISWAP_V3',
          poolFee: shape.feeTier as UniV3FeeTier
        }
      };
      candidates.push({
        route: exactOutputRoute,
        feeTierAttempt: exactOutputAttemptSummary,
        status: exactOutputStatus,
        reason: exactOutputReason,
        constraintReason: exactOutputConstraintReason,
        constraintBreakdown: exactOutputConstraintBreakdown
      });
    };

    for (const feeTier of policy.feeTiers) {
      await evaluatePathCandidate({ kind: 'DIRECT', hopCount: 1, feeTier });
    }
    const bridgeTokens = input.policy?.bridgeTokens ?? this.context.bridgeTokens ?? [];
    for (const bridgeToken of bridgeTokens) {
      if (bridgeToken.toLowerCase() === tokenIn.toLowerCase() || bridgeToken.toLowerCase() === tokenOut.toLowerCase()) {
        continue;
      }
      for (const feeTier of policy.feeTiers) {
        for (const secondFeeTier of policy.feeTiers) {
          const encodedPath = encodeUniV3Path([
            { tokenIn, fee: feeTier, tokenOut: bridgeToken },
            { tokenIn: bridgeToken, fee: secondFeeTier, tokenOut }
          ]);
          await evaluatePathCandidate({
            kind: 'TWO_HOP',
            hopCount: 2,
            bridgeToken,
            feeTier,
            secondFeeTier,
            encodedPath
          });
        }
      }
    }

    for (const attempt of attempts) {
      if (!attempt.candidateClass) {
        attempt.candidateClass = deriveRejectedCandidateClass({
          venue: 'UNISWAP_V3',
          status: attempt.status,
          reason: attempt.reason,
          quotedAmountOut: attempt.quotedAmountOut,
          exactOutputViability: attempt.exactOutputViability,
          constraintReason: attempt.constraintReason,
          constraintBreakdown: attempt.constraintBreakdown
        });
      }
    }
    const sortByNetEdge = (a: Candidate, b: Candidate): number => {
      if (a.route.netEdgeOut !== b.route.netEdgeOut) {
        return a.route.netEdgeOut > b.route.netEdgeOut ? -1 : 1;
      }
      if (a.route.quotedAmountOut !== b.route.quotedAmountOut) {
        return a.route.quotedAmountOut > b.route.quotedAmountOut ? -1 : 1;
      }
      if (a.route.gasCostOut !== b.route.gasCostOut) {
        return a.route.gasCostOut < b.route.gasCostOut ? -1 : 1;
      }
      return 0;
    };

    const successfulQuotes = candidates.filter((candidate) => candidate.feeTierAttempt.quoteSucceeded);
    const routeableCandidates = candidates.filter((candidate) => candidate.status === 'ROUTEABLE');
    if (routeableCandidates.length > 0) {
      const sorted = [...routeableCandidates].sort(sortByNetEdge);
      const best = sorted[0]!;
      const summary: VenueRouteAttemptSummary = {
        venue: 'UNISWAP_V3',
        pathKind: best.route.pathKind,
        executionMode: best.route.executionMode,
        hopCount: best.route.hopCount,
        bridgeToken: best.route.bridgeToken,
        pathDescriptor: best.feeTierAttempt.pathDescriptor,
        status: 'ROUTEABLE',
        reason: 'ROUTEABLE',
        quotedAmountOut: best.route.quotedAmountOut,
        minAmountOut: best.route.minAmountOut,
        grossEdgeOut: best.route.grossEdgeOut,
        netEdgeOut: best.route.netEdgeOut,
        selectedFeeTier: best.feeTierAttempt.feeTier,
        exactOutputViability: best.feeTierAttempt.exactOutputViability,
        hedgeGap: best.feeTierAttempt.hedgeGap,
        candidateClass: best.feeTierAttempt.candidateClass,
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
      const summary = ensureRejectedCandidateClass({
        venue: 'UNISWAP_V3',
        status: 'GAS_NOT_PRICEABLE',
        reason: 'GAS_CONVERSION_FAILED',
        feeTierAttempts: attempts,
        quoteCount
      }) as RejectedVenueRouteAttemptSummary;
      return makeFailure('GAS_NOT_PRICEABLE', 'gas conversion failed for all successful quotes', summary);
    }

    if (successfulQuotes.length > 0) {
      const hasConstraintReject = successfulQuotes.some((candidate) => candidate.status === 'CONSTRAINT_REJECTED');
      const bestRejectedByConstraint = hasConstraintReject
        ? successfulQuotes
            .filter((candidate) => candidate.status === 'CONSTRAINT_REJECTED' && candidate.constraintBreakdown)
            .sort((a, b) => {
              const aBreakdown = a.constraintBreakdown!;
              const bBreakdown = b.constraintBreakdown!;
              const aIsRequiredOutput = a.constraintReason === 'REQUIRED_OUTPUT';
              const bIsRequiredOutput = b.constraintReason === 'REQUIRED_OUTPUT';
              if (aIsRequiredOutput !== bIsRequiredOutput) {
                return aIsRequiredOutput ? -1 : 1;
              }
              if (aIsRequiredOutput && bIsRequiredOutput) {
                const viabilityStatusRank = (status: ExactOutputViability['status'] | undefined): number => {
                  if (status === 'SATISFIABLE') return 0;
                  if (status === 'UNSATISFIABLE') return 1;
                  if (status === 'NOT_CHECKED') return 2;
                  return 3;
                };
                const aStatusRank = viabilityStatusRank(a.feeTierAttempt.exactOutputViability?.status);
                const bStatusRank = viabilityStatusRank(b.feeTierAttempt.exactOutputViability?.status);
                if (aStatusRank !== bStatusRank) {
                  return aStatusRank - bStatusRank;
                }
                const aInputDeficit = a.feeTierAttempt.hedgeGap?.inputDeficit ?? a.feeTierAttempt.exactOutputViability?.inputDeficit;
                const bInputDeficit = b.feeTierAttempt.hedgeGap?.inputDeficit ?? b.feeTierAttempt.exactOutputViability?.inputDeficit;
                if (aInputDeficit !== undefined && bInputDeficit !== undefined && aInputDeficit !== bInputDeficit) {
                  return aInputDeficit < bInputDeficit ? -1 : 1;
                }
                if ((aInputDeficit !== undefined) !== (bInputDeficit !== undefined)) {
                  return aInputDeficit !== undefined ? -1 : 1;
                }
                const aCoverage = a.feeTierAttempt.hedgeGap?.outputCoverageBps;
                const bCoverage = b.feeTierAttempt.hedgeGap?.outputCoverageBps;
                if (aCoverage !== undefined && bCoverage !== undefined && aCoverage !== bCoverage) {
                  return aCoverage > bCoverage ? -1 : 1;
                }
                if (aBreakdown.requiredOutputShortfallOut !== bBreakdown.requiredOutputShortfallOut) {
                  return aBreakdown.requiredOutputShortfallOut < bBreakdown.requiredOutputShortfallOut ? -1 : 1;
                }
              }
              if (aBreakdown.minAmountOutShortfallOut !== bBreakdown.minAmountOutShortfallOut) {
                return aBreakdown.minAmountOutShortfallOut < bBreakdown.minAmountOutShortfallOut ? -1 : 1;
              }
              if (a.route.quotedAmountOut !== b.route.quotedAmountOut) {
                return a.route.quotedAmountOut > b.route.quotedAmountOut ? -1 : 1;
              }
              if (a.route.gasCostOut !== b.route.gasCostOut) {
                return a.route.gasCostOut < b.route.gasCostOut ? -1 : 1;
              }
              return 0;
            })[0]
        : undefined;
      const bestRejectedByEdge = [...successfulQuotes].sort((a, b) =>
        sortByNetEdge(a, b)
      )[0]!;
      const bestRejected = bestRejectedByConstraint ?? bestRejectedByEdge;
      const summary = ensureRejectedCandidateClass({
        venue: 'UNISWAP_V3',
        pathKind: bestRejected.route.pathKind,
        executionMode: bestRejected.route.executionMode,
        hopCount: bestRejected.route.hopCount,
        bridgeToken: bestRejected.route.bridgeToken,
        pathDescriptor: bestRejected.feeTierAttempt.pathDescriptor,
        status: hasConstraintReject ? 'CONSTRAINT_REJECTED' : 'NOT_PROFITABLE',
        reason: hasConstraintReject ? (bestRejected.constraintReason ?? 'MIN_AMOUNT_OUT') : 'NET_EDGE_NON_POSITIVE',
        quotedAmountOut: bestRejected.route.quotedAmountOut,
        minAmountOut: bestRejected.route.minAmountOut,
        grossEdgeOut: bestRejected.route.grossEdgeOut,
        netEdgeOut: bestRejected.route.netEdgeOut,
        selectedFeeTier: bestRejected.feeTierAttempt.feeTier,
        constraintReason: bestRejected.constraintReason,
        constraintBreakdown: bestRejected.constraintBreakdown,
        exactOutputViability: bestRejected.feeTierAttempt.exactOutputViability,
        hedgeGap: bestRejected.feeTierAttempt.hedgeGap,
        candidateClass: bestRejected.feeTierAttempt.candidateClass,
        feeTierAttempts: attempts,
        quoteCount
      }) as RejectedVenueRouteAttemptSummary;
      return makeFailure(
        hasConstraintReject ? 'CONSTRAINT_REJECTED' : 'NOT_PROFITABLE',
        hasConstraintReject ? 'quoted amount below min amount out' : 'all successful quotes are not profitable',
        summary
      );
    }

    const summary = ensureRejectedCandidateClass({
      venue: 'UNISWAP_V3',
      status: 'NOT_ROUTEABLE',
      reason: attempts.some((attempt) => attempt.status === 'QUOTE_FAILED') ? 'POOL_OR_QUOTE_UNAVAILABLE' : 'POOL_MISSING',
      feeTierAttempts: attempts,
      quoteCount
    }) as RejectedVenueRouteAttemptSummary;
    return makeFailure('NOT_ROUTEABLE', 'no fee tier produced a successful quote', summary);
  }
}
