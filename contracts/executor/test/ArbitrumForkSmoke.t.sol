// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface Vm {
    function createSelectFork(string calldata rpcUrl) external returns (uint256);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
}

contract ArbitrumForkSmokeTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant UNISWAPX_DUTCH_V3_REACTOR = 0xB274d5F4b833b61B340b654d600A864fB604a87c;
    address private constant UNISWAPX_ORDER_QUOTER = 0x88440407634F89873c5D9439987Ac4BE9725fea8;
    address private constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address private constant UNIV3_FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    address private constant UNIV3_QUOTER_V2 = 0x61fFE014bA17989E743c5F6cB21bF9697530B21e;
    address private constant UNIV3_SWAP_ROUTER_02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address private constant UNIVERSAL_ROUTER = 0xa51afafe0263b40edaef0df8781ea9aa03e381a3;
    address private constant TIMEBOOST_AUCTION_CONTRACT = 0x5fcb496a31b7AE91e7c9078Ec662bd7A55cd3079;

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
}
