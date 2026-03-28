import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeSignedOrder, computeOrderHash } from '@uni/protocol';
import { createPostgresAdapter } from '../db/postgres.js';
import { PostgresOrderStore } from '../store/postgres/postgresOrderStore.js';
import { InMemoryOrderStore } from '../store/memory/inMemoryOrderStore.js';
import { InMemoryNonceLedger, NonceManager } from '../send/nonceManager.js';
import { loadRuntimeConfig } from '../runtime/config.js';
import { runReplay } from './replayRunner.js';
import type { RouteBook } from '../routing/routeBook.js';
import type { RejectedCandidateClass } from '../routing/rejectedCandidateTypes.js';
import type { ConstraintRejectReason } from '../routing/constraintTypes.js';
import type { ExactOutputViabilityStatus } from '../routing/exactOutputTypes.js';
import type { HedgeGapClass } from '../routing/hedgeGapTypes.js';

type ReplayFixture = { encodedOrder: `0x${string}`; signature: `0x${string}`; orderHash?: `0x${string}` };
type ReplaySource = 'DB_ORDER' | 'DB_JOURNAL' | 'FIXTURE';
type ReplayResolveSnapshot = {
  chainId: bigint;
  blockNumber: bigint;
  blockNumberish: bigint;
  timestamp: bigint;
  baseFeePerGas: bigint;
  sampledAtMs: number;
};

type OrderLookupResult = {
  source: ReplaySource;
  fixture: ReplayFixture;
  resolveSnapshot?: ReplayResolveSnapshot;
};

type ReplayDbLookups = {
  findFromDatabase?: (databaseUrl: string, orderHash: string) => Promise<OrderLookupResult | undefined>;
  findFromJournalId?: (databaseUrl: string, journalId: string) => Promise<OrderLookupResult | undefined>;
};

function parseArgs(argv: string[]): { orderHash?: string; fixture?: string; journalId?: string } {
  const result: { orderHash?: string; fixture?: string; journalId?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--order-hash') {
      result.orderHash = argv[i + 1];
      i += 1;
    } else if (arg === '--fixture') {
      result.fixture = argv[i + 1];
      i += 1;
    } else if (arg === '--journal-id') {
      result.journalId = argv[i + 1];
      i += 1;
    }
  }
  return result;
}

function loadFixtureByHash(orderHash: string): ReplayFixture {
  const fixturesDir = path.resolve(process.cwd(), 'fixtures/orders/arbitrum/live');
  const files = fs.readdirSync(fixturesDir).filter((file) => file.endsWith('.json'));
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8')) as ReplayFixture;
    const decoded = decodeSignedOrder(parsed.encodedOrder, parsed.signature);
    const hash = computeOrderHash(decoded.order) as `0x${string}`;
    if (hash.toLowerCase() === orderHash.toLowerCase()) {
      return parsed;
    }
  }
  throw new Error(`order hash not found in fixture corpus: ${orderHash}`);
}

type JournalRow = {
  id?: number;
  order_hash?: string;
  event_type?: string;
  payload_json: unknown;
};

type JournalOrderSeenPayload = {
  encodedOrder?: string;
  signature?: string;
};

type DroppedResolveSnapshotPayload = {
  chainId?: string;
  blockNumber?: string;
  blockNumberish?: string;
  timestamp?: string;
  baseFeePerGas?: string;
  sampledAtMs?: number;
};

function toReplayFixture(payload: JournalOrderSeenPayload): ReplayFixture | undefined {
  if (
    typeof payload.encodedOrder === 'string'
    && payload.encodedOrder.startsWith('0x')
    && typeof payload.signature === 'string'
    && payload.signature.startsWith('0x')
  ) {
    return {
      encodedOrder: payload.encodedOrder as `0x${string}`,
      signature: payload.signature as `0x${string}`
    };
  }
  return undefined;
}

