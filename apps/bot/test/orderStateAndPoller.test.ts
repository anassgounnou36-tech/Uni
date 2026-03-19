import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeOrderHash, decodeSignedOrder } from '@uni/protocol';
import { describe, expect, it } from 'vitest';
import { assertLegalOrderTransition } from '../src/domain/orderState.js';
import { OrdersApiClient } from '../src/intake/ordersApiClient.js';
import { normalizeApiOrder } from '../src/intake/ordersApiClient.js';
import { OrdersPoller } from '../src/intake/poller.js';

function makeOrderPayload(orderType: string, fixtureName = 'live-01.json'): Record<string, unknown> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/orders/arbitrum/live');
  const fixture = JSON.parse(fs.readFileSync(path.join(root, fixtureName), 'utf8')) as {
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

  it('allows dropped transitions from scheduler and simulation states', () => {
    expect(() => assertLegalOrderTransition('SUPPORTED', 'DROPPED')).not.toThrow();
    expect(() => assertLegalOrderTransition('SCHEDULED', 'DROPPED')).not.toThrow();
    expect(() => assertLegalOrderTransition('SIM_OK', 'DROPPED')).not.toThrow();
    expect(() => assertLegalOrderTransition('SIM_FAIL', 'DROPPED')).not.toThrow();
  });

  it('pollOnce returns fetched API payloads for coordinator ingestion', async () => {
    const supported = makeOrderPayload('Dutch_V3');
    const fetchImpl: typeof fetch = async () =>
      ({
        ok: true,
        json: async () => [supported, supported]
      } as Response);

    const client = new OrdersApiClient({
      baseUrl: 'https://orders.example',
      chainId: 42161,
      fetchImpl
    });
    const poller = new OrdersPoller(client);

    const result = await poller.pollOnce();

    expect(result).toEqual({
      fetched: 2,
      payloads: [supported, supported]
    });
  });

  it('rejects payloads where API orderHash mismatches canonical decoded hash', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/orders/arbitrum/invalid');
    const mismatchFixture = JSON.parse(fs.readFileSync(path.join(root, 'order-hash-mismatch.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(normalizeApiOrder(mismatchFixture)).toBeUndefined();
  });
});
