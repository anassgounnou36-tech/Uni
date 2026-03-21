// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISettlementAdapter {
    function executeExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 minAmountOut,
        uint160 limitSqrtPriceX96,
        address recipient
    ) external returns (uint256 amountOut);

    function executeExactInputPath(bytes calldata path, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        returns (uint256 amountOut);
}
