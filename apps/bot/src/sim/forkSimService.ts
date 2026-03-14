import type { Address } from 'viem';
import type { PreparedExecution } from '../execution/preparedExecution.js';
import { classifyRevertReason } from './revertClassifier.js';
import { withForkSnapshot } from './forkLifecycle.js';
import type { ForkClients, ForkSimResult } from './types.js';
export type { ForkSimResult, SimTxRequest } from './types.js';

export type ForkSimServiceConfig = {
  clients: ForkClients;
  fundAmountWei?: bigint;
  cleanupSnapshot?: boolean;
};

export class ForkSimService {
  constructor(private readonly config: ForkSimServiceConfig) {}

  async simulatePrepared(prepared: PreparedExecution): Promise<ForkSimResult> {
    const run = async (): Promise<ForkSimResult> => {
      await this.prepareSenderBalance();

      const executorCode = await this.config.clients.publicClient.getCode({ address: prepared.executionPlan.executor });
      if (!executorCode || executorCode === '0x') {
        return {
          ok: false,
          reason: 'UNKNOWN',
          preparedExecution: prepared,
          txRequest: prepared.txRequest,
          serializedTransaction: prepared.serializedTransaction,
          details: 'EXECUTOR_CODE_MISSING'
        };
      }

      try {
        const txHash = await this.config.clients.publicClient.sendRawTransaction({
          serializedTransaction: prepared.serializedTransaction
        });
        const receipt = await this.config.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
        const ok = receipt.status === 'success';
        return {
          ok,
          reason: ok ? 'SUPPORTED' : 'UNKNOWN',
          preparedExecution: prepared,
          txRequest: prepared.txRequest,
          serializedTransaction: prepared.serializedTransaction,
          gasUsed: receipt.gasUsed,
          details: ok ? undefined : 'transaction reverted',
          receipt: {
            status: receipt.status,
            transactionHash: txHash,
            gasUsed: receipt.gasUsed
          }
        };
      } catch (error) {
        return {
          ok: false,
          reason: classifyRevertReason(error),
          preparedExecution: prepared,
          txRequest: prepared.txRequest,
          serializedTransaction: prepared.serializedTransaction,
          details: error instanceof Error ? error.message : String(error)
        };
      }
    };

    if (this.config.cleanupSnapshot ?? true) {
      return withForkSnapshot(this.config.clients.testClient, run);
    }

    return run();
  }

  private async prepareSenderBalance(): Promise<void> {
    await this.config.clients.testClient.setBalance({
      address: this.config.clients.sender as Address,
      value: this.config.fundAmountWei ?? 10n ** 18n
    });
  }
}
