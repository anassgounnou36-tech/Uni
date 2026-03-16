import type { RouteCandidateSummary } from '../routing/venues.js';

export type RouteDecisionAttribution = {
  chosenVenue: 'UNISWAP_V3' | 'CAMELOT_AMMV3';
  chosenNetEdgeOut: bigint;
  quotedAmountOut: bigint;
  requiredOutput: bigint;
  minAmountOut: bigint;
  alternatives: RouteCandidateSummary[];
};

export type ExecutionOutcomeAttribution = {
  chosenVenue: 'UNISWAP_V3' | 'CAMELOT_AMMV3';
  simulationResult: 'SIM_OK' | 'SIM_FAIL' | 'NOT_RUN';
  simulationReason?: string;
  sendResult: 'SEND_ACCEPT' | 'SEND_REJECT' | 'SEND_NOT_ATTEMPTED';
  sendReason?: string;
  realizedGas?: bigint;
};
