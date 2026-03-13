import { normalizeConditionalEnvelope, type ConditionalEnvelope } from './conditional.js';
import { classifySendResult, type JsonRpcErrorShape, type SendResultClassification } from './sendResultClassifier.js';

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
};

export type SendAttempt = {
  writer: 'sequencer' | 'fallback';
  classification: SendResultClassification;
  txHash?: `0x${string}`;
  error?: JsonRpcErrorShape;
};

export type SendEnvelopeRecord = {
  method: 'eth_sendRawTransaction' | 'eth_sendRawTransactionConditional';
  rawTransaction: `0x${string}`;
  conditional?: ConditionalEnvelope;
};

export type SequencerClientResult = {
  attempts: SendAttempt[];
  accepted: boolean;
  envelope: SendEnvelopeRecord;
};

const DEFAULT_FETCH: FetchLike = (...args) => fetch(...args);

function shouldTryFallback(classification: SendResultClassification): boolean {
  return classification === 'transport_error' || classification === 'limit_exceeded';
}

export class SequencerClient {
  private readonly fetchImpl: FetchLike;
  private readonly envelopes: SendEnvelopeRecord[] = [];

  constructor(private readonly config: SequencerClientConfig) {
    this.fetchImpl = config.fetchImpl ?? DEFAULT_FETCH;
  }

  getRecordedEnvelopes(): SendEnvelopeRecord[] {
    return [...this.envelopes];
  }

  async sendRawTransaction(rawTransaction: `0x${string}`): Promise<SequencerClientResult> {
    return this.sendInternal('eth_sendRawTransaction', rawTransaction);
  }

  async sendRawTransactionConditional(
    rawTransaction: `0x${string}`,
    conditional: ConditionalEnvelope
  ): Promise<SequencerClientResult> {
    const normalized = normalizeConditionalEnvelope(conditional, {
      enableKnownAccounts: this.config.enableConditionalKnownAccounts
    });
    return this.sendInternal('eth_sendRawTransactionConditional', rawTransaction, normalized);
  }

  private async sendInternal(
    method: 'eth_sendRawTransaction' | 'eth_sendRawTransactionConditional',
    rawTransaction: `0x${string}`,
    conditional?: ConditionalEnvelope
  ): Promise<SequencerClientResult> {
    const envelope: SendEnvelopeRecord = { method, rawTransaction, conditional };
    this.envelopes.push(envelope);
    if (this.config.shadowMode) {
      return {
        attempts: [],
        accepted: false,
        envelope
      };
    }

    const sequencer = await this.sendRpc('sequencer', this.config.sequencerUrl, method, rawTransaction, conditional);
    const attempts: SendAttempt[] = [sequencer];
    if (sequencer.classification === 'accepted') {
      return { attempts, accepted: true, envelope };
    }

    if (shouldTryFallback(sequencer.classification)) {
      const fallback = await this.sendRpc('fallback', this.config.fallbackUrl, method, rawTransaction, conditional);
      attempts.push(fallback);
      return { attempts, accepted: fallback.classification === 'accepted', envelope };
    }

    return { attempts, accepted: false, envelope };
  }

  private async sendRpc(
    writer: 'sequencer' | 'fallback',
    url: string,
    method: 'eth_sendRawTransaction' | 'eth_sendRawTransactionConditional',
    rawTransaction: `0x${string}`,
    conditional?: ConditionalEnvelope
  ): Promise<SendAttempt> {
    try {
      const params =
        method === 'eth_sendRawTransactionConditional'
          ? [rawTransaction, this.assertConditionalEnvelope(conditional)]
          : [rawTransaction];
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
        writer,
        classification,
        txHash: json.result,
        error: json.error
      };
    } catch (transportError) {
      return {
        writer,
        classification: classifySendResult({
          ok: false,
          transportError
        })
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
