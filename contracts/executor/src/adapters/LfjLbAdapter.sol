// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISettlementAdapter} from "../interfaces/ISettlementAdapter.sol";
import {ExecutorErrors} from "../libraries/ExecutorErrors.sol";
import {ILfjLbRouter} from "../external/lfj/ILfjLbRouter.sol";

interface IERC20Lfj {
    function approve(address spender, uint256 amount) external returns (bool);
}

contract LfjLbAdapter is ISettlementAdapter {
    address public immutable ROUTER;

    constructor(address router_) {
        if (router_ == address(0)) revert ExecutorErrors.ZeroAddress();
        ROUTER = router_;
    }

    function executeExactInputSingle(address, address, uint24, uint256, uint256, uint160, address)
        external
        pure
        returns (uint256)
    {
        revert ExecutorErrors.BadRoute();
    }

    function executeExactInputPath(bytes calldata, uint256, uint256, address) external pure returns (uint256) {
        revert ExecutorErrors.BadRoute();
    }

    function executeExactOutputSingle(address, address, uint24, uint256, uint256, uint160, address)
        external
        pure
        returns (uint256)
    {
        revert ExecutorErrors.BadRoute();
    }

    function executeExactOutputPath(bytes calldata, uint256, uint256, address) external pure returns (uint256) {
        revert ExecutorErrors.BadRoute();
    }

    function executeLfjExactInputPath(LfjPath calldata path, uint256 amountIn, uint256 minAmountOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        _validatePath(path);
        _safeApprove(path.tokenPath[0], ROUTER, 0);
        _safeApprove(path.tokenPath[0], ROUTER, amountIn);
        amountOut = ILfjLbRouter(ROUTER).swapExactTokensForTokens(
            amountIn,
            minAmountOut,
            ILfjLbRouter.Path({pairBinSteps: path.pairBinSteps, versions: path.versions, tokenPath: path.tokenPath}),
            recipient,
            block.timestamp
        );
    }

    function executeLfjExactOutputPath(LfjPath calldata path, uint256 targetAmountOut, uint256 maxAmountIn, address recipient)
        external
        returns (uint256 amountInUsed)
    {
        _validatePath(path);
        _safeApprove(path.tokenPath[0], ROUTER, 0);
        _safeApprove(path.tokenPath[0], ROUTER, maxAmountIn);
        amountInUsed = ILfjLbRouter(ROUTER).swapTokensForExactTokens(
            targetAmountOut,
            maxAmountIn,
            ILfjLbRouter.Path({pairBinSteps: path.pairBinSteps, versions: path.versions, tokenPath: path.tokenPath}),
            recipient,
            block.timestamp
        );
    }

    function _validatePath(LfjPath calldata path) private pure {
        uint256 hops = path.pairBinSteps.length;
        if (hops == 0 || hops > 2) revert ExecutorErrors.BadRoute();
        if (path.versions.length != hops) revert ExecutorErrors.BadRoute();
        if (path.tokenPath.length != hops + 1) revert ExecutorErrors.BadRoute();
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20Lfj.approve, (spender, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert ExecutorErrors.TokenApprovalFailed();
        }
    }
}
