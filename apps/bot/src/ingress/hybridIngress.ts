import { normalizeApiOrder, type OrdersApiOrderPayload } from '../intake/ordersApiClient.js';
import type { DecisionJournal } from '../journal/types.js';
import type { BotMetrics } from '../telemetry/metrics.js';
import type { IngressObservation, OrderStore } from '../store/types.js';
import type { IngressEnvelope, UniswapWebhookPayload } from './types.js';

export type HybridIngressCoordinatorConfig = {
  store: OrderStore;
  journal: DecisionJournal;
  metrics?: BotMetrics;
};

function asWebhookApiPayload(payload: UniswapWebhookPayload): OrdersApiOrderPayload {
  return {
    orderHash: payload.orderHash,
    orderType: 'Dutch_V3',
    encodedOrder: payload.encodedOrder,
    signature: payload.signature
  };
}

export class HybridIngressCoordinator {
  private readonly pendingOrderHashes: `0x${string}`[] = [];
  private readonly pendingSet = new Set<`0x${string}`>();

  constructor(private readonly config: HybridIngressCoordinatorConfig) {}

  private markPending(orderHash: `0x${string}`): void {
    if (this.pendingSet.has(orderHash)) {
      return;
    }
    this.pendingSet.add(orderHash);
    this.pendingOrderHashes.push(orderHash);
  }

  dequeueForScheduling(limit: number = Number.POSITIVE_INFINITY): `0x${string}`[] {
    const drained: `0x${string}`[] = [];
    while (drained.length < limit && this.pendingOrderHashes.length > 0) {
      const next = this.pendingOrderHashes.shift();
      if (!next) {
        break;
      }
      this.pendingSet.delete(next);
      drained.push(next);
    }
    return drained;
  }

  async ingest(envelope: IngressEnvelope<OrdersApiOrderPayload | UniswapWebhookPayload>): Promise<void> {
    const observation: IngressObservation = {
      source: envelope.source,
      receivedAtMs: envelope.receivedAtMs,
      createdAtMs: envelope.createdAtMs,
      remoteIp: envelope.remoteIp
    };
    const payload = envelope.source === 'WEBHOOK' ? asWebhookApiPayload(envelope.payload as UniswapWebhookPayload) : (envelope.payload as OrdersApiOrderPayload);
    const normalized = normalizeApiOrder(payload);

    if (!normalized) {
      this.config.metrics?.increment(`orders_seen_total{source="${envelope.source}",validation="REJECTED"}`);
      await this.config.journal.append({
        type: 'ORDER_SEEN',
        atMs: envelope.receivedAtMs,
        orderHash: envelope.orderHashHint,
        payload: {
          source: envelope.source,
          receivedAtMs: envelope.receivedAtMs,
          createdAtMs: envelope.createdAtMs,
          deduped: false,
          validation: 'REJECTED',
          reason: 'MALFORMED_OR_UNSUPPORTED'
        }
      });
      return;
    }

    const upserted = await this.config.store.upsertDiscovered(payload, normalized, envelope.receivedAtMs, observation);
    if (!upserted.created) {
      await this.config.store.recordIngressConfirmation(normalized.orderHash, observation);
      this.config.metrics?.increment(`orders_deduped_total{source="${envelope.source}"}`);
    } else {
      await this.config.store.transition(normalized.orderHash, 'DECODED');
    }

    this.config.metrics?.increment(`orders_seen_total{source="${envelope.source}",validation="ACCEPTED"}`);
    await this.config.journal.append({
      type: 'ORDER_SEEN',
      atMs: envelope.receivedAtMs,
      orderHash: normalized.orderHash,
      payload: {
        source: envelope.source,
        receivedAtMs: envelope.receivedAtMs,
        createdAtMs: envelope.createdAtMs,
        encodedOrder: typeof payload.encodedOrder === 'string' ? payload.encodedOrder : undefined,
        signature: typeof payload.signature === 'string' ? payload.signature : undefined,
        deduped: !upserted.created,
        validation: 'ACCEPTED'
      }
    });

    if (!upserted.created) {
      return;
    }

    if (normalized.orderType !== 'Dutch_V3') {
      await this.config.store.transition(normalized.orderHash, 'UNSUPPORTED', 'NOT_DUTCH_V3');
      this.config.metrics?.increment('orders_unsupported_total{reason="NOT_DUTCH_V3"}');
      await this.config.journal.append({
        type: 'ORDER_UNSUPPORTED',
        atMs: Date.now(),
        orderHash: normalized.orderHash,
        payload: { reason: 'NOT_DUTCH_V3' }
      });
      return;
    }

    await this.config.store.transition(normalized.orderHash, 'SUPPORTED', 'SUPPORTED');
    this.config.metrics?.increment('orders_supported_total');
    await this.config.journal.append({
      type: 'ORDER_SUPPORTED',
      atMs: Date.now(),
      orderHash: normalized.orderHash,
      payload: { reason: 'SUPPORTED' }
    });
    this.markPending(normalized.orderHash);
  }
}