async function findFromDatabase(databaseUrl: string, orderHash: string): Promise<OrderLookupResult | undefined> {
  const sql = await createPostgresAdapter(databaseUrl);
  try {
    const store = new PostgresOrderStore(sql);
    const order = await store.get(orderHash as `0x${string}`);
    if (order?.normalizedOrder?.encodedOrder && order.normalizedOrder.signature) {
      return {
        source: 'DB_ORDER',
        fixture: {
          encodedOrder: order.normalizedOrder.encodedOrder,
          signature: order.normalizedOrder.signature,
          orderHash: order.normalizedOrder.orderHash
        }
      };
    }

    const journalRows = await sql.query<JournalRow>(
      `select payload_json
       from decision_journal
       where order_hash = $1 and event_type = 'ORDER_SEEN'
       order by at_ms desc, id desc
       limit 10`,
      [orderHash]
    );
    for (const row of journalRows.rows) {
      const payload = (typeof row.payload_json === 'string'
        ? JSON.parse(row.payload_json)
        : row.payload_json) as JournalOrderSeenPayload;
      const fixture = toReplayFixture(payload);
      if (fixture) {
        return {
          source: 'DB_JOURNAL',
          fixture: {
            ...fixture,
            orderHash: orderHash as `0x${string}`
          }
        };
      }
    }
  } catch {
    return undefined;
  } finally {
    await sql.close().catch(() => undefined);
  }
  return undefined;
}

function toReplayResolveSnapshot(payload: DroppedResolveSnapshotPayload | undefined): ReplayResolveSnapshot | undefined {
  if (!payload) return undefined;
  if (
    payload.chainId === undefined
    || payload.blockNumber === undefined
    || payload.blockNumberish === undefined
    || payload.timestamp === undefined
    || payload.baseFeePerGas === undefined
    || payload.sampledAtMs === undefined
  ) {
    return undefined;
  }
  return {
    chainId: BigInt(payload.chainId),
    blockNumber: BigInt(payload.blockNumber),
    blockNumberish: BigInt(payload.blockNumberish),
    timestamp: BigInt(payload.timestamp),
    baseFeePerGas: BigInt(payload.baseFeePerGas),
    sampledAtMs: payload.sampledAtMs
  };
}

async function findFromJournalId(databaseUrl: string, journalId: string): Promise<OrderLookupResult | undefined> {
  const sql = await createPostgresAdapter(databaseUrl);
  try {
    const journalRows = await sql.query<JournalRow>(
      `select id, order_hash, event_type, payload_json
       from decision_journal
       where id = $1
       limit 1`,
      [journalId]
    );
    const row = journalRows.rows[0];
    if (!row?.order_hash) {
      return undefined;
    }
    const payload = (typeof row.payload_json === 'string'
      ? JSON.parse(row.payload_json)
      : row.payload_json) as { resolveSnapshot?: DroppedResolveSnapshotPayload };
    const orderSeenRows = await sql.query<JournalRow>(
      `select payload_json
       from decision_journal
       where order_hash = $1 and event_type = 'ORDER_SEEN'
       order by at_ms desc, id desc
       limit 10`,
      [row.order_hash]
    );
    for (const seenRow of orderSeenRows.rows) {
      const seenPayload = (typeof seenRow.payload_json === 'string'
        ? JSON.parse(seenRow.payload_json)
        : seenRow.payload_json) as JournalOrderSeenPayload;
      const fixture = toReplayFixture(seenPayload);
      if (fixture) {
        return {
          source: 'DB_JOURNAL',
          fixture: {
            ...fixture,
            orderHash: row.order_hash as `0x${string}`
          },
          resolveSnapshot: toReplayResolveSnapshot(payload.resolveSnapshot)
        };
      }
    }
  } catch {
    return undefined;
  } finally {
    await sql.close().catch(() => undefined);
  }
  return undefined;
}

