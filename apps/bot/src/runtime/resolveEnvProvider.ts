import type { Address, PublicClient } from 'viem';

const ARBITRUM_ONE_CHAIN_ID = 42161n;
const ARBSYS_ADDRESS: Address = '0x0000000000000000000000000000000000000064';
const ARBSYS_ABI = [
  {
    type: 'function',
    name: 'arbBlockNumber',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  }
] as const;

export type ResolveEnvSnapshot = {
  chainId: bigint;
  blockNumber: bigint;
  blockNumberish: bigint;
  timestamp: bigint;
  baseFeePerGas: bigint;
  sampledAtMs: number;
};

export interface ResolveEnvProvider {
  getCurrent(): Promise<ResolveEnvSnapshot>;
}

export class ViemResolveEnvProvider implements ResolveEnvProvider {
  constructor(private readonly client: PublicClient) {}

  async getCurrent(): Promise<ResolveEnvSnapshot> {
    const [chainId, block] = await Promise.all([this.client.getChainId(), this.client.getBlock()]);
    const chainIdBigInt = BigInt(chainId);
    const blockNumber = block.number ?? 0n;
    let blockNumberish = blockNumber;
    if (chainIdBigInt === ARBITRUM_ONE_CHAIN_ID) {
      try {
        blockNumberish = await this.client.readContract({
          address: ARBSYS_ADDRESS,
          abi: ARBSYS_ABI,
          functionName: 'arbBlockNumber'
        });
      } catch {
        blockNumberish = blockNumber;
      }
    }
    return {
      chainId: chainIdBigInt,
      blockNumber,
      blockNumberish,
      timestamp: block.timestamp,
      baseFeePerGas: block.baseFeePerGas ?? 0n,
      sampledAtMs: Date.now()
    };
  }
}
