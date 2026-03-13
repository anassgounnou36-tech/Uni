// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Executor} from "../src/Executor.sol";

contract ExecutorTest {
    function testDeploys() public {
        Executor executor = new Executor();
        require(executor.VERSION() == 1, "unexpected version");
    }
}
