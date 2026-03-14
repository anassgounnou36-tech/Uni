// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library ExecutorTypes {
    struct RoutePlan {
        address tokenIn;
        address tokenOut;
        uint24 poolFee;
        uint256 minAmountOut;
    }
}
