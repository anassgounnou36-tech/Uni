// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library ExecutorTypes {
    struct ResolvedInput {
        address token;
        uint256 amount;
        uint256 maxAmount;
    }

    struct ResolvedOutput {
        address token;
        uint256 amount;
        address recipient;
    }

    struct ResolvedOrder {
        bytes info;
        ResolvedInput input;
        ResolvedOutput[] outputs;
    }

    struct RoutePlan {
        address tokenIn;
        address tokenOut;
        uint24 poolFee;
        uint256 minAmountOut;
    }
}
