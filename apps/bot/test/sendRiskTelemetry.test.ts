import { describe, expect, it } from 'vitest';
import { buildFreshnessGuard, normalizeConditionalEnvelope } from '../src/send/conditional.js';
import { InMemoryNonceLedger, NonceManager } from '../src/send/nonceManager.js';
import { classifySendResult } from '../src/send/sendResultClassifier.js';
import { SequencerClient } from '../src/send/sequencerClient.js';
import { buildTransaction } from '../src/send/txBuilder.js';
import { RiskEngine } from '../src/risk/riskEngine.js';
import { BotMetrics } from '../src/telemetry/metrics.js';
import { JsonConsoleLogger } from '../src/telemetry/logging.js';

describe('send path primitives', () => {
  it('classifies Arbitrum sequencer error codes', () => {
    expect(classifySendResult({ ok: false, error: { code: -32003, message: 'rejected' } })).toEqual('sequencer_rejected');
    expect(classifySendResult({ ok: false, error: { code: -32005, message: 'limit exceeded' } })).toEqual('limit_exceeded');
  });

  it('normalizes conditional envelopes and keeps freshness guard timestamp-first', () => {
    const freshness = buildFreshnessGuard(1_900_000_123n, 123n);
    expect(freshness).toEqual({
      TimestampMax: 1_900_000_123n,
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
  });

  it('uses sequencer-first send and falls back on limit errors; shadow mode records but does not broadcast', async () => {
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

    const accepted = await client.sendRawTransaction('0xbb');
    expect(accepted.accepted).toEqual(true);
    expect(accepted.attempts.map((attempt) => attempt.writer)).toEqual(['sequencer', 'fallback']);

    const shadow = new SequencerClient({
      sequencerUrl: 'https://sequencer.example',
      fallbackUrl: 'https://fallback.example',
      shadowMode: true
    });
    const shadowResult = await shadow.sendRawTransactionConditional('0xcc', { TimestampMax: 10n });
    expect(shadowResult.accepted).toEqual(false);
    expect(shadowResult.attempts).toEqual([]);
    expect(shadow.getRecordedEnvelopes()).toHaveLength(1);
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

    await manager.markLanded(lease);
    const lease2 = await manager.lease('0x2222222222222222222222222222222222222222', 'order-b');
    expect(lease2.nonce).toEqual(8n);
  });

  it('builds transaction payload with gas ceiling enforcement', () => {
    const tx = buildTransaction({
      from: '0x3333333333333333333333333333333333333333',
      chainId: 42161n,
      nonce: 9n,
      gas: 500000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
      simulationTx: {
        to: '0x4444444444444444444444444444444444444444',
        data: '0x1234',
        value: 0n
      },
      maxGasCeiling: 1_000_000n
    });
    expect(tx.nonce).toEqual('0x9');
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
