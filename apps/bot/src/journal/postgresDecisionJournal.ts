import type { SqlAdapter } from '../db/types.js';
import type { DecisionJournal, DecisionJournalEvent, JournalEventType } from './types.js';

type DecisionJournalRow = {
  id: number | string;
  order_hash: string | null;
  event_type: string;
  at_ms: number | string;
  payload_json: unknown;
};

function parsePayload(payload: unknown): Record<string, unknown> {
  if (typeof payload === 'string') {
    return JSON.parse(payload) as Record<string, unknown>;
  }
  return (payload ?? {}) as Record<string, unknown>;
}

function fromRow(row: DecisionJournalRow): DecisionJournalEvent {
  return {
    type: row.event_type as JournalEventType,
    atMs: Number(row.at_ms),
    orderHash: (row.order_hash ?? undefined) as `0x${string}` | undefined,
    payload: parsePayload(row.payload_json)
  } as DecisionJournalEvent;
}

export class PostgresDecisionJournal implements DecisionJournal {
  constructor(private readonly sqlAdapter: SqlAdapter) {}

  async ensureSchema(): Promise<void> {
    await this.sqlAdapter.query(
      `create table if not exists decision_journal (
        id bigserial primary key,
        order_hash text,
        event_type text not null,
        source text,
        at_ms bigint not null,
        payload_json jsonb not null
      )`
    );
  }

  async append(event: DecisionJournalEvent): Promise<void> {
    const source = event.type === 'ORDER_SEEN' ? event.payload.source : null;
    await this.sqlAdapter.query(
      'insert into decision_journal(order_hash, event_type, source, at_ms, payload_json) values ($1, $2, $3, $4, $5::jsonb)',
      [event.orderHash ?? null, event.type, source, event.atMs, JSON.stringify(event.payload)]
    );
  }

  async byOrderHash(orderHash: `0x${string}`): Promise<DecisionJournalEvent[]> {
    const result = await this.sqlAdapter.query<DecisionJournalRow>(
      'select id, order_hash, event_type, at_ms, payload_json from decision_journal where order_hash = $1 order by at_ms asc, id asc',
      [orderHash]
    );
    return result.rows.map(fromRow);
  }

  async latest(limit: number): Promise<DecisionJournalEvent[]> {
    if (limit <= 0) {
      return [];
    }
    const result = await this.sqlAdapter.query<DecisionJournalRow>(
      'select id, order_hash, event_type, at_ms, payload_json from decision_journal order by at_ms desc, id desc limit $1',
      [limit]
    );
    return result.rows.map(fromRow).reverse();
  }

  async byType(type: JournalEventType): Promise<DecisionJournalEvent[]> {
    const result = await this.sqlAdapter.query<DecisionJournalRow>(
      'select id, order_hash, event_type, at_ms, payload_json from decision_journal where event_type = $1 order by at_ms asc, id asc',
      [type]
    );
    return result.rows.map(fromRow);
  }
}
