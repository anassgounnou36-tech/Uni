import type { IngressSource } from '../ingress/types.js';
import type { ExecutionOutcomeAttribution, RouteDecisionAttribution } from '../attribution/types.js';
import type { ConstraintBindingFloor, ConstraintRejectReason } from '../routing/constraintTypes.js';
import type { ExactOutputViabilityStatus } from '../routing/exactOutputTypes.js';
import type { HedgeGapClass } from '../routing/hedgeGapTypes.js';
import type { RejectedCandidateClass } from '../routing/rejectedCandidateTypes.js';
import type { RoutePathKind } from '../routing/pathTypes.js';
import type { HedgeExecutionMode } from '../routing/executionModeTypes.js';

export type JournalEventType =
  | 'ORDER_SEEN'
  | 'ORDER_SUPPORTED'
  | 'ORDER_UNSUPPORTED'
  | 'ORDER_SCHEDULED'
  | 'ORDER_REPRICED'
  | 'ORDER_DROPPED'
  | 'ORDER_EVALUATION_BLOCKED'
  | 'ORDER_PREPARE_FAILED'
  | 'PLAN_BUILT'
  | 'PREPARED'
  | 'SIM_RESULT'
  | 'SEND_ATTEMPT'
  | 'SEND_RESULT';

export type BaseJournalEvent<TType extends JournalEventType, TPayload extends Record<string, unknown>> = {
  type: TType;
  atMs: number;
  orderHash?: `0x${string}`;
  payload: TPayload;
};

type JournalConstraintBreakdown = {
  requiredOutput: string;
  quotedAmountOut: string;
  slippageBufferOut: string;
  gasCostOut: string;
  riskBufferOut: string;
  profitFloorOut: string;
  slippageFloorOut: string;
  profitabilityFloorOut: string;
  minAmountOut: string;
  requiredOutputShortfallOut: string;
  minAmountOutShortfallOut: string;
  bindingFloor: ConstraintBindingFloor;
  nearMiss: boolean;
  nearMissBps: string;
};

type JournalExactOutputViability = {
  status: ExactOutputViabilityStatus;
  targetOutput: string;
  requiredInputForTargetOutput: string;
  availableInput: string;
  inputDeficit?: string;
  inputSlack?: string;
  checkedFeeTier?: number;
  pathKind?: RoutePathKind;
  hopCount?: 1 | 2;
  bridgeToken?: string;
  pathDescriptor?: string;
  reason: string;
};

type JournalHedgeGapSummary = {
  pathKind?: RoutePathKind;
  hopCount?: 1 | 2;
  bridgeToken?: string;
  pathDescriptor?: string;
  requiredOutput: string;
  quotedAmountOut: string;
  outputCoverageBps: string;
  requiredOutputShortfallOut: string;
  minAmountOutShortfallOut?: string;
  inputDeficit?: string;
  inputSlack?: string;
  gapClass: HedgeGapClass;
  nearMiss: boolean;
  nearMissBps: string;
};

type JournalFeeTierAttempt = {
  feeTier: number;
  secondFeeTier?: number;
  executionMode?: HedgeExecutionMode;
  pathKind?: RoutePathKind;
  hopCount?: 1 | 2;
  bridgeToken?: string;
  pathDescriptor?: string;
  poolExists: boolean;
  quoteSucceeded: boolean;
  quotedAmountOut?: string;
  minAmountOut?: string;
  grossEdgeOut?: string;
  netEdgeOut?: string;
  status: string;
  reason: string;
  errorCategory?: 'RATE_LIMITED' | 'RPC_UNAVAILABLE' | 'RPC_FAILED' | 'QUOTE_REVERTED';
  errorMessage?: string;
  constraintReason?: ConstraintRejectReason;
  constraintBreakdown?: JournalConstraintBreakdown;
  exactOutputViability?: JournalExactOutputViability;
  hedgeGap?: JournalHedgeGapSummary;
  candidateClass?: RejectedCandidateClass;
};

type JournalVenueAttempt = {
  venue: string;
  executionMode?: HedgeExecutionMode;
  pathKind?: RoutePathKind;
  hopCount?: 1 | 2;
  bridgeToken?: string;
  pathDescriptor?: string;
  status: string;
  reason: string;
  errorCategory?: 'RATE_LIMITED' | 'RPC_UNAVAILABLE' | 'RPC_FAILED' | 'QUOTE_REVERTED';
  errorMessage?: string;
  quotedAmountOut?: string;
  minAmountOut?: string;
  grossEdgeOut?: string;
  netEdgeOut?: string;
  selectedFeeTier?: number;
  quoteCount?: number;
  constraintReason?: ConstraintRejectReason;
  constraintBreakdown?: JournalConstraintBreakdown;
  exactOutputViability?: JournalExactOutputViability;
  hedgeGap?: JournalHedgeGapSummary;
  candidateClass?: RejectedCandidateClass;
  feeTierAttempts?: JournalFeeTierAttempt[];
};

export type OrderSeenEvent = BaseJournalEvent<
  'ORDER_SEEN',
  {
    source: IngressSource;
    receivedAtMs: number;
    createdAtMs?: number;
    encodedOrder?: string;
    signature?: string;
    deduped: boolean;
    validation: 'ACCEPTED' | 'REJECTED';
    reason?: string;
  }
>;

