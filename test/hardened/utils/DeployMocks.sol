// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFlowLimiter} from "../../../src/hardened/IFlowLimiter.sol";

/// @notice A flow limiter for the deploy tests. It admits everything. The deploy tests only need an address with code
/// that the mediator stores.
contract DeployFlowLimiter is IFlowLimiter {
    function checkDeposit(address, address, uint256) external {}

    function checkWithdrawal(address, address, uint256, bytes32) external {}
}
