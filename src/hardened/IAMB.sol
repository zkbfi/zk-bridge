// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAMB
/// @notice The Arbitrary Message Bridge interface, as OmniBridge defines it (`omni/omnibridge`,
/// `contracts/interfaces/IAMB.sol`). `MessageBridge` implements it and adds `executeMessage`. The mediator codes
/// against this interface only and never calls `executeMessage`.
/// @dev `UserRequestForSignature` and `RelayedMessage` stay in the interface for compatibility. A bridge without
/// validators never emits them.
interface IAMB {
    /// @notice Emitted by every send. `encodedData` is the Arbitrary Message Bridge message encoding.
    event UserRequestForAffirmation(bytes32 indexed messageId, bytes encodedData);
    /// @notice Never emitted by a bridge without validators.
    event UserRequestForSignature(bytes32 indexed messageId, bytes encodedData);
    /// @notice Emitted on every execution of a message. `MessageBridge` emits it only for a delivery that succeeded: a
    /// delivery whose call fails reverts. So `status` is always true there.
    event AffirmationCompleted(
        address indexed sender, address indexed executor, bytes32 indexed messageId, bool status
    );
    /// @notice Never emitted by a bridge without validators.
    event RelayedMessage(address indexed sender, address indexed executor, bytes32 indexed messageId, bool status);

    /// @notice The sender of the message on the other chain. Set only during the call to the target.
    function messageSender() external view returns (address);

    /// @notice The ceiling of the gas that a message may ask for. `MessageBridge` reads no gas from a message and answers
    /// the width of the gas field.
    function maxGasPerTx() external view returns (uint256);

    /// @notice The source transaction hash of the message. Set only during the call to the target.
    function transactionHash() external view returns (bytes32);

    /// @notice The identifier of the message. Set only during the call to the target.
    function messageId() external view returns (bytes32);

    /// @notice The identifier of the chain that sent the message. Set only during the call to the target.
    function messageSourceChainId() external view returns (bytes32);

    /// @notice Whether the call to the target of a message succeeded. On `MessageBridge`: whether the message was
    /// delivered.
    function messageCallStatus(bytes32 _messageId) external view returns (bool);

    /// @notice The hash of the data of a message whose call failed. Always zero on `MessageBridge`, where a failed call
    /// reverts the delivery.
    function failedMessageDataHash(bytes32 _messageId) external view returns (bytes32);

    /// @notice The target of a message whose call failed.
    function failedMessageReceiver(bytes32 _messageId) external view returns (address);

    /// @notice The sender of a message whose call failed.
    function failedMessageSender(bytes32 _messageId) external view returns (address);

    /// @notice Sends a message to `_contract` on the other chain.
    /// @param _contract The target on the other chain.
    /// @param _data The call data.
    /// @param _gas The gas that the call to the target gets. `MessageBridge` ignores it: the target gets all the gas of
    /// the delivery.
    /// @return The message identifier.
    function requireToPassMessage(address _contract, bytes calldata _data, uint256 _gas) external returns (bytes32);

    /// @notice The same as `requireToPassMessage`. This bridge has no separate manual lane.
    function requireToConfirmMessage(address _contract, bytes calldata _data, uint256 _gas) external returns (bytes32);

    /// @notice The identifier of this chain.
    function sourceChainId() external view returns (uint256);

    /// @notice The identifier of the other chain.
    function destinationChainId() external view returns (uint256);
}
