import type { ExecutionPlan } from '../execution/types.js';
import type { ForkSimResult } from '../sim/forkSimService.js';
import type { SequencerClientResult } from '../send/sequencerClient.js';
import type { ExecutionOutcomeAttribution, RouteDecisionAttribution } from './types.js';

export function buildRouteDecisionAttribution(plan: ExecutionPlan): RouteDecisionAttribution {
  return {
    chosenVenue: plan.route.venue,
    chosenNetEdgeOut: plan.route.netEdgeOut,
    quotedAmountOut: plan.route.quotedAmountOut,
    requiredOutput: plan.route.requiredOutput,
    minAmountOut: plan.route.minAmountOut,
    alternatives: plan.routeAlternatives
  };
}

export function buildExecutionOutcomeAttribution(input: {
  plan: ExecutionPlan;
  simResult?: ForkSimResult;
  sendResult?: SequencerClientResult;
}): ExecutionOutcomeAttribution {
  const simResult = input.simResult;
  const sendResult = input.sendResult;
  return {
    chosenVenue: input.plan.route.venue,
    simulationResult: simResult ? (simResult.ok ? 'SIM_OK' : 'SIM_FAIL') : 'NOT_RUN',
    simulationReason: simResult?.reason,
    sendResult: sendResult ? (sendResult.accepted ? 'SEND_ACCEPT' : 'SEND_REJECT') : 'SEND_NOT_ATTEMPTED',
    sendReason: sendResult?.accepted ? undefined : sendResult?.attempts[0]?.classification,
    realizedGas: simResult?.gasUsed
  };
}
