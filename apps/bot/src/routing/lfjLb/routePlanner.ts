import type { Address } from 'viem';
import type { RejectedVenueRouteAttemptSummary, VenueRouteAttemptSummary } from '../attemptTypes.js';
import { ensureRejectedCandidateClass, rejectedCandidateClassPriority } from '../rejectedCandidateTypes.js';
import { computeDirectFamilyDominance, type RouteFamily } from '../familyTypes.js';
import { LfjLbQuoter } from './quoter.js';
import type { LfjLbPathShape, LfjLbRoutePlanningResult, LfjLbRoutingContext } from './types.js';
import type { RouteEvalReadCache } from '../rpc/readCache.js';

const DEFAULT_TWO_HOP_UNLOCK_MIN_COVERAGE_BPS = 9_800n;
const DEFAULT_MAX_TWO_HOP_FAMILIES_PER_ORDER = 2;

function sumRequiredOutput(outputs: ReadonlyArray<{ amount: bigint }>): bigint {
  return outputs.reduce((sum, output) => sum + output.amount, 0n);
}

function shouldUnlockTwoHop(params: {
  directQuote: { ok: boolean; route?: { quotedAmountOut: bigint } };
  requiredOutput: bigint;
  thresholdBps: bigint;
}): boolean {
  if (!params.directQuote.ok) return true;
  if (!params.directQuote.route) return true;
  if (params.requiredOutput <= 0n) return true;
  const coverageBps = (params.directQuote.route.quotedAmountOut * 10_000n) / params.requiredOutput;
  return coverageBps >= params.thresholdBps;
}

export class LfjLbRoutePlanner {
  private readonly quoter: LfjLbQuoter;
  private readonly bridgeTokens: readonly Address[];
  private readonly routeEvalChainId?: bigint;
  private readonly maxTwoHopFamiliesPerOrder?: number;
  private readonly enableTwoHop: boolean;
  private readonly onRouteEvalFamilyEvaluated?: LfjLbRoutingContext['onRouteEvalFamilyEvaluated'];
  private readonly onRouteEvalFamilyPruned?: LfjLbRoutingContext['onRouteEvalFamilyPruned'];
  private readonly onRouteEvalFamilyPromoted?: LfjLbRoutingContext['onRouteEvalFamilyPromoted'];

  constructor(context: LfjLbRoutingContext) {
    this.quoter = new LfjLbQuoter(context);
    this.bridgeTokens = context.bridgeTokens ?? [];
    this.routeEvalChainId = context.routeEvalChainId;
    this.maxTwoHopFamiliesPerOrder = context.maxTwoHopFamiliesPerOrder;
    this.enableTwoHop = context.enableTwoHop ?? false;
    this.onRouteEvalFamilyEvaluated = context.onRouteEvalFamilyEvaluated;
    this.onRouteEvalFamilyPruned = context.onRouteEvalFamilyPruned;
    this.onRouteEvalFamilyPromoted = context.onRouteEvalFamilyPromoted;
  }

  async planBestRoute(input: {
    resolvedOrder: { input: { token: Address; amount: bigint }; outputs: ReadonlyArray<{ token: Address; amount: bigint }> };
    policy?: {
      bridgeTokens?: readonly Address[];
      twoHopUnlockMinCoverageBps?: bigint;
      maxTwoHopFamiliesPerOrder?: number;
    } & Record<string, unknown>;
    routeEval?: { chainId?: bigint; blockNumberish?: bigint; readCache?: unknown };
  }): Promise<LfjLbRoutePlanningResult> {
    const { resolvedOrder } = input;
    if (resolvedOrder.outputs.length === 0) {
      const summary: VenueRouteAttemptSummary = {
        venue: 'LFJ_LB',
        status: 'NOT_ROUTEABLE',
        reason: 'ORDER_HAS_NO_OUTPUTS',
        candidateClass: ensureRejectedCandidateClass({
          venue: 'LFJ_LB',
          status: 'NOT_ROUTEABLE',
          reason: 'ORDER_HAS_NO_OUTPUTS'
        }).candidateClass
      };
      return { ok: false, failure: { reason: 'NOT_ROUTEABLE', details: 'order has no outputs', summary } };
    }

    const tokenIn = resolvedOrder.input.token;
    const tokenOut = resolvedOrder.outputs[0]!.token;
    const sameOutputToken = resolvedOrder.outputs.every((output) => output.token.toLowerCase() === tokenOut.toLowerCase());
    if (!sameOutputToken) {
      const summary: VenueRouteAttemptSummary = {
        venue: 'LFJ_LB',
        status: 'NOT_ROUTEABLE',
        reason: 'OUTPUT_TOKEN_MISMATCH',
        candidateClass: ensureRejectedCandidateClass({
          venue: 'LFJ_LB',
          status: 'NOT_ROUTEABLE',
          reason: 'OUTPUT_TOKEN_MISMATCH'
        }).candidateClass
      };
      return { ok: false, failure: { reason: 'NOT_ROUTEABLE', details: 'output token mismatch', summary } };
    }
    if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
      const summary: VenueRouteAttemptSummary = {
        venue: 'LFJ_LB',
        status: 'NOT_ROUTEABLE',
        reason: 'TOKEN_IN_EQUALS_TOKEN_OUT',
        candidateClass: ensureRejectedCandidateClass({
          venue: 'LFJ_LB',
          status: 'NOT_ROUTEABLE',
          reason: 'TOKEN_IN_EQUALS_TOKEN_OUT'
        }).candidateClass
      };
      return { ok: false, failure: { reason: 'NOT_ROUTEABLE', details: 'input/output token are equal', summary } };
    }

