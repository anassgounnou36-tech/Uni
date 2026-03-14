import { assertLegalOrderTransition, type OrderState } from '../../domain/orderState.js';
import type { SqlAdapter } from '../../db/types.js';
import type { IngressObservation, NormalizedOrder, OrderReasonCode, OrderStore, StoredOrderRecord, UpsertResult } from '../types.js';

type StoredOrderRow = {
  order_hash: string;
  raw_json: unknown;
};

function now(nowMs?: number): number {
  return nowMs ?? Date.now();
}

function bigintReplacer(_: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { __bigint: value.toString() };
  }
  return value;
}

function reviveBigints(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reviveBigints);
  }
  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.__bigint === 'string' && Object.keys(candidate).length === 1) {
      return BigInt(candidate.__bigint);
    }
    const revived: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(candidate)) {
      revived[key] = reviveBigints(entry);
    }
    return revived;
  }
  return value;
}

function parseRecord(raw: unknown): StoredOrderRecord {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return reviveBigints(parsed) as StoredOrderRecord;
}

export class PostgresOrderStore implements OrderStore {
  constructor(private readonly sqlAdapter: SqlAdapter) {}

  async writeSchema(): Promise<void> {
    await this.sqlAdapter.query(
      `create table if not exists orders (
        order_hash text primary key,
        raw_json jsonb not null,
        state text not null,
        reason_code text,
        updated_at_ms bigint not null
      )`
    );
  }

  private async persist(record: StoredOrderRecord): Promise<void> {
    await this.sqlAdapter.query(
      `insert into orders(order_hash, raw_json, state, reason_code, updated_at_ms)
       values ($1, $2::jsonb, $3, $4, $5)
       on conflict (order_hash)
       do update set raw_json = excluded.raw_json,
                     state = excluded.state,
                     reason_code = excluded.reason_code,
                     updated_at_ms = excluded.updated_at_ms`,
      [record.orderHash, JSON.stringify(record, bigintReplacer), record.state, record.reason ?? null, record.updatedAt]
    );
  }

  async upsertDiscovered(
    rawPayload: unknown,
    normalizedOrder: NormalizedOrder | undefined,
    nowMs?: number,
    ingress?: IngressObservation
  ): Promise<UpsertResult> {
    if (!normalizedOrder) {
      throw new Error('normalizedOrder is required for dedupe by orderHash');
    }

    const existing = await this.get(normalizedOrder.orderHash);
    if (existing) {
      return { created: false, record: existing };
    }

    const timestamp = now(nowMs);
    const discovered: StoredOrderRecord = {
      orderHash: normalizedOrder.orderHash,
      rawPayload,
      normalizedOrder,
      state: 'DISCOVERED',
      transitions: [{ state: 'DISCOVERED', at: timestamp }],
      firstSeenAtMs: ingress?.receivedAtMs ?? timestamp,
      firstSeenSource: ingress?.source ?? 'POLL',
      firstCreatedAtMs: ingress?.createdAtMs,
      firstRemoteIp: ingress?.remoteIp,
      confirmedBySources: ingress ? [ingress.source] : ['POLL'],
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await this.persist(discovered);
    return { created: true, record: discovered };
  }

  async recordIngressConfirmation(orderHash: `0x${string}`, ingress: IngressObservation): Promise<StoredOrderRecord> {
    const existing = await this.get(orderHash);
    if (!existing) {
      throw new Error(`Cannot confirm ingress for unknown order ${orderHash}`);
    }

    const hasSource = existing.confirmedBySources.includes(ingress.source);
    if (hasSource) {
      return existing;
    }

    const updated: StoredOrderRecord = {
      ...existing,
      confirmedBySources: [...existing.confirmedBySources, ingress.source],
      updatedAt: now()
    };
    await this.persist(updated);
    return updated;
  }

  async transition(orderHash: `0x${string}`, nextState: OrderState, reason?: OrderReasonCode, nowMs?: number): Promise<StoredOrderRecord> {
    const existing = await this.get(orderHash);
    if (!existing) {
      throw new Error(`Cannot transition unknown order ${orderHash}`);
    }

    assertLegalOrderTransition(existing.state, nextState);
    const timestamp = now(nowMs);
    const updated: StoredOrderRecord = {
      ...existing,
      state: nextState,
      reason: reason ?? existing.reason,
      updatedAt: timestamp,
      transitions: [...existing.transitions, { state: nextState, at: timestamp, reason }]
    };
    await this.persist(updated);
    return updated;
  }

  async get(orderHash: `0x${string}`): Promise<StoredOrderRecord | undefined> {
    const result = await this.sqlAdapter.query<StoredOrderRow>(
      'select order_hash, raw_json from orders where order_hash = $1 limit 1',
      [orderHash]
    );
    const row = result.rows[0];
    if (!row) {
      return undefined;
    }
    const record = parseRecord(row.raw_json);
    return {
      ...record,
      orderHash: orderHash
    };
  }

  async list(): Promise<StoredOrderRecord[]> {
    const result = await this.sqlAdapter.query<StoredOrderRow>('select order_hash, raw_json from orders order by updated_at_ms asc');
    return result.rows.map((row) => {
      const record = parseRecord(row.raw_json);
      return {
        ...record,
        orderHash: row.order_hash as `0x${string}`
      };
    });
  }
}
