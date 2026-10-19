// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FakeDepositEmitter
/// @notice Emits the vault's `DepositInitiated` event with no tokens behind it (H-02).
contract FakeDepositEmitter {
    event DepositInitiated(
        address indexed token,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        bytes32 nonce,
        uint64 targetChainId
    );

    function fakeDeposit(address token, address recipient, uint256 amount, bytes32 nonce, uint64 targetChainId)
        external
    {
        emit DepositInitiated(token, msg.sender, recipient, amount, nonce, targetChainId);
    }
}
