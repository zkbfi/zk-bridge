// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MerkleTrie} from "./vendor/optimism/trie/MerkleTrie.sol";
import {RLPReader} from "./vendor/optimism/rlp/RLPReader.sol";
import {ReceiptLogs} from "./ReceiptLogs.sol";
import {BeaconProofVerifier} from "./BeaconProofVerifier.sol";

/// @title ReceiptProofLib
/// @notice The execution layer checks of a delivery of the message bridge: the receipt, the transaction and the log of a
/// message (checks 5 to 7 and the log of `executeMessage`). All of it is pure: it reads only its arguments.
/// @dev An external library, linked into `MessageBridge`. It exists so that each contract creation of the bridge stays
/// under the per-transaction gas cap of EIP-7825 (16,777,216): a library is deployed by a transaction of its own. A linked
/// library has no owner and no storage, and its address is fixed in the bytecode of the bridge, so the bridge stays
/// immutable. It reverts with the errors of `BeaconProofVerifier` (and `MalformedEventData` of the bridge, declared here
/// with the same signature), so the errors of a delivery are the same as before the split.
library ReceiptProofLib {
    /// @notice The log event data is not the encoding of one `bytes` value. The same error as
    /// `MessageBridge.MalformedEventData`.
    error MalformedEventData();

    /// @dev The index of `transactionsRoot` in the execution block header list.
    uint256 internal constant TRANSACTIONS_ROOT_FIELD = 4;
    /// @dev The index of `receiptsRoot` in the execution block header list.
    uint256 internal constant RECEIPTS_ROOT_FIELD = 5;

    /// @notice The receipt, the transaction and the log of a message, under an execution header whose hash the caller
    /// proved. Returns the identifier in the topic of the log, the encoded message of its data and the hash of the
    /// transaction at the index of the receipt.
    /// @dev Checks 5 to 7, then the log: the header roots, the receipt (which must record success), the transaction at
    /// the same trie key, the log at `logIndex`, its emitter (`emitter`), its topic 0 (`topic`) and two topics, and the
    /// event data (one `bytes` value in its one encoding). The caller checks `receiptIndex == transactionIndex` first.
    function provenLog(
        bytes calldata executionHeaderRlp,
        bytes[] calldata receiptProof,
        uint256 receiptIndex,
        bytes[] calldata transactionProof,
        uint256 logIndex,
        address emitter,
        bytes32 topic
    ) external pure returns (bytes32 topicMessageId, bytes memory encoded, bytes32 sourceTransactionHash) {
        bytes memory receipt;
        (receipt, sourceTransactionHash) =
            _receiptAndTransaction(executionHeaderRlp, receiptProof, receiptIndex, transactionProof);
        (topicMessageId, encoded) = _messageOf(receiptLog(receipt, logIndex), emitter, topic);
    }

    /// @dev Checks 5 and 6: the receipt and the hash of the transaction at the trie key `index`, under the roots of the
    /// execution header.
    function _receiptAndTransaction(
        bytes calldata executionHeaderRlp,
        bytes[] calldata receiptProof,
        uint256 index,
        bytes[] calldata transactionProof
    ) private pure returns (bytes memory receipt, bytes32 transactionHash) {
        RLPReader.RLPItem[] memory headerItems = RLPReader.readList(executionHeaderRlp);
        bytes32 receiptsRoot = headerRoot(headerItems, RECEIPTS_ROOT_FIELD);
        bytes32 transactionsRoot = headerRoot(headerItems, TRANSACTIONS_ROOT_FIELD);
        bytes memory key = encodeUint(index);
        receipt = MerkleTrie.get(key, receiptProof, receiptsRoot);
        transactionHash = keccak256(MerkleTrie.get(key, transactionProof, transactionsRoot));
    }

    /// @dev Checks the emitter and the topics of a log, then returns the identifier of its topic and the message of
    /// its data.
    function _messageOf(RLPReader.RLPItem memory log, address emitter, bytes32 topic)
        private
        pure
        returns (bytes32 topicMessageId, bytes memory encoded)
    {
        RLPReader.RLPItem[] memory logFields = logFieldsOf(log);
        requireEmitter(logFields[0], emitter);
        RLPReader.RLPItem[] memory topics = RLPReader.readList(logFields[1]);
        if (topics.length == 0) revert BeaconProofVerifier.WrongEventTopic(bytes32(0));
        bytes32 topic0 = toBytes32(RLPReader.readBytes(topics[0]));
        if (topic0 != topic) revert BeaconProofVerifier.WrongEventTopic(topic0);
        if (topics.length != 2) revert BeaconProofVerifier.MalformedLog();

        topicMessageId = toBytes32(RLPReader.readBytes(topics[1]));
        encoded = decodeBytes(RLPReader.readBytes(logFields[2]));
    }

    // ------------------------------------------------------------------ steps (internal, also used by tests)

    /// @dev A 32-byte root of the execution header: the item at `field`. Reverts on a short header or a wrong width.
    function headerRoot(RLPReader.RLPItem[] memory fields, uint256 field) internal pure returns (bytes32) {
        if (fields.length <= field) revert BeaconProofVerifier.MalformedExecutionHeader();
        bytes memory root = RLPReader.readBytes(fields[field]);
        if (root.length != 32) revert BeaconProofVerifier.MalformedExecutionHeader();
        return bytes32(root);
    }

    /// @dev Checks 6 and 7, up to the log. The receipt is an EIP-2718 envelope. It must record success. Returns the
    /// log at `logIndex`. The receipt may hold more than 32 logs.
    function receiptLog(bytes memory receipt, uint256 logIndex) internal pure returns (RLPReader.RLPItem memory) {
        RLPReader.RLPItem[] memory fields = RLPReader.readList(receiptPayload(receipt));
        if (fields.length != 4) revert BeaconProofVerifier.MalformedReceipt();
        bytes memory status = RLPReader.readBytes(fields[0]);
        if (status.length != 1 || status[0] != 0x01) revert BeaconProofVerifier.ReceiptFailed();

        (bool logFound, RLPReader.RLPItem memory log, uint256 logCount) = ReceiptLogs.itemAt(fields[3], logIndex);
        if (!logFound) revert BeaconProofVerifier.LogIndexOutOfRange(logIndex, logCount);
        return log;
    }

    /// @dev The three fields of a log: emitter, topics and data.
    function logFieldsOf(RLPReader.RLPItem memory log) internal pure returns (RLPReader.RLPItem[] memory fields) {
        fields = RLPReader.readList(log);
        if (fields.length != 3) revert BeaconProofVerifier.MalformedLog();
    }

    /// @dev Requires that the emitter item of a log is `expected`.
    function requireEmitter(RLPReader.RLPItem memory emitterItem, address expected) internal pure {
        bytes memory emitter = RLPReader.readBytes(emitterItem);
        if (emitter.length != 20) revert BeaconProofVerifier.MalformedLog();
        address emitterAddress = address(bytes20(emitter));
        if (emitterAddress != expected) revert BeaconProofVerifier.WrongEmitter(expected, emitterAddress);
    }

    /// @dev Reads the event data, which is `abi.encode(bytes)`: the offset 32, the length, the bytes padded to a word.
    /// Any other layout is refused, so one message has one encoding.
    function decodeBytes(bytes memory eventData) internal pure returns (bytes memory) {
        if (eventData.length < 64) revert MalformedEventData();
        (uint256 offset, uint256 length) = abi.decode(eventData, (uint256, uint256));
        if (offset != 32) revert MalformedEventData();
        if (eventData.length != 64 + ((length + 31) / 32) * 32) revert MalformedEventData();
        return abi.decode(eventData, (bytes));
    }

    /// @dev Strips the EIP-2718 type byte. Legacy receipts start with a list prefix (at least 0xc0). The result is an
    /// RLP item that points one byte into the receipt, so no byte is copied. A receipt of only a type byte gives an
    /// item of length zero, which the reader refuses.
    function receiptPayload(bytes memory receipt) internal pure returns (RLPReader.RLPItem memory payload) {
        if (receipt.length == 0) revert BeaconProofVerifier.MalformedReceipt();
        uint8 first = uint8(receipt[0]);
        payload = RLPReader.toRLPItem(receipt);
        if (first >= 0xc0) return payload;
        if (first < 0x01 || first > 0x04) revert BeaconProofVerifier.MalformedReceipt();
        payload.length -= 1;
        payload.ptr = RLPReader.MemoryPointer.wrap(RLPReader.MemoryPointer.unwrap(payload.ptr) + 1);
    }

    function toBytes32(bytes memory value) internal pure returns (bytes32) {
        if (value.length != 32) revert BeaconProofVerifier.MalformedLog();
        return bytes32(value);
    }

    /// @dev The RLP encoding of an unsigned integer, which is the receipts trie key of a transaction index.
    function encodeUint(uint256 value) internal pure returns (bytes memory) {
        if (value == 0) return hex"80";
        if (value < 0x80) return abi.encodePacked(uint8(value));
        uint256 length;
        for (uint256 rest = value; rest > 0; rest >>= 8) {
            length++;
        }
        bytes memory encoded = new bytes(length + 1);
        encoded[0] = bytes1(uint8(0x80 + length));
        for (uint256 i = 0; i < length; i++) {
            encoded[length - i] = bytes1(uint8(value >> (8 * i)));
        }
        return encoded;
    }
}
