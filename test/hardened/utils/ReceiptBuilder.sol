// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {TrieBuilder} from "./TrieBuilder.sol";

/// @title ReceiptBuilder
/// @notice Builds receipts, transactions and whole blocks of them inside a test, so that a test can prove a log that a
/// real contract emitted. The tries come from `TrieBuilder`.
library ReceiptBuilder {
    /// @dev The cumulative gas of a receipt that the caller does not choose.
    uint256 internal constant DEFAULT_CUMULATIVE_GAS = 300_000;
    /// @dev The type of every filler entry.
    uint8 internal constant FILLER_TYPE = 2;

    /// @notice The status field of a receipt.
    enum ReceiptStatus {
        Success,
        Failure
    }

    /// @notice One log of a receipt.
    struct LogEntry {
        address emitter;
        bytes32[] topics;
        bytes data;
    }

    /// @notice The receipts and the transactions of one block, with the root of each trie.
    struct Block {
        bytes[] receipts;
        bytes[] transactions;
        bytes32 receiptsRoot;
        bytes32 transactionsRoot;
    }

    /// @notice The reason that `assemble` refuses its input.
    error IndexOutOfRange(uint256 index, uint256 count);

    /// @notice Turns a log that `vm.getRecordedLogs` returned into a log entry.
    /// @param recorded The recorded log.
    /// @return The log entry with the same emitter, topics and data.
    function fromRecorded(Vm.Log memory recorded) internal pure returns (LogEntry memory) {
        return LogEntry({emitter: recorded.emitter, topics: recorded.topics, data: recorded.data});
    }

    /// @notice Encodes a receipt in its consensus form: RLP of status, cumulative gas, logs bloom and logs.
    /// @dev Type 0 has no type byte. Every other type gets its value as the first byte, so a test can build a type that
    /// the bridge does not support. The logs bloom is 256 zero bytes. The bridge does not read it.
    /// @param receiptType The type of the transaction that the receipt belongs to.
    /// @param status Whether the transaction succeeded.
    /// @param logs The logs of the receipt.
    /// @return The encoded receipt.
    function receipt(uint8 receiptType, ReceiptStatus status, LogEntry[] memory logs)
        internal
        pure
        returns (bytes memory)
    {
        return _receipt(receiptType, status, DEFAULT_CUMULATIVE_GAS, logs);
    }

    /// @notice Encodes a transaction that looks like a signed one.
    /// @dev The bytes are not a valid signed transaction: the signature is a fixed dummy. The bridge only hashes them.
    /// The content depends on `payload`, so a different payload gives a different hash. Type 0 is a bare list. Every
    /// other type gets its value as the first byte and the field layout of a dynamic fee transaction.
    /// @param transactionType The type byte, or 0 for a legacy transaction.
    /// @param payload The call data of the transaction.
    /// @return The encoded transaction.
    function transaction(uint8 transactionType, bytes memory payload) internal pure returns (bytes memory) {
        if (transactionType == 0) return _legacyTransaction(payload);
        return bytes.concat(bytes1(transactionType), _typedTransactionBody(payload));
    }

    /// @notice A receipt without logs for a block position. Different seeds give different receipts.
    /// @param seed The position of the receipt in its block.
    /// @return The encoded receipt.
    function fillerReceipt(uint256 seed) internal pure returns (bytes memory) {
        return _receipt(FILLER_TYPE, ReceiptStatus.Success, 21_000 * (seed + 1), new LogEntry[](0));
    }

    /// @notice A transaction for a block position. Different seeds give different transactions.
    /// @param seed The position of the transaction in its block.
    /// @return The encoded transaction.
    function fillerTransaction(uint256 seed) internal pure returns (bytes memory) {
        return transaction(FILLER_TYPE, abi.encodePacked("filler", seed));
    }

    /// @notice Builds a block of `count` entries where one position holds the real receipt and transaction.
    /// @param count The number of receipts and of transactions.
    /// @param index The position of the real entries.
    /// @param realReceipt The receipt at `index`.
    /// @param realTransaction The transaction at `index`.
    /// @return built The block with both trie roots.
    function assemble(uint256 count, uint256 index, bytes memory realReceipt, bytes memory realTransaction)
        internal
        pure
        returns (Block memory built)
    {
        if (index >= count) revert IndexOutOfRange(index, count);
        built.receipts = new bytes[](count);
        built.transactions = new bytes[](count);
        for (uint256 i = 0; i < count; i++) {
            built.receipts[i] = i == index ? realReceipt : fillerReceipt(i);
            built.transactions[i] = i == index ? realTransaction : fillerTransaction(i);
        }
        built.receiptsRoot = TrieBuilder.indexedRoot(built.receipts);
        built.transactionsRoot = TrieBuilder.indexedRoot(built.transactions);
    }

    /// @notice The proof of the receipt at `index`.
    /// @param assembled The block.
    /// @param index The position of the receipt.
    /// @return The nodes from the root to the leaf.
    function receiptProofOf(Block memory assembled, uint256 index) internal pure returns (bytes[] memory) {
        return TrieBuilder.indexedProof(assembled.receipts, index);
    }

    /// @notice The proof of the transaction at `index`.
    /// @param assembled The block.
    /// @param index The position of the transaction.
    /// @return The nodes from the root to the leaf.
    function transactionProofOf(Block memory assembled, uint256 index) internal pure returns (bytes[] memory) {
        return TrieBuilder.indexedProof(assembled.transactions, index);
    }

    // ---------------------------------------------------------------- encoding

    function _receipt(uint8 receiptType, ReceiptStatus status, uint256 cumulativeGas, LogEntry[] memory logs)
        private
        pure
        returns (bytes memory)
    {
        bytes[] memory encodedLogs = new bytes[](logs.length);
        for (uint256 i = 0; i < logs.length; i++) {
            encodedLogs[i] = _encodeLog(logs[i]);
        }
        bytes[] memory fields = new bytes[](4);
        fields[0] = TrieBuilder.encodeBytes(status == ReceiptStatus.Success ? bytes(hex"01") : bytes(""));
        fields[1] = TrieBuilder.encodeUint(cumulativeGas);
        fields[2] = TrieBuilder.encodeBytes(new bytes(256));
        fields[3] = TrieBuilder.encodeList(encodedLogs);
        bytes memory body = TrieBuilder.encodeList(fields);
        if (receiptType == 0) return body;
        return bytes.concat(bytes1(receiptType), body);
    }

    function _encodeLog(LogEntry memory entry) private pure returns (bytes memory) {
        bytes[] memory encodedTopics = new bytes[](entry.topics.length);
        for (uint256 i = 0; i < entry.topics.length; i++) {
            encodedTopics[i] = TrieBuilder.encodeBytes(abi.encodePacked(entry.topics[i]));
        }
        bytes[] memory fields = new bytes[](3);
        fields[0] = TrieBuilder.encodeBytes(abi.encodePacked(entry.emitter));
        fields[1] = TrieBuilder.encodeList(encodedTopics);
        fields[2] = TrieBuilder.encodeBytes(entry.data);
        return TrieBuilder.encodeList(fields);
    }

    function _legacyTransaction(bytes memory payload) private pure returns (bytes memory) {
        bytes[] memory fields = new bytes[](9);
        fields[0] = TrieBuilder.encodeBytes(hex"07");
        fields[1] = TrieBuilder.encodeBytes(hex"3b9aca00");
        fields[2] = TrieBuilder.encodeBytes(hex"0493e0");
        fields[3] = TrieBuilder.encodeBytes(abi.encodePacked(address(0xB1D6E)));
        fields[4] = TrieBuilder.encodeBytes("");
        fields[5] = TrieBuilder.encodeBytes(payload);
        fields[6] = TrieBuilder.encodeBytes(hex"25");
        fields[7] = TrieBuilder.encodeBytes(abi.encodePacked(keccak256("signature r")));
        fields[8] = TrieBuilder.encodeBytes(abi.encodePacked(keccak256("signature s")));
        return TrieBuilder.encodeList(fields);
    }

    function _typedTransactionBody(bytes memory payload) private pure returns (bytes memory) {
        bytes[] memory fields = new bytes[](12);
        fields[0] = TrieBuilder.encodeBytes(hex"0171");
        fields[1] = TrieBuilder.encodeBytes(hex"07");
        fields[2] = TrieBuilder.encodeBytes(hex"3b9aca00");
        fields[3] = TrieBuilder.encodeBytes(hex"77359400");
        fields[4] = TrieBuilder.encodeBytes(hex"0493e0");
        fields[5] = TrieBuilder.encodeBytes(abi.encodePacked(address(0xB1D6E)));
        fields[6] = TrieBuilder.encodeBytes("");
        fields[7] = TrieBuilder.encodeBytes(payload);
        fields[8] = TrieBuilder.encodeList(new bytes[](0));
        fields[9] = TrieBuilder.encodeBytes("");
        fields[10] = TrieBuilder.encodeBytes(abi.encodePacked(keccak256("signature r")));
        fields[11] = TrieBuilder.encodeBytes(abi.encodePacked(keccak256("signature s")));
        return TrieBuilder.encodeList(fields);
    }
}
