import type { Address } from 'viem';
import type { RoutePlannerInput } from '../univ3/types.js';
import { CamelotAmmv3Quoter, type CamelotAmmv3QuoterContext } from './quoter.js';
import type { HedgeRoutePlan } from '../venues.js';
import type { VenueRouteAttemptSummary } from '../attemptTypes.js';

export type CamelotRoutePlanningResult =
  | { ok: true; route: HedgeRoutePlan & { venue: 'CAMELOT_AMMV3' }; summary: VenueRouteAttemptSummary }
  | {
      ok: false;
      failure: {
        reason: 'NOT_ROUTEABLE' | 'QUOTE_FAILED' | 'NOT_PROFITABLE' | 'GAS_NOT_PRICEABLE' | 'CONSTRAINT_REJECTED';
        details?: string;
        summary: VenueRouteAttemptSummary;
      };
    };

export class CamelotAmmv3RoutePlanner {
  private readonly quoter: CamelotAmmv3Quoter;

  constructor(context: CamelotAmmv3QuoterContext) {
    this.quoter = new CamelotAmmv3Quoter(context);
  }

  async planBestRoute(input: RoutePlannerInput): Promise<CamelotRoutePlanningResult> {
    const { resolvedOrder } = input;
    if (resolvedOrder.outputs.length === 0) {
      return {
        ok: false,
        failure: {
          reason: 'NOT_ROUTEABLE',
          details: 'order has no outputs',
          summary: {
            venue: 'CAMELOT_AMMV3',
            status: 'NOT_ROUTEABLE',
            reason: 'ORDER_HAS_NO_OUTPUTS'
          }
        }
      };
    }

    const tokenIn = resolvedOrder.input.token;
    const tokenOut = resolvedOrder.outputs[0]!.token;
    const sameOutputToken = resolvedOrder.outputs.every((output) => output.token.toLowerCase() === tokenOut.toLowerCase());
    if (!sameOutputToken) {
      return {
        ok: false,
        failure: {
          reason: 'NOT_ROUTEABLE',
          details: 'output token mismatch',
          summary: {
            venue: 'CAMELOT_AMMV3',
            status: 'NOT_ROUTEABLE',
            reason: 'OUTPUT_TOKEN_MISMATCH'
          }
        }
      };
    }

    const quote = await this.quoter.quoteExactInputSingle({
      tokenIn: tokenIn as Address,
      tokenOut: tokenOut as Address,
      amountIn: resolvedOrder.input.amount,
      outputs: resolvedOrder.outputs as ReadonlyArray<{ token: Address; amount: bigint }>,
      policy: input.policy
    });
    if (!quote.ok) {
      return { ok: false, failure: { reason: quote.reason, details: quote.details, summary: quote.summary } };
    }

    return { ok: true, route: quote.route, summary: quote.summary };
  }
}
