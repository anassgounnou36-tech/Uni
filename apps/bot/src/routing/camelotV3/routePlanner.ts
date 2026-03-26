import type { Address } from 'viem';
import type { RoutePlannerInput } from '../univ3/types.js';
import { CamelotAmmv3Quoter, type CamelotAmmv3QuoterContext } from './quoter.js';
import type { HedgeRoutePlan } from '../venues.js';
import type { RejectedVenueRouteAttemptSummary, VenueRouteAttemptSummary } from '../attemptTypes.js';
import { ensureRejectedCandidateClass, rejectedCandidateClassPriority } from '../rejectedCandidateTypes.js';
import { computeDirectFamilyDominance, type RouteFamily } from '../familyTypes.js';

const DEFAULT_TWO_HOP_UNLOCK_MIN_COVERAGE_BPS = 9_800n;
const DEFAULT_MAX_TWO_HOP_FAMILIES_PER_ORDER = 2;

function sumRequiredOutput(outputs: ReadonlyArray<{ amount: bigint }>): bigint {
  return outputs.reduce((sum, output) => sum + output.amount, 0n);
}

function shouldUnlockCamelotTwoHop(params: {
  directQuote: Awaited<ReturnType<CamelotAmmv3Quoter['quoteExactInputSingle']>>;
  requiredOutput: bigint;
  thresholdBps: bigint;
}): boolean {
  if (!params.directQuote.ok) {
    return true;
  }
  if (params.requiredOutput <= 0n) {
    return true;
  }
  const coverageBps = (params.directQuote.route.quotedAmountOut * 10_000n) / params.requiredOutput;
  return coverageBps >= params.thresholdBps;
}

export type CamelotRoutePlanningResult =
  | { ok: true; route: HedgeRoutePlan & { venue: 'CAMELOT_AMMV3' }; summary: VenueRouteAttemptSummary }
  | {
      ok: false;
      failure: {
        reason:
          | 'NOT_ROUTEABLE'
          | 'QUOTE_FAILED'
          | 'NOT_PROFITABLE'
          | 'GAS_NOT_PRICEABLE'
          | 'CONSTRAINT_REJECTED'
          | 'RATE_LIMITED'
          | 'RPC_UNAVAILABLE'
          | 'RPC_FAILED'
          | 'QUOTE_REVERTED';
        details?: string;
        summary: VenueRouteAttemptSummary;
      };
    };

export class CamelotAmmv3RoutePlanner {
  private readonly quoter: CamelotAmmv3Quoter;
  private readonly bridgeTokens: readonly Address[];
  private readonly routeEvalChainId?: bigint;
  private readonly maxTwoHopFamiliesPerOrder?: number;
  private readonly onRouteEvalFamilyEvaluated?: CamelotAmmv3QuoterContext['onRouteEvalFamilyEvaluated'];
  private readonly onRouteEvalFamilyPruned?: CamelotAmmv3QuoterContext['onRouteEvalFamilyPruned'];
  private readonly onRouteEvalFamilyPromoted?: CamelotAmmv3QuoterContext['onRouteEvalFamilyPromoted'];

  constructor(context: CamelotAmmv3QuoterContext) {
    this.quoter = new CamelotAmmv3Quoter(context);
    this.bridgeTokens = context.bridgeTokens ?? [];
    this.routeEvalChainId = context.routeEvalChainId;
    this.maxTwoHopFamiliesPerOrder = context.maxTwoHopFamiliesPerOrder;
    this.onRouteEvalFamilyEvaluated = context.onRouteEvalFamilyEvaluated;
    this.onRouteEvalFamilyPruned = context.onRouteEvalFamilyPruned;
    this.onRouteEvalFamilyPromoted = context.onRouteEvalFamilyPromoted;
  }

