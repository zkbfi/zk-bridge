// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {MerkleTrie} from "../../src/hardened/vendor/optimism/trie/MerkleTrie.sol";
import {RLPReader} from "../../src/hardened/vendor/optimism/rlp/RLPReader.sol";
import {ReceiptLogs} from "../../src/hardened/ReceiptLogs.sol";
import {TrieBuilder} from "./utils/TrieBuilder.sol";
import {ReceiptBuilder} from "./utils/ReceiptBuilder.sol";

/// @notice Runs the vendored trie reader and the receipt reader behind an external call. A revert then happens in its own
/// call frame, so a test can expect it, and each proof is built in fresh memory.
contract TrieHarness {
    function get(bytes memory key, bytes[] memory proof, bytes32 root) external pure returns (bytes memory) {
        return MerkleTrie.get(key, proof, root);
    }

    function indexedProof(bytes[] memory values, uint256 index) external pure returns (bytes[] memory) {
        return TrieBuilder.indexedProof(values, index);
    }

    function indexedProofs(bytes[] memory values) external pure returns (bytes[][] memory) {
        return TrieBuilder.indexedProofs(values);
    }

    function proofOf(bytes[] memory keys, bytes[] memory values, uint256 position)
        external
        pure
        returns (bytes[] memory)
    {
        return TrieBuilder.proofOf(keys, values, position);
    }

    function rootOf(bytes[] memory keys, bytes[] memory values) external pure returns (bytes32) {
        return TrieBuilder.rootOf(keys, values);
    }

    function assemble(uint256 count, uint256 index, bytes memory realReceipt, bytes memory realTransaction)
        external
        pure
        returns (ReceiptBuilder.Block memory)
    {
        return ReceiptBuilder.assemble(count, index, realReceipt, realTransaction);
    }

    /// @dev Reads a receipt the way the bridge does: strip a type byte below 0xc0, read four fields, step to the log
    /// with `ReceiptLogs.itemAt`, read the three fields of the log.
    function decode(bytes memory receipt, uint256 logIndex)
        external
        pure
        returns (
            bytes memory status,
            bytes memory emitter,
            bytes32[] memory topics,
            bytes memory data,
            uint256 logCount
        )
    {
        RLPReader.RLPItem memory payload = RLPReader.toRLPItem(receipt);
        if (uint8(receipt[0]) < 0xc0) {
            payload.length -= 1;
            payload.ptr = RLPReader.MemoryPointer.wrap(RLPReader.MemoryPointer.unwrap(payload.ptr) + 1);
        }
        RLPReader.RLPItem[] memory fields = RLPReader.readList(payload);
        require(fields.length == 4, "receipt has four fields");
        status = RLPReader.readBytes(fields[0]);
        (,, logCount) = ReceiptLogs.itemAt(fields[3], type(uint256).max);

        (bool found, RLPReader.RLPItem memory log,) = ReceiptLogs.itemAt(fields[3], logIndex);
        require(found, "log exists");
        RLPReader.RLPItem[] memory logFields = RLPReader.readList(log);
        require(logFields.length == 3, "log has three fields");
        emitter = RLPReader.readBytes(logFields[0]);
        RLPReader.RLPItem[] memory topicItems = RLPReader.readList(logFields[1]);
        topics = new bytes32[](topicItems.length);
        for (uint256 i = 0; i < topicItems.length; i++) {
            topics[i] = bytes32(RLPReader.readBytes(topicItems[i]));
        }
        data = RLPReader.readBytes(logFields[2]);
    }
}

