import type { SqlAdapter, SqlQueryResult, SqlRow } from '../../src/db/types.js';

type DecisionJournalRow = {
  id: number;
  order_hash: string | null;
  event_type: string;
  source: string | null;
  at_ms: number;
  payload_json: unknown;
};

type OrdersRow = {
  order_hash: string;
  raw_json: unknown;
  state: string;
  reason_code: string | null;
  updated_at_ms: number;
};

type NonceRow = {
  address: string;
  next_nonce: string;
  updated_at_ms: number;
};

type SharedState = {
  nextDecisionId: number;
  decisionJournal: DecisionJournalRow[];
  orders: Map<string, OrdersRow>;
  nonceLedger: Map<string, NonceRow>;
};

export function createSharedSqlState(): SharedState {
  return {
    nextDecisionId: 1,
    decisionJournal: [],
    orders: new Map(),
    nonceLedger: new Map()
  };
}

export function createInMemorySqlAdapter(state: SharedState = createSharedSqlState()): SqlAdapter {
  return {
    async query<T extends SqlRow = SqlRow>(sql: string, params: unknown[] = []): Promise<SqlQueryResult<T>> {
      const normalized = sql.trim().toLowerCase().replace(/\s+/g, ' ');

      if (normalized.startsWith('create table if not exists')) {
        return { rows: [] as T[] };
      }

      if (normalized.startsWith('insert into decision_journal')) {
        const [orderHash, eventType, source, atMs, payloadJson] = params;
        state.decisionJournal.push({
          id: state.nextDecisionId++,
          order_hash: (orderHash as string | null) ?? null,
          event_type: String(eventType),
          source: (source as string | null) ?? null,
          at_ms: Number(atMs),
          payload_json: typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson
        });
        return { rows: [] as T[] };
      }

      if (normalized.includes('from decision_journal where order_hash = $1')) {
        const orderHash = String(params[0]);
        const rows = state.decisionJournal
          .filter((row) => row.order_hash === orderHash)
          .sort((a, b) => a.at_ms - b.at_ms || a.id - b.id);
        return { rows: rows as T[] };
      }

      if (normalized.includes('from decision_journal where event_type = $1')) {
        const eventType = String(params[0]);
        const rows = state.decisionJournal
          .filter((row) => row.event_type === eventType)
          .sort((a, b) => a.at_ms - b.at_ms || a.id - b.id);
        return { rows: rows as T[] };
      }

      if (normalized.includes('from decision_journal order by at_ms desc')) {
        const limit = Number(params[0]);
        const rows = [...state.decisionJournal].sort((a, b) => b.at_ms - a.at_ms || b.id - a.id).slice(0, limit);
        return { rows: rows as T[] };
      }

      if (normalized.startsWith('insert into orders(')) {
        const [orderHash, rawJson, stateText, reasonCode, updatedAtMs] = params;
        state.orders.set(String(orderHash), {
          order_hash: String(orderHash),
          raw_json: typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson,
          state: String(stateText),
          reason_code: (reasonCode as string | null) ?? null,
          updated_at_ms: Number(updatedAtMs)
        });
        return { rows: [] as T[] };
      }

      if (normalized.includes('from orders where order_hash = $1')) {
        const row = state.orders.get(String(params[0]));
        return { rows: (row ? [{ order_hash: row.order_hash, raw_json: row.raw_json }] : []) as T[] };
      }

      if (normalized.includes('from orders order by updated_at_ms asc')) {
        const rows = [...state.orders.values()]
          .sort((a, b) => a.updated_at_ms - b.updated_at_ms)
          .map((row) => ({ order_hash: row.order_hash, raw_json: row.raw_json }));
        return { rows: rows as T[] };
      }

      if (normalized.startsWith('insert into nonce_ledger(')) {
        const [address, nextNonce, updatedAtMs] = params;
        state.nonceLedger.set(String(address).toLowerCase(), {
          address: String(address),
          next_nonce: String(nextNonce),
          updated_at_ms: Number(updatedAtMs)
        });
        return { rows: [] as T[] };
      }

      if (normalized.includes('select next_nonce from nonce_ledger where lower(address) = lower($1)')) {
        const row = state.nonceLedger.get(String(params[0]).toLowerCase());
        return { rows: (row ? [{ next_nonce: row.next_nonce }] : []) as T[] };
      }

      throw new Error(`Unsupported SQL in test adapter: ${sql}`);
    },
    async close(): Promise<void> {
      return;
    }
  };
}
