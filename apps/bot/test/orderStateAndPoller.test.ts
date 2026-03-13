import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeOrderHash, decodeSignedOrder } from '@uni/protocol';
import { describe, expect, it } from 'vitest';
import { assertLegalOrderTransition } from '../src/domain/orderState.js';
import { OrdersApiClient } from '../src/intake/ordersApiClient.js';
import { OrdersPoller } from '../src/intake/poller.js';
import { InMemoryOrderStore } from '../src/store/memory/inMemoryOrderStore.js';

function makeOrderPayload(orderType: string): Record<string, unknown> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/orders/arbitrum/live');
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'live-01.json'), 'utf8')) as {
    encodedOrder: `0x${string}`;
    signature: `0x${string}`;
  };
  const decoded = decodeSignedOrder(fixture.encodedOrder, fixture.signature);
  const orderHash = computeOrderHash(decoded.order);
  return {
    orderHash,
    orderType,
    encodedOrder: fixture.encodedOrder,
    signature: fixture.signature
  };
}

describe('order state and poller', () => {
  it('rejects illegal state transitions', () => {
    expect(() => assertLegalOrderTransition('DISCOVERED', 'LANDED')).toThrow('Illegal order transition');
  });

  it('polls, dedupes by orderHash, and archives unsupported orders with reason code', async () => {
    const supported = makeOrderPayload('Dutch_V3');
    const unsupported = {
      ...makeOrderPayload('Limit'),
      orderHash: '0x9999999999999999999999999999999999999999999999999999999999999999'
    };
    const fetchImpl: typeof fetch = async () =>
      ({
        ok: true,
        json: async () => [supported, supported, unsupported]
      } as Response);

    const client = new OrdersApiClient({
      baseUrl: 'https://orders.example',
      chainId: 42161,
      fetchImpl
    });
    const store = new InMemoryOrderStore();
    const poller = new OrdersPoller(client, store);

    const result = await poller.pollOnce();

    expect(result).toEqual({
      discovered: 2,
      deduped: 1,
      unsupported: 1
    });

    const records = store.list().sort((a, b) => a.orderHash.localeCompare(b.orderHash));
    expect(records[0]!.state).toEqual('DECODED');
    expect(records[0]!.transitions.map((transition) => transition.state)).toEqual(['DISCOVERED', 'DECODED']);
    expect(records[1]!.state).toEqual('UNSUPPORTED');
    expect(records[1]!.reason).toEqual('NOT_DUTCH_V3');
  });
});
