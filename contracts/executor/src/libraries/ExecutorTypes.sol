// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library ExecutorTypes {
    uint8 internal constant VENUE_UNISWAP_V3 = 0;
    uint8 internal constant VENUE_CAMELOT_AMMV3 = 1;

    struct RoutePlan {
        uint8 venue;
        address tokenIn;
        address tokenOut;
        uint24 uniPoolFee;
        uint160 limitSqrtPriceX96;
        uint256 minAmountOut;
    }
}
