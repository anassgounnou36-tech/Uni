import { InMemoryDecisionJournal } from './inMemoryDecisionJournal.js';
import type { DecisionJournal, DecisionJournalEvent, JournalEventType } from './types.js';

export type JournalSqlWriter = (statement: string, params: readonly unknown[]) => Promise<void>;

const NOOP_JOURNAL_SQL_WRITER: JournalSqlWriter = async () => {
  return;
};

export class PostgresDecisionJournal implements DecisionJournal {
  private readonly memory = new InMemoryDecisionJournal();

  constructor(private readonly sqlWriter: JournalSqlWriter = NOOP_JOURNAL_SQL_WRITER) {}

  async ensureSchema(): Promise<void> {
    await this.sqlWriter(
      `create table if not exists decision_journal (
        id bigserial primary key,
        order_hash text,
        event_type text not null,
        source text,
        at_ms bigint not null,
        payload_json jsonb not null
      )`,
      []
    );
  }

  async append(event: DecisionJournalEvent): Promise<void> {
    await this.memory.append(event);
    const source = event.type === 'ORDER_SEEN' ? event.payload.source : null;
    await this.sqlWriter(
      'insert into decision_journal(order_hash, event_type, source, at_ms, payload_json) values ($1, $2, $3, $4, $5::jsonb)',
      [event.orderHash ?? null, event.type, source, event.atMs, JSON.stringify(event.payload)]
    );
  }

  async byOrderHash(orderHash: `0x${string}`): Promise<DecisionJournalEvent[]> {
    return this.memory.byOrderHash(orderHash);
  }

  async latest(limit: number): Promise<DecisionJournalEvent[]> {
    return this.memory.latest(limit);
  }

  async byType(type: JournalEventType): Promise<DecisionJournalEvent[]> {
    return this.memory.byType(type);
  }
}
