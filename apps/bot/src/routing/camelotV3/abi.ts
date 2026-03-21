import { parseAbi } from 'viem';

export const CAMELOT_AMMV3_FACTORY_ABI = parseAbi([
  'function poolByPair(address tokenA, address tokenB) view returns (address pool)'
]);

export const CAMELOT_AMMV3_QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint160 limitSqrtPrice) returns (uint256 amountOut, uint16 observedFee)',
  'function quoteExactOutputSingle(address tokenIn, address tokenOut, uint256 amountOut, uint160 limitSqrtPrice) returns (uint256 amountIn, uint16 observedFee)',
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut)',
  'function quoteExactOutput(bytes path, uint256 amountOut) returns (uint256 amountIn)'
]);

export const CAMELOT_AMMV3_ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 limitSqrtPrice)) payable returns (uint256 amountOut)',
  'function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256 amountOut)'
]);