    const routeEval = {
      chainId: input.routeEval?.chainId ?? this.routeEvalChainId ?? 42161n,
      blockNumberish: input.routeEval?.blockNumberish ?? 0n,
      readCache: input.routeEval?.readCache as RouteEvalReadCache | undefined
    };
    const directFamily: RouteFamily = {
      venue: 'LFJ_LB',
      familyKind: 'DIRECT',
      tokenIn,
      tokenOut,
      pathKind: 'DIRECT',
      hopCount: 1,
      pathDescriptor: `DIRECT: ${tokenIn} -> ${tokenOut}`,
      discovery: 'LFJ_DIRECT_BIN_STEP_VERSION',
      probePriority: 0,
      familyKey: `LFJ_LB:DIRECT:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`
    };
    const directShape: LfjLbPathShape = {
      kind: 'DIRECT',
      hopCount: 1,
      binSteps: [20],
      versions: [1]
    };
    this.onRouteEvalFamilyEvaluated?.('LFJ_LB', 'DIRECT', directFamily.familyKind);
    const directQuote = await this.quoter.quotePath({
      tokenIn,
      tokenOut,
      amountIn: resolvedOrder.input.amount,
      outputs: resolvedOrder.outputs,
      policy: input.policy,
      shape: directShape,
      routeEval
    });

    const requiredOutput = sumRequiredOutput(resolvedOrder.outputs);
    const twoHopUnlockThresholdBps = input.policy?.twoHopUnlockMinCoverageBps ?? DEFAULT_TWO_HOP_UNLOCK_MIN_COVERAGE_BPS;
    const configuredMaxTwoHop = input.policy?.maxLfjTwoHopFamiliesPerOrder as number | undefined;
    const maxTwoHopFamilies = Math.max(
      1,
      configuredMaxTwoHop ?? input.policy?.maxTwoHopFamiliesPerOrder ?? this.maxTwoHopFamiliesPerOrder ?? DEFAULT_MAX_TWO_HOP_FAMILIES_PER_ORDER
    );
    const bridgeTokens = (input.policy?.bridgeTokens ?? this.bridgeTokens)
      .filter((bridge) => bridge.toLowerCase() !== tokenIn.toLowerCase() && bridge.toLowerCase() !== tokenOut.toLowerCase())
      .slice(0, maxTwoHopFamilies);
    const shouldProbeTwoHop = this.enableTwoHop && shouldUnlockTwoHop({
      directQuote: directQuote.ok ? { ok: true, route: directQuote.route } : { ok: false },
      requiredOutput,
      thresholdBps: twoHopUnlockThresholdBps
    });
    const twoHopQuotes = shouldProbeTwoHop
      ? await Promise.all(
          bridgeTokens.map(async (bridgeToken, index) => {
            const family: RouteFamily = {
              venue: 'LFJ_LB',
              familyKind: 'TWO_HOP',
              tokenIn,
              tokenOut,
              bridgeToken,
              pathKind: 'TWO_HOP',
              hopCount: 2,
              pathDescriptor: `TWO_HOP: ${tokenIn} -> ${bridgeToken} -> ${tokenOut}`,
              discovery: 'LFJ_TWO_HOP_BRIDGE_BIN_STEP_VERSION',
              probePriority: 100 + index,
              familyKey: `LFJ_LB:TWO_HOP:${tokenIn.toLowerCase()}:${bridgeToken.toLowerCase()}:${tokenOut.toLowerCase()}`
            };
            this.onRouteEvalFamilyEvaluated?.('LFJ_LB', 'TWO_HOP', family.familyKind);
            const quote = await this.quoter.quotePath({
              tokenIn,
              tokenOut,
              amountIn: resolvedOrder.input.amount,
              outputs: resolvedOrder.outputs,
              policy: input.policy,
              shape: {
                kind: 'TWO_HOP',
                hopCount: 2,
                bridgeToken,
                binSteps: [20, 20],
                versions: [1, 1]
              },
              routeEval
            });
            if (quote.ok) {
              return {
                ...quote,
                summary: { ...quote.summary, familyKind: family.familyKind, probePriority: family.probePriority, familyKey: family.familyKey }
              };
            }
            return {
              ...quote,
              summary: { ...quote.summary, familyKind: family.familyKind, probePriority: family.probePriority, familyKey: family.familyKey }
            };
          })
        )
      : [];
    if ((input.policy?.bridgeTokens ?? this.bridgeTokens).length > bridgeTokens.length) {
      this.onRouteEvalFamilyPruned?.('LFJ_LB', 'TWO_HOP');
    }

