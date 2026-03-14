import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import {
  assertTimestampMaxFresh,
  buildFreshnessGuard,
  deriveTimestampMax,
  normalizeConditionalEnvelope
} from '../src/send/conditional.js';
import { InMemoryNonceLedger, NonceManager } from '../src/send/nonceManager.js';
import { classifySendResult } from '../src/send/sendResultClassifier.js';
import { SequencerClient } from '../src/send/sequencerClient.js';
import { buildTransaction } from '../src/send/txBuilder.js';
import { RiskEngine } from '../src/risk/riskEngine.js';
import { BotMetrics } from '../src/telemetry/metrics.js';
import { JsonConsoleLogger } from '../src/telemetry/logging.js';
import type { ExecutionPlan } from '../src/execution/types.js';

const SAMPLE_PLAN: ExecutionPlan = {
  orderHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  reactor: '0x1111111111111111111111111111111111111111',
  executor: '0x2222222222222222222222222222222222222222',
  signedOrder: { order: '0x1234', sig: '0x5678' },
  normalizedOrder: {} as never,
  resolvedOrder: {} as never,
  route: {} as never,
  routeAlternatives: [],
  callbackData: '0x',
  executeCalldata: '0x1234',
  txRequestDraft: {
    chainId: 42161n,
    to: '0x2222222222222222222222222222222222222222',
    data: '0x1234',
    value: 0n
  },
  conditionalEnvelope: { TimestampMax: 100n },
  requiredOutputOut: 1n,
  predictedNetEdgeOut: 1n,
  selectedBlock: 1n,
  resolveEnv: { timestamp: 1n, basefee: 1n, chainId: 42161n }
};

describe('send path primitives', () => {
  it('classifies Arbitrum sequencer error codes', () => {
    expect(classifySendResult({ ok: false, error: { code: -32003, message: 'rejected' } })).toEqual('sequencer_rejected');
    expect(classifySendResult({ ok: false, error: { code: -32005, message: 'limit exceeded' } })).toEqual('limit_exceeded');
  });

  it('normalizes and derives timestamp-first conditional freshness guards', () => {
    const timestampMax = deriveTimestampMax({
      currentL2TimestampSec: 1_900_000_000n,
      scheduledWindowBlocks: 2n,
      avgBlockTimeSec: 1n,
      maxStalenessSec: 5n
    });
    const freshness = buildFreshnessGuard(timestampMax, {
      enableConditionalBlockBounds: true,
      blockNumberMax: 123n
    });
    expect(freshness).toEqual({
      TimestampMax: 1_900_000_007n,
      BlockNumberMax: 123n
    });

    const normalized = normalizeConditionalEnvelope(
      {
        TimestampMin: 1n,
        TimestampMax: 2n,
        knownAccounts: [{ address: '0x1111111111111111111111111111111111111111', nonce: 1n }]
      },
      { enableKnownAccounts: false }
    );
    expect(normalized.knownAccounts).toBeUndefined();
    expect(() => assertTimestampMaxFresh({ TimestampMax: 1n }, 2n)).toThrow('stale');
  });

  it('uses sequencer-first send and falls back on limit errors; shadow mode records serialized tx', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return {
          json: async () => ({ error: { code: -32005, message: 'rate limit' } })
        } as Response;
      }
      return {
        json: async () => ({ result: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
      } as Response;
    };

    const client = new SequencerClient({
      sequencerUrl: 'https://sequencer.example',
      fallbackUrl: 'https://fallback.example',
      fetchImpl
    });

    const accepted = await client.send({
      orderHash: SAMPLE_PLAN.orderHash,
      serializedTransaction: '0xbb',
      nonce: 9n
    });
    expect(accepted.accepted).toEqual(true);
    expect(accepted.attempts.map((attempt) => attempt.writer)).toEqual(['sequencer', 'fallback']);

    const shadow = new SequencerClient({
      sequencerUrl: 'https://sequencer.example',
      fallbackUrl: 'https://fallback.example',
      shadowMode: true,
      getCurrentL2TimestampSec: () => 5n
    });
    const shadowResult = await shadow.send({
      orderHash: SAMPLE_PLAN.orderHash,
      serializedTransaction: '0xcc',
      nonce: 10n,
      conditional: { TimestampMax: 10n }
    });
    expect(shadowResult.accepted).toEqual(false);
    expect(shadowResult.attempts).toEqual([]);
    expect(shadow.getSendRecords()).toHaveLength(1);
    expect(shadow.getSendRecords()[0]!.serializedTransaction).toEqual('0xcc');
  });

  it('leases nonces single-flight and prevents duplicate concurrent usage', async () => {
    const ledger = new InMemoryNonceLedger();
    const manager = new NonceManager({
      ledger,
      chainNonceReader: async () => 7n
    });
    const lease = await manager.lease('0x2222222222222222222222222222222222222222', 'order-a');
    expect(lease.nonce).toEqual(7n);

    await expect(manager.lease('0x2222222222222222222222222222222222222222', 'order-b')).rejects.toThrow('NONCE_LEASE_IN_FLIGHT');

    await manager.markBroadcastAccepted(lease);
    await manager.markLanded(lease);
    const lease2 = await manager.lease('0x2222222222222222222222222222222222222222', 'order-b');
    expect(lease2.nonce).toEqual(8n);
  });

  it('builds a serialized signed transaction and enforces gas ceiling', async () => {
    const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945382dbf0f32a9f4d3b5b6f3a2f4d8c5e9b11');
    const walletClient = {
      account,
      chain: arbitrum,
      prepareTransactionRequest: async (args: {
        nonce: bigint;
        to: `0x${string}`;
        data: `0x${string}`;
        gas: bigint;
        value: bigint;
        maxFeePerGas: bigint;
        maxPriorityFeePerGas: bigint;
      }) => ({
        chainId: 42161,
        from: account.address,
        ...args,
        type: 'eip1559' as const
      }),
      signTransaction: async (args: Parameters<typeof account.signTransaction>[0]) =>
        account.signTransaction({
          ...args,
          chainId: 42161,
          nonce: BigInt(args.nonce as number)
        })
    } as never;

    const publicClient = {
      estimateGas: async () => 21_000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 100_000_000n })
    } as never;

    const tx = await buildTransaction({
      plan: SAMPLE_PLAN,
      publicClient,
      walletClient,
      sender: account.address,
      leasedNonce: 9n,
      simulationGasUsed: 21_000n,
      policy: {
        gasHeadroomBps: 100n,
        maxGasCeiling: 25_000n
      }
    });
    expect(tx.serializedTransaction.startsWith('0x')).toEqual(true);

    await expect(
      buildTransaction({
        plan: SAMPLE_PLAN,
        publicClient,
        walletClient,
        sender: account.address,
        leasedNonce: 9n,
        simulationGasUsed: 30_000n,
        policy: {
          gasHeadroomBps: 100n,
          maxGasCeiling: 25_000n
        }
      })
    ).rejects.toThrow('exceeds configured ceiling');
  });
});

