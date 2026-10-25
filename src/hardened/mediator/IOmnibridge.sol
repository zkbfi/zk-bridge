// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IOmnibridge
/// @notice The one function of the OmniBridge mediator that the routers of OmniBridge call.
interface IOmnibridge {
    function relayTokens(address token, address receiver, uint256 value) external;
}