async function hasJournalEntryForOrderHash(databaseUrl: string, orderHash: string): Promise<boolean> {
  const sql = await createPostgresAdapter(databaseUrl);
  try {
    const rows = await sql.query<{ count: string }>(
      `select count(*)::text as count from decision_journal where order_hash = $1`,
      [orderHash]
    );
    return (rows.rows[0]?.count ?? '0') !== '0';
  } catch {
    return false;
  } finally {
    await sql.close().catch(() => undefined);
  }
}

export async function resolveInput(
  args: { orderHash?: string; fixture?: string; journalId?: string },
  databaseUrl?: string,
  lookups: ReplayDbLookups = {}
): Promise<OrderLookupResult> {
  if (args.fixture) {
    return {
      source: 'FIXTURE',
      fixture: JSON.parse(fs.readFileSync(path.resolve(process.cwd(), args.fixture), 'utf8')) as ReplayFixture
    };
  }
  if (!args.orderHash) {
    if (args.journalId) {
      if (!databaseUrl) {
        throw new Error('--journal-id requires databaseUrl/runtime DB configuration');
      }
      const fromJournal = await (lookups.findFromJournalId ?? findFromJournalId)(databaseUrl, args.journalId);
      if (fromJournal) {
        return fromJournal;
      }
      throw new Error(`journal id not found or missing ORDER_SEEN payload: ${args.journalId}`);
    }
    throw new Error('Usage: replay --order-hash <hash> [--journal-id <id>] [--fixture <path>]');
  }
  if (databaseUrl) {
    const fromDb = await (lookups.findFromDatabase ?? findFromDatabase)(databaseUrl, args.orderHash);
    if (fromDb) {
      return fromDb;
    }
  }
  return {
    source: 'FIXTURE',
    fixture: loadFixtureByHash(args.orderHash)
  };
}

