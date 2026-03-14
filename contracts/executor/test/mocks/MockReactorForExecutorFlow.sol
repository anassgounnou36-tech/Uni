// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IReactor} from "../../src/external/uniswapx/IReactor.sol";
import {IReactorCallback} from "../../src/external/uniswapx/IReactorCallback.sol";
import {ReactorStructs} from "../../src/external/uniswapx/ReactorStructs.sol";

error MockReactorForcedRevertAfterCallback();

contract MockReactorForExecutorFlow is IReactor {
    address public lastCaller;
    bytes public lastOrderBytes;
    bytes public lastSigBytes;
    bytes public lastCallbackData;
    bool public shouldCallback = true;
    bool public shouldRevertAfterCallback = false;
    ReactorStructs.ResolvedOrder[] private configuredResolvedOrders;

    function setShouldCallback(bool value) external {
        shouldCallback = value;
    }

    function setShouldRevertAfterCallback(bool value) external {
        shouldRevertAfterCallback = value;
    }

    function clearConfiguredResolvedOrders() external {
        delete configuredResolvedOrders;
    }

    function pushConfiguredResolvedOrder(ReactorStructs.ResolvedOrder calldata order) external {
        configuredResolvedOrders.push();
        ReactorStructs.ResolvedOrder storage stored = configuredResolvedOrders[configuredResolvedOrders.length - 1];
        stored.info = order.info;
        stored.input = order.input;
        stored.sig = order.sig;
        stored.hash = order.hash;
        for (uint256 i = 0; i < order.outputs.length; i++) {
            stored.outputs.push(order.outputs[i]);
        }
    }

    function execute(ReactorStructs.SignedOrder calldata) external {}

    function executeWithCallback(ReactorStructs.SignedOrder calldata order, bytes calldata callbackData) external {
        lastCaller = msg.sender;
        lastOrderBytes = order.order;
        lastSigBytes = order.sig;
        lastCallbackData = callbackData;

        if (shouldCallback) {
            ReactorStructs.ResolvedOrder[] memory resolvedOrdersMemory =
                new ReactorStructs.ResolvedOrder[](configuredResolvedOrders.length);

            for (uint256 i = 0; i < configuredResolvedOrders.length; i++) {
                ReactorStructs.ResolvedOrder storage stored = configuredResolvedOrders[i];
                ReactorStructs.OutputToken[] memory outputs = new ReactorStructs.OutputToken[](stored.outputs.length);
                for (uint256 j = 0; j < stored.outputs.length; j++) {
                    outputs[j] = stored.outputs[j];
                }
                resolvedOrdersMemory[i] = ReactorStructs.ResolvedOrder({
                    info: stored.info,
                    input: stored.input,
                    outputs: outputs,
                    sig: stored.sig,
                    hash: stored.hash
                });
            }

            IReactorCallback(msg.sender).reactorCallback(resolvedOrdersMemory, callbackData);
        }

        if (shouldRevertAfterCallback) {
            revert MockReactorForcedRevertAfterCallback();
        }
    }

    function executeBatch(ReactorStructs.SignedOrder[] calldata) external {}

    function executeBatchWithCallback(ReactorStructs.SignedOrder[] calldata, bytes calldata) external {}
}
