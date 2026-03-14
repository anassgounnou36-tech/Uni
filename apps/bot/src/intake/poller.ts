import type { OrdersApiClient } from './ordersApiClient.js';
import type { OrdersApiOrderPayload } from './ordersApiClient.js';
import type { IngressEnvelope } from '../ingress/types.js';

export type PollerResult = {
  fetched: number;
  payloads: OrdersApiOrderPayload[];
};

export class OrdersPoller {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly client: OrdersApiClient) {}

  async pollOnce(): Promise<PollerResult> {
    const payloads = await this.client.fetchOpenOrders();
    return {
      fetched: payloads.length,
      payloads
    };
  }

  start(
    onPayloads: (envelope: IngressEnvelope<OrdersApiOrderPayload>) => Promise<void>,
    onError?: (error: unknown) => void
  ): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.pollOnce()
        .then(async ({ payloads }) => {
          const receivedAtMs = Date.now();
          for (const payload of payloads) {
            await onPayloads({
              source: 'POLL',
              payload,
              receivedAtMs,
              orderHashHint:
                typeof payload.orderHash === 'string' && payload.orderHash.startsWith('0x')
                  ? (payload.orderHash as `0x${string}`)
                  : undefined
            });
          }
        })
        .catch((error: unknown) => {
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
