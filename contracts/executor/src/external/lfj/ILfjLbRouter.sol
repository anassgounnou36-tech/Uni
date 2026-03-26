// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILfjLbRouter {
    struct Path {
        uint256[] pairBinSteps;
        uint8[] versions;
        address[] tokenPath;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Path calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256 amountOut);

    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        Path calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256 amountIn);
}
