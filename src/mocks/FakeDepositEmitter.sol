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

    /// @dev The hardened vault event. It has a final `destinationVault` parameter, so its topic differs from the
    /// revision 2 event above. Both events share one name; the signatures tell them apart.
    event DepositInitiated(
        address indexed token,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        bytes32 nonce,
        uint64 targetChainId,
        address destinationVault
    );

    /// @notice Emits the hardened event. The revision 2 tests still call `fakeDeposit`, which emits the old event.
    function fakeHardenedDeposit(
        address token,
        address recipient,
        uint256 amount,
        bytes32 nonce,
        uint64 targetChainId,
        address destinationVault
    ) external {
        emit DepositInitiated(token, msg.sender, recipient, amount, nonce, targetChainId, destinationVault);
    }

    function fakeDeposit(address token, address recipient, uint256 amount, bytes32 nonce, uint64 targetChainId)
        external
    {
        emit DepositInitiated(token, msg.sender, recipient, amount, nonce, targetChainId);
    }
}
