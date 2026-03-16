import { computeOrderHash, decodeSignedOrder } from '@uni/protocol';
import type { NormalizedOrder } from '../store/types.js';

export type OrdersApiOrderPayload = {
  orderHash?: string;
  orderType?: string;
  encodedOrder?: string;
  signature?: string;
  [key: string]: unknown;
};

export type OrdersApiResponse = {
  orders?: OrdersApiOrderPayload[];
};

export type OrdersApiClientConfig = {
  baseUrl: string;
  chainId: number;
  cadenceMs?: number;
  orderType?: string;
  orderStatus?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function toHex(value: string | undefined): `0x${string}` | undefined {
  if (!value || !value.startsWith('0x')) {
    return undefined;
  }
  return value as `0x${string}`;
}

export function normalizeApiOrder(payload: OrdersApiOrderPayload): NormalizedOrder | undefined {
  const apiOrderHash = toHex(payload.orderHash);
  const encodedOrder = toHex(payload.encodedOrder);
  const signature = toHex(payload.signature ?? '0x');

  if (!apiOrderHash || !encodedOrder || !signature) {
    return undefined;
  }

  let decodedOrder: ReturnType<typeof decodeSignedOrder>;
  try {
    decodedOrder = decodeSignedOrder(encodedOrder, signature);
  } catch {
    return undefined;
  }

  const canonicalOrderHash = computeOrderHash(decodedOrder.order) as `0x${string}`;
  if (canonicalOrderHash !== apiOrderHash) {
    return undefined;
  }

  return {
    orderHash: canonicalOrderHash,
    orderType: typeof payload.orderType === 'string' ? payload.orderType : 'Dutch_V3',
    encodedOrder,
    signature,
    decodedOrder,
    reactor: decodedOrder.order.info.reactor
  };
}

export class OrdersApiClient {
  private readonly fetchImpl: typeof fetch;
  readonly cadenceMs: number;
  readonly chainId: number;
  readonly orderType: string;
  readonly orderStatus: string;
  readonly requestTimeoutMs: number;

  constructor(private readonly config: OrdersApiClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.cadenceMs = config.cadenceMs ?? 1_000;
    this.chainId = config.chainId;
    this.orderType = config.orderType ?? 'Dutch_V3';
    this.orderStatus = config.orderStatus ?? 'open';
    this.requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
  }

  private buildUrl(): string {
    const url = new URL('/v2/orders', this.config.baseUrl);
    url.searchParams.set('orderStatus', this.orderStatus);
    url.searchParams.set('chainId', String(this.chainId));
    url.searchParams.set('orderType', this.orderType);
    return url.toString();
  }

  async fetchOpenOrders(signal?: AbortSignal): Promise<OrdersApiOrderPayload[]> {
    const timeoutMs = this.requestTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    const timeoutError = new Error(`Orders API request timed out after ${timeoutMs}ms`);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);

    let response: Response;
    try {
      response = await this.fetchImpl(this.buildUrl(), { method: 'GET', signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
      throw new Error(`Orders API error ${response.status}`);
    }

    const data = (await response.json()) as OrdersApiResponse | OrdersApiOrderPayload[];
    if (Array.isArray(data)) {
      return data;
    }

    return data.orders ?? [];
  }
}