contract TrieBuilderTest is Test {
    event Probe(address indexed sender, uint256 indexed number, bytes payload);

    TrieHarness internal harness;

    /// @dev Roots of index keyed tries, computed by the pure Python builder of `generate_receipts.py`. Item `i` of
    /// "varied" holds `1 + (i * 37) % 90` bytes taken in a cycle from `keccak256("value", uint256(i))`. Item `i` of
    /// "tiny" holds `1 + i % 5` bytes of the same hash.
    uint256[8] internal variedSizes = [1, 2, 3, 16, 17, 40, 130, 300];
    bytes32[8] internal variedRoots = [
        bytes32(0x03ee1f6124738de34fd07a170e9ca709c5a73069ad3c438d43127dc4f83b5af5),
        0x0fd3af5588234e2e5afb3412493e4cdee4c6efe5e6efedbdcfbbff88b4b725b4,
        0xd09bdc1abf623a46c2b2edfd7a9242e0f665e82d4f252a3a351d202a246e3602,
        0xff6af539bd70daeec03697818bc600b7fb515d8db63964f462a7efcffda004ad,
        0x5b2fcfb12cb9c123e912ac9bccd0dcdea9b443431f6cedc9f582d4fc8768ce1a,
        0x09d6e13189288ddeec8e90989ae3a9cc1ec9a1643ebd99c6bbf1b6a4ec06b184,
        0x378dbf7b2020f208c86af6e3c3790749b9dedaa31eb33f94dbc0973b966ee0a1,
        0xa83155e90d0194a48f0b7b0e11e79149249350545cd3b01b887ff66c43fdb246
    ];
    uint256[7] internal tinySizes = [1, 2, 5, 17, 40, 130, 300];
    bytes32[7] internal tinyRoots = [
        bytes32(0x03ee1f6124738de34fd07a170e9ca709c5a73069ad3c438d43127dc4f83b5af5),
        0x67e55e9f04541835dd2bd47cb723bd7c6bde6e7fbc49d20eb2de1e0dc8770a10,
        0x91c5759cbfe725eb6a152161851cebee06c9361ee76551cd6c3ed43b7a1fd7a5,
        0x770ecb18cd512da122143c2537841fd5b3bbbcbd5c1ba87d5ec5673e8c39e30d,
        0xf1b3f03c0191983c677c430f9781a752256a58ebede79596d665cb0567c306da,
        0x0217daec3f5d92d572687927c6d4274298aa6b886e26add1168c951977fe55f8,
        0xa0ce196dee4e5304f59464c0c71504861664d723c459853c8b5b2bf31f2ad15e
    ];

    bytes32 internal constant TOPIC = keccak256("Probe(address,uint256,bytes)");

    function setUp() public {
        harness = new TrieHarness();
    }

    // ---------------------------------------------------------------- helpers

    function _value(uint256 length, uint256 i) internal pure returns (bytes memory out) {
        bytes32 seed = keccak256(abi.encodePacked("value", i));
        out = new bytes(length);
        for (uint256 k = 0; k < length; k++) {
            out[k] = seed[k % 32];
        }
    }

    function _variedValues(uint256 size) internal pure returns (bytes[] memory values) {
        values = new bytes[](size);
        for (uint256 i = 0; i < size; i++) {
            values[i] = _value(1 + (i * 37) % 90, i);
        }
    }

    function _tinyValues(uint256 size) internal pure returns (bytes[] memory values) {
        values = new bytes[](size);
        for (uint256 i = 0; i < size; i++) {
            values[i] = _value(1 + (i % 5), i);
        }
    }

    function _strings(string memory a, string memory b, string memory c) internal pure returns (bytes[] memory out) {
        out = new bytes[](3);
        out[0] = bytes(a);
        out[1] = bytes(b);
        out[2] = bytes(c);
    }

    function _assertEveryIndexProves(bytes[] memory values, bytes32 root) internal view {
        bytes[][] memory proofs = harness.indexedProofs(values);
        assertEq(proofs.length, values.length, "one proof per item");
        for (uint256 i = 0; i < values.length; i++) {
            bytes memory found = harness.get(TrieBuilder.indexKey(i), proofs[i], root);
            assertEq(found, values[i], "the proof of an index returns the value of that index");
        }
    }

    function _logEntry() internal pure returns (ReceiptBuilder.LogEntry memory entry) {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = TOPIC;
        topics[1] = bytes32(uint256(0xabc));
        entry = ReceiptBuilder.LogEntry({emitter: address(0x1234), topics: topics, data: hex"00112233445566778899"});
    }

    function _single(ReceiptBuilder.LogEntry memory entry)
        internal
        pure
        returns (ReceiptBuilder.LogEntry[] memory logs)
    {
        logs = new ReceiptBuilder.LogEntry[](1);
        logs[0] = entry;
    }

    // ---------------------------------------------------------------- general trie

    /// Claim: the builder gives the root of the well-known Ethereum trie test ("doe", "dog", "dogglesworth").
    /// Shows: the root equals the published constant. The key "dog" ends at a branch node and the key "doe" splits off
    /// below a shared extension, so all three node kinds take part.
    /// Matters: this vector does not come from our code or from our Python builder, so it catches a flaw that both
    /// builders could share.
    function test_rootOf_matchesTheEthereumTrieVector() public pure {
        bytes[] memory keys = _strings("doe", "dog", "dogglesworth");
        bytes[] memory values = _strings("reindeer", "puppy", "cat");
        assertEq(
            TrieBuilder.rootOf(keys, values),
            0x8aad789dff2f538bca5d8ea56e8abe10f4c7ba3a5dea95fea4cd6e7c3a1168d3,
            "the root of the Ethereum trie vector"
        );
    }

    /// Claim: every entry of the Ethereum trie vector can be proved, also the entry that sits in a branch node.
    /// Shows: `MerkleTrie.get` returns the value of "doe", "dog" and "dogglesworth" from the proofs of the builder.
    /// Matters: a branch that holds a value is the rarest node shape. The vendored reader must accept what the builder
    /// writes there.
    function test_proofOf_everyEntryOfTheEthereumTrieVector() public view {
        bytes[] memory keys = _strings("doe", "dog", "dogglesworth");
        bytes[] memory values = _strings("reindeer", "puppy", "cat");
        bytes32 root = harness.rootOf(keys, values);
        for (uint256 i = 0; i < keys.length; i++) {
            assertEq(harness.get(keys[i], harness.proofOf(keys, values, i), root), values[i], "the value of the key");
        }
    }

    /// Claim: the builder refuses two entries with the same key, an empty key, and input of unequal length.
    /// Shows: each case reverts with its own error.
    /// Matters: a silent choice between two values for one key would make a test prove the wrong thing.
    function test_rootOf_refusesBadInput() public {
        bytes[] memory keys = _strings("aa", "ab", "aa");
        bytes[] memory values = _strings("1", "2", "3");
        vm.expectRevert(abi.encodeWithSelector(TrieBuilder.DuplicateKey.selector, 0, 2));
        harness.rootOf(keys, values);

        keys[2] = "";
        vm.expectRevert(abi.encodeWithSelector(TrieBuilder.EmptyKey.selector, 2));
        harness.rootOf(keys, values);

        bytes[] memory shortValues = new bytes[](2);
        vm.expectRevert(abi.encodeWithSelector(TrieBuilder.LengthMismatch.selector, 3, 2));
        harness.rootOf(keys, shortValues);

        vm.expectRevert(abi.encodeWithSelector(TrieBuilder.PositionOutOfRange.selector, 3, 3));
        harness.proofOf(_strings("aa", "ab", "ac"), values, 3);
    }

    // ---------------------------------------------------------------- index keyed trie

    /// Claim: `indexKey` is the RLP encoding of the integer.
    /// Shows: 0 gives 0x80, 1 gives 0x01, 127 gives 0x7f, 128 gives 0x8180, 255 gives 0x81ff, 256 gives 0x820100.
    /// Matters: the bridge builds the same key from `receiptIndex`. A different key reads a different leaf.
    function test_indexKey_knownValues() public pure {
        assertEq(TrieBuilder.indexKey(0), hex"80");
        assertEq(TrieBuilder.indexKey(1), hex"01");
        assertEq(TrieBuilder.indexKey(127), hex"7f");
        assertEq(TrieBuilder.indexKey(128), hex"8180");
        assertEq(TrieBuilder.indexKey(255), hex"81ff");
        assertEq(TrieBuilder.indexKey(256), hex"820100");
    }

    /// Claim: the builder computes the same roots as the independent Python builder, for items of varied length.
    /// Shows: eight sizes from 1 to 300 give eight hard-coded roots. Items are 1 to 90 bytes, so some nodes are shorter
    /// than 32 bytes and some are longer.
    /// Matters: the Python builder produced the existing fixtures, so equal roots show that the two builders agree on
    /// the node layout, the hex-prefix encoding and the hashing rule.
    function test_indexedRoot_matchesPythonForVariedItems() public view {
        for (uint256 s = 0; s < variedSizes.length; s++) {
            bytes[] memory values = _variedValues(variedSizes[s]);
            assertEq(TrieBuilder.indexedRoot(values), variedRoots[s], "root of a varied trie");
        }
    }

    /// Claim: the builder computes the same roots as the Python builder when every item is 1 to 5 bytes long.
    /// Shows: seven sizes from 1 to 300 give seven hard-coded roots.
    /// Matters: tiny items make leaves and branches shorter than 32 bytes, which sit inside their parent. This is the
    /// rule that is easiest to get wrong.
    function test_indexedRoot_matchesPythonForTinyItems() public view {
        for (uint256 s = 0; s < tinySizes.length; s++) {
            bytes[] memory values = _tinyValues(tinySizes[s]);
            assertEq(TrieBuilder.indexedRoot(values), tinyRoots[s], "root of a tiny trie");
        }
    }

    /// Claim: for every size and every index, the proof of the builder makes `MerkleTrie.get` return that item (varied
    /// items).
    /// Shows: all 509 proofs of the eight varied tries verify against the hard-coded Python roots.
    /// Matters: this is the exact call that the bridge makes. It also shows that the proof order and the node
    /// selection are right, not only the root.
    function test_indexedProof_everyIndexOfVariedTries() public view {
        for (uint256 s = 0; s < variedSizes.length; s++) {
            _assertEveryIndexProves(_variedValues(variedSizes[s]), variedRoots[s]);
        }
    }

    /// Claim: the same, for tries of tiny items.
    /// Shows: all 497 proofs of the seven tiny tries verify against the hard-coded Python roots.
    /// Matters: a proof through an embedded node needs that node as its own proof element. This test fails when the
    /// builder leaves it out.
    function test_indexedProof_everyIndexOfTinyTries() public view {
        for (uint256 s = 0; s < tinySizes.length; s++) {
            _assertEveryIndexProves(_tinyValues(tinySizes[s]), tinyRoots[s]);
        }
    }

    /// Claim: a tiny trie has embedded nodes, and the proof lists them.
    /// Shows: in a trie of 40 tiny items, some proof node is shorter than 32 bytes and some is not.
    /// Matters: without this check, the tiny tries might never reach the embedded node path of the builder.
    function test_indexedProof_containsEmbeddedNodes() public view {
        bytes[] memory values = _tinyValues(40);
        uint256 shortNodes;
        uint256 longNodes;
        for (uint256 i = 0; i < values.length; i++) {
            bytes[] memory proof = harness.indexedProof(values, i);
            for (uint256 n = 1; n < proof.length; n++) {
                if (proof[n].length < 32) shortNodes++;
                else longNodes++;
            }
        }
        assertGt(shortNodes, 0, "some node is embedded");
        assertGt(longNodes, 0, "some node is hashed");
    }

    /// Claim: the single proof of an item equals its proof from the batch builder.
    /// Shows: for tries of 1 to 130 items, varied and tiny, both builders give the same nodes for every index.
    /// Matters: tests use the single call, and the exhaustive tests use the batch call. The two must not drift apart.
    function test_indexedProof_singleEqualsBatch() public view {
        uint256[4] memory sizes = [uint256(1), 3, 17, 130];
        for (uint256 s = 0; s < sizes.length; s++) {
            bytes[] memory values = s % 2 == 0 ? _tinyValues(sizes[s]) : _variedValues(sizes[s]);
            bytes[][] memory batch = harness.indexedProofs(values);
            for (uint256 i = 0; i < values.length; i++) {
                assertEq(abi.encode(harness.indexedProof(values, i)), abi.encode(batch[i]), "same proof");
            }
        }
    }

    /// Claim: a proof from one trie fails against the root of another trie.
    /// Shows: `MerkleTrie.get` reverts with "invalid root hash" when the first node does not hash to the root.
    /// Matters: the bridge trusts the root of the header only. A builder that made proofs which pass under any root
    /// would hide a bridge that skips the root check.
    function test_proof_failsAgainstAnotherRoot() public {
        bytes[] memory first = _variedValues(40);
        bytes[] memory second = _variedValues(41);
        bytes32 otherRoot = TrieBuilder.indexedRoot(second);
        assertTrue(otherRoot != TrieBuilder.indexedRoot(first), "the tries differ");

        bytes[] memory proof = harness.indexedProof(first, 7);
        vm.expectRevert("MerkleTrie: invalid root hash");
        harness.get(TrieBuilder.indexKey(7), proof, otherRoot);
    }

    /// Claim: the proof of index `i` does not prove any other index `j`.
    /// Shows: for 40 items, asking for each other key with the proof of index 7 either reverts or returns a value that
    /// is not item `j`. The count of reverts is also checked, so that a reader that ignored the key would fail.
    /// Matters: a proof for one transaction must not let a forged message claim another position.
    function test_proof_doesNotRevealAnotherIndex() public view {
        bytes[] memory values = _variedValues(40);
        bytes32 root = TrieBuilder.indexedRoot(values);
        bytes[] memory proof = harness.indexedProof(values, 7);
        uint256 reverted;
        for (uint256 j = 0; j < values.length; j++) {
            if (j == 7) continue;
            try harness.get(TrieBuilder.indexKey(j), proof, root) returns (bytes memory found) {
                assertTrue(keccak256(found) != keccak256(values[j]), "another index is revealed");
            } catch {
                reverted++;
            }
        }
        assertEq(reverted, values.length - 1, "every other index fails against this proof");
    }

    // ---------------------------------------------------------------- receipts and blocks

    /// Claim: a receipt of type 0, 1, 2, 3, 4 and 7 sits in a block, proves through `MerkleTrie.get`, and reads back
    /// through the same steps as the bridge.
    /// Shows: for each type, the first byte is the type byte (or a list prefix for type 0), the receipt and the
    /// transaction come back from their proofs byte for byte, the hash of the transaction matches, and the status,
    /// emitter, topics and data of the log read back unchanged.
    /// Matters: integration tests prove real messages through these bytes. A flaw in the encoding would make a proof of a
    /// real message fail for a reason that has nothing to do with the bridge.
    function test_receipt_everyTypeRoundTrips() public view {
        uint8[6] memory types = [0, 1, 2, 3, 4, 7];
        ReceiptBuilder.LogEntry memory entry = _logEntry();
        for (uint256 t = 0; t < types.length; t++) {
            bytes memory receipt =
                ReceiptBuilder.receipt(types[t], ReceiptBuilder.ReceiptStatus.Success, _single(entry));
            bytes memory transaction = ReceiptBuilder.transaction(types[t], hex"deadbeef");
            ReceiptBuilder.Block memory built = harness.assemble(9, 4, receipt, transaction);
            bytes memory key = TrieBuilder.indexKey(4);

            if (types[t] == 0) assertGe(uint8(receipt[0]), 0xc0, "a legacy receipt starts with a list prefix");
            else assertEq(uint8(receipt[0]), types[t], "a typed receipt starts with its type byte");
            if (types[t] == 0) assertGe(uint8(transaction[0]), 0xc0, "a legacy transaction is a bare list");
            else assertEq(uint8(transaction[0]), types[t], "a typed transaction starts with its type byte");

            bytes memory provenReceipt = harness.get(key, ReceiptBuilder.receiptProofOf(built, 4), built.receiptsRoot);
            bytes memory provenTransaction =
                harness.get(key, ReceiptBuilder.transactionProofOf(built, 4), built.transactionsRoot);
            assertEq(provenReceipt, receipt, "the receipt comes back from its proof");
            assertEq(keccak256(provenTransaction), keccak256(transaction), "the transaction hash matches");

            (bytes memory status, bytes memory emitter, bytes32[] memory topics, bytes memory data, uint256 logCount) =
                harness.decode(provenReceipt, 0);
            assertEq(status, hex"01", "success is the byte 0x01");
            assertEq(emitter, abi.encodePacked(entry.emitter), "the emitter reads back");
            assertEq(topics.length, 2, "two topics read back");
            assertEq(topics[0], entry.topics[0]);
            assertEq(topics[1], entry.topics[1]);
            assertEq(data, entry.data, "the data reads back");
            assertEq(logCount, 1, "the receipt holds one log");
        }
    }

    /// Claim: a failed receipt carries an empty status, and a receipt without logs has no log to read.
    /// Shows: the status of a failure reads back as no bytes. A filler receipt holds no log, so a read of log 0 reverts.
    /// Matters: tests of the failure path of the bridge need a receipt that really records failure.
    function test_receipt_failureStatusAndNoLogs() public {
        bytes memory failed = ReceiptBuilder.receipt(2, ReceiptBuilder.ReceiptStatus.Failure, _single(_logEntry()));
        (bytes memory status,,,,) = harness.decode(failed, 0);
        assertEq(status.length, 0, "failure is the empty string");

        bytes memory filler = ReceiptBuilder.fillerReceipt(3);
        vm.expectRevert("log exists");
        harness.decode(filler, 0);
    }

    /// Claim: a receipt with 64 logs gives the right log at position 40.
    /// Shows: the log at position 40 has the emitter, topic and data that only that log holds, and the walk over the
    /// 64 logs passes the 32 item limit of the vendored list reader.
    /// Matters: a real transaction can emit many logs, and the bridge must find one among them.
    function test_receipt_sixtyFourLogsReadLogForty() public view {
        ReceiptBuilder.LogEntry[] memory logs = new ReceiptBuilder.LogEntry[](64);
        for (uint256 i = 0; i < logs.length; i++) {
            bytes32[] memory logTopics = new bytes32[](1);
            logTopics[0] = bytes32(i);
            logs[i] = ReceiptBuilder.LogEntry({
                emitter: address(uint160(0x1000 + i)), topics: logTopics, data: abi.encode(i)
            });
        }
        bytes memory receipt = ReceiptBuilder.receipt(2, ReceiptBuilder.ReceiptStatus.Success, logs);
        ReceiptBuilder.Block memory built =
            ReceiptBuilder.assemble(30, 21, receipt, ReceiptBuilder.transaction(2, hex"01"));
        bytes memory proven =
            harness.get(TrieBuilder.indexKey(21), harness.indexedProof(built.receipts, 21), built.receiptsRoot);

        (, bytes memory emitter, bytes32[] memory topics, bytes memory data,) = harness.decode(proven, 40);
        assertEq(emitter, abi.encodePacked(address(uint160(0x1000 + 40))), "the emitter of log 40");
        assertEq(topics[0], bytes32(uint256(40)), "the topic of log 40");
        assertEq(data, abi.encode(uint256(40)), "the data of log 40");
    }

    /// Claim: `fromRecorded` turns a log of `vm.getRecordedLogs` into an entry that encodes to the log that the contract
    /// emitted.
    /// Shows: after a real emit, the entry has the emitter, the two topics and the data of the event, and it survives a
    /// trip through a receipt.
    /// Matters: this is how integration tests take logs from real contracts.
    function test_fromRecorded_keepsEmitterTopicsAndData() public {
        vm.recordLogs();
        emit Probe(address(0xCAFE), 77, hex"010203");
        Vm.Log[] memory recorded = vm.getRecordedLogs();
        assertEq(recorded.length, 1);

        ReceiptBuilder.LogEntry memory entry = ReceiptBuilder.fromRecorded(recorded[0]);
        assertEq(entry.emitter, address(this), "the test contract emitted the event");
        assertEq(entry.topics.length, 3, "event signature and two indexed values");
        assertEq(entry.topics[0], TOPIC);
        assertEq(entry.topics[1], bytes32(uint256(uint160(address(0xCAFE)))));
        assertEq(entry.topics[2], bytes32(uint256(77)));
        assertEq(entry.data, abi.encode(hex"010203"));

        bytes memory receipt = ReceiptBuilder.receipt(2, ReceiptBuilder.ReceiptStatus.Success, _single(entry));
        (, bytes memory emitter, bytes32[] memory topics, bytes memory data,) = harness.decode(receipt, 0);
        assertEq(emitter, abi.encodePacked(address(this)));
        assertEq(topics[2], bytes32(uint256(77)));
        assertEq(data, entry.data);
    }

    /// Claim: filler entries are deterministic and distinct, and the real entry changes the roots.
    /// Shows: the same seed gives the same bytes, two seeds give two receipts and two transactions, and a block with a
    /// different real receipt has a different receipts root but the same transactions root.
    /// Matters: a test that proves position `i` of a block must not be able to mistake it for a neighbor.
    function test_assemble_fillersAreDistinctAndTheRealEntryCounts() public pure {
        assertEq(ReceiptBuilder.fillerReceipt(5), ReceiptBuilder.fillerReceipt(5));
        assertEq(ReceiptBuilder.fillerTransaction(5), ReceiptBuilder.fillerTransaction(5));
        assertTrue(keccak256(ReceiptBuilder.fillerReceipt(5)) != keccak256(ReceiptBuilder.fillerReceipt(6)));
        assertTrue(keccak256(ReceiptBuilder.fillerTransaction(5)) != keccak256(ReceiptBuilder.fillerTransaction(6)));
        assertTrue(
            keccak256(ReceiptBuilder.transaction(2, hex"01")) != keccak256(ReceiptBuilder.transaction(2, hex"02"))
        );

        bytes memory transaction = ReceiptBuilder.transaction(2, hex"01");
        ReceiptBuilder.Block memory one = ReceiptBuilder.assemble(
            20, 3, ReceiptBuilder.receipt(2, ReceiptBuilder.ReceiptStatus.Success, _single(_logEntry())), transaction
        );
        ReceiptBuilder.Block memory two = ReceiptBuilder.assemble(
            20, 3, ReceiptBuilder.receipt(2, ReceiptBuilder.ReceiptStatus.Failure, _single(_logEntry())), transaction
        );
        assertTrue(one.receiptsRoot != two.receiptsRoot, "the real receipt is part of the root");
        assertEq(one.transactionsRoot, two.transactionsRoot, "the transactions are the same");
        assertEq(one.receipts.length, 20);
        assertEq(one.transactions[3], transaction, "the real transaction sits at its index");
    }
}
