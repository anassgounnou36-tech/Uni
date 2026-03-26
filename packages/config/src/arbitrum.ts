import type { Address } from 'viem';

/**
 * Locked Arbitrum One protocol addresses and endpoints.
 * Sources: Uniswap protocol deployment docs and Arbitrum public infrastructure docs.
 */
export const UNISWAPX_DUTCH_V3_REACTOR: Address = '0xB274d5F4b833b61B340b654d600A864fB604a87c';
export const UNISWAPX_ORDER_QUOTER: Address = '0x88440407634F89873c5D9439987Ac4BE9725fea8';
export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const UNIV3_FACTORY: Address = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
export const UNIV3_QUOTER_V2: Address = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
export const UNIV3_SWAP_ROUTER_02: Address = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
export const CAMELOT_AMMV3_FACTORY: Address = '0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B';
export const CAMELOT_AMMV3_QUOTER: Address = '0x0Fc73040b26E9bC8514fA028D998E73A254Fa76E';
export const CAMELOT_AMMV3_SWAP_ROUTER: Address = '0x1F721E2E82F6676FCE4eA07A5958cF098D339e18';
export const LFJ_LB_ROUTER: Address = '0xb4315e873dbcf96ffd0acd8ea43f689d8c20fb30';
export const LFJ_LB_QUOTER: Address = '0x64b57f4249aa99a812212cee7daefedc40b203cd';
export const LFJ_LB_FACTORY: Address = '0x8e42f2f4101563bf679975178e880fd87d3efd4e';
export const UNIVERSAL_ROUTER: Address = '0xa51afafe0263b40edaef0df8781ea9aa03e381a3';

export const ARB1_SEQUENCER_ENDPOINT = 'https://arb1-sequencer.arbitrum.io/rpc';
export const TIMEBOOST_AUCTION_CONTRACT: Address = '0x5fcb496a31b7AE91e7c9078Ec662bd7A55cd3079';
export const TIMEBOOST_AUCTIONEER = 'https://arb1-auctioneer.arbitrum.io/';
export const UNISWAPX_ORDERS_API = 'https://api.uniswap.org/v2/orders';

export type UniswapXDutchReactorVersion = 'dutch_v3' | 'dutch_v2_deprecated_unsupported';

/**
 * Dutch_V2 is intentionally marked as deprecated and unsupported on Arbitrum.
 * Keep this type marker so integrations cannot accidentally rely on it.
 */
export const ARBITRUM_DUTCH_REACTOR_SUPPORT: Record<UniswapXDutchReactorVersion, 'supported' | 'unsupported'>
  = {
    dutch_v3: 'supported',
    dutch_v2_deprecated_unsupported: 'unsupported'
  };
