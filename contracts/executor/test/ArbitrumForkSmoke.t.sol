// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UniV3SwapRouter02Adapter} from "../src/adapters/UniV3SwapRouter02Adapter.sol";
import {UniswapXDutchV3Executor} from "../src/UniswapXDutchV3Executor.sol";
import {ReactorStructs} from "../src/external/uniswapx/ReactorStructs.sol";
import {ExecutorErrors} from "../src/libraries/ExecutorErrors.sol";
import {ExecutorTypes} from "../src/libraries/ExecutorTypes.sol";

interface Vm {
    function createSelectFork(string calldata rpcUrl) external returns (uint256);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function deal(address account, uint256 newBalance) external;
    function prank(address msgSender) external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert() external;
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IWETH is IERC20 {
    function deposit() external payable;
}

contract ArbitrumForkSmokeTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant UNISWAPX_DUTCH_V3_REACTOR = 0xB274d5F4b833b61B340b654d600A864fB604a87c;
    address private constant UNISWAPX_ORDER_QUOTER = 0x88440407634F89873c5D9439987Ac4BE9725fea8;
    address private constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address private constant UNIV3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address private constant UNIV3_QUOTER_V2 = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e;
    address private constant UNIV3_SWAP_ROUTER_02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address private constant UNIVERSAL_ROUTER = 0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3;
    address private constant TIMEBOOST_AUCTION_CONTRACT = 0x5fcb496a31b7AE91e7c9078Ec662bd7A55cd3079;
    address private constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
    address private constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address private constant TREASURY = address(0x123456);

    UniV3SwapRouter02Adapter private adapter;
    UniswapXDutchV3Executor private executor;

    function testArbitrumAddressesHaveBytecode() public {
        string memory forkUrl = vm.envOr("ARB1_RPC_URL", "https://arb1-sequencer.arbitrum.io/rpc");
        vm.createSelectFork(forkUrl);

        require(UNISWAPX_DUTCH_V3_REACTOR.code.length > 0, "missing Dutch V3 reactor bytecode");
        require(UNISWAPX_ORDER_QUOTER.code.length > 0, "missing order quoter bytecode");
        require(PERMIT2.code.length > 0, "missing permit2 bytecode");
        require(UNIV3_FACTORY.code.length > 0, "missing univ3 factory bytecode");
        require(UNIV3_QUOTER_V2.code.length > 0, "missing univ3 quoter bytecode");
        require(UNIV3_SWAP_ROUTER_02.code.length > 0, "missing univ3 swap router bytecode");
        require(UNIVERSAL_ROUTER.code.length > 0, "missing universal router bytecode");
        require(TIMEBOOST_AUCTION_CONTRACT.code.length > 0, "missing timeboost auction bytecode");
    }

    function testForkCallbackPathSettlementViaPrankedReactor() public {
        _setUpForkExecutor();
        _fundExecutorWithWeth(0.01 ether);

        uint256 requiredOutput = 10_000;
        vm.prank(UNISWAPX_DUTCH_V3_REACTOR);
        executor.reactorCallback(_singleOrder(0.01 ether, requiredOutput), _route(1, 500));

        require(
            IERC20(USDC).allowance(address(executor), UNISWAPX_DUTCH_V3_REACTOR) == requiredOutput,
            "missing reactor approval"
        );
    }

    function testForkWrongCallerReverts() public {
        _setUpForkExecutor();
        _fundExecutorWithWeth(0.01 ether);

        vm.expectRevert(ExecutorErrors.UnauthorizedCaller.selector);
        executor.reactorCallback(_singleOrder(0.01 ether, 1), _route(1, 500));
    }

    function testForkPausedReverts() public {
        _setUpForkExecutor();
        executor.setPaused(true);

        vm.prank(UNISWAPX_DUTCH_V3_REACTOR);
        vm.expectRevert(ExecutorErrors.Paused.selector);
        executor.reactorCallback(_singleOrder(0.01 ether, 1), _route(1, 500));
    }

    function testForkBadRouteReverts() public {
        _setUpForkExecutor();
        _fundExecutorWithWeth(0.01 ether);

        vm.prank(UNISWAPX_DUTCH_V3_REACTOR);
        vm.expectRevert(ExecutorErrors.BadRoute.selector);
        executor.reactorCallback(
            _singleOrder(0.01 ether, 1),
            abi.encode(
                ExecutorTypes.RoutePlan({
                    venue: ExecutorTypes.VENUE_UNISWAP_V3,
                    executionMode: 0,
                    pathKind: ExecutorTypes.PATH_KIND_DIRECT,
                    hopCount: 1,
                    tokenIn: WETH,
                    tokenOut: WETH,
                    uniPoolFee: 500,
                    encodedPath: "",
                    limitSqrtPriceX96: 0,
                    minAmountOut: 1,
                    targetOutput: 0,
                    maxAmountIn: 0
                })
            )
        );
    }

