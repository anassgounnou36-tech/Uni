import type { OrderState } from '../../domain/orderState.js';
import { InMemoryOrderStore } from '../memory/inMemoryOrderStore.js';
import type { IngressObservation, NormalizedOrder, OrderReasonCode, OrderStore, StoredOrderRecord, UpsertResult } from '../types.js';

export type SqlWriter = (statement: string, params: readonly unknown[]) => Promise<void>;

const NOOP_SQL_WRITER: SqlWriter = async () => {
  return;
};

export class PostgresOrderStore implements OrderStore {
  private readonly memory = new InMemoryOrderStore();

  constructor(private readonly sqlWriter: SqlWriter = NOOP_SQL_WRITER) {}

  async writeSchema(): Promise<void> {
    await this.sqlWriter('/* schema bootstrap omitted in tests */', []);
  }

  upsertDiscovered(
    rawPayload: unknown,
    normalizedOrder: NormalizedOrder | undefined,
    nowMs?: number,
    ingress?: IngressObservation
  ): UpsertResult {
    const result = this.memory.upsertDiscovered(rawPayload, normalizedOrder, nowMs, ingress);
    if (result.created) {
      void this.sqlWriter('insert into orders(order_hash, raw_payload, state) values ($1, $2, $3)', [
        result.record.orderHash,
        JSON.stringify(rawPayload),
        result.record.state
      ]);
    }
    return result;
  }

  recordIngressConfirmation(orderHash: `0x${string}`, ingress: IngressObservation): StoredOrderRecord {
    const record = this.memory.recordIngressConfirmation(orderHash, ingress);
    void this.sqlWriter('update orders set updated_at = now() where order_hash = $1', [orderHash]);
    return record;
  }

  transition(orderHash: `0x${string}`, nextState: OrderState, reason?: OrderReasonCode, nowMs?: number): StoredOrderRecord {
    const record = this.memory.transition(orderHash, nextState, reason, nowMs);
    void this.sqlWriter('update orders set state = $2, reason = $3 where order_hash = $1', [orderHash, nextState, reason ?? null]);
    return record;
  }

  get(orderHash: `0x${string}`): StoredOrderRecord | undefined {
    return this.memory.get(orderHash);
  }

  list(): StoredOrderRecord[] {
    return this.memory.list();
  }
}
