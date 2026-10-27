// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOmnibridge} from "./IOmnibridge.sol";
import {IAMB} from "../IAMB.sol";

/// @title ITokenMediator
/// @notice The functions of `TokenMediator` that the routers call. The relay functions are the OmniBridge functions.
/// The overloads with a `gasLimit` are new: OmniBridge has no such function, because its owner sets the gas limits.
interface ITokenMediator is IOmnibridge {
    function relayTokensAndCall(address token, address receiver, uint256 value, bytes calldata data) external;

    /// @notice Relays tokens of the caller to `receiver`, with a gas limit that the caller chooses.
    /// @param gasLimit The gas that the call on the other chain gets, at least. The mediator uses the larger of this
    /// value and the default of the message, and refuses a value above the maximum of the message bridge.
    function relayTokens(address token, address receiver, uint256 value, uint256 gasLimit) external;

    /// @notice Relays tokens of the caller to `receiver` and calls it, with a gas limit that the caller chooses.
    /// @param gasLimit The gas that the call on the other chain gets, at least. See the overload of `relayTokens`.
    function relayTokensAndCall(address token, address receiver, uint256 value, bytes calldata data, uint256 gasLimit)
        external;

    function bridgeContract() external view returns (IAMB);
}
