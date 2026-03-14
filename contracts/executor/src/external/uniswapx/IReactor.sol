// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReactorStructs} from "./ReactorStructs.sol";

interface IReactor {
    function execute(ReactorStructs.SignedOrder calldata order) external;

    function executeWithCallback(ReactorStructs.SignedOrder calldata order, bytes calldata callbackData) external;

    function executeBatch(ReactorStructs.SignedOrder[] calldata orders) external;

    function executeBatchWithCallback(ReactorStructs.SignedOrder[] calldata orders, bytes calldata callbackData)
        external;
}