export type DecisionJournalEvent =
  | OrderSeenEvent
  | BaseJournalEvent<'ORDER_SUPPORTED', { reason?: string }>
  | BaseJournalEvent<'ORDER_UNSUPPORTED', { reason: string }>
  | BaseJournalEvent<
      'ORDER_SCHEDULED',
      { scheduledBlock: string; competeWindowEnd: string; predictedEdgeOut: string; chosenVenue?: string }
    >
  | BaseJournalEvent<'ORDER_REPRICED', { reason?: string; edgeOut?: string }>
  | BaseJournalEvent<
      'ORDER_DROPPED',
      {
        reason: string;
        resolveSnapshot?: {
          chainId: string;
          blockNumber: string;
          blockNumberish: string;
          timestamp: string;
          baseFeePerGas: string;
          sampledAtMs: number;
        };
        thresholdOut?: string;
        candidateBlockOffsets?: string[];
        bestObservedNetEdgeOut?: string;
        bestObservedVenue?: string;
        bestRejectedSummary?: {
          venue: string;
          executionMode?: HedgeExecutionMode;
          pathKind?: RoutePathKind;
          hopCount?: 1 | 2;
          bridgeToken?: string;
          pathDescriptor?: string;
          status: string;
          reason: string;
          quotedAmountOut?: string;
          minAmountOut?: string;
          grossEdgeOut?: string;
          netEdgeOut?: string;
          selectedFeeTier?: number;
          quoteCount?: number;
          candidateClass: RejectedCandidateClass;
          constraintReason?: ConstraintRejectReason;
          constraintBreakdown?: JournalConstraintBreakdown;
          exactOutputViability?: JournalExactOutputViability;
          hedgeGap?: JournalHedgeGapSummary;
          feeTierAttempts?: JournalFeeTierAttempt[];
        };
        evaluations?: Array<{
          block: string;
          selectionOk: boolean;
          selectionReason?: string;
          chosenRouteVenue?: string;
          requiredOutput: string;
          quotedAmountOut: string;
          minAmountOut: string;
          gasCostOut: string;
          riskBufferOut: string;
          profitFloorOut: string;
          netEdgeOut: string;
          venueAttempts: JournalVenueAttempt[];
          bestRejectedSummary?: JournalVenueAttempt;
        }>;
        chosenRouteVenue?: string;
        chosenRoutePathKind?: RoutePathKind;
        chosenRouteHopCount?: 1 | 2;
        chosenRouteBridgeToken?: string;
        chosenRouteExecutionMode?: HedgeExecutionMode;
        chosenRoutePathDescriptor?: string;
        chosenRouteCandidateClass?: RejectedCandidateClass;
        chosenRouteConstraintReason?: ConstraintRejectReason;
        error?: string;
        message?: string;
        errorCategory?: string;
        errorMessage?: string;
        errorSelector?: string;
        decodedErrorName?: string;
        prepareFailureReason?: string;
        preflightStage?: string;
        runtimeSessionId?: string;
        plannedAtBlockNumber?: string;
        candidateBlockNumberish?: string;
        blockDelta?: string;
        timeDeltaMs?: number;
        staleRetryCount?: number;
        netEdgeOut?: string;
        simReason?: string;
      }
    >
  | BaseJournalEvent<
      'ORDER_EVALUATION_BLOCKED',
      {
        orderHash: `0x${string}`;
        reason: string;
        candidateCount: number;
        blockedCount: number;
        revertedProbeCount?: number;
        revertedProbeBudgetExhausted?: boolean;
        errorMessage?: string;
        venueAttempts?: JournalVenueAttempt[];
      }
    >
  | BaseJournalEvent<
      'ORDER_PREPARE_FAILED',
      {
        orderHash: `0x${string}`;
        venue?: string;
        pathKind?: RoutePathKind;
        hopCount?: 1 | 2;
        bridgeToken?: string;
        executionMode?: HedgeExecutionMode;
        pathDescriptor?: string;
        candidateClass?: RejectedCandidateClass;
        constraintReason?: ConstraintRejectReason;
        error: string;
        message: string;
        errorCategory?: string;
        errorMessage?: string;
        errorSelector?: string;
        decodedErrorName?: string;
        prepareFailureReason?: string;
        preflightStage?: string;
        runtimeSessionId?: string;
        plannedAtBlockNumber?: string;
        candidateBlockNumberish?: string;
        blockDelta?: string;
        timeDeltaMs?: number;
        staleRetryCount?: number;
      }
    >
  | BaseJournalEvent<'PLAN_BUILT', { ok: boolean; reason?: string; routeDecision?: RouteDecisionAttribution }>
  | BaseJournalEvent<'PREPARED', { ok: boolean; nonce?: string; reason?: string }>
  | BaseJournalEvent<'SIM_RESULT', { ok: boolean; reason: string; attribution?: ExecutionOutcomeAttribution }>
  | BaseJournalEvent<'SEND_ATTEMPT', { mode: 'SHADOW' | 'LIVE'; writer: string }>
  | BaseJournalEvent<'SEND_RESULT', { accepted: boolean; reason?: string; writer?: string; attribution?: ExecutionOutcomeAttribution }>;

export interface DecisionJournal {
  append(event: DecisionJournalEvent): Promise<void>;
  byOrderHash(orderHash: `0x${string}`): Promise<DecisionJournalEvent[]>;
  latest(limit: number): Promise<DecisionJournalEvent[]>;
  byType(type: JournalEventType): Promise<DecisionJournalEvent[]>;
}
