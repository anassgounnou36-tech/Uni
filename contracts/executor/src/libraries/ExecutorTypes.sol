// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library ExecutorTypes {
    uint8 internal constant VENUE_UNISWAP_V3 = 0;
    uint8 internal constant VENUE_CAMELOT_AMMV3 = 1;
    uint8 internal constant PATH_KIND_DIRECT = 0;
    uint8 internal constant PATH_KIND_TWO_HOP = 1;
    uint8 internal constant PATH_DIRECTION_FORWARD = 0;
    uint8 internal constant PATH_DIRECTION_REVERSE = 1;

    struct RoutePlan {
        uint8 venue;
        uint8 executionMode;
        uint8 pathKind;
        uint8 hopCount;
        uint8 pathDirection;
        address tokenIn;
        address tokenOut;
        uint24 uniPoolFee;
        bytes encodedPath;
        uint160 limitSqrtPriceX96;
        uint256 minAmountOut;
        uint256 targetOutput;
        uint256 maxAmountIn;
    }
}
