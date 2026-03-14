import { arbitrum } from 'viem/chains';
import { createPublicClient, createTestClient, createWalletClient, http, type Address, type PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ForkClients } from './types.js';

export type ForkClientConfig = {
  rpcUrl: string;
  privateKey: `0x${string}`;
};

export function createForkClients(config: ForkClientConfig): ForkClients {
  const transport = http(config.rpcUrl);
  const account: PrivateKeyAccount = privateKeyToAccount(config.privateKey);
  return {
    publicClient: createPublicClient({ chain: arbitrum, transport }),
    walletClient: createWalletClient({ account, chain: arbitrum, transport }),
    testClient: createTestClient({ chain: arbitrum, mode: 'anvil', transport }),
    sender: account.address as Address
  };
}
