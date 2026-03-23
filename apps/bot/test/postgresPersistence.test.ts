import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeOrderHash, decodeSignedOrder } from '@uni/protocol';
import { describe, expect, it } from 'vitest';
import { PostgresDecisionJournal } from '../src/journal/postgresDecisionJournal.js';
import { PostgresOrderStore } from '../src/store/postgres/postgresOrderStore.js';
import { PostgresNonceLedger } from '../src/send/nonceManager.js';
import { buildRuntimeFromConfig } from '../src/runtime/buildRuntime.js';
import type { RuntimeConfig } from '../src/runtime/config.js';
import { PostgresOrderStore as DurableOrderStore } from '../src/store/postgres/postgresOrderStore.js';
import { PostgresDecisionJournal as DurableDecisionJournal } from '../src/journal/postgresDecisionJournal.js';
import { createInMemorySqlAdapter, createSharedSqlState } from './helpers/inMemorySqlAdapter.js';

function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    readRpcUrl: 'http://127.0.0.1:8545',
    forkRpcUrl: 'http://127.0.0.1:8545',
    sequencerUrl: 'http://127.0.0.1:8547',
    databaseUrl: 'postgres://example:example@localhost:5432/uni',
    allowEphemeralState: false,
    signerPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    executorAddress: '0x3333333333333333333333333333333333333333',
    pollCadenceMs: 100,
    enableWebhookIngress: false,
    webhookHost: '127.0.0.1',
    webhookPort: 8080,
    webhookPath: '/uniswapx/webhook',
    trustProxy: false,
    allowedWebhookCidrs: ['127.0.0.1/32'],
    maxWebhookBodyBytes: 100000,
    schedulerCadenceMs: 100,
    hotLaneCadenceMs: 100,
    candidateBlockOffsets: [0n],
    competeWindowBlocks: 2n,
    thresholdOut: 1n,
    routeEvalMaxConcurrency: 4,
    infraBlockedRetryCooldownTicks: 2,
    shadowMode: false,
    canaryMode: false,
    canaryAllowlistedPairs: [],
    maxLiveNotionalIn: 10n ** 30n,
    maxLiveInflight: 10,
    minLiveEdgeOut: 1n,
    enableCamelotAmmv3: false,
    bridgeTokens: ['0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'],
    enableMetricsServer: false,
    metricsHost: '127.0.0.1',
    metricsPort: 9100,
    ...overrides
  };
}

function loadNormalizedOrder() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/orders/arbitrum/live');
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'live-01.json'), 'utf8')) as {
    encodedOrder: `0x${string}`;
    signature: `0x${string}`;
  };
  const decoded = decodeSignedOrder(fixture.encodedOrder, fixture.signature);
  return {
    orderHash: computeOrderHash(decoded.order) as `0x${string}`,
    orderType: 'Dutch_V3',
    encodedOrder: fixture.encodedOrder,
    signature: fixture.signature,
    decodedOrder: decoded,
    reactor: decoded.order.info.reactor
  };
}

describe('postgres persistence behavior', () => {
  it('postgresDecisionJournal_readsPersistedEventsFromFreshInstance', async () => {
    const state = createSharedSqlState();
    const adapter = createInMemorySqlAdapter(state);

    const journalA = new PostgresDecisionJournal(adapter);
    await journalA.ensureSchema();
    await journalA.append({
      type: 'ORDER_SEEN',
      atMs: 100,
      orderHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      payload: { source: 'POLL', receivedAtMs: 100, deduped: false, validation: 'ACCEPTED' }
    });
    await journalA.append({
      type: 'ORDER_SUPPORTED',
      atMs: 101,
      orderHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      payload: { reason: 'SUPPORTED' }
    });

    const journalB = new PostgresDecisionJournal(adapter);
    await journalB.ensureSchema();

    const byOrder = await journalB.byOrderHash('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(byOrder).toHaveLength(2);
    expect(byOrder[1]?.type).toEqual('ORDER_SUPPORTED');

    const byType = await journalB.byType('ORDER_SUPPORTED');
    expect(byType).toHaveLength(1);

    const latest = await journalB.latest(2);
    expect(latest).toHaveLength(2);
    expect(latest[0]?.type).toEqual('ORDER_SEEN');
  });

  it('postgresOrderStore_readsPersistedOrderFromFreshInstance', async () => {
    const state = createSharedSqlState();
    const adapter = createInMemorySqlAdapter(state);
    const normalized = loadNormalizedOrder();

    const storeA = new PostgresOrderStore(adapter);
    await storeA.writeSchema();
    await storeA.upsertDiscovered(normalized, normalized, 100, { source: 'POLL', receivedAtMs: 100 });
    await storeA.transition(normalized.orderHash, 'DECODED', undefined, 101);
    await storeA.transition(normalized.orderHash, 'SUPPORTED', 'SUPPORTED', 102);

    const storeB = new PostgresOrderStore(adapter);
    await storeB.writeSchema();

    const restored = await storeB.get(normalized.orderHash);
    expect(restored?.state).toEqual('SUPPORTED');
    expect(restored?.reason).toEqual('SUPPORTED');

    const listed = await storeB.list();
    expect(listed.map((entry) => entry.orderHash)).toContain(normalized.orderHash);
  });

  it('postgresNonceLedger_readsPersistedNonceFromFreshInstance', async () => {
    const state = createSharedSqlState();
    const adapter = createInMemorySqlAdapter(state);

    const ledgerA = new PostgresNonceLedger(adapter);
    await ledgerA.ensureSchema();
    await ledgerA.writeNextNonce('0x1111111111111111111111111111111111111111', 42n, 'LEASED', 'o1');

    const ledgerB = new PostgresNonceLedger(adapter);
    await ledgerB.ensureSchema();
    const restored = await ledgerB.readNextNonce('0x1111111111111111111111111111111111111111');
    expect(restored).toEqual(42n);
  });

  it('buildRuntimeFromConfig_rejectsLiveModeWhenDatabaseAdapterCannotBeCreated', async () => {
    await expect(
      buildRuntimeFromConfig(
        runtimeConfig({
          shadowMode: false,
          canaryMode: false,
          databaseUrl: 'postgres://bad.invalid:5432/uni'
        })
      )
    ).rejects.toThrow('failed to create Postgres adapter for durable runtime');
  });

  it('buildRuntimeFromConfig_liveModeUsesDurableComponents', async () => {
    const sharedState = createSharedSqlState();
    const built = await buildRuntimeFromConfig(runtimeConfig(), {
      createSqlAdapter: async () => createInMemorySqlAdapter(sharedState)
    });

    expect(built.orderStore).toBeInstanceOf(DurableOrderStore);
    expect(built.decisionJournal).toBeInstanceOf(DurableDecisionJournal);
    expect(built.sqlAdapter).toBeDefined();

    await built.runtime.stop();
    await built.sqlAdapter?.close();
  });
});
