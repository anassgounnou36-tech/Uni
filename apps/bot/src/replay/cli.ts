import fs from 'node:fs';
import path from 'node:path';
import { decodeSignedOrder, computeOrderHash } from '@uni/protocol';
import { InMemoryOrderStore } from '../store/memory/inMemoryOrderStore.js';
import { InMemoryNonceLedger, NonceManager } from '../send/nonceManager.js';
import { loadRuntimeConfig } from '../runtime/config.js';
import { runReplay } from './replayRunner.js';
import type { RouteBook } from '../routing/routeBook.js';

type ReplayFixture = { encodedOrder: `0x${string}`; signature: `0x${string}`; orderHash?: `0x${string}` };

function parseArgs(argv: string[]): { orderHash?: string; fixture?: string } {
  const result: { orderHash?: string; fixture?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--order-hash') {
      result.orderHash = argv[i + 1];
      i += 1;
    } else if (arg === '--fixture') {
      result.fixture = argv[i + 1];
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.orderHash && !args.fixture) {
    throw new Error('Usage: replay --order-hash <hash> [--fixture <path>]');
  }
  const fixture = args.fixture
    ? (JSON.parse(fs.readFileSync(path.resolve(process.cwd(), args.fixture), 'utf8')) as ReplayFixture)
    : loadFixtureByHash(args.orderHash!);
  const decoded = decodeSignedOrder(fixture.encodedOrder, fixture.signature);
  const hash = (fixture.orderHash ?? computeOrderHash(decoded.order)) as `0x${string}`;

  const config = loadRuntimeConfig(process.env);
  const resolveSnapshot = {
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

  const first = replay[0];
  const output = {
    orderHash: hash,
    resolvedInput: decoded.order.baseInput,
    resolvedOutput: decoded.order.baseOutputs,
    decision: first?.decision,
    chosenRoute: first?.chosenVenue,
    bestRejected: first?.rejectedVenueSummaries?.find((summary) => !summary.eligible),
    candidateClass: undefined,
    constraintReason: first?.reason,
    exactOutputViability: undefined,
    hedgeGap: undefined,
    simResult: first?.simResult
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(output));
}

void main();
