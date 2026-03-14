import { assertTimestampMaxFresh, normalizeConditionalEnvelope, type ConditionalEnvelope } from './conditional.js';
import { classifySendResult, type JsonRpcErrorShape, type SendResultClassification } from './sendResultClassifier.js';
import type { PreparedExecution } from '../execution/preparedExecution.js';

type FetchLike = typeof fetch;

type JsonRpcResponse = {
  result?: `0x${string}`;
  error?: JsonRpcErrorShape;
};

export type SequencerClientConfig = {
  sequencerUrl: string;
  fallbackUrl: string;
  fetchImpl?: FetchLike;
  shadowMode?: boolean;
  enableConditionalKnownAccounts?: boolean;
  getCurrentL2TimestampSec?: () => bigint;
};

export type SendAttempt = {
  writer: 'sequencer' | 'fallback';
  classification: SendResultClassification;
  txHash?: `0x${string}`;
  error?: JsonRpcErrorShape;
};

export type SendRecord = {
  orderHash: `0x${string}`;
  serializedTransaction: `0x${string}`;
  nonce: bigint;
  writer: 'sequencer' | 'fallback' | 'shadow';
  conditionalEnvelope?: ConditionalEnvelope;
  classification: SendResultClassification | 'shadow_recorded';
  attemptedAt: number;
};

export type SequencerClientResult = {
  attempts: SendAttempt[];
  accepted: boolean;
  records: SendRecord[];
};

export type SendInput = {
  orderHash: `0x${string}`;
  serializedTransaction: `0x${string}`;
  nonce: bigint;
  conditional?: ConditionalEnvelope;
};

const DEFAULT_FETCH: FetchLike = (...args) => fetch(...args);

function shouldTryFallback(classification: SendResultClassification): boolean {
  return classification === 'transport_error' || classification === 'limit_exceeded';
}

export class SequencerClient {
  private readonly fetchImpl: FetchLike;
  private readonly records: SendRecord[] = [];

  constructor(private readonly config: SequencerClientConfig) {
    this.fetchImpl = config.fetchImpl ?? DEFAULT_FETCH;
  }

  getSendRecords(): SendRecord[] {
    return [...this.records];
  }

  async send(input: SendInput): Promise<SequencerClientResult> {
    const normalizedConditional =
      input.conditional === undefined
        ? undefined
        : normalizeConditionalEnvelope(input.conditional, {
            enableKnownAccounts: this.config.enableConditionalKnownAccounts
          });
    if (normalizedConditional && this.config.getCurrentL2TimestampSec) {
      assertTimestampMaxFresh(normalizedConditional, this.config.getCurrentL2TimestampSec());
    }
    const method = normalizedConditional ? 'eth_sendRawTransactionConditional' : 'eth_sendRawTransaction';

    if (this.config.shadowMode) {
      const record: SendRecord = {
        orderHash: input.orderHash,
        serializedTransaction: input.serializedTransaction,
        nonce: input.nonce,
        writer: 'shadow',
        conditionalEnvelope: normalizedConditional,
        classification: 'shadow_recorded',
        attemptedAt: Date.now()
      };
      this.records.push(record);
      return {
        attempts: [],
        accepted: false,
        records: [record]
      };
    }

    const sequencer = await this.sendRpc(
      'sequencer',
      this.config.sequencerUrl,
      method,
      input.orderHash,
      input.serializedTransaction,
      input.nonce,
      normalizedConditional
    );
    const attempts: SendAttempt[] = [sequencer.attempt];
    const records: SendRecord[] = [sequencer.record];

    if (sequencer.attempt.classification === 'accepted') {
      this.records.push(...records);
      return { attempts, accepted: true, records };
    }

    if (shouldTryFallback(sequencer.attempt.classification)) {
      const fallback = await this.sendRpc(
        'fallback',
        this.config.fallbackUrl,
        method,
        input.orderHash,
        input.serializedTransaction,
        input.nonce,
        normalizedConditional
      );
      attempts.push(fallback.attempt);
      records.push(fallback.record);
      this.records.push(...records);
      return { attempts, accepted: fallback.attempt.classification === 'accepted', records };
    }

    this.records.push(...records);
    return { attempts, accepted: false, records };
  }

  async sendPreparedExecution(prepared: PreparedExecution): Promise<SequencerClientResult> {
    return this.send({
      orderHash: prepared.orderHash,
      serializedTransaction: prepared.serializedTransaction,
      nonce: prepared.nonce,
      conditional: prepared.conditionalEnvelope
    });
  }

  private async sendRpc(
    writer: 'sequencer' | 'fallback',
    url: string,
    method: 'eth_sendRawTransaction' | 'eth_sendRawTransactionConditional',
    orderHash: `0x${string}`,
    serializedTransaction: `0x${string}`,
    nonce: bigint,
    conditionalEnvelope?: ConditionalEnvelope
  ): Promise<{ attempt: SendAttempt; record: SendRecord }> {
    try {
      const params = method === 'eth_sendRawTransactionConditional' ? [serializedTransaction, this.assertConditionalEnvelope(conditionalEnvelope)] : [serializedTransaction];
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params
        })
      });
      const json = (await response.json()) as JsonRpcResponse;
      const classification = classifySendResult({
        ok: Boolean(json.result),
        txHash: json.result,
        error: json.error
      });
      return {
        attempt: {
          writer,
          classification,
          txHash: json.result,
          error: json.error
        },
        record: {
          orderHash,
          serializedTransaction,
          nonce,
          writer,
          conditionalEnvelope,
          classification,
          attemptedAt: Date.now()
        }
      };
    } catch (transportError) {
      const classification = classifySendResult({ ok: false, transportError });
      return {
        attempt: {
          writer,
          classification
        },
        record: {
          orderHash,
          serializedTransaction,
          nonce,
          writer,
          conditionalEnvelope,
          classification,
          attemptedAt: Date.now()
        }
      };
    }
  }

  private assertConditionalEnvelope(conditional: ConditionalEnvelope | undefined): ConditionalEnvelope {
    if (!conditional) {
      throw new Error('conditional envelope is required for eth_sendRawTransactionConditional');
    }
    return conditional;
  }
}
