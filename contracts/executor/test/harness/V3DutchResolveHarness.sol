// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract V3DutchResolveHarness {
    error InvalidCosignerInput();
    error InvalidCosignerOutput();
    error DeadlineReached();
    error NoExclusiveOverride();
    error InvalidDecayCurve();

    uint256 private constant BPS = 10_000;

    struct NonlinearDutchDecay {
        uint256 relativeBlocks;
        int256[] relativeAmounts;
    }

    struct V3DutchInput {
        address token;
        uint256 startAmount;
        NonlinearDutchDecay curve;
        uint256 maxAmount;
        uint256 adjustmentPerGweiBaseFee;
    }

    struct V3DutchOutput {
        address token;
        uint256 startAmount;
        NonlinearDutchDecay curve;
        address recipient;
        uint256 minAmount;
        uint256 adjustmentPerGweiBaseFee;
    }

    struct CosignerData {
        uint256 decayStartBlock;
        address exclusiveFiller;
        uint256 exclusivityOverrideBps;
        uint256 inputAmount;
        uint256[] outputAmounts;
    }

    struct OrderInfo {
        address reactor;
        address swapper;
        uint256 nonce;
        uint256 deadline;
        address additionalValidationContract;
        bytes additionalValidationData;
    }

    struct V3DutchOrder {
        OrderInfo info;
        address cosigner;
        uint256 startingBaseFee;
        V3DutchInput baseInput;
        V3DutchOutput[] baseOutputs;
        CosignerData cosignerData;
        bytes cosignature;
    }

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
        OrderInfo info;
        ResolvedInput input;
        ResolvedOutput[] outputs;
    }

    function resolve(
        V3DutchOrder memory order,
        uint256 blockNumberish,
        uint256 timestamp,
        uint256 basefee,
        address filler
    ) external pure returns (ResolvedOrder memory resolved) {
        if (order.info.deadline < timestamp) revert DeadlineReached();

        _applyCosignerOverrides(order);
        _applyGas(order, basefee);

        resolved.info = order.info;
        resolved.input = ResolvedInput({
            token: order.baseInput.token,
            amount: _decayInput(order.baseInput, order.cosignerData.decayStartBlock, blockNumberish),
            maxAmount: order.baseInput.maxAmount
        });

        resolved.outputs = new ResolvedOutput[](order.baseOutputs.length);
        for (uint256 i = 0; i < order.baseOutputs.length; i++) {
            V3DutchOutput memory output = order.baseOutputs[i];
            resolved.outputs[i] = ResolvedOutput({
                token: output.token,
                amount: _decayOutput(output, order.cosignerData.decayStartBlock, blockNumberish),
                recipient: output.recipient
            });
        }

        if (
            order.cosignerData.exclusiveFiller != address(0)
                && blockNumberish <= order.cosignerData.decayStartBlock
                && order.cosignerData.exclusiveFiller != filler
        ) {
            if (order.cosignerData.exclusivityOverrideBps == 0) revert NoExclusiveOverride();
            uint256 scaledBps = BPS + order.cosignerData.exclusivityOverrideBps;
            for (uint256 i = 0; i < resolved.outputs.length; i++) {
                resolved.outputs[i].amount = _mulDivUp(resolved.outputs[i].amount, scaledBps, BPS);
            }
        }
    }

    function _applyCosignerOverrides(V3DutchOrder memory order) internal pure {
        if (order.cosignerData.inputAmount != 0) {
            if (order.cosignerData.inputAmount > order.baseInput.startAmount) revert InvalidCosignerInput();
            order.baseInput.startAmount = order.cosignerData.inputAmount;
        }

        if (order.cosignerData.outputAmounts.length != order.baseOutputs.length) revert InvalidCosignerOutput();

        for (uint256 i = 0; i < order.baseOutputs.length; i++) {
            uint256 outputAmount = order.cosignerData.outputAmounts[i];
            if (outputAmount != 0) {
                if (outputAmount < order.baseOutputs[i].startAmount) revert InvalidCosignerOutput();
                order.baseOutputs[i].startAmount = outputAmount;
            }
        }
    }

    function _applyGas(V3DutchOrder memory order, uint256 basefee) internal pure {
        int256 gasDeltaWei = int256(basefee) - int256(order.startingBaseFee);

        if (order.baseInput.adjustmentPerGweiBaseFee != 0) {
            int256 inputDelta = _computeDelta(order.baseInput.adjustmentPerGweiBaseFee, gasDeltaWei);
            order.baseInput.startAmount = _boundedAdd(order.baseInput.startAmount, inputDelta, 0, order.baseInput.maxAmount);
        }

        for (uint256 i = 0; i < order.baseOutputs.length; i++) {
            V3DutchOutput memory output = order.baseOutputs[i];
            if (output.adjustmentPerGweiBaseFee != 0) {
                int256 outputDelta = _computeDelta(output.adjustmentPerGweiBaseFee, gasDeltaWei);
                order.baseOutputs[i].startAmount = _boundedSub(output.startAmount, outputDelta, output.minAmount, type(uint256).max);
            }
        }
    }

    function _computeDelta(uint256 adjustmentPerGweiBaseFee, int256 gasDeltaWei) internal pure returns (int256) {
        if (gasDeltaWei >= 0) {
            return int256(_mulDivDown(adjustmentPerGweiBaseFee, uint256(gasDeltaWei), 1 gwei));
        }
        return -int256(_mulDivUp(adjustmentPerGweiBaseFee, uint256(-gasDeltaWei), 1 gwei));
    }

    function _decayInput(V3DutchInput memory input, uint256 decayStartBlock, uint256 blockNumberish) internal pure returns (uint256) {
        return _decayAmount(input.curve, input.startAmount, decayStartBlock, blockNumberish, 0, input.maxAmount, true);
    }

    function _decayOutput(V3DutchOutput memory output, uint256 decayStartBlock, uint256 blockNumberish)
        internal
        pure
        returns (uint256)
    {
        return _decayAmount(output.curve, output.startAmount, decayStartBlock, blockNumberish, output.minAmount, type(uint256).max, false);
    }

    function _decayAmount(
        NonlinearDutchDecay memory curve,
        uint256 startAmount,
        uint256 decayStartBlock,
        uint256 blockNumberish,
        uint256 minAmount,
        uint256 maxAmount,
        bool isInput
    ) internal pure returns (uint256) {
        if (curve.relativeAmounts.length > 16) revert InvalidDecayCurve();
        if (decayStartBlock >= blockNumberish || curve.relativeAmounts.length == 0) {
            return _bound(startAmount, minAmount, maxAmount);
        }

        uint256 blockDelta = blockNumberish - decayStartBlock;
        if (blockDelta > type(uint16).max) blockDelta = type(uint16).max;

        (uint256 startPoint, uint256 endPoint, int256 relStartAmount, int256 relEndAmount) = _locateCurvePosition(curve, uint16(blockDelta));
        int256 curveDelta = isInput
            ? _linearInputDecay(startPoint, endPoint, blockDelta, relStartAmount, relEndAmount)
            : _linearOutputDecay(startPoint, endPoint, blockDelta, relStartAmount, relEndAmount);

        return _boundedSub(startAmount, curveDelta, minAmount, maxAmount);
    }

    function _locateCurvePosition(NonlinearDutchDecay memory curve, uint16 currentRelativeBlock)
        internal
        pure
        returns (uint16 startPoint, uint16 endPoint, int256 startAmount, int256 endAmount)
    {
        uint16 firstPoint = _packedUint16(curve.relativeBlocks, 0);
        if (firstPoint >= currentRelativeBlock) {
            return (0, firstPoint, 0, curve.relativeAmounts[0]);
        }

        uint16 lastCurveIndex = uint16(curve.relativeAmounts.length) - 1;
        for (uint16 i = 1; i <= lastCurveIndex; i++) {
            uint16 point = _packedUint16(curve.relativeBlocks, i);
            if (point >= currentRelativeBlock) {
                return (
                    _packedUint16(curve.relativeBlocks, i - 1),
                    point,
                    curve.relativeAmounts[i - 1],
                    curve.relativeAmounts[i]
                );
            }
        }

        uint16 lastPoint = _packedUint16(curve.relativeBlocks, lastCurveIndex);
        int256 lastAmount = curve.relativeAmounts[lastCurveIndex];
        return (lastPoint, lastPoint, lastAmount, lastAmount);
    }

    function _linearInputDecay(uint256 startPoint, uint256 endPoint, uint256 currentPoint, int256 startAmount, int256 endAmount)
        internal
        pure
        returns (int256)
    {
        if (currentPoint >= endPoint) return endAmount;
        uint256 elapsed = currentPoint - startPoint;
        uint256 duration = endPoint - startPoint;
        int256 delta = endAmount < startAmount
            ? -int256(_mulDivDown(uint256(startAmount - endAmount), elapsed, duration))
            : int256(_mulDivUp(uint256(endAmount - startAmount), elapsed, duration));
        return startAmount + delta;
    }

    function _linearOutputDecay(uint256 startPoint, uint256 endPoint, uint256 currentPoint, int256 startAmount, int256 endAmount)
        internal
        pure
        returns (int256)
    {
        if (currentPoint >= endPoint) return endAmount;
        uint256 elapsed = currentPoint - startPoint;
        uint256 duration = endPoint - startPoint;
        int256 delta = endAmount < startAmount
            ? -int256(_mulDivUp(uint256(startAmount - endAmount), elapsed, duration))
            : int256(_mulDivDown(uint256(endAmount - startAmount), elapsed, duration));
        return startAmount + delta;
    }

    function _packedUint16(uint256 packedData, uint256 n) internal pure returns (uint16) {
        return uint16(packedData >> (n * 16));
    }

    function _mulDivDown(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256) {
        return a * b / denominator;
    }

    function _mulDivUp(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256) {
        return (a * b + denominator - 1) / denominator;
    }

    function _bound(uint256 value, uint256 minValue, uint256 maxValue) internal pure returns (uint256) {
        if (value < minValue) return minValue;
        if (value > maxValue) return maxValue;
        return value;
    }

    function _boundedAdd(uint256 a, int256 b, uint256 minValue, uint256 maxValue) internal pure returns (uint256) {
        return _boundedSub(a, -b, minValue, maxValue);
    }

    function _boundedSub(uint256 a, int256 b, uint256 minValue, uint256 maxValue) internal pure returns (uint256) {
        uint256 result;
        if (b < 0) {
            uint256 absB = uint256(-b);
            if (type(uint256).max - absB < a) {
                return maxValue;
            }
            result = a + absB;
        } else {
            if (a < uint256(b)) {
                return minValue;
            }
            result = a - uint256(b);
        }
        return _bound(result, minValue, maxValue);
    }
}