    type PlannerQuote = typeof directQuote | (typeof twoHopQuotes)[number];
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
      quote.summary.dominanceMargin = dominance.dominanceMargin;
      quote.summary.dominanceConfidence = dominance.dominanceConfidence;
      quote.summary.dominanceReason = dominance.dominanceReason;
      return quote;
    };
    const decoratedDirectQuote = decorateDominance(directQuote);
    const decoratedTwoHopQuotes = twoHopQuotes.map((quote) => decorateDominance(quote));
    const routeable = [decoratedDirectQuote, ...decoratedTwoHopQuotes].filter(
      (quote): quote is Extract<typeof quote, { ok: true }> => quote.ok
    );
    if (routeable.length > 0) {
      const best = [...routeable].sort((a, b) => {
        if (a.route.netEdgeOut !== b.route.netEdgeOut) return a.route.netEdgeOut > b.route.netEdgeOut ? -1 : 1;
        if (a.route.quotedAmountOut !== b.route.quotedAmountOut) return a.route.quotedAmountOut > b.route.quotedAmountOut ? -1 : 1;
        if (a.route.gasCostOut !== b.route.gasCostOut) return a.route.gasCostOut < b.route.gasCostOut ? -1 : 1;
        return 0;
      })[0]!;
      this.onRouteEvalFamilyPromoted?.('LFJ_LB', best.route.pathKind, best.route.executionMode ?? 'EXACT_INPUT');
      return {
        ok: true,
        route: best.route,
        summary: {
          ...best.summary,
          familyKind: best.route.pathKind,
          probePriority: best.route.pathKind === 'DIRECT' ? 0 : 100,
          familyKey:
            best.route.pathKind === 'DIRECT'
              ? `LFJ_LB:DIRECT:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`
              : `LFJ_LB:TWO_HOP:${tokenIn.toLowerCase()}:${(best.route.bridgeToken ?? '').toLowerCase()}:${tokenOut.toLowerCase()}`,
          dominanceScore: best.summary.dominanceScore,
          dominanceMargin: best.summary.dominanceMargin,
          dominanceConfidence: best.summary.dominanceConfidence,
          dominanceReason: best.summary.dominanceReason,
          exactOutputPromotedFromFamily: best.route.executionMode === 'EXACT_OUTPUT'
        }
      };
    }

    const rejected = [decoratedDirectQuote, ...decoratedTwoHopQuotes]
      .filter((quote): quote is Extract<typeof quote, { ok: false }> => !quote.ok)
      .map((quote) => ({ ...quote, summary: ensureRejectedCandidateClass(quote.summary as RejectedVenueRouteAttemptSummary) }))
      .sort((a, b) => {
        const aClassPriority = rejectedCandidateClassPriority(a.summary.candidateClass ?? 'UNKNOWN');
        const bClassPriority = rejectedCandidateClassPriority(b.summary.candidateClass ?? 'UNKNOWN');
        if (aClassPriority !== bClassPriority) return aClassPriority - bClassPriority;
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
        if (aMode !== bMode) return aMode === 'EXACT_OUTPUT' ? -1 : 1;
        return 0;
      })[0];
    if (!rejected) {
      return {
        ok: false,
        failure: {
          reason: 'NOT_ROUTEABLE',
          details: 'no lfj route candidates',
          summary: { venue: 'LFJ_LB', status: 'NOT_ROUTEABLE', reason: 'POOL_MISSING', candidateClass: 'ROUTE_MISSING' }
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
              ? `LFJ_LB:DIRECT:${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`
              : `LFJ_LB:TWO_HOP:${tokenIn.toLowerCase()}:${(rejected.summary.bridgeToken ?? '').toLowerCase()}:${tokenOut.toLowerCase()}`,
          dominanceScore: rejected.summary.dominanceScore,
          dominanceMargin: rejected.summary.dominanceMargin,
          dominanceConfidence: rejected.summary.dominanceConfidence,
          dominanceReason: rejected.summary.dominanceReason,
          exactOutputPromotedFromFamily: rejected.summary.executionMode === 'EXACT_OUTPUT'
        }
      }
    };
  }
}
