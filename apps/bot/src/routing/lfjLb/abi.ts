import { parseAbi } from 'viem';

export const LFJ_LB_FACTORY_ABI = parseAbi([
  'function getLBPairInformation(address tokenX, address tokenY, uint256 binStep) view returns (address lbPair, uint256 binStepOut, uint16 createdByOwner, bool ignoredForRouting)'
]);

export const LFJ_LB_QUOTER_ABI = parseAbi([
  'function findBestPathFromAmountIn((uint256[] pairBinSteps,uint8[] versions,address[] tokenPath) route, uint128 amountIn) view returns (uint128 amountOut, address[] virtualAmountsWithoutSlippage, uint256[] fees, uint256[] binSteps, uint256[] versions)',
  'function findBestPathFromAmountOut((uint256[] pairBinSteps,uint8[] versions,address[] tokenPath) route, uint128 amountOut) view returns (uint128 amountIn, address[] virtualAmountsWithoutSlippage, uint256[] fees, uint256[] binSteps, uint256[] versions)'
]);
