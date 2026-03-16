// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISettlementAdapter} from "../interfaces/ISettlementAdapter.sol";
import {ExecutorErrors} from "../libraries/ExecutorErrors.sol";
import {ICamelotAmmv3Router} from "../external/camelot/ICamelotAmmv3Router.sol";

interface IERC20Camelot {
    function approve(address spender, uint256 amount) external returns (bool);
}

contract CamelotAmmv3Adapter is ISettlementAdapter {
    address public immutable ROUTER;

    constructor(address router_) {
        if (router_ == address(0)) revert ExecutorErrors.ZeroAddress();
        ROUTER = router_;
    }

    function executeExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24,
        uint256 amountIn,
        uint256 minAmountOut,
        uint160 limitSqrtPriceX96,
        address recipient
    ) external returns (uint256 amountOut) {
        _safeApprove(tokenIn, ROUTER, 0);
        _safeApprove(tokenIn, ROUTER, amountIn);
        amountOut = ICamelotAmmv3Router(ROUTER).exactInputSingle(
            ICamelotAmmv3Router.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                recipient: recipient,
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                limitSqrtPrice: limitSqrtPriceX96
            })
        );
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20Camelot.approve, (spender, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert ExecutorErrors.TokenApprovalFailed();
        }
    }
}
