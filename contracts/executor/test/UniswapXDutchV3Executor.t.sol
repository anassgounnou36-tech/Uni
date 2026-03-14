// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniswapXDutchV3Executor} from "../src/UniswapXDutchV3Executor.sol";
import {IReactorCallback} from "../src/external/uniswapx/IReactorCallback.sol";
import {ReactorStructs} from "../src/external/uniswapx/ReactorStructs.sol";
import {ExecutorErrors} from "../src/libraries/ExecutorErrors.sol";
import {ExecutorTypes} from "../src/libraries/ExecutorTypes.sol";

interface Vm {
    function prank(address msgSender) external;
    function expectRevert(bytes4 revertData) external;
}

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        unchecked {
            balanceOf[msg.sender] -= amount;
            balanceOf[to] += amount;
        }
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

contract MockSettlementAdapter {
    uint256 public amountOut;

    function setAmountOut(uint256 amountOut_) external {
        amountOut = amountOut_;
    }

    function executeExactInputSingle(
        address,
        address tokenOut,
        uint24,
        uint256,
        uint256 minAmountOut,
        address recipient
    ) external returns (uint256) {
        if (amountOut < minAmountOut) return amountOut;
        MockERC20(tokenOut).mint(recipient, amountOut);
        return amountOut;
    }
}

contract MockReactor {
    bytes public lastOrder;
    bytes public lastSignature;
    bytes public lastCallbackData;
    bool public callbackEnabled;
    address public callbackTokenIn;
    uint256 public callbackAmountIn;
    address public callbackTokenOut;
    uint256 public callbackAmountOut;

    function setCallbackPayload(address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut) external {
        callbackEnabled = true;
        callbackTokenIn = tokenIn;
        callbackAmountIn = amountIn;
        callbackTokenOut = tokenOut;
        callbackAmountOut = amountOut;
    }

    function executeWithCallback(ReactorStructs.SignedOrder calldata order, bytes calldata callbackData) external {
        lastOrder = order.order;
        lastSignature = order.sig;
        lastCallbackData = callbackData;
        if (!callbackEnabled) return;

        ReactorStructs.ResolvedOrder[] memory resolvedOrders = new ReactorStructs.ResolvedOrder[](1);
        ReactorStructs.OutputToken[] memory outputs = new ReactorStructs.OutputToken[](1);
        outputs[0] = ReactorStructs.OutputToken({token: callbackTokenOut, amount: callbackAmountOut, recipient: address(this)});
        resolvedOrders[0] = ReactorStructs.ResolvedOrder({
            info: ReactorStructs.OrderInfo({
                reactor: address(this),
                swapper: address(0xBEEF),
                nonce: 1,
                deadline: type(uint256).max,
                additionalValidationContract: address(0),
                additionalValidationData: ""
            }),
            input: ReactorStructs.InputToken({token: callbackTokenIn, amount: callbackAmountIn, maxAmount: callbackAmountIn}),
            outputs: outputs,
            sig: order.sig,
            hash: keccak256(order.order)
        });
        IReactorCallback(msg.sender).reactorCallback(resolvedOrders, callbackData);
    }
}

