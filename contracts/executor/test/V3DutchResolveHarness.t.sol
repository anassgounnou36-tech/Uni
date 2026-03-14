// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {V3DutchResolveHarness} from "./harness/V3DutchResolveHarness.sol";

contract V3DutchResolveHarnessTest {
    V3DutchResolveHarness private harness;

    constructor() {
        harness = new V3DutchResolveHarness();
    }

    function testResolveUsesBlockNumberishForDecay() public view {
        V3DutchResolveHarness.V3DutchOrder memory order = _baseOrder();
        V3DutchResolveHarness.ResolvedOrder memory atStart =
            harness.resolve(order, 1000, 1700000000, 100000000, address(0));
        V3DutchResolveHarness.ResolvedOrder memory later =
            harness.resolve(order, 1250, 1700000000, 100000000, address(0));

        require(atStart.input.amount == 1000000, "start input mismatch");
        require(later.input.amount < atStart.input.amount, "input should decay with blockNumberish");
        require(later.outputs[0].amount <= atStart.outputs[0].amount, "output should decay with blockNumberish");
    }

    function testResolveAppliesExclusivityOverrideForNonExclusiveFiller() public view {
        V3DutchResolveHarness.V3DutchOrder memory order = _baseOrder();
        order.cosignerData.exclusiveFiller = address(0x1234);
        order.cosignerData.exclusivityOverrideBps = 50;

        V3DutchResolveHarness.ResolvedOrder memory resolved =
            harness.resolve(order, 1000, 1700000000, 100000000, address(0x9999));

        require(resolved.outputs[0].amount == 1809000, "exclusive override mismatch");
    }

    function _baseOrder() private pure returns (V3DutchResolveHarness.V3DutchOrder memory order) {
        int256[] memory inputRelativeAmounts = new int256[](1);
        inputRelativeAmounts[0] = int256(100000);

        int256[] memory outputRelativeAmounts = new int256[](1);
        outputRelativeAmounts[0] = int256(200000);

        V3DutchResolveHarness.V3DutchOutput[] memory outputs = new V3DutchResolveHarness.V3DutchOutput[](1);
        outputs[0] = V3DutchResolveHarness.V3DutchOutput({
            token: address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48),
            startAmount: 1800000,
            curve: V3DutchResolveHarness.NonlinearDutchDecay({relativeBlocks: 500, relativeAmounts: outputRelativeAmounts}),
            recipient: address(0x1111),
            minAmount: 1500000,
            adjustmentPerGweiBaseFee: 2000
        });

        uint256[] memory outputAmounts = new uint256[](1);
        outputAmounts[0] = 0;

        order = V3DutchResolveHarness.V3DutchOrder({
            info: V3DutchResolveHarness.OrderInfo({
                reactor: address(0xB274d5F4b833b61B340b654d600A864fB604a87c),
                swapper: address(0x1111),
                nonce: 1,
                deadline: 2000000000,
                additionalValidationContract: address(0),
                additionalValidationData: ""
            }),
            cosigner: address(0x2222),
            startingBaseFee: 100000000,
            baseInput: V3DutchResolveHarness.V3DutchInput({
                token: address(0x82aF49447D8a07e3bd95BD0d56f35241523fBab1),
                startAmount: 1000000,
                curve: V3DutchResolveHarness.NonlinearDutchDecay({relativeBlocks: 500, relativeAmounts: inputRelativeAmounts}),
                maxAmount: 1300000,
                adjustmentPerGweiBaseFee: 1000
            }),
            baseOutputs: outputs,
            cosignerData: V3DutchResolveHarness.CosignerData({
                decayStartBlock: 1000,
                exclusiveFiller: address(0),
                exclusivityOverrideBps: 0,
                inputAmount: 0,
                outputAmounts: outputAmounts
            }),
            cosignature: ""
        });
    }
}
