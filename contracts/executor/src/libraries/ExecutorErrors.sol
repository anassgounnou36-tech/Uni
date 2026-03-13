// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library ExecutorErrors {
    error UnauthorizedCaller();
    error Paused();
    error UnsupportedOrderShape();
    error UnsupportedOutputShape();
    error BadRoute();
    error TokenMismatch();
    error InsufficientInput();
    error InsufficientOutput();
    error SlippageExceeded();
    error ZeroAddress();
    error NotOwner();
    error Reentrancy();
}
