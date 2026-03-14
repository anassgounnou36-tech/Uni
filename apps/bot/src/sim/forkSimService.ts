import { parseGwei } from 'viem';
import type { Address } from 'viem';
import type { ExecutionPlan } from '../execution/types.js';
import { classifyRevertReason } from './revertClassifier.js';
import { withForkSnapshot } from './forkLifecycle.js';
import type { ForkClients, ForkSimResult, SimTxRequest } from './types.js';
export type { ForkSimResult, SimTxRequest } from './types.js';

export type ForkSimServiceConfig = {
  clients: ForkClients;
  fundAmountWei?: bigint;
  cleanupSnapshot?: boolean;
};

const DEFAULT_MAX_FEE_GWEI = '0.2';
const DEFAULT_MAX_PRIORITY_FEE_GWEI = '0.01';

function fallbackFee(value: bigint | undefined, defaultGwei: string): bigint {
  if (value && value > 0n) {
    return value;
  }
  return parseGwei(defaultGwei);
}

export class ForkSimService {
  constructor(private readonly config: ForkSimServiceConfig) {}

  async simulateFinal(plan: ExecutionPlan): Promise<ForkSimResult> {
    const run = async (): Promise<ForkSimResult> => {
      await this.prepareSenderBalance();

      const nonce = await this.config.clients.publicClient.getTransactionCount({
        address: this.config.clients.sender,
        blockTag: 'pending'
      });

      const [gasEstimate, feeEstimate] = await Promise.all([
        this.config.clients.publicClient.estimateGas({
          account: this.config.clients.sender,
          to: plan.executor,
          data: plan.executeCalldata,
          value: 0n
        }),
        this.config.clients.publicClient.estimateFeesPerGas()
      ]);

      const txRequest: SimTxRequest = {
        chainId: plan.txRequestDraft.chainId,
        from: this.config.clients.sender,
        to: plan.executor,
        nonce: BigInt(nonce),
        gas: gasEstimate,
        maxFeePerGas: fallbackFee(feeEstimate.maxFeePerGas, DEFAULT_MAX_FEE_GWEI),
        maxPriorityFeePerGas: fallbackFee(feeEstimate.maxPriorityFeePerGas, DEFAULT_MAX_PRIORITY_FEE_GWEI),
        value: 0n,
        data: plan.executeCalldata
      };

      const serializedTransaction = await this.config.clients.walletClient.signTransaction({
        account: this.config.clients.walletClient.account!,
        chain: this.config.clients.walletClient.chain,
        nonce: Number(txRequest.nonce),
        to: txRequest.to,
        gas: txRequest.gas,
        maxFeePerGas: txRequest.maxFeePerGas,
        maxPriorityFeePerGas: txRequest.maxPriorityFeePerGas,
        value: txRequest.value,
        data: txRequest.data,
        type: 'eip1559'
      });

      try {
        const txHash = await this.config.clients.publicClient.sendRawTransaction({ serializedTransaction });
        const receipt = await this.config.clients.publicClient.waitForTransactionReceipt({ hash: txHash });
        const ok = receipt.status === 'success';
        return {
          ok,
          reason: ok ? 'SUPPORTED' : 'UNKNOWN',
          executionPlan: plan,
          txRequest,
          serializedTransaction,
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
          executionPlan: plan,
          txRequest,
          serializedTransaction,
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
