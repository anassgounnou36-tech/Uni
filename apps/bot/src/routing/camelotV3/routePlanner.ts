import type { Address } from 'viem';
import type { RoutePlannerInput } from '../univ3/types.js';
import { CamelotAmmv3Quoter, type CamelotAmmv3QuoterContext } from './quoter.js';
import type { HedgeRoutePlan, RouteCandidateFailureReason } from '../venues.js';

export type CamelotRoutePlanningResult =
  | { ok: true; route: HedgeRoutePlan & { venue: 'CAMELOT_AMMV3' } }
  | { ok: false; failure: { reason: RouteCandidateFailureReason; details?: string } };

export class CamelotAmmv3RoutePlanner {
  private readonly quoter: CamelotAmmv3Quoter;

  constructor(context: CamelotAmmv3QuoterContext) {
    this.quoter = new CamelotAmmv3Quoter(context);
  }

  async planBestRoute(input: RoutePlannerInput): Promise<CamelotRoutePlanningResult> {
    const { resolvedOrder } = input;
    if (resolvedOrder.outputs.length === 0) {
      return { ok: false, failure: { reason: 'CAMELOT_NOT_ROUTEABLE', details: 'order has no outputs' } };
    }

    const tokenIn = resolvedOrder.input.token;
    const tokenOut = resolvedOrder.outputs[0]!.token;
    const sameOutputToken = resolvedOrder.outputs.every((output) => output.token.toLowerCase() === tokenOut.toLowerCase());
    if (!sameOutputToken) {
      return { ok: false, failure: { reason: 'CAMELOT_NOT_ROUTEABLE', details: 'output token mismatch' } };
    }

    const quote = await this.quoter.quoteExactInputSingle({
      tokenIn: tokenIn as Address,
      tokenOut: tokenOut as Address,
      amountIn: resolvedOrder.input.amount,
      outputs: resolvedOrder.outputs as ReadonlyArray<{ token: Address; amount: bigint }>,
      policy: input.policy
    });
    if (!quote.ok) {
      return { ok: false, failure: { reason: quote.reason, details: quote.details } };
    }

    return { ok: true, route: quote.route };
  }
}
