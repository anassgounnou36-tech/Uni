// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISettlementAdapter} from "../interfaces/ISettlementAdapter.sol";
import {ExecutorErrors} from "../libraries/ExecutorErrors.sol";

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);

    struct ExactOutputParams {
        bytes path;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256 amountIn);
}

contract UniV3SwapRouter02Adapter is ISettlementAdapter {
    address public immutable ROUTER;

    constructor(address router_) {
        if (router_ == address(0)) revert ExecutorErrors.ZeroAddress();
        ROUTER = router_;
    }

    function executeExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 amountIn,
        uint256 minAmountOut,
        uint160 limitSqrtPriceX96,
        address recipient
    ) external returns (uint256 amountOut) {
        _safeApprove(tokenIn, ROUTER, 0);
        _safeApprove(tokenIn, ROUTER, amountIn);
        amountOut = ISwapRouter02(ROUTER)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: poolFee,
                    recipient: recipient,
                    amountIn: amountIn,
                    amountOutMinimum: minAmountOut,
                    sqrtPriceLimitX96: limitSqrtPriceX96
                })
            );
    }

    function executeExactInputPath(bytes calldata path, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        if (path.length == 0) revert ExecutorErrors.BadRoute();
        uint256 hops = ((path.length - 20) / 23);
        if (hops == 0 || hops > 2 || ((path.length - 20) % 23) != 0) revert ExecutorErrors.BadRoute();
        address tokenIn;
        assembly {
            tokenIn := shr(96, calldataload(path.offset))
        }
        _safeApprove(tokenIn, ROUTER, 0);
        _safeApprove(tokenIn, ROUTER, amountIn);
        amountOut = ISwapRouter02(ROUTER).exactInput(
            ISwapRouter02.ExactInputParams({
                path: path,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut
            })
        );
    }

    function executeExactOutputSingle(
        address tokenIn,
        address tokenOut,
        uint24 poolFee,
        uint256 targetAmountOut,
        uint256 maxAmountIn,
        uint160 limitSqrtPriceX96,
        address recipient
    ) external returns (uint256 amountInUsed) {
        _safeApprove(tokenIn, ROUTER, 0);
        _safeApprove(tokenIn, ROUTER, maxAmountIn);
        amountInUsed = ISwapRouter02(ROUTER).exactOutputSingle(
            ISwapRouter02.ExactOutputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: recipient,
                amountOut: targetAmountOut,
                amountInMaximum: maxAmountIn,
                sqrtPriceLimitX96: limitSqrtPriceX96
            })
        );
    }

    function executeExactOutputPath(bytes calldata path, uint256 targetAmountOut, uint256 maxAmountIn, address recipient)
        external
        returns (uint256 amountInUsed)
    {
        if (path.length == 0) revert ExecutorErrors.BadRoute();
        uint256 hops = ((path.length - 20) / 23);
        if (hops == 0 || hops > 2 || ((path.length - 20) % 23) != 0) revert ExecutorErrors.BadRoute();
        address tokenIn;
        assembly {
            tokenIn := shr(96, calldataload(path.offset))
        }
        _safeApprove(tokenIn, ROUTER, 0);
        _safeApprove(tokenIn, ROUTER, maxAmountIn);
        amountInUsed = ISwapRouter02(ROUTER).exactOutput(
            ISwapRouter02.ExactOutputParams({
                path: path,
                recipient: recipient,
                amountOut: targetAmountOut,
                amountInMaximum: maxAmountIn
            })
        );
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert ExecutorErrors.TokenApprovalFailed();
        }
    }
}
