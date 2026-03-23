import { describe, expect, it } from 'vitest';
import { RouteEvalReadCache } from '../src/routing/rpc/readCache.js';
import { RouteEvalRpcGate } from '../src/routing/rpc/rpcGate.js';
import { normalizeRouteEvalRpcError } from '../src/routing/rpc/errors.js';

describe('routing rpc infra helpers', () => {
  it('repeated identical reads hit cache within one block snapshot', async () => {
    const cache = new RouteEvalReadCache();
    let calls = 0;
    const load = async () => {
      calls += 1;
      return 'ok';
    };

    const first = await cache.getOrSet(
      {
        chainId: 42161n,
        blockNumberish: 1000n,
        target: '0x0000000000000000000000000000000000000001',
        fn: 'getPool',
        args: ['0x1', '0x2', 3000]
      },
      load
    );
    const second = await cache.getOrSet(
      {
        chainId: 42161n,
        blockNumberish: 1000n,
        target: '0x0000000000000000000000000000000000000001',
        fn: 'getPool',
        args: ['0x1', '0x2', 3000]
      },
      load
    );

    expect(first.hit).toBe(false);
    expect(second.hit).toBe(true);
    expect(calls).toBe(1);
  });

  it('cache does not leak across block snapshots', async () => {
    const cache = new RouteEvalReadCache();
    let calls = 0;
    const load = async () => {
      calls += 1;
      return 'ok';
    };

    await cache.getOrSet(
      {
        chainId: 42161n,
        blockNumberish: 1000n,
        target: '0x0000000000000000000000000000000000000001',
        fn: 'slot0',
        args: []
      },
      load
    );
    await cache.getOrSet(
      {
        chainId: 42161n,
        blockNumberish: 1001n,
        target: '0x0000000000000000000000000000000000000001',
        fn: 'slot0',
        args: []
      },
      load
    );

    expect(calls).toBe(2);
  });

  it('route-eval concurrency is bounded', async () => {
    const gate = new RouteEvalRpcGate(2);
    let running = 0;
    let peak = 0;
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    await Promise.all(
      Array.from({ length: 8 }).map(async () =>
        gate.run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await wait(10);
          running -= 1;
          return true;
        })
      )
    );

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('normalizes rate-limit and rpc-unavailable errors', () => {
    const rateLimited = normalizeRouteEvalRpcError(new Error('429 exceeded its compute units per second capacity'));
    const unavailable = normalizeRouteEvalRpcError(new Error('network timeout while connecting'));

    expect(rateLimited.category).toBe('RATE_LIMITED');
    expect(unavailable.category).toBe('RPC_UNAVAILABLE');
  });
});
