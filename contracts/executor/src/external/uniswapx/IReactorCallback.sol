// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReactorStructs} from "./ReactorStructs.sol";

interface IReactorCallback {
    function reactorCallback(ReactorStructs.ResolvedOrder[] calldata resolvedOrders, bytes calldata callbackData)
        external;
}
