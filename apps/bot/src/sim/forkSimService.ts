import type { ResolvedV3DutchOrder } from '@uni/protocol';
import { classifyRevertReason } from './revertClassifier.js';
import type { OrderReasonCode } from '../store/types.js';

export type SimulatedTransaction = {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
};

export type ForkSimResult = {
  ok: boolean;
  reason: OrderReasonCode;
  transaction: SimulatedTransaction;
  details?: string;
};

export type ForkSimExecutor = (transaction: SimulatedTransaction) => Promise<void>;

export type ForkSimServiceConfig = {
  reactor: `0x${string}`;
  executor: ForkSimExecutor;
};

function encodeOrderHashData(orderHash: `0x${string}`): `0x${string}` {
  return `0x${orderHash.slice(2).padStart(64, '0')}` as `0x${string}`;
}

export class ForkSimService {
  constructor(private readonly config: ForkSimServiceConfig) {}

  buildSubmissionTx(resolved: ResolvedV3DutchOrder): SimulatedTransaction {
    return {
      to: this.config.reactor,
      data: encodeOrderHashData(resolved.hash as `0x${string}`),
      value: 0n
    };
  }

  async simulateFinal(resolved: ResolvedV3DutchOrder): Promise<ForkSimResult> {
    const transaction = this.buildSubmissionTx(resolved);
    try {
      await this.config.executor(transaction);
      return { ok: true, reason: 'SUPPORTED', transaction };
    } catch (error) {
      const reason = classifyRevertReason(error instanceof Error ? error.message : error);
      return {
        ok: false,
        reason,
        transaction,
        details: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