export function formatReplayOutput(params: {
  source: ReplaySource;
  orderHash: `0x${string}`;
  replayRecord: Awaited<ReturnType<typeof runReplay>>[number] | undefined;
}) {
  const bestRejected = params.replayRecord?.rejectedVenueSummaries?.find((summary) => !summary.eligible);
  const chosenCandidate = params.replayRecord?.rejectedVenueSummaries?.find(
    (summary) => summary.eligible && summary.venue === params.replayRecord?.chosenVenue
  );
  return {
    source: params.source,
    orderHash: params.orderHash,
    routeBookReason: params.replayRecord?.reason,
    candidateClass: (bestRejected as { candidateClass?: RejectedCandidateClass } | undefined)?.candidateClass,
    constraintReason: (bestRejected as { constraintReason?: ConstraintRejectReason } | undefined)?.constraintReason,
    exactOutputStatus: (
      bestRejected as { exactOutputViability?: { status?: ExactOutputViabilityStatus } } | undefined
    )?.exactOutputViability?.status,
    gapClass: (bestRejected as { hedgeGap?: { gapClass?: HedgeGapClass } } | undefined)?.hedgeGap?.gapClass,
    familyKind: chosenCandidate?.familyKind ?? bestRejected?.familyKind,
    probePriority: chosenCandidate?.probePriority ?? bestRejected?.probePriority,
    familyKey: chosenCandidate?.familyKey ?? bestRejected?.familyKey,
    dominanceScore: chosenCandidate?.dominanceScore ?? bestRejected?.dominanceScore,
    dominanceMargin: chosenCandidate?.dominanceMargin ?? bestRejected?.dominanceMargin,
    dominanceConfidence: chosenCandidate?.dominanceConfidence ?? bestRejected?.dominanceConfidence,
    dominanceReason: chosenCandidate?.dominanceReason ?? bestRejected?.dominanceReason,
    exactOutputPromotedFromFamily: chosenCandidate?.exactOutputPromotedFromFamily ?? bestRejected?.exactOutputPromotedFromFamily,
    bestRejectedVenue: bestRejected?.venue,
    bestRejectedPathKind: bestRejected?.pathKind,
    bestRejectedBridgeToken: bestRejected?.bridgeToken,
    bestRejectedReason: bestRejected?.reason,
    decision: params.replayRecord?.decision,
    chosenRoute: params.replayRecord?.chosenVenue,
    preparedExecution: params.replayRecord?.preparedExecution,
    simResult: params.replayRecord?.simResult
  };
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadRuntimeConfig(process.env);
  let resolvedInput: OrderLookupResult;
  try {
    resolvedInput = await resolveInput(args, config.databaseUrl);
  } catch (error) {
    if (
      args.orderHash
      && config.databaseUrl
      && error instanceof Error
      && (
        error.message.includes('DeadlineReached')
        || error.message.toLowerCase().includes('deadline reached')
      )
    ) {
      const hasJournal = await hasJournalEntryForOrderHash(config.databaseUrl, args.orderHash);
      if (hasJournal) {
        throw new Error(`Replay failed on deadline context. Retry with --journal-id <id> for snapshot-based replay of ${args.orderHash}`);
      }
    }
    throw error;
  }
  const fixture = resolvedInput.fixture;
  const decoded = decodeSignedOrder(fixture.encodedOrder, fixture.signature);
  const hash = (fixture.orderHash ?? computeOrderHash(decoded.order)) as `0x${string}`;

  const resolveSnapshot = resolvedInput.resolveSnapshot ?? {
    chainId: 42161n,
    blockNumber: 0n,
    blockNumberish: 0n,
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
    baseFeePerGas: 0n,
    sampledAtMs: Date.now()
  };
  const resolveEnvProvider = {
    getCurrent: async () => resolveSnapshot
  };
  const routeBook = {
    selectBestRoute: async () => ({
      ok: false as const,
      reason: 'NOT_ROUTEABLE' as const,
      venueAttempts: [
        {
          venue: 'UNISWAP_V3',
          status: 'NOT_ROUTEABLE',
          reason: 'REPLAY_OFFLINE',
          candidateClass: 'UNKNOWN'
        }
      ],
      bestRejectedSummary: {
        venue: 'UNISWAP_V3',
        status: 'NOT_ROUTEABLE',
        reason: 'REPLAY_OFFLINE',
        candidateClass: 'UNKNOWN'
      },
      alternativeRoutes: []
    })
  } as unknown as RouteBook;

  const nonceManager = new NonceManager({
    ledger: new InMemoryNonceLedger(),
    chainNonceReader: async () => 0n
  });
  const replay = await runReplay({
    corpus: [{
      orderHash: hash,
      orderType: 'Dutch_V3',
      encodedOrder: fixture.encodedOrder,
      signature: fixture.signature,
      decodedOrder: decoded,
      reactor: decoded.order.info.reactor
    }],
    store: new InMemoryOrderStore(),
    supportPolicy: {
      allowlistedPairs: [{ inputToken: decoded.order.baseInput.token, outputToken: decoded.order.baseOutputs[0]!.token }],
      thresholdOut: config.thresholdOut,
      candidateBlockOffsets: config.candidateBlockOffsets,
      competeWindowBlocks: config.competeWindowBlocks
    },
    routeBook,
    simService: { simulatePrepared: async () => ({ ok: false, reason: 'SIM_NOT_RUN' }) } as never,
    resolveEnv: {
      chainId: resolveSnapshot.chainId,
      timestamp: resolveSnapshot.timestamp,
      basefee: resolveSnapshot.baseFeePerGas
    },
    resolveEnvProvider,
    shadowMode: true,
    executor: config.executorAddress,
    conditionalEnvelope: { TimestampMax: resolveSnapshot.timestamp + 120n },
    sequencerClient: { sendPreparedExecution: async () => ({ accepted: false, attempts: [], records: [] }) } as never,
    nonceManager,
    executionPreparer: async () => {
      throw new Error('execution preparation not enabled in replay CLI');
    }
  });

  const output = formatReplayOutput({
    source: resolvedInput.source,
    orderHash: hash,
    replayRecord: replay[0]
  });
  console.log(JSON.stringify(output));
}

const isEntrypoint = path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  void main();
}
