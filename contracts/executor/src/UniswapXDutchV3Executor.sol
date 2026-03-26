// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISettlementAdapter} from "./interfaces/ISettlementAdapter.sol";
import {IReactor} from "./external/uniswapx/IReactor.sol";
import {IReactorCallback} from "./external/uniswapx/IReactorCallback.sol";
import {ReactorStructs} from "./external/uniswapx/ReactorStructs.sol";
import {ExecutorErrors} from "./libraries/ExecutorErrors.sol";
import {ExecutorTypes} from "./libraries/ExecutorTypes.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract UniswapXDutchV3Executor is IReactorCallback {
    address public immutable REACTOR;
    address public immutable UNISWAP_V3_ADAPTER;
    address public immutable CAMELOT_AMMV3_ADAPTER;
    address public immutable LFJ_LB_ADAPTER;
    address public immutable TREASURY;

    address public owner;
    bool public paused;
    uint256 private _entered;

    event RealizedProfit(address indexed token, uint256 requiredAmount, uint256 settledAmount, uint256 profitAmount);
    event PausedSet(bool isPaused);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert ExecutorErrors.NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_entered == 1) revert ExecutorErrors.Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    modifier whenNotPaused() {
        if (paused) revert ExecutorErrors.Paused();
        _;
    }

  constructor(
      address reactor_,
      address uniswapV3Adapter_,
      address camelotAmmv3Adapter_,
      address lfjLbAdapter_,
      address treasury_,
      address owner_
  )
  {
      if (
            reactor_ == address(0) || uniswapV3Adapter_ == address(0) || camelotAmmv3Adapter_ == address(0)
                || lfjLbAdapter_ == address(0)
                || treasury_ == address(0)
                || owner_ == address(0)
        ) {
            revert ExecutorErrors.ZeroAddress();
        }
        REACTOR = reactor_;
        UNISWAP_V3_ADAPTER = uniswapV3Adapter_;
        CAMELOT_AMMV3_ADAPTER = camelotAmmv3Adapter_;
        LFJ_LB_ADAPTER = lfjLbAdapter_;
        TREASURY = treasury_;
        owner = owner_;
    }

    /// @dev `execute` intentionally does not take the callback reentrancy lock.
    /// The valid flow is external caller -> execute -> reactor -> reactorCallback in the same transaction.
    function execute(ReactorStructs.SignedOrder calldata order, bytes calldata callbackData) external whenNotPaused {
        IReactor(REACTOR).executeWithCallback(order, callbackData);
    }

    function reactorCallback(ReactorStructs.ResolvedOrder[] calldata resolvedOrders, bytes calldata callbackData)
        external
        whenNotPaused
        nonReentrant
    {
        if (msg.sender != REACTOR) revert ExecutorErrors.UnauthorizedCaller();
        if (resolvedOrders.length != 1) revert ExecutorErrors.UnsupportedOrderShape();

        ReactorStructs.ResolvedOrder calldata order = resolvedOrders[0];
        ExecutorTypes.RoutePlan memory route = abi.decode(callbackData, (ExecutorTypes.RoutePlan));
        if (route.tokenIn == address(0) || route.tokenOut == address(0)) {
            revert ExecutorErrors.BadRoute();
        }
        if (route.tokenIn == route.tokenOut) revert ExecutorErrors.BadRoute();
        if (order.input.token != route.tokenIn) revert ExecutorErrors.TokenMismatch();

        address settlementAdapter = _resolveSettlementAdapter(route);

        uint256 outputCount = order.outputs.length;
        if (outputCount == 0) revert ExecutorErrors.UnsupportedOutputShape();

        uint256 requiredOutput;
        for (uint256 i = 0; i < outputCount; i++) {
            if (order.outputs[i].token != route.tokenOut) revert ExecutorErrors.UnsupportedOutputShape();
            requiredOutput += order.outputs[i].amount;
        }

        uint256 amountIn = order.input.amount;
        if (IERC20(route.tokenIn).balanceOf(address(this)) < amountIn) revert ExecutorErrors.InsufficientInput();
        uint256 executionMode = route.executionMode;
        uint256 settledOutput;
        if (executionMode == 1) {
            uint256 targetOutput = route.targetOutput;
            uint256 maxAmountIn = route.maxAmountIn;
            if (targetOutput == 0 || maxAmountIn == 0 || maxAmountIn > amountIn) revert ExecutorErrors.BadRoute();
            _safeTransfer(route.tokenIn, settlementAdapter, maxAmountIn);
            uint256 usedAmountIn;
            if (route.venue == ExecutorTypes.VENUE_LFJ_LB) {
                ISettlementAdapter.LfjPath memory lfjPath = _toLfjPath(route);
                usedAmountIn = ISettlementAdapter(settlementAdapter).executeLfjExactOutputPath(
                    lfjPath,
                    targetOutput,
                    maxAmountIn,
                    address(this)
                );
            } else if (route.pathKind == ExecutorTypes.PATH_KIND_DIRECT) {
                usedAmountIn = ISettlementAdapter(settlementAdapter).executeExactOutputSingle(
                    route.tokenIn,
                    route.tokenOut,
                    route.uniPoolFee,
                    targetOutput,
                    maxAmountIn,
                    route.limitSqrtPriceX96,
                    address(this)
                );
            } else if (route.pathKind == ExecutorTypes.PATH_KIND_TWO_HOP) {
                if (route.hopCount != 2 || route.encodedPath.length == 0) revert ExecutorErrors.BadRoute();
                _validateBoundedPath(route);
                usedAmountIn =
                    ISettlementAdapter(settlementAdapter).executeExactOutputPath(route.encodedPath, targetOutput, maxAmountIn, address(this));
            } else {
                revert ExecutorErrors.BadRoute();
            }
            if (usedAmountIn > maxAmountIn) revert ExecutorErrors.ExactOutputExceededMaxInput();
            settledOutput = targetOutput;
        } else {
            _safeTransfer(route.tokenIn, settlementAdapter, amountIn);
            uint256 minimumOutput = route.minAmountOut > requiredOutput ? route.minAmountOut : requiredOutput;
            if (route.venue == ExecutorTypes.VENUE_LFJ_LB) {
                ISettlementAdapter.LfjPath memory lfjPath = _toLfjPath(route);
                settledOutput = ISettlementAdapter(settlementAdapter).executeLfjExactInputPath(
                    lfjPath,
                    amountIn,
                    minimumOutput,
                    address(this)
                );
            } else if (route.pathKind == ExecutorTypes.PATH_KIND_DIRECT) {
                settledOutput = ISettlementAdapter(settlementAdapter).executeExactInputSingle(
                    route.tokenIn,
                    route.tokenOut,
                    route.uniPoolFee,
                    amountIn,
                    minimumOutput,
                    route.limitSqrtPriceX96,
                    address(this)
                );
            } else if (route.pathKind == ExecutorTypes.PATH_KIND_TWO_HOP) {
                if (route.hopCount != 2 || route.encodedPath.length == 0) revert ExecutorErrors.BadRoute();
                _validateBoundedPath(route);
                settledOutput =
                    ISettlementAdapter(settlementAdapter).executeExactInputPath(route.encodedPath, amountIn, minimumOutput, address(this));
            } else {
                revert ExecutorErrors.BadRoute();
            }
            if (settledOutput < minimumOutput) revert ExecutorErrors.SlippageExceeded();
        }

        uint256 outputBalance = IERC20(route.tokenOut).balanceOf(address(this));
        if (outputBalance < requiredOutput) revert ExecutorErrors.InsufficientOutput();

        _safeApprove(route.tokenOut, REACTOR, 0);
        _safeApprove(route.tokenOut, REACTOR, requiredOutput);

        uint256 profit = outputBalance - requiredOutput;
        if (profit > 0) _safeTransfer(route.tokenOut, TREASURY, profit);

        emit RealizedProfit(route.tokenOut, requiredOutput, settledOutput, profit);
    }

    function setPaused(bool isPaused) external onlyOwner {
        paused = isPaused;
        emit PausedSet(isPaused);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ExecutorErrors.ZeroAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (!paused) revert ExecutorErrors.NotPaused();
        if (token == address(0) || to == address(0)) revert ExecutorErrors.ZeroAddress();
        _safeTransfer(token, to, amount);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ExecutorErrors.TokenTransferFailed();
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ExecutorErrors.TokenApprovalFailed();
    }

    function _resolveSettlementAdapter(ExecutorTypes.RoutePlan memory route) private view returns (address) {
        if (route.hopCount == 0 || route.hopCount > 2) revert ExecutorErrors.BadRoute();
        if (route.venue == ExecutorTypes.VENUE_UNISWAP_V3) {
            if (route.pathKind == ExecutorTypes.PATH_KIND_DIRECT && route.uniPoolFee == 0) revert ExecutorErrors.BadRoute();
            return UNISWAP_V3_ADAPTER;
        }
        if (route.venue == ExecutorTypes.VENUE_CAMELOT_AMMV3) {
            if (route.pathKind == ExecutorTypes.PATH_KIND_DIRECT && route.uniPoolFee != 0) revert ExecutorErrors.BadRoute();
            return CAMELOT_AMMV3_ADAPTER;
        }
        if (route.venue == ExecutorTypes.VENUE_LFJ_LB) {
            _validateLfjPath(route);
            return LFJ_LB_ADAPTER;
        }
        revert ExecutorErrors.BadRoute();
    }

    function _validateLfjPath(ExecutorTypes.RoutePlan memory route) private pure {
        if (route.hopCount == 0 || route.hopCount > 2) revert ExecutorErrors.BadRoute();
        if (route.lfjTokenPath.length != route.hopCount + 1) revert ExecutorErrors.BadRoute();
        if (route.lfjBinSteps.length != route.hopCount) revert ExecutorErrors.BadRoute();
        if (route.lfjVersions.length != route.hopCount) revert ExecutorErrors.BadRoute();
        if (route.lfjTokenPath[0] != route.tokenIn || route.lfjTokenPath[route.lfjTokenPath.length - 1] != route.tokenOut) {
            revert ExecutorErrors.BadRoute();
        }
    }

    function _toLfjPath(ExecutorTypes.RoutePlan memory route) private pure returns (ISettlementAdapter.LfjPath memory path) {
        _validateLfjPath(route);
        path = ISettlementAdapter.LfjPath({
            tokenPath: route.lfjTokenPath,
            pairBinSteps: route.lfjBinSteps,
            versions: route.lfjVersions
        });
    }

    function _validateBoundedPath(ExecutorTypes.RoutePlan memory route) private pure {
        bytes memory path = route.encodedPath;
        // Encoded path format is token(20) + N * (fee(3) + token(20)).
        if (path.length <= 20 || ((path.length - 20) % 23) != 0) revert ExecutorErrors.BadRoute();
        uint256 hops = (path.length - 20) / 23;
        if (hops == 0 || hops > 2 || hops != route.hopCount) revert ExecutorErrors.BadRoute();
        if (route.executionMode == 0 && route.pathDirection != ExecutorTypes.PATH_DIRECTION_FORWARD) {
            revert ExecutorErrors.BadRoute();
        }
        if (route.executionMode == 1 && route.pathDirection != ExecutorTypes.PATH_DIRECTION_REVERSE) {
            revert ExecutorErrors.BadRoute();
        }
        address start;
        address finish;
        assembly {
            start := shr(96, mload(add(path, 32)))
            finish := shr(96, mload(add(add(path, 32), sub(mload(path), 20))))
        }
        if (route.executionMode == 1) {
            if (start != route.tokenOut || finish != route.tokenIn) revert ExecutorErrors.BadRoute();
        } else {
            if (start != route.tokenIn || finish != route.tokenOut) revert ExecutorErrors.BadRoute();
        }
    }
}
