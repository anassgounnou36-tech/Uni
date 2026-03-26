// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISettlementAdapter {
    struct LfjPath {
        address[] tokenPath;
        uint256[] pairBinSteps;
        uint8[] versions;
    }

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

    function executeExactOutputSingle(
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 targetAmountOut,
        uint256 maxAmountIn,
        uint160 limitSqrtPriceX96,
        address recipient
    ) external returns (uint256 amountInUsed);

    function executeExactOutputPath(bytes calldata path, uint256 targetAmountOut, uint256 maxAmountIn, address recipient)
        external
        returns (uint256 amountInUsed);

    function executeLfjExactInputPath(
        LfjPath calldata path,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external returns (uint256 amountOut);

    function executeLfjExactOutputPath(
        LfjPath calldata path,
        uint256 targetAmountOut,
        uint256 maxAmountIn,
        address recipient
    ) external returns (uint256 amountInUsed);
}
