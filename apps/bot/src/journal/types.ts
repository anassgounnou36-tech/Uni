import type { IngressSource } from '../ingress/types.js';
import type { ExecutionOutcomeAttribution, RouteDecisionAttribution } from '../attribution/types.js';

export type JournalEventType =
  | 'ORDER_SEEN'
  | 'ORDER_SUPPORTED'
  | 'ORDER_UNSUPPORTED'
  | 'ORDER_SCHEDULED'
  | 'ORDER_REPRICED'
  | 'ORDER_DROPPED'
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

export type OrderSeenEvent = BaseJournalEvent<
  'ORDER_SEEN',
  {
    source: IngressSource;
    receivedAtMs: number;
    createdAtMs?: number;
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
  | BaseJournalEvent<'ORDER_DROPPED', { reason: string }>
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
