import type { Address, PublicClient } from 'viem';
import { UNIV3_FACTORY_ABI, UNIV3_POOL_ABI } from './abi.js';
import type { UniV3FeeTier } from './types.js';

export type DiscoveredPool = {
  tokenIn: Address;
  tokenOut: Address;
  feeTier: UniV3FeeTier;
  pool: Address;
  liquidity: bigint;
  sqrtPriceX96: bigint;
};

export type PoolDiscoveryStatus = 'POOL_MISSING' | 'POOL_PRESENT' | 'POOL_INACTIVE';
export type PoolDiscoveryResult = {
  status: PoolDiscoveryStatus;
  pool?: DiscoveredPool;
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export async function discoverPool(
  client: PublicClient,
  factory: Address,
  tokenIn: Address,
  tokenOut: Address,
  feeTier: UniV3FeeTier
): Promise<DiscoveredPool | undefined> {
  const discovered = await discoverPoolWithStatus(client, factory, tokenIn, tokenOut, feeTier);
  return discovered.pool;
}

export async function discoverPoolWithStatus(
  client: PublicClient,
  factory: Address,
  tokenIn: Address,
  tokenOut: Address,
  feeTier: UniV3FeeTier
): Promise<PoolDiscoveryResult> {
  const pool = await client.readContract({
    address: factory,
    abi: UNIV3_FACTORY_ABI,
    functionName: 'getPool',
    args: [tokenIn, tokenOut, feeTier]
  });

  if (pool.toLowerCase() === ZERO_ADDRESS) {
    return { status: 'POOL_MISSING' };
  }

  const [liquidity, slot0] = await Promise.all([
    client.readContract({
      address: pool,
      abi: UNIV3_POOL_ABI,
      functionName: 'liquidity'
    }),
    client.readContract({
      address: pool,
      abi: UNIV3_POOL_ABI,
      functionName: 'slot0'
    })
  ]);

  const sqrtPriceX96 = slot0[0];
  if (liquidity === 0n || sqrtPriceX96 === 0n) {
    return { status: 'POOL_INACTIVE' };
  }

  return {
    status: 'POOL_PRESENT',
    pool: {
      tokenIn,
      tokenOut,
      feeTier,
      pool,
      liquidity,
      sqrtPriceX96
    }
  };
}