  async planBestRoute(input: RoutePlannerInput): Promise<CamelotRoutePlanningResult> {
    const { resolvedOrder } = input;
    if (resolvedOrder.outputs.length === 0) {
      const summary: VenueRouteAttemptSummary = {
        venue: 'CAMELOT_AMMV3',
        status: 'NOT_ROUTEABLE',
        reason: 'ORDER_HAS_NO_OUTPUTS',
        candidateClass: ensureRejectedCandidateClass({
          venue: 'CAMELOT_AMMV3',
          status: 'NOT_ROUTEABLE',
          reason: 'ORDER_HAS_NO_OUTPUTS'
        }).candidateClass
      };
      return {
        ok: false,
        failure: {
          reason: 'NOT_ROUTEABLE',
          details: 'order has no outputs',
          summary
        }
      };
    }

    const tokenIn = resolvedOrder.input.token;
    const tokenOut = resolvedOrder.outputs[0]!.token;
    const sameOutputToken = resolvedOrder.outputs.every((output) => output.token.toLowerCase() === tokenOut.toLowerCase());
    if (!sameOutputToken) {
      const summary: VenueRouteAttemptSummary = {
        venue: 'CAMELOT_AMMV3',
        status: 'NOT_ROUTEABLE',
        reason: 'OUTPUT_TOKEN_MISMATCH',
        candidateClass: ensureRejectedCandidateClass({
          venue: 'CAMELOT_AMMV3',
          status: 'NOT_ROUTEABLE',
          reason: 'OUTPUT_TOKEN_MISMATCH'
        }).candidateClass
      };
      return {
        ok: false,
        failure: {
          reason: 'NOT_ROUTEABLE',
          details: 'output token mismatch',
          summary
        }
      };
    }

    const routeEval = {
      chainId: input.routeEval?.chainId ?? this.routeEvalChainId ?? 42161n,
      blockNumberish: input.routeEval?.blockNumberish ?? 0n,
      readCache: input.routeEval?.readCache
    };
    const directFamily: RouteFamily = {
      venue: 'CAMELOT_AMMV3',
      familyKind: 'DIRECT',
      tokenIn: tokenIn as Address,
      tokenOut: tokenOut as Address,
      pathKind: 'DIRECT',
      hopCount: 1,
      pathDescriptor: `DIRECT: ${tokenIn} -> ${tokenOut}`,
      discovery: 'DIRECT_PAIR',
      probePriority: 0,
      familyKey: `CAMELOT_AMMV3:DIRECT:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`
    };

    const directQuote = await this.quoter.quoteExactInputSingle({
      tokenIn: tokenIn as Address,
      tokenOut: tokenOut as Address,
      amountIn: resolvedOrder.input.amount,
      outputs: resolvedOrder.outputs as ReadonlyArray<{ token: Address; amount: bigint }>,
      policy: input.policy,
      routeEval
    });
    this.onRouteEvalFamilyEvaluated?.('CAMELOT_AMMV3', 'DIRECT', directFamily.familyKind);
    const requiredOutput = sumRequiredOutput(resolvedOrder.outputs as ReadonlyArray<{ amount: bigint }>);
    const twoHopUnlockThresholdBps = input.policy?.twoHopUnlockMinCoverageBps ?? DEFAULT_TWO_HOP_UNLOCK_MIN_COVERAGE_BPS;
    const bridgeTokens = input.policy?.bridgeTokens ?? this.bridgeTokens;
    const maxTwoHopFamilies = Math.max(
      1,
      input.policy?.maxTwoHopFamiliesPerOrder ?? this.maxTwoHopFamiliesPerOrder ?? DEFAULT_MAX_TWO_HOP_FAMILIES_PER_ORDER
    );
    const selectedBridgeTokens = bridgeTokens
      .filter((bridge) => bridge.toLowerCase() !== tokenIn.toLowerCase() && bridge.toLowerCase() !== tokenOut.toLowerCase())
      .slice(0, maxTwoHopFamilies);
    const bridgeQuotes = shouldUnlockCamelotTwoHop({
      directQuote,
      requiredOutput,
      thresholdBps: twoHopUnlockThresholdBps
    })
      ? await Promise.all(
        selectedBridgeTokens
          .map((bridgeToken, index) => {
            this.onRouteEvalFamilyEvaluated?.('CAMELOT_AMMV3', 'TWO_HOP', 'TWO_HOP');
            const family: RouteFamily = {
              venue: 'CAMELOT_AMMV3',
              familyKind: 'TWO_HOP',
              tokenIn: tokenIn as Address,
              tokenOut: tokenOut as Address,
              bridgeToken,
              pathKind: 'TWO_HOP',
              hopCount: 2,
              pathDescriptor: `TWO_HOP: ${tokenIn} -> ${bridgeToken} -> ${tokenOut}`,
              discovery: 'TWO_HOP_BRIDGE_FEE',
              probePriority: 100 + index,
              familyKey: `CAMELOT_AMMV3:TWO_HOP:${tokenIn.toLowerCase()}:${bridgeToken.toLowerCase()}:${tokenOut.toLowerCase()}`
            };
            return this.quoter.quoteExactInputPath({
            tokenIn: tokenIn as Address,
            tokenOut: tokenOut as Address,
            bridgeToken,
            amountIn: resolvedOrder.input.amount,
            outputs: resolvedOrder.outputs as ReadonlyArray<{ token: Address; amount: bigint }>,
            policy: input.policy,
            routeEval
            }).then((quote) => ({
              ...quote,
              summary: {
                ...quote.summary,
                familyKind: family.familyKind,
                probePriority: family.probePriority,
                familyKey: family.familyKey
              }
            }));
          })
      )
      : [];
    if (bridgeTokens.length > selectedBridgeTokens.length) {
      this.onRouteEvalFamilyPruned?.('CAMELOT_AMMV3', 'TWO_HOP');
    }
    type PlannerQuote = typeof directQuote | (typeof bridgeQuotes)[number];
    const decorateDominance = (quote: PlannerQuote): PlannerQuote => {
      const dominance = computeDirectFamilyDominance({
        pathKind: quote.summary.pathKind,
        status: quote.summary.status,
        outputCoverageBps: quote.summary.hedgeGap?.outputCoverageBps,
        exactOutputStatus: quote.summary.exactOutputViability?.status,
        candidateClass: quote.summary.candidateClass,
        nearMiss: quote.summary.constraintBreakdown?.nearMiss ?? quote.summary.hedgeGap?.nearMiss,
        requiredShortfallOut:
          quote.summary.hedgeGap?.requiredOutputShortfallOut ?? quote.summary.constraintBreakdown?.requiredOutputShortfallOut
      });
      quote.summary.dominanceScore = dominance.dominanceScore;
      quote.summary.dominanceReason = dominance.dominanceReason;
      return quote;
    };
    const decoratedDirectQuote = decorateDominance(directQuote);
    const decoratedBridgeQuotes = bridgeQuotes.map((quote) => decorateDominance(quote));
    const routeable = [decoratedDirectQuote, ...decoratedBridgeQuotes].filter(
      (quote): quote is Extract<typeof quote, { ok: true }> => quote.ok
    );
    if (routeable.length > 0) {
      const best = [...routeable].sort((a, b) => {
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
      })[0]!;
      this.onRouteEvalFamilyPromoted?.(
        'CAMELOT_AMMV3',
        best.route.pathKind,
        best.route.executionMode ?? 'EXACT_INPUT'
      );
      return {
        ok: true,
        route: best.route,
        summary: {
          ...best.summary,
          familyKind: best.route.pathKind,
          probePriority: best.route.pathKind === 'DIRECT' ? 0 : 100,
          familyKey:
            best.route.pathKind === 'DIRECT'
              ? `CAMELOT_AMMV3:DIRECT:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`
              : `CAMELOT_AMMV3:TWO_HOP:${tokenIn.toLowerCase()}:${(best.route.bridgeToken ?? '').toLowerCase()}:${tokenOut.toLowerCase()}`,
          dominanceScore: best.summary.dominanceScore,
          dominanceReason: best.summary.dominanceReason,
          exactOutputPromotedFromFamily: best.route.executionMode === 'EXACT_OUTPUT'
        }
      };
    }
    const rejected = [decoratedDirectQuote, ...decoratedBridgeQuotes]
      .filter((quote): quote is Extract<typeof quote, { ok: false }> => !quote.ok)
      .map((quote) => ({
        ...quote,
        summary: ensureRejectedCandidateClass(quote.summary as RejectedVenueRouteAttemptSummary)
      }))
      .sort((a, b) => {
        const aClassPriority = rejectedCandidateClassPriority(a.summary.candidateClass ?? 'UNKNOWN');
        const bClassPriority = rejectedCandidateClassPriority(b.summary.candidateClass ?? 'UNKNOWN');
        if (aClassPriority !== bClassPriority) {
          return aClassPriority - bClassPriority;
        }
        const aInputDeficit = a.summary.hedgeGap?.inputDeficit ?? a.summary.exactOutputViability?.inputDeficit;
        const bInputDeficit = b.summary.hedgeGap?.inputDeficit ?? b.summary.exactOutputViability?.inputDeficit;
        if (aInputDeficit !== undefined && bInputDeficit !== undefined && aInputDeficit !== bInputDeficit) {
          return aInputDeficit < bInputDeficit ? -1 : 1;
        }
        const aOut = a.summary.quotedAmountOut ?? 0n;
        const bOut = b.summary.quotedAmountOut ?? 0n;
        if (aOut !== bOut) return aOut > bOut ? -1 : 1;
        const aMode = a.summary.executionMode ?? 'EXACT_INPUT';
        const bMode = b.summary.executionMode ?? 'EXACT_INPUT';
        if (aMode !== bMode) {
          return aMode === 'EXACT_OUTPUT' ? -1 : 1;
        }
        return 0;
      })[0];
    if (!rejected) {
      return {
        ok: false,
        failure: {
          reason: 'NOT_ROUTEABLE',
          details: 'no camelot route candidates',
          summary: {
            venue: 'CAMELOT_AMMV3',
            status: 'NOT_ROUTEABLE',
            reason: 'POOL_MISSING',
            candidateClass: 'ROUTE_MISSING'
          }
        }
      };
    }
    if (
      rejected.reason === 'RATE_LIMITED'
      || rejected.reason === 'RPC_UNAVAILABLE'
      || rejected.reason === 'RPC_FAILED'
      || rejected.reason === 'QUOTE_REVERTED'
    ) {
      return {
        ok: false,
        failure: {
          reason: rejected.reason,
          details: rejected.details,
          summary: {
            ...ensureRejectedCandidateClass(rejected.summary as RejectedVenueRouteAttemptSummary),
            familyKind: rejected.summary.pathKind,
            probePriority: rejected.summary.pathKind === 'DIRECT' ? 0 : 100,
            familyKey:
              rejected.summary.pathKind === 'DIRECT'
                ? `CAMELOT_AMMV3:DIRECT:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`
                : `CAMELOT_AMMV3:TWO_HOP:${tokenIn.toLowerCase()}:${(rejected.summary.bridgeToken ?? '').toLowerCase()}:${tokenOut.toLowerCase()}`,
            dominanceScore: rejected.summary.dominanceScore,
            dominanceReason: rejected.summary.dominanceReason,
            exactOutputPromotedFromFamily: rejected.summary.executionMode === 'EXACT_OUTPUT'
          }
        }
      };
    }
    return {
      ok: false,
      failure: {
        reason: rejected.reason,
        details: rejected.details,
        summary: {
          ...ensureRejectedCandidateClass(rejected.summary as RejectedVenueRouteAttemptSummary),
          familyKind: rejected.summary.pathKind,
          probePriority: rejected.summary.pathKind === 'DIRECT' ? 0 : 100,
          familyKey:
            rejected.summary.pathKind === 'DIRECT'
              ? `CAMELOT_AMMV3:DIRECT:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`
              : `CAMELOT_AMMV3:TWO_HOP:${tokenIn.toLowerCase()}:${(rejected.summary.bridgeToken ?? '').toLowerCase()}:${tokenOut.toLowerCase()}`,
          dominanceScore: rejected.summary.dominanceScore,
          dominanceReason: rejected.summary.dominanceReason,
          exactOutputPromotedFromFamily: rejected.summary.executionMode === 'EXACT_OUTPUT'
        }
      }
    };
  }
}
