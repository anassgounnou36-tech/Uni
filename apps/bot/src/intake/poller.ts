import type { OrdersApiClient } from './ordersApiClient.js';
import { normalizeApiOrder } from './ordersApiClient.js';
import type { OrderStore } from '../store/types.js';

export type PollerResult = {
  discovered: number;
  deduped: number;
  unsupported: number;
};

export class OrdersPoller {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly client: OrdersApiClient,
    private readonly store: OrderStore
  ) {}

  async pollOnce(): Promise<PollerResult> {
    const payloads = await this.client.fetchOpenOrders();
    const result: PollerResult = { discovered: 0, deduped: 0, unsupported: 0 };

    for (const payload of payloads) {
      const normalized = normalizeApiOrder(payload);
      if (!normalized) {
        result.unsupported += 1;
        continue;
      }

      const upserted = this.store.upsertDiscovered(payload, normalized);
      if (!upserted.created) {
        result.deduped += 1;
        continue;
      }

      result.discovered += 1;
      this.store.transition(normalized.orderHash, 'DECODED');

      if (normalized.orderType !== 'Dutch_V3') {
        this.store.transition(normalized.orderHash, 'UNSUPPORTED', 'NOT_DUTCH_V3');
        result.unsupported += 1;
      }
    }

    return result;
  }

  start(onError?: (error: unknown) => void): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.pollOnce().catch((error: unknown) => {
        onError?.(error);
      });
    }, this.client.cadenceMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
