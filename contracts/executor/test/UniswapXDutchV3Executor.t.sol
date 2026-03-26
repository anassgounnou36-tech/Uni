// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniswapXDutchV3Executor} from "../src/UniswapXDutchV3Executor.sol";
import {UniV3SwapRouter02Adapter} from "../src/adapters/UniV3SwapRouter02Adapter.sol";
import {IReactorCallback} from "../src/external/uniswapx/IReactorCallback.sol";
import {ReactorStructs} from "../src/external/uniswapx/ReactorStructs.sol";
import {ExecutorErrors} from "../src/libraries/ExecutorErrors.sol";
import {ExecutorTypes} from "../src/libraries/ExecutorTypes.sol";
import {MockReactorForExecutorFlow} from "./mocks/MockReactorForExecutorFlow.sol";

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
    uint256 public amountInUsed;
    uint24 public lastPoolFee;
    bytes public lastPath;
    bool public usedExactOutputSingle;
    bool public usedExactOutputPath;

    function setAmountOut(uint256 amountOut_) external {
        amountOut = amountOut_;
    }

    function setAmountInUsed(uint256 amountInUsed_) external {
        amountInUsed = amountInUsed_;
    }

    function executeExactInputSingle(
        address,
        address tokenOut,
        uint24 poolFee,
        uint256,
        uint256 minAmountOut,
        uint160,
        address recipient
    ) external returns (uint256) {
        lastPoolFee = poolFee;
        if (amountOut < minAmountOut) return amountOut;
        MockERC20(tokenOut).mint(recipient, amountOut);
        return amountOut;
    }

    function executeExactInputPath(bytes calldata path, uint256, uint256 minAmountOut, address recipient)
        external
        returns (uint256)
    {
        lastPath = path;
        if (amountOut < minAmountOut) return amountOut;
        address tokenOut;
        uint256 len = path.length;
        // Load the final 20-byte token address from the encoded path.
        assembly {
            tokenOut := shr(96, calldataload(add(path.offset, sub(len, 20))))
        }
        MockERC20(tokenOut).mint(recipient, amountOut);
        return amountOut;
    }

    function executeExactOutputSingle(
        address,
        address tokenOut,
        uint24,
        uint256 targetAmountOut,
        uint256,
        uint160,
        address recipient
    ) external returns (uint256) {
        usedExactOutputSingle = true;
        MockERC20(tokenOut).mint(recipient, targetAmountOut);
        return amountInUsed;
    }

    function executeExactOutputPath(bytes calldata path, uint256 targetAmountOut, uint256, address recipient)
        external
        returns (uint256)
    {
        usedExactOutputPath = true;
        lastPath = path;
        address tokenOut;
        uint256 len = path.length;
        assembly {
            tokenOut := shr(96, calldataload(add(path.offset, sub(len, 20))))
        }
        MockERC20(tokenOut).mint(recipient, targetAmountOut);
        return amountInUsed;
    }
}

