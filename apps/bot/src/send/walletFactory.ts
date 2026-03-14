import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http, type Chain, type PrivateKeyAccount, type WalletClient } from 'viem';

export type WalletFactoryConfig = {
  privateKey: `0x${string}`;
  rpcUrl: string;
  chain: Chain;
};

export function createSigningWallet(config: WalletFactoryConfig): { walletClient: WalletClient; account: PrivateKeyAccount } {
  const account = privateKeyToAccount(config.privateKey);
  return {
    account,
    walletClient: createWalletClient({
      account,
      chain: config.chain,
      transport: http(config.rpcUrl)
    })
  };
}
