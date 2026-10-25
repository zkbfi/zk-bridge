// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title AmbMessageCodec
/// @notice The Arbitrary Message Bridge message encoding, byte for byte as OmniBridge has it.
/// @dev Sources, read on 2026-10-24 at commit 908a48107919d4ab127f9af07d44d47eac91547e of
/// `poanetwork/tokenbridge-contracts`:
/// - `contracts/upgradeable_contracts/arbitrary_message/MessageDelivery.sol`: `_packHeader` writes the message, and
///   `_getNewMessageId` builds the message identifier.
/// - `contracts/libraries/ArbitraryMessage.sol`: `unpackData` reads it, and its comment lists the offsets.
/// - `contracts/upgradeable_contracts/arbitrary_message/VersionableAMB.sol`: `MESSAGE_PACKING_VERSION`.
/// - `contracts/upgradeable_contracts/arbitrary_message/BasicAMB.sol`: `_setChainIds` fixes the chain identifier
///   lengths (the fewest bytes that hold the value, so leading zero bytes are not kept).
///
/// The layout, with offsets in bytes:
///
///     0  : 32 bytes  message identifier
///     32 : 20 bytes  sender
///     52 : 20 bytes  executor (the target)
///     72 : 4 bytes   gas limit (uint32)
///     76 : 1 byte    length X of the source chain identifier
///     77 : 1 byte    length Y of the destination chain identifier
///     78 : 1 byte    data type (0x00 for `requireToPassMessage`, 0x80 for `requireToConfirmMessage`)
///     79 : X bytes   source chain identifier
///     79 + X : Y bytes destination chain identifier
///     79 + X + Y : the rest, the call data
///
/// The message identifier is `MESSAGE_PACKING_VERSION | (keccak256(chainId, bridge) & BRIDGE_ID_MASK) | nonce`, where
/// `chainId` is the 32 byte source chain identifier, `bridge` is the 20 byte address of the sending bridge, and the
/// nonce takes the lowest 8 bytes. The bytes 4 to 23 of the hash are kept. The nonce only makes identifiers unique.
library AmbMessageCodec {
    /// @notice The message is shorter than its header says, or a chain identifier length is not 1 to 32.
    error MalformedMessage();

    /// @notice The message format version. It stands in the top 4 bytes of every message identifier.
    bytes32 internal constant MESSAGE_PACKING_VERSION = bytes32(uint256(0x00050000) << 224);

    /// @notice The bytes of the hash of (chain identifier, bridge) that stand in the message identifier.
    bytes32 internal constant BRIDGE_ID_MASK = 0x00000000ffffffffffffffffffffffffffffffffffffffff0000000000000000;

    /// @notice The data type of a message sent with `requireToPassMessage`.
    uint8 internal constant DATA_TYPE_PASS = 0x00;

    /// @notice The data type of a message sent with `requireToConfirmMessage`.
    uint8 internal constant DATA_TYPE_CONFIRM = 0x80;

    /// @dev The fixed part of the header: 32 + 20 + 20 + 4 + 1 + 1 + 1 bytes.
    uint256 private constant FIXED_HEADER_LENGTH = 79;

    /// @notice The fields of a message, without the call data.
    struct Header {
        bytes32 messageId;
        address sender;
        address executor;
        uint32 gasLimit;
        uint8 dataType;
        uint256 sourceChainId;
        uint256 destinationChainId;
    }

    /// @notice The bytes of a message identifier that no bridge writes and a receiver checks: the version.
    /// @param messageId The identifier.
    function hasValidVersion(bytes32 messageId) internal pure returns (bool) {
        return messageId & 0xffffffff00000000000000000000000000000000000000000000000000000000 == MESSAGE_PACKING_VERSION;
    }

    /// @notice The identifier prefix of a bridge: the version and the bridge part. Add the nonce to get an identifier.
    /// @param sourceChainId The chain identifier of the sending bridge.
    /// @param bridge The address of the sending bridge.
    function messageIdPrefix(uint256 sourceChainId, address bridge) internal pure returns (bytes32) {
        return MESSAGE_PACKING_VERSION | (keccak256(abi.encodePacked(sourceChainId, bridge)) & BRIDGE_ID_MASK);
    }

    /// @notice Writes a message.
    /// @param header The fields. `gasLimit` and the chain identifiers are written as the format says.
    /// @param data The call data.
    function encode(Header memory header, bytes calldata data) internal pure returns (bytes memory) {
        uint256 sourceLength = chainIdLength(header.sourceChainId);
        uint256 destinationLength = chainIdLength(header.destinationChainId);
        return abi.encodePacked(
            header.messageId,
            header.sender,
            header.executor,
            header.gasLimit,
            uint8(sourceLength),
            uint8(destinationLength),
            header.dataType,
            _chainIdBytes(header.sourceChainId, sourceLength),
            _chainIdBytes(header.destinationChainId, destinationLength),
            data
        );
    }

    /// @notice Reads a message.
    /// @param encoded The message, as `encode` writes it.
    /// @return header The fields.
    /// @return data The call data. It is a copy.
    function decode(bytes memory encoded) internal view returns (Header memory header, bytes memory data) {
        if (encoded.length < FIXED_HEADER_LENGTH) revert MalformedMessage();
        uint256 sourceLength;
        uint256 destinationLength;
        assembly {
            mstore(header, mload(add(encoded, 32)))
            mstore(add(header, 32), shr(96, mload(add(encoded, 64))))
            mstore(add(header, 64), shr(96, mload(add(encoded, 84))))
            mstore(add(header, 96), shr(224, mload(add(encoded, 104))))
            sourceLength := byte(0, mload(add(encoded, 108)))
            destinationLength := byte(0, mload(add(encoded, 109)))
            mstore(add(header, 128), byte(0, mload(add(encoded, 110))))
        }
        if (sourceLength == 0 || sourceLength > 32 || destinationLength == 0 || destinationLength > 32) {
            revert MalformedMessage();
        }
        uint256 dataStart = FIXED_HEADER_LENGTH + sourceLength + destinationLength;
        if (encoded.length < dataStart) revert MalformedMessage();
        uint256 destinationStart = FIXED_HEADER_LENGTH + sourceLength;
        assembly {
            mstore(
                add(header, 160),
                shr(sub(256, shl(3, sourceLength)), mload(add(encoded, add(32, FIXED_HEADER_LENGTH))))
            )
            mstore(
                add(header, 192),
                shr(sub(256, shl(3, destinationLength)), mload(add(encoded, add(32, destinationStart))))
            )
        }
        data = _copy(encoded, dataStart);
    }

    /// @notice The fewest bytes that hold a chain identifier: 1 to 32 (an identifier of zero takes one byte).
    /// @param chainId The chain identifier.
    function chainIdLength(uint256 chainId) internal pure returns (uint256 length) {
        length = 1;
        while (length < 32 && chainId >> (8 * length) != 0) {
            length++;
        }
    }

    /// @dev The low `length` bytes of `chainId`, most significant first.
    function _chainIdBytes(uint256 chainId, uint256 length) private pure returns (bytes memory encoded) {
        encoded = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            encoded[length - 1 - i] = bytes1(uint8(chainId >> (8 * i)));
        }
    }

    /// @dev The bytes of `source` from `start` to its end, in new memory. The copy goes through the identity precompile.
    function _copy(bytes memory source, uint256 start) private view returns (bytes memory copy) {
        uint256 length = source.length - start;
        copy = new bytes(length);
        bool ok;
        assembly {
            ok := staticcall(gas(), 4, add(add(source, 32), start), length, add(copy, 32), length)
        }
        if (!ok) revert MalformedMessage();
    }
}