    function testForkInsufficientOutputReverts() public {
        _setUpForkExecutor();
        _fundExecutorWithWeth(0.01 ether);

        vm.prank(UNISWAPX_DUTCH_V3_REACTOR);
        vm.expectRevert(ExecutorErrors.InsufficientOutput.selector);
        executor.reactorCallback(_singleOrder(0.01 ether, type(uint128).max), _route(1, 500));
    }

    function testForkSlippageReverts() public {
        _setUpForkExecutor();
        _fundExecutorWithWeth(0.01 ether);

        vm.prank(UNISWAPX_DUTCH_V3_REACTOR);
        vm.expectRevert();
        executor.reactorCallback(_singleOrder(0.01 ether, 1), _route(type(uint256).max, 500));
    }

    function testForkUnsupportedOutputShapeReverts() public {
        _setUpForkExecutor();
        _fundExecutorWithWeth(0.01 ether);

        ReactorStructs.ResolvedOrder[] memory orders = new ReactorStructs.ResolvedOrder[](1);
        ReactorStructs.OutputToken[] memory outputs = new ReactorStructs.OutputToken[](2);
        outputs[0] = ReactorStructs.OutputToken({token: USDC, amount: 1, recipient: address(0x1)});
        outputs[1] = ReactorStructs.OutputToken({token: WETH, amount: 1, recipient: address(0x2)});
        orders[0] = ReactorStructs.ResolvedOrder({
            info: _orderInfo(),
            input: ReactorStructs.InputToken({token: WETH, amount: 0.01 ether, maxAmount: 0.01 ether}),
            outputs: outputs,
            sig: "",
            hash: bytes32(0)
        });

        vm.prank(UNISWAPX_DUTCH_V3_REACTOR);
        vm.expectRevert(ExecutorErrors.UnsupportedOutputShape.selector);
        executor.reactorCallback(orders, _route(1, 500));
    }

    function testForkProfitSweepBehavior() public {
        _setUpForkExecutor();
        _fundExecutorWithWeth(0.01 ether);

        uint256 treasuryBefore = IERC20(USDC).balanceOf(TREASURY);
        vm.prank(UNISWAPX_DUTCH_V3_REACTOR);
        executor.reactorCallback(_singleOrder(0.01 ether, 1), _route(1, 500));

        require(IERC20(USDC).balanceOf(TREASURY) > treasuryBefore, "profit not swept");
    }

    function _setUpForkExecutor() private {
        string memory forkUrl = vm.envOr("ARB1_RPC_URL", "https://arb1-sequencer.arbitrum.io/rpc");
        vm.createSelectFork(forkUrl);
        adapter = new UniV3SwapRouter02Adapter(UNIV3_SWAP_ROUTER_02);
        executor = new UniswapXDutchV3Executor(
            UNISWAPX_DUTCH_V3_REACTOR, address(adapter), address(adapter), TREASURY, address(this)
        );
    }

    function _fundExecutorWithWeth(uint256 amount) private {
        vm.deal(address(this), amount);
        IWETH(WETH).deposit{value: amount}();
        IERC20(WETH).transfer(address(executor), amount);
    }

    function _singleOrder(uint256 inputAmount, uint256 requiredOutput)
        private
        pure
        returns (ReactorStructs.ResolvedOrder[] memory orders)
    {
        orders = new ReactorStructs.ResolvedOrder[](1);
        ReactorStructs.OutputToken[] memory outputs = new ReactorStructs.OutputToken[](1);
        outputs[0] = ReactorStructs.OutputToken({token: USDC, amount: requiredOutput, recipient: address(0xCAFE)});
        orders[0] = ReactorStructs.ResolvedOrder({
            info: _orderInfo(),
            input: ReactorStructs.InputToken({token: WETH, amount: inputAmount, maxAmount: inputAmount}),
            outputs: outputs,
            sig: "",
            hash: bytes32(0)
        });
    }

    function _orderInfo() private pure returns (ReactorStructs.OrderInfo memory) {
        return ReactorStructs.OrderInfo({
            reactor: UNISWAPX_DUTCH_V3_REACTOR,
            swapper: address(0xF00D),
            nonce: 1,
            deadline: type(uint256).max,
            additionalValidationContract: address(0),
            additionalValidationData: ""
        });
    }

    function _route(uint256 minOut, uint24 fee) private pure returns (bytes memory) {
        return abi.encode(
            ExecutorTypes.RoutePlan({
                venue: ExecutorTypes.VENUE_UNISWAP_V3,
                executionMode: 0,
                pathKind: ExecutorTypes.PATH_KIND_DIRECT,
                hopCount: 1,
                tokenIn: WETH,
                tokenOut: USDC,
                uniPoolFee: fee,
                encodedPath: "",
                limitSqrtPriceX96: 0,
                minAmountOut: minOut,
                targetOutput: 0,
                maxAmountIn: 0
            })
        );
    }

    receive() external payable {}
}
