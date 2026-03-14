import { assertLegalOrderTransition } from '../../domain/orderState.js';
import type { IngressObservation, OrderStore, StoredOrderRecord, UpsertResult } from '../types.js';
import type { OrderReasonCode, NormalizedOrder } from '../types.js';

function now(nowMs?: number): number {
  return nowMs ?? Date.now();
}

export class InMemoryOrderStore implements OrderStore {
  private readonly records = new Map<`0x${string}`, StoredOrderRecord>();

  upsertDiscovered(
    rawPayload: unknown,
    normalizedOrder: NormalizedOrder | undefined,
    nowMs?: number,
    ingress?: IngressObservation
  ): UpsertResult {
    if (!normalizedOrder) {
      throw new Error('normalizedOrder is required for dedupe by orderHash');
    }

    const timestamp = now(nowMs);
    const existing = this.records.get(normalizedOrder.orderHash);
    if (existing) {
      return { created: false, record: existing };
    }

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

    this.records.set(discovered.orderHash, discovered);
    return { created: true, record: discovered };
  }

  recordIngressConfirmation(orderHash: `0x${string}`, ingress: IngressObservation): StoredOrderRecord {
    const existing = this.records.get(orderHash);
    if (!existing) {
      throw new Error(`Cannot confirm ingress for unknown order ${orderHash}`);
    }
    const hasSource = existing.confirmedBySources.includes(ingress.source);
    const updated: StoredOrderRecord = hasSource
      ? existing
      : { ...existing, confirmedBySources: [...existing.confirmedBySources, ingress.source], updatedAt: now() };
    if (!hasSource) {
      this.records.set(orderHash, updated);
    }
    return updated;
  }

  transition(orderHash: `0x${string}`, nextState: StoredOrderRecord['state'], reason?: OrderReasonCode, nowMs?: number): StoredOrderRecord {
    const existing = this.records.get(orderHash);
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

    this.records.set(orderHash, updated);
    return updated;
  }

  get(orderHash: `0x${string}`): StoredOrderRecord | undefined {
    return this.records.get(orderHash);
  }

  list(): StoredOrderRecord[] {
    return [...this.records.values()];
  }
}
