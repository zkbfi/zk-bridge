// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWETH} from "./IWETH.sol";
import {ITokenMediator} from "./ITokenMediator.sol";

/// @title WETHOmnibridgeRouter
/// @notice Sends the native coin through the mediator as the wrapped token, and unwraps it on delivery. It follows
/// `WETHOmnibridgeRouter` of OmniBridge (`contracts/helpers/WETHOmnibridgeRouter.sol`) without its owner and
/// `claimTokens`. The mediator handles tokens only, so the router wraps and unwraps.
/// @dev Send: `wrapAndRelayTokens` wraps the coin and relays the wrapped token. The fallback address on the other chain
/// is the caller, not the router, because the router may not exist there. Receive: a sender relays the wrapped token
/// with `relayTokensAndCall` to this router on the destination chain, with the 20 byte address of the coin receiver as
/// data. The mediator calls `onTokenBridged`, and the router unwraps and sends the coin.
///
/// Divergence from OmniBridge: when the receiver cannot take the coin, the router wraps it again and sends the wrapped
/// token. OmniBridge reverts, which would leave the tokens in a router that has no owner to recover them. The router
/// sends the coin with a fixed gas amount (`NATIVE_SEND_GAS`), not with all its gas. A receiver that burns gas then
/// cannot leave the router too little gas for the fallback.
contract WETHOmnibridgeRouter {
    using SafeERC20 for IWETH;

    /// @notice The caller of `onTokenBridged` is not the mediator.
    error NotMediator(address caller);
    /// @notice The token is not the wrapped token of this router.
    error NotWrappedToken(address token);
    /// @notice The data is not the 20 byte address of the receiver.
    error InvalidReceiverData(uint256 length);
    /// @notice The coin came from an account that is not the wrapped token.
    error NotWrappedTokenSender(address sender);
    /// @notice A relay with a call needs data, because the mediator calls only when there is data.
    error EmptyData();

    /// @notice The gas that the router gives the receiver of the native coin. It is enough for the `receive` function of
    /// a smart-contract wallet, and it is a bound: a receiver cannot burn more.
    uint256 public constant NATIVE_SEND_GAS = 50_000;

    /// @notice The mediator on this chain.
    ITokenMediator public immutable bridge;
    /// @notice The wrapped native token.
    IWETH public immutable WETH;

    /// @param bridge_ The mediator on this chain.
    /// @param weth The wrapped native token (WETH or WPLS).
    constructor(ITokenMediator bridge_, IWETH weth) {
        bridge = bridge_;
        WETH = weth;
        weth.approve(address(bridge_), type(uint256).max);
    }

    /// @notice Wraps the coin and relays it to the caller on the other chain.
    function wrapAndRelayTokens() external payable {
        _wrapAndRelay(msg.sender, "");
    }

    /// @notice Wraps the coin and relays it to `receiver` on the other chain.
    function wrapAndRelayTokens(address receiver) external payable {
        _wrapAndRelay(receiver, "");
    }

    /// @notice Wraps the coin, relays it to `receiver` and calls `onTokenBridged` on it with `data`.
    function relayTokensAndCall(address receiver, bytes calldata data) external payable {
        if (data.length == 0) revert EmptyData();
        _wrapAndRelay(receiver, data);
    }

    /// @notice The callback of the mediator. It unwraps the received wrapped token and sends the coin.
    /// @param token The wrapped token on this chain.
    /// @param value The amount that the mediator sent to the router.
    /// @param data The 20 byte address of the receiver of the coin.
    function onTokenBridged(address token, uint256 value, bytes memory data) external {
        if (msg.sender != address(bridge)) revert NotMediator(msg.sender);
        if (token != address(WETH)) revert NotWrappedToken(token);
        if (data.length != 20) revert InvalidReceiverData(data.length);
        address receiver = address(bytes20(data));

        WETH.withdraw(value);
        (bool sent,) = receiver.call{value: value, gas: NATIVE_SEND_GAS}("");
        if (sent) return;
        WETH.deposit{value: value}();
        WETH.safeTransfer(receiver, value);
    }

    /// @notice Accepts the coin from the wrapped token only, when it unwraps.
    receive() external payable {
        if (msg.sender != address(WETH)) revert NotWrappedTokenSender(msg.sender);
    }

    function _wrapAndRelay(address receiver, bytes memory data) private {
        WETH.deposit{value: msg.value}();
        bridge.relayTokensWithFallback(address(WETH), receiver, msg.value, data, msg.sender);
    }
}
