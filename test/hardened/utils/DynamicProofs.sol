// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {BeaconLightClient} from "../../../src/hardened/BeaconLightClient.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";
import {MessageFixtures} from "./MessageFixtures.sol";
import {ReceiptBuilder} from "./ReceiptBuilder.sol";
import {WithdrawalScenes} from "./WithdrawalScenes.sol";

/// @notice Builds a message proof from the logs that a real contract emitted in a test. The fixture proofs of
/// `MessageFixtures` cover fixed messages. A test that sends a message through a real `MessageBridge` and delivers it on
/// the other side needs a proof of that log, which this contract builds on the spot: it puts the logs of the sending call
/// into a receipt, puts the receipt and a transaction into tries (with filler entries around them), puts the roots into
/// an execution header, and builds the beacon part with the scenes of `WithdrawalScenes`.
///
/// The beacon part is the same synthetic one as in the other tests: the header chain is built here and stored in the
/// light client that the destination bridge reads. The tries are real Merkle Patricia tries, with branch and extension
/// nodes (see `TrieBuilder`).
abstract contract DynamicProofs is WithdrawalScenes {
    /// @notice What a source block holds around the message: the transaction that sent it, and how that transaction sits
    /// in its block.
    /// @param receiptType The receipt type byte: 0 is a legacy receipt, 1 to 4 are typed receipts.
    /// @param status Whether the receipt records success.
    /// @param logs Every log of the transaction, in order. The proof names one of them.
    /// @param transactionType The type byte of the transaction.
    /// @param transactionPayload Bytes that make the transaction unique. They stand for the content of the transaction.
    /// @param blockSize The number of transactions in the block. The others are fillers.
    /// @param index The position of the transaction in the block. It is the trie key of the receipt and of the transaction.
    struct SourceTransaction {
        uint8 receiptType;
        ReceiptBuilder.ReceiptStatus status;
        ReceiptBuilder.LogEntry[] logs;
        uint8 transactionType;
        bytes transactionPayload;
        uint256 blockSize;
        uint256 index;
    }

    /// @dev Makes the payload of each transaction unique, so no two transactions of a test share a hash.
    uint256 private _transactionCounter;

    /// @notice The source transaction of a recorded call: a successful type 2 receipt that holds every recorded log, in a
    /// block of eight transactions, at position 3.
    /// @param recorded The logs that `vm.getRecordedLogs` returned for the call.
    function _sourceTransactionOf(Vm.Log[] memory recorded) internal returns (SourceTransaction memory source) {
        source.receiptType = 2;
        source.status = ReceiptBuilder.ReceiptStatus.Success;
        source.logs = new ReceiptBuilder.LogEntry[](recorded.length);
        for (uint256 i = 0; i < recorded.length; i++) {
            source.logs[i] = ReceiptBuilder.fromRecorded(recorded[i]);
        }
        source.transactionType = 2;
        source.transactionPayload = abi.encode("source transaction", _transactionCounter++);
        source.blockSize = 8;
        source.index = 3;
    }

    /// @notice The position of the first log that `emitter` emitted with `topic0`, among the recorded logs.
    /// @dev Reverts when there is none, so a test that forgot to send fails here and not later in a proof.
    function _logIndexOf(Vm.Log[] memory recorded, address emitter, bytes32 topic0) internal pure returns (uint256) {
        for (uint256 i = 0; i < recorded.length; i++) {
            if (recorded[i].emitter != emitter) continue;
            if (recorded[i].topics.length == 0 || recorded[i].topics[0] != topic0) continue;
            return i;
        }
        revert("DynamicProofs: the recorded logs hold no log of that emitter and topic");
    }

    /// @notice The hash that a target sees as `transactionHash()`: the hash of the transaction of `source`.
    function _transactionHashOf(SourceTransaction memory source) internal pure returns (bytes32) {
        return keccak256(ReceiptBuilder.transaction(source.transactionType, source.transactionPayload));
    }

    /// @notice Builds the proof of log `logIndex` of `source` for `destination`. It stores the beacon part in `client`
    /// (the light client that `destination` reads, which tracks the chain of `source` under `genesisRoot`) and adds the
    /// fork layouts to `destination`.
    /// @return proof The evidence for `destination.executeMessage`.
    /// @return transactionHash The hash of the source transaction, which the target must see.
    function _proveMessage(
        MessageBridge destination,
        BeaconLightClient client,
        bytes32 genesisRoot,
        SourceTransaction memory source,
        uint256 logIndex
    ) internal returns (MessageBridge.MessageProof memory proof, bytes32 transactionHash) {
        bytes memory transaction = ReceiptBuilder.transaction(source.transactionType, source.transactionPayload);
        ReceiptBuilder.Block memory assembled = ReceiptBuilder.assemble(
            source.blockSize,
            source.index,
            ReceiptBuilder.receipt(source.receiptType, source.status, source.logs),
            transaction
        );
        SceneParams memory params = _defaultParams();
        params.genesisRoot = genesisRoot;
        Scene memory scene = _buildScene(
            MessageFixtures.deliver(),
            params,
            _executionHeaderRlp(assembled.receiptsRoot, assembled.transactionsRoot, 17)
        );
        _storeScene(client, genesisRoot, params, scene);
        _addLayouts(destination, client, params, scene);

        proof = _clone(scene.proof);
        proof.receiptProof = ReceiptBuilder.receiptProofOf(assembled, source.index);
        proof.receiptIndex = source.index;
        proof.transactionProof = ReceiptBuilder.transactionProofOf(assembled, source.index);
        proof.transactionIndex = source.index;
        proof.logIndex = logIndex;
        transactionHash = keccak256(transaction);
    }
}
