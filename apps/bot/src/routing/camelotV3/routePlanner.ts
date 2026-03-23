import type { Address } from 'viem';
import type { RoutePlannerInput } from '../univ3/types.js';
import { CamelotAmmv3Quoter, type CamelotAmmv3QuoterContext } from './quoter.js';
import type { HedgeRoutePlan } from '../venues.js';
import type { RejectedVenueRouteAttemptSummary, VenueRouteAttemptSummary } from '../attemptTypes.js';
import { ensureRejectedCandidateClass, rejectedCandidateClassPriority } from '../rejectedCandidateTypes.js';

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

  constructor(context: CamelotAmmv3QuoterContext) {
    this.quoter = new CamelotAmmv3Quoter(context);
    this.bridgeTokens = context.bridgeTokens ?? [];
    this.routeEvalChainId = context.routeEvalChainId;
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

    const directQuote = await this.quoter.quoteExactInputSingle({
      tokenIn: tokenIn as Address,
      tokenOut: tokenOut as Address,
      amountIn: resolvedOrder.input.amount,
      outputs: resolvedOrder.outputs as ReadonlyArray<{ token: Address; amount: bigint }>,
      policy: input.policy,
      routeEval
    });
    const bridgeTokens = input.policy?.bridgeTokens ?? this.bridgeTokens;
    const bridgeQuotes = await Promise.all(
      bridgeTokens
        .filter((bridge) => bridge.toLowerCase() !== tokenIn.toLowerCase() && bridge.toLowerCase() !== tokenOut.toLowerCase())
        .map((bridgeToken) => this.quoter.quoteExactInputPath({
          tokenIn: tokenIn as Address,
          tokenOut: tokenOut as Address,
          bridgeToken,
          amountIn: resolvedOrder.input.amount,
          outputs: resolvedOrder.outputs as ReadonlyArray<{ token: Address; amount: bigint }>,
          policy: input.policy,
          routeEval
        }))
    );
    const routeable = [directQuote, ...bridgeQuotes].filter((quote): quote is Extract<typeof quote, { ok: true }> => quote.ok);
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
      return { ok: true, route: best.route, summary: best.summary };
    }
    const rejected = [directQuote, ...bridgeQuotes]
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
            ...ensureRejectedCandidateClass(rejected.summary as RejectedVenueRouteAttemptSummary)
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
          ...ensureRejectedCandidateClass(rejected.summary as RejectedVenueRouteAttemptSummary)
        }
      }
    };
  }
}
