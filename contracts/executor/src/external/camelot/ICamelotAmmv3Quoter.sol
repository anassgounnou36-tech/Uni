// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICamelotAmmv3Quoter {
    function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn, uint160 limitSqrtPrice)
        external
        returns (uint256 amountOut, uint16 observedFee);
}