contract MockSwapRouter02 {
    uint256 public amountOut;
    bytes public lastPath;

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function setAmountOut(uint256 value) external {
        amountOut = value;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256) {
        if (amountOut < params.amountOutMinimum) {
            return amountOut;
        }
        MockERC20(params.tokenOut).mint(params.recipient, amountOut);
        return amountOut;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256) {
        if (amountOut < params.amountOutMinimum) {
            return amountOut;
        }
        bytes calldata path = params.path;
        address tokenOut;
        uint256 len = path.length;
        assembly {
            tokenOut := shr(96, calldataload(add(path.offset, sub(len, 20))))
        }
        MockERC20(tokenOut).mint(params.recipient, amountOut);
        return amountOut;
    }

    struct ExactOutputParams {
        bytes path;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
    }

    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256) {
        lastPath = params.path;
        return 1;
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
    MockSettlementAdapter private uniAdapter;
    MockSettlementAdapter private camelotAdapter;
    MockSettlementAdapter private lfjAdapter;
    UniswapXDutchV3Executor private executor;

    address private constant REACTOR = address(0xB274d5F4b833b61B340b654d600A864fB604a87c);
    address private constant TREASURY = address(0x1111);

    constructor() {
        tokenIn = new MockERC20();
        tokenOut = new MockERC20();
        uniAdapter = new MockSettlementAdapter();
        camelotAdapter = new MockSettlementAdapter();
        lfjAdapter = new MockSettlementAdapter();
        executor = new UniswapXDutchV3Executor(
            REACTOR, address(uniAdapter), address(camelotAdapter), address(lfjAdapter), TREASURY, address(this)
        );
    }

    function testWrongCallerReverts() public {
        vm.expectRevert(ExecutorErrors.UnauthorizedCaller.selector);
        executor.reactorCallback(_resolvedOrder(tokenIn, tokenOut, 1e18, 10e6), _route(tokenIn, tokenOut, 9e6));
    }

    function testExecuteWrapperForwardsSignedOrderAndCallbackData() public {
        MockReactor reactor = new MockReactor();
        UniswapXDutchV3Executor wrapper =
            new UniswapXDutchV3Executor(
                address(reactor), address(uniAdapter), address(camelotAdapter), address(lfjAdapter), TREASURY, address(this)
            );

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
            new UniswapXDutchV3Executor(
                address(reactor), address(uniAdapter), address(camelotAdapter), address(lfjAdapter), TREASURY, address(this)
            );
        tokenIn.mint(address(wrapper), 1e18);
        uniAdapter.setAmountOut(12e6);
        reactor.setCallbackPayload(address(tokenIn), 1e18, address(tokenOut), 10e6);

        wrapper.execute(
            ReactorStructs.SignedOrder({order: hex"010203", sig: hex"0405"}), _route(tokenIn, tokenOut, 9e6)
        );

        require(tokenOut.allowance(address(wrapper), address(reactor)) == 10e6, "reactor allowance not set");
    }

    function testExecuteCallsMockReactorAndExercisesRealCallbackPath() public {
        MockReactorForExecutorFlow reactor = new MockReactorForExecutorFlow();
        MockSwapRouter02 router = new MockSwapRouter02();
        UniV3SwapRouter02Adapter realAdapter = new UniV3SwapRouter02Adapter(address(router));
        UniV3SwapRouter02Adapter distinctCamelotSlotAdapter = new UniV3SwapRouter02Adapter(address(router));
        UniswapXDutchV3Executor wrapper =
            new UniswapXDutchV3Executor(
                address(reactor), address(realAdapter), address(distinctCamelotSlotAdapter), address(lfjAdapter), TREASURY, address(this)
            );

        tokenIn.mint(address(wrapper), 1e18);
        router.setAmountOut(12e6);

        ReactorStructs.OutputToken[] memory outputs = new ReactorStructs.OutputToken[](1);
        outputs[0] =
            ReactorStructs.OutputToken({token: address(tokenOut), amount: 10e6, recipient: address(0xCAFE)});
        reactor.pushConfiguredResolvedOrder(
            ReactorStructs.ResolvedOrder({
                info: ReactorStructs.OrderInfo({
                    reactor: address(reactor),
                    swapper: address(0xBEEF),
                    nonce: 1,
                    deadline: type(uint256).max,
                    additionalValidationContract: address(0),
                    additionalValidationData: ""
                }),
                input: ReactorStructs.InputToken({token: address(tokenIn), amount: 1e18, maxAmount: 1e18}),
                outputs: outputs,
                sig: hex"0405",
                hash: keccak256(hex"010203")
            })
        );

        ReactorStructs.SignedOrder memory signedOrder = ReactorStructs.SignedOrder({order: hex"010203", sig: hex"0405"});
        bytes memory callbackData = _route(tokenIn, tokenOut, 9e6);
        wrapper.execute(signedOrder, callbackData);

        require(reactor.lastCaller() == address(wrapper), "caller mismatch");
        require(keccak256(reactor.lastOrderBytes()) == keccak256(signedOrder.order), "order mismatch");
        require(keccak256(reactor.lastSigBytes()) == keccak256(signedOrder.sig), "signature mismatch");
        require(keccak256(reactor.lastCallbackData()) == keccak256(callbackData), "callback mismatch");
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
        uniAdapter.setAmountOut(10e6);

        vm.prank(REACTOR);
        vm.expectRevert(ExecutorErrors.BadRoute.selector);
        executor.reactorCallback(_resolvedOrder(tokenIn, tokenOut, 1e18, 10e6), _route(tokenOut, tokenOut, 9e6));
    }

    function testBadRouteRevertsWhenInputAndOutputTokensAreEqual() public {
        tokenIn.mint(address(executor), 1e18);
        uniAdapter.setAmountOut(2e18);

        vm.prank(REACTOR);
        vm.expectRevert(ExecutorErrors.BadRoute.selector);
        executor.reactorCallback(_resolvedOrder(tokenIn, tokenIn, 1e18, 1e18), _route(tokenIn, tokenIn, 1e18));
    }

    function testCamelotVenueRoutePlanRejectedWhenMalformed() public {
        tokenIn.mint(address(executor), 1e18);
        camelotAdapter.setAmountOut(2e18);

        vm.prank(REACTOR);
        vm.expectRevert(ExecutorErrors.BadRoute.selector);
        executor.reactorCallback(
            _resolvedOrder(tokenIn, tokenOut, 1e18, 1e18),
            abi.encode(
                ExecutorTypes.RoutePlan({
                    venue: ExecutorTypes.VENUE_CAMELOT_AMMV3,
                    pathKind: ExecutorTypes.PATH_KIND_DIRECT,
                    hopCount: 1,
                    pathDirection: ExecutorTypes.PATH_DIRECTION_FORWARD,
                    tokenIn: address(tokenIn),
                    tokenOut: address(tokenOut),
                    uniPoolFee: 500,
                    executionMode: 0,
                    encodedPath: "",
                    lfjTokenPath: new address[](0),
                    lfjBinSteps: new uint256[](0),
                    lfjVersions: new uint8[](0),
                    limitSqrtPriceX96: 0,
                    minAmountOut: 1e18,
                    targetOutput: 0,
                    maxAmountIn: 0
                })
            )
        );
    }

    function testExecutorSelectsCamelotAdapterForCamelotVenue() public {
        tokenIn.mint(address(executor), 1e18);
        uniAdapter.setAmountOut(1);
        camelotAdapter.setAmountOut(12e6);

        vm.prank(REACTOR);
        executor.reactorCallback(_resolvedOrder(tokenIn, tokenOut, 1e18, 10e6), _camelotRoute(tokenIn, tokenOut, 9e6));

        require(tokenOut.allowance(address(executor), REACTOR) == 10e6, "reactor allowance not set");
    }

    function testExecutorSelectsUniswapAdapterForUniswapVenue() public {
        tokenIn.mint(address(executor), 1e18);
        uniAdapter.setAmountOut(12e6);
        camelotAdapter.setAmountOut(1);

        vm.prank(REACTOR);
        executor.reactorCallback(_resolvedOrder(tokenIn, tokenOut, 1e18, 10e6), _route(tokenIn, tokenOut, 9e6));

        require(uniAdapter.lastPoolFee() == 500, "uniswap adapter not used");
    }

    function testExecutorDispatchesTwoHopPathToCorrectAdapter() public {
        tokenIn.mint(address(executor), 1e18);
        uniAdapter.setAmountOut(12e6);
        camelotAdapter.setAmountOut(1);
        vm.prank(REACTOR);
        executor.reactorCallback(
            _resolvedOrder(tokenIn, tokenOut, 1e18, 10e6),
            abi.encode(
                ExecutorTypes.RoutePlan({
                    venue: ExecutorTypes.VENUE_UNISWAP_V3,
                    pathKind: ExecutorTypes.PATH_KIND_TWO_HOP,
                    hopCount: 2,
                    pathDirection: ExecutorTypes.PATH_DIRECTION_FORWARD,
                    tokenIn: address(tokenIn),
                    tokenOut: address(tokenOut),
                    uniPoolFee: 0,
                    executionMode: 0,
                    encodedPath: abi.encodePacked(address(tokenIn), bytes3(uint24(500)), address(0x1234), bytes3(uint24(3000)), address(tokenOut)),
                    lfjTokenPath: new address[](0),
                    lfjBinSteps: new uint256[](0),
                    lfjVersions: new uint8[](0),
                    limitSqrtPriceX96: 0,
                    minAmountOut: 9e6,
                    targetOutput: 0,
                    maxAmountIn: 0
                })
            )
        );
        require(uniAdapter.lastPath().length > 0, "path not dispatched to uni adapter");
    }

    function testExecutorDispatchesExactOutputToCorrectAdapter() public {
        tokenIn.mint(address(executor), 1e18);
        uniAdapter.setAmountInUsed(8e17);
        vm.prank(REACTOR);
        executor.reactorCallback(
            _resolvedOrder(tokenIn, tokenOut, 1e18, 10e6),
            abi.encode(
                ExecutorTypes.RoutePlan({
                    venue: ExecutorTypes.VENUE_UNISWAP_V3,
                    executionMode: 1,
                    pathKind: ExecutorTypes.PATH_KIND_DIRECT,
                    hopCount: 1,
                    pathDirection: ExecutorTypes.PATH_DIRECTION_FORWARD,
                    tokenIn: address(tokenIn),
                    tokenOut: address(tokenOut),
                    uniPoolFee: 500,
                    encodedPath: "",
                    lfjTokenPath: new address[](0),
                    lfjBinSteps: new uint256[](0),
                    lfjVersions: new uint8[](0),
                    limitSqrtPriceX96: 0,
                    minAmountOut: 0,
                    targetOutput: 10e6,
                    maxAmountIn: 1e18
                })
            )
        );
        require(uniAdapter.usedExactOutputSingle(), "exact output single not used");
    }

    function testBoundedExactOutputRejectsSpendAboveMaxAmountIn() public {
        tokenIn.mint(address(executor), 1e18);
        uniAdapter.setAmountInUsed(1e18 + 1);
        vm.prank(REACTOR);
        vm.expectRevert(ExecutorErrors.ExactOutputExceededMaxInput.selector);
        executor.reactorCallback(
            _resolvedOrder(tokenIn, tokenOut, 1e18, 10e6),
            abi.encode(
                ExecutorTypes.RoutePlan({
                    venue: ExecutorTypes.VENUE_UNISWAP_V3,
                    executionMode: 1,
                    pathKind: ExecutorTypes.PATH_KIND_DIRECT,
                    hopCount: 1,
                    pathDirection: ExecutorTypes.PATH_DIRECTION_FORWARD,
                    tokenIn: address(tokenIn),
                    tokenOut: address(tokenOut),
                    uniPoolFee: 500,
                    encodedPath: "",
                    lfjTokenPath: new address[](0),
                    lfjBinSteps: new uint256[](0),
                    lfjVersions: new uint8[](0),
                    limitSqrtPriceX96: 0,
                    minAmountOut: 0,
                    targetOutput: 10e6,
                    maxAmountIn: 1e18
                })
            )
        );
    }

    function testBoundedPathValidationRejectsMoreThanTwoHops() public {
        tokenIn.mint(address(executor), 1e18);
        uniAdapter.setAmountOut(12e6);
        vm.prank(REACTOR);
        vm.expectRevert(ExecutorErrors.BadRoute.selector);
        executor.reactorCallback(
            _resolvedOrder(tokenIn, tokenOut, 1e18, 10e6),
            abi.encode(
                ExecutorTypes.RoutePlan({
                    venue: ExecutorTypes.VENUE_UNISWAP_V3,
                    pathKind: ExecutorTypes.PATH_KIND_TWO_HOP,
                    hopCount: 3,
                    pathDirection: ExecutorTypes.PATH_DIRECTION_FORWARD,
                    tokenIn: address(tokenIn),
                    tokenOut: address(tokenOut),
                    uniPoolFee: 0,
                    executionMode: 0,
                    encodedPath: abi.encodePacked(
                        address(tokenIn),
                        bytes3(uint24(500)),
                        address(0x1234),
                        bytes3(uint24(500)),
                        address(0x5678),
                        bytes3(uint24(500)),
                        address(tokenOut)
                    ),
                    lfjTokenPath: new address[](0),
                    lfjBinSteps: new uint256[](0),
                    lfjVersions: new uint8[](0),
                    limitSqrtPriceX96: 0,
                    minAmountOut: 9e6,
                    targetOutput: 0,
                    maxAmountIn: 0
                })
            )
        );
    }

    function testExecutorValidateBoundedPathAcceptsForwardExactInputAndReversedExactOutput() public {
        tokenIn.mint(address(executor), 2e18);
        uniAdapter.setAmountOut(12e6);
        uniAdapter.setAmountInUsed(9e17);
        bytes memory forwardPath =
            abi.encodePacked(address(tokenIn), bytes3(uint24(500)), address(0x1234), bytes3(uint24(3000)), address(tokenOut));
        vm.prank(REACTOR);
        executor.reactorCallback(
            _resolvedOrder(tokenIn, tokenOut, 1e18, 10e6),
            abi.encode(
                ExecutorTypes.RoutePlan({
                    venue: ExecutorTypes.VENUE_UNISWAP_V3,
                    executionMode: 0,
                    pathKind: ExecutorTypes.PATH_KIND_TWO_HOP,
                    hopCount: 2,
                    pathDirection: ExecutorTypes.PATH_DIRECTION_FORWARD,
                    tokenIn: address(tokenIn),
                    tokenOut: address(tokenOut),
                    uniPoolFee: 0,
                    encodedPath: forwardPath,
                    lfjTokenPath: new address[](0),
                    lfjBinSteps: new uint256[](0),
                    lfjVersions: new uint8[](0),
                    limitSqrtPriceX96: 0,
                    minAmountOut: 9e6,
                    targetOutput: 0,
                    maxAmountIn: 0
                })
            )
        );
        bytes memory reversePath =
            abi.encodePacked(address(tokenOut), bytes3(uint24(3000)), address(0x1234), bytes3(uint24(500)), address(tokenIn));
        vm.prank(REACTOR);
        executor.reactorCallback(
            _resolvedOrder(tokenIn, tokenOut, 1e18, 10e6),
            abi.encode(
                ExecutorTypes.RoutePlan({
                    venue: ExecutorTypes.VENUE_UNISWAP_V3,
                    executionMode: 1,
                    pathKind: ExecutorTypes.PATH_KIND_TWO_HOP,
                    hopCount: 2,
                    pathDirection: ExecutorTypes.PATH_DIRECTION_REVERSE,
                    tokenIn: address(tokenIn),
                    tokenOut: address(tokenOut),
                    uniPoolFee: 0,
                    encodedPath: reversePath,
                    lfjTokenPath: new address[](0),
                    lfjBinSteps: new uint256[](0),
                    lfjVersions: new uint8[](0),
                    limitSqrtPriceX96: 0,
                    minAmountOut: 0,
                    targetOutput: 10e6,
                    maxAmountIn: 1e18
                })
            )
        );
        require(uniAdapter.usedExactOutputPath(), "exact output path not used");
    }

    function testInsufficientOutputReverts() public {
        tokenIn.mint(address(executor), 1e18);
        uniAdapter.setAmountOut(9e6);

        vm.prank(REACTOR);
        vm.expectRevert(ExecutorErrors.SlippageExceeded.selector);
        executor.reactorCallback(_resolvedOrder(tokenIn, tokenOut, 1e18, 10e6), _route(tokenIn, tokenOut, 9e6));
    }

    function testUnsupportedOutputShapeReverts() public {
        tokenIn.mint(address(executor), 1e18);
        uniAdapter.setAmountOut(20e6);
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
        uniAdapter.setAmountOut(20e6);

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
        uniAdapter.setAmountOut(settled);

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
        uniAdapter.setAmountOut(12e6);

        vm.prank(REACTOR);
        executor.reactorCallback(_resolvedOrder(tokenIn, tokenOut, 1e18, 10e6), _route(tokenIn, tokenOut, 9e6));
    }

    function testUniswapAdapterExactOutputPathApprovesRealInputTokenNotFirstPathToken() public {
        MockERC20 tokenMid = new MockERC20();
        MockSwapRouter02 router = new MockSwapRouter02();
        UniV3SwapRouter02Adapter adapter = new UniV3SwapRouter02Adapter(address(router));
        tokenIn.mint(address(this), 1e18);
        tokenIn.transfer(address(adapter), 1e18);
        bytes memory reversedPath =
            abi.encodePacked(address(tokenOut), bytes3(uint24(3000)), address(tokenMid), bytes3(uint24(500)), address(tokenIn));
        adapter.executeExactOutputPath(reversedPath, 10e6, 1e18, address(this));
        require(tokenOut.allowance(address(adapter), address(router)) == 0, "approved first path token");
        require(tokenIn.allowance(address(adapter), address(router)) == 1e18, "did not approve real input token");
        require(keccak256(router.lastPath()) == keccak256(reversedPath), "path mutated");
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
                venue: ExecutorTypes.VENUE_UNISWAP_V3,
                pathKind: ExecutorTypes.PATH_KIND_DIRECT,
                hopCount: 1,
                pathDirection: ExecutorTypes.PATH_DIRECTION_FORWARD,
                tokenIn: address(inToken),
                tokenOut: address(outToken),
                executionMode: 0,
                uniPoolFee: 500,
                encodedPath: "",
                lfjTokenPath: new address[](0),
                lfjBinSteps: new uint256[](0),
                lfjVersions: new uint8[](0),
                limitSqrtPriceX96: 0,
                minAmountOut: minAmountOut,
                targetOutput: 0,
                maxAmountIn: 0
            })
        );
    }

    function _camelotRoute(MockERC20 inToken, MockERC20 outToken, uint256 minAmountOut) private pure returns (bytes memory) {
        return abi.encode(
            ExecutorTypes.RoutePlan({
                venue: ExecutorTypes.VENUE_CAMELOT_AMMV3,
                pathKind: ExecutorTypes.PATH_KIND_DIRECT,
                hopCount: 1,
                pathDirection: ExecutorTypes.PATH_DIRECTION_FORWARD,
                tokenIn: address(inToken),
                tokenOut: address(outToken),
                executionMode: 0,
                uniPoolFee: 0,
                encodedPath: "",
                lfjTokenPath: new address[](0),
                lfjBinSteps: new uint256[](0),
                lfjVersions: new uint8[](0),
                limitSqrtPriceX96: 0,
                minAmountOut: minAmountOut,
                targetOutput: 0,
                maxAmountIn: 0
            })
        );
    }

    function bound(uint256 x, uint256 minVal, uint256 maxVal) private pure returns (uint256) {
        if (x < minVal) return minVal;
        if (x > maxVal) return maxVal;
        return x;
    }
}