contract UniswapXDutchV3ExecutorTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockERC20 private tokenIn;
    MockERC20 private tokenOut;
    MockSettlementAdapter private adapter;
    UniswapXDutchV3Executor private executor;

    address private constant REACTOR = address(0xB274d5F4b833b61B340b654d600A864fB604a87c);
    address private constant TREASURY = address(0x1111);

    constructor() {
        tokenIn = new MockERC20();
        tokenOut = new MockERC20();
        adapter = new MockSettlementAdapter();
        executor = new UniswapXDutchV3Executor(REACTOR, address(adapter), TREASURY, address(this));
    }

    function testWrongCallerReverts() public {
        vm.expectRevert(ExecutorErrors.UnauthorizedCaller.selector);
        executor.reactorCallback(_resolvedOrder(tokenIn, tokenOut, 1e18, 10e6), _route(tokenIn, tokenOut, 9e6));
    }

    function testExecuteWrapperForwardsSignedOrderAndCallbackData() public {
        MockReactor reactor = new MockReactor();
        UniswapXDutchV3Executor wrapper =
            new UniswapXDutchV3Executor(address(reactor), address(adapter), TREASURY, address(this));

        ReactorStructs.SignedOrder memory order = ReactorStructs.SignedOrder({order: hex"1234", sig: hex"5678"});
        bytes memory callbackData = hex"abcd";
        wrapper.execute(order, callbackData);

        require(keccak256(reactor.lastOrder()) == keccak256(order.order), "order mismatch");
        require(keccak256(reactor.lastSignature()) == keccak256(order.sig), "signature mismatch");
        require(keccak256(reactor.lastCallbackData()) == keccak256(callbackData), "callback mismatch");
    }

    function testExecuteRoundTripThroughMockReactorAndCallbackSucceeds() public {
        MockReactor reactor = new MockReactor();
        UniswapXDutchV3Executor wrapper =
            new UniswapXDutchV3Executor(address(reactor), address(adapter), TREASURY, address(this));
        tokenIn.mint(address(wrapper), 1e18);
        adapter.setAmountOut(12e6);
        reactor.setCallbackPayload(address(tokenIn), 1e18, address(tokenOut), 10e6);

        wrapper.execute(
            ReactorStructs.SignedOrder({order: hex"010203", sig: hex"0405"}), _route(tokenIn, tokenOut, 9e6)
        );

        require(tokenOut.allowance(address(wrapper), address(reactor)) == 10e6, "reactor allowance not set");
    }

    function testPausedReverts() public {
        executor.setPaused(true);
        vm.prank(REACTOR);
        vm.expectRevert(ExecutorErrors.Paused.selector);
        executor.reactorCallback(_resolvedOrder(tokenIn, tokenOut, 1e18, 10e6), _route(tokenIn, tokenOut, 9e6));
    }

    function testBadRouteReverts() public {
        tokenIn.mint(address(executor), 1e18);
        adapter.setAmountOut(10e6);

        vm.prank(REACTOR);
        vm.expectRevert(ExecutorErrors.BadRoute.selector);
        executor.reactorCallback(_resolvedOrder(tokenIn, tokenOut, 1e18, 10e6), _route(tokenOut, tokenOut, 9e6));
    }

    function testInsufficientOutputReverts() public {
        tokenIn.mint(address(executor), 1e18);
        adapter.setAmountOut(9e6);

        vm.prank(REACTOR);
        vm.expectRevert(ExecutorErrors.SlippageExceeded.selector);
        executor.reactorCallback(_resolvedOrder(tokenIn, tokenOut, 1e18, 10e6), _route(tokenIn, tokenOut, 9e6));
    }

    function testUnsupportedOutputShapeReverts() public {
        tokenIn.mint(address(executor), 1e18);
        adapter.setAmountOut(20e6);
        ReactorStructs.ResolvedOrder[] memory orders = new ReactorStructs.ResolvedOrder[](1);
        ReactorStructs.OutputToken[] memory outputs = new ReactorStructs.OutputToken[](2);
        outputs[0] = ReactorStructs.OutputToken({token: address(tokenOut), amount: 10e6, recipient: address(0xA)});
        outputs[1] = ReactorStructs.OutputToken({token: address(tokenIn), amount: 2e6, recipient: address(0xB)});
        orders[0] = ReactorStructs.ResolvedOrder({
            info: _orderInfo(),
            input: ReactorStructs.InputToken({token: address(tokenIn), amount: 1e18, maxAmount: 1e18}),
            outputs: outputs,
            sig: "",
            hash: bytes32(0)
        });

        vm.prank(REACTOR);
        vm.expectRevert(ExecutorErrors.UnsupportedOutputShape.selector);
        executor.reactorCallback(orders, _route(tokenIn, tokenOut, 9e6));
    }

    function testUnsupportedOrderShapeReverts() public {
        ReactorStructs.ResolvedOrder[] memory orders = new ReactorStructs.ResolvedOrder[](2);
        ReactorStructs.OutputToken[] memory outputs = new ReactorStructs.OutputToken[](1);
        outputs[0] = ReactorStructs.OutputToken({token: address(tokenOut), amount: 1, recipient: address(0xA)});
        orders[0] = ReactorStructs.ResolvedOrder({
            info: _orderInfo(),
            input: ReactorStructs.InputToken({token: address(tokenIn), amount: 1, maxAmount: 1}),
            outputs: outputs,
            sig: "",
            hash: bytes32(0)
        });
        orders[1] = orders[0];

        vm.prank(REACTOR);
        vm.expectRevert(ExecutorErrors.UnsupportedOrderShape.selector);
        executor.reactorCallback(orders, _route(tokenIn, tokenOut, 1));
    }

    function testProfitSweptToTreasuryAndReactorApprovalSet() public {
        tokenIn.mint(address(executor), 1e18);
        adapter.setAmountOut(20e6);

        vm.prank(REACTOR);
        executor.reactorCallback(_resolvedOrder(tokenIn, tokenOut, 1e18, 10e6), _route(tokenIn, tokenOut, 9e6));

        require(tokenOut.balanceOf(TREASURY) == 10e6, "profit not swept");
        require(tokenOut.allowance(address(executor), REACTOR) == 10e6, "reactor allowance not set");
    }

    function testFuzzSingleOutputApproval(uint96 outputAmount, uint96 excessProfit) public {
        outputAmount = uint96(bound(outputAmount, 1, 1_000_000_000));
        excessProfit = uint96(bound(excessProfit, 0, 1_000_000_000));
        uint256 settled = uint256(outputAmount) + uint256(excessProfit);

        tokenIn.mint(address(executor), 1e18);
        adapter.setAmountOut(settled);

        vm.prank(REACTOR);
        executor.reactorCallback(
            _resolvedOrder(tokenIn, tokenOut, 1e18, uint256(outputAmount)),
            _route(tokenIn, tokenOut, uint256(outputAmount))
        );

        require(tokenOut.allowance(address(executor), REACTOR) == uint256(outputAmount), "bad allowance");
        require(tokenOut.balanceOf(TREASURY) == uint256(excessProfit), "bad profit");
    }

    function testGasHappyPathCallback() public {
        tokenIn.mint(address(executor), 1e18);
        adapter.setAmountOut(12e6);

        vm.prank(REACTOR);
        executor.reactorCallback(_resolvedOrder(tokenIn, tokenOut, 1e18, 10e6), _route(tokenIn, tokenOut, 9e6));
    }

    function _resolvedOrder(MockERC20 inToken, MockERC20 outToken, uint256 inputAmount, uint256 outputAmount)
        private
        pure
        returns (ReactorStructs.ResolvedOrder[] memory orders)
    {
        orders = new ReactorStructs.ResolvedOrder[](1);
        ReactorStructs.OutputToken[] memory outputs = new ReactorStructs.OutputToken[](1);
        outputs[0] = ReactorStructs.OutputToken({
            token: address(outToken), amount: outputAmount, recipient: address(0xC0FFEE)
        });
        orders[0] = ReactorStructs.ResolvedOrder({
            info: _orderInfo(),
            input: ReactorStructs.InputToken({token: address(inToken), amount: inputAmount, maxAmount: inputAmount}),
            outputs: outputs,
            sig: "",
            hash: bytes32(0)
        });
    }

    function _orderInfo() private pure returns (ReactorStructs.OrderInfo memory) {
        return ReactorStructs.OrderInfo({
            reactor: address(0xB274),
            swapper: address(0xBEEF),
            nonce: 1,
            deadline: type(uint256).max,
            additionalValidationContract: address(0),
            additionalValidationData: ""
        });
    }

    function _route(MockERC20 inToken, MockERC20 outToken, uint256 minAmountOut) private pure returns (bytes memory) {
        return abi.encode(
            ExecutorTypes.RoutePlan({
                tokenIn: address(inToken), tokenOut: address(outToken), poolFee: 500, minAmountOut: minAmountOut
            })
        );
    }

    function bound(uint256 x, uint256 minVal, uint256 maxVal) private pure returns (uint256) {
        if (x < minVal) return minVal;
        if (x > maxVal) return maxVal;
        return x;
    }
}