describe('risk and observability primitives', () => {
  it('enforces hard risk limits and records metrics/logs', () => {
    const riskEngine = new RiskEngine({
      globalPause: false,
      tokenAllowlist: new Set(['0xaaaa', '0xbbbb']),
      maxNotionalPerTrade: 100n,
      maxGas: 1_000_000n,
      maxConcurrentInflight: 2,
      maxAttemptsPerOrder: 3,
      orderTtlMs: 1_000,
      minProfit: 1n,
      minConfidence: 0.5,
      maxRiskBufferBps: 300
    });

    const denied = riskEngine.evaluate({
      inputToken: '0xcccc',
      outputToken: '0xbbbb',
      notional: 10n,
      gas: 10n,
      concurrentInflight: 0,
      attempts: 0,
      createdAtMs: 0,
      nowMs: 1,
      expectedProfit: 3n,
      confidence: 0.9,
      riskBufferBps: 100
    });
    expect(denied).toEqual({ allowed: false, reason: 'TOKEN_NOT_ALLOWLISTED' });

    const metrics = new BotMetrics();
    metrics.increment('orders.discovered');
    metrics.increment('sends.attempted', 2);
    metrics.observeIngestToSendLatency(10);
    metrics.observeIngestToSendLatency(40);
    metrics.observeSimLatency(7);
    metrics.recordRealizedPnl(9n);
    metrics.observeGasPerLandedFill(100000);
    const snapshot = metrics.snapshot();
    expect(snapshot.counters['orders.discovered']).toEqual(1);
    expect(snapshot.ingestToSendLatencyMs.p95).toEqual(40);
    expect(snapshot.realizedPnl).toEqual(9n);

    const lines: string[] = [];
    const logger = new JsonConsoleLogger((line) => lines.push(line));
    logger.log('info', 'scheduler.decision', { action: 'WOULD_SEND' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"event":"scheduler.decision"');
  });
});
