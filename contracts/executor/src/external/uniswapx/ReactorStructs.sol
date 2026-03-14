// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library ReactorStructs {
    struct SignedOrder {
        bytes order;
        bytes sig;
    }

    struct OrderInfo {
        address reactor;
        address swapper;
        uint256 nonce;
        uint256 deadline;
        address additionalValidationContract;
        bytes additionalValidationData;
    }

    struct InputToken {
        address token;
        uint256 amount;
        uint256 maxAmount;
    }

    struct OutputToken {
        address token;
        uint256 amount;
        address recipient;
    }

    struct ResolvedOrder {
        OrderInfo info;
        InputToken input;
        OutputToken[] outputs;
        bytes sig;
        bytes32 hash;
    }
}
