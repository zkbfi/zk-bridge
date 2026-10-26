// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";
import {MessageRecorder} from "./utils/MessageTargets.sol";

/// @notice Tests of `openDeposits`. A bridge refuses sends until `openDeposits` proves, through its own light client,
/// that the light client on the other chain stored a head. The tests of the lock on the send side (a closed bridge refuses
/// first, the honest proof opens for good, an unstored slot does not open) live in `MessageBridgeSend.t.sol`. The state
/// tries here have one leaf each, which is a valid trie. Branch and extension nodes of real tries are covered by the
/// Anvil tests of the prover, which use `eth_getProof`.
contract DepositOpeningTest is MessageScenes {
    event DepositsOpened(uint64 indexed remoteSlot, bytes32 indexed remoteBlockHash, uint64 storedSlot);

    /// @dev The gas of the first send of a fresh open bridge, as measured with the lock in place. See the gas test.
    uint256 internal constant SEND_GAS_MEASURED = 26_130;

    /// @dev A bridge on chain A, closed, with the fixture light client of chain A and the remote light client of chain B.
    MessageBridge internal closed;

    function setUp() public override {
        super.setUp();
        closed = _deploySourceBridge(0, address(gateA));
    }

    /// @dev The whole honest preparation for a bridge: see `_honestOpeningProof`.
    function _honestProof(MessageBridge target) internal returns (BeaconProofVerifier.OpeningProof memory) {
        return _honestOpeningProof(
            BeaconLightClient(address(target.lightClient())), BeaconLightClient(target.remoteLightClient())
        );
    }

    /// @dev A send from the fixture sender to the recorder.
    function _sendFrom(MessageBridge from) internal returns (bytes32) {
        vm.prank(MessageFixtures.SENDER);
        return from.requireToPassMessage(MessageFixtures.TARGET_RECORDER, "x", 100_000);
    }

    // ================================================================ opening exactly at the condition

    /// Claim: while the remote light client has stored no update, the bridge cannot be opened, and it opens in the call
    /// after the first update. Shows: the first call reverts and the flag stays false; the second call emits
    /// `DepositsOpened` with the slots and the block hash, and sets the flag. The blocks are the same in both calls: only
    /// the state of the remote light client differs. Matters: this is the condition itself. An opening before it would
    /// let messages in that are lost.
    function test_open_opensExactlyWhenTheRemoteLightClientStoredAnUpdate() public {
        BeaconLightClient remote = lightClientForB;
        BeaconLightClient own = lightClientForA;

        // Before: the remote light client holds only its checkpoint. The best a prover can show is a snapshot of
        // its storage that holds other entries: the head. The entry for the first update slot is not in it.
        bytes memory headLeaf = _leaf(
            abi.encodePacked(keccak256(abi.encode(uint256(0)))), _rlpBytes(_trimmed(bytes32(uint256(INITIAL_SLOT))))
        );
        bytes memory accountLeaf = _leaf(
            abi.encodePacked(keccak256(abi.encodePacked(address(remote)))),
            _account(keccak256(headLeaf), address(remote), 4)
        );
        bytes memory header = _header(keccak256(accountLeaf));
        BeaconProofVerifier.OpeningProof memory early;
        early.remoteSlot = _ownStores(own, header);
        early.remoteHeaderRlp = header;
        early.accountProof = new bytes[](1);
        early.accountProof[0] = accountLeaf;
        early.storedSlot = FIRST_UPDATE_SLOT;
        early.storageProof = new bytes[](1);
        early.storageProof[0] = headLeaf;
        vm.expectRevert();
        closed.openDeposits(early);
        assertFalse(closed.depositsOpen(), "no entry, no opening");

        // After: the remote light client follows once and the honest model has the entry.
        _remoteFollows(remote, FIRST_UPDATE_SLOT);
        Model memory model = _model(remote, FIRST_UPDATE_SLOT, _rlpBytes(_trimmed(_execHash(FIRST_UPDATE_SLOT))));
        uint64 laterSlot = _ownStores(own, model.header);
        vm.expectEmit(true, true, false, true, address(closed));
        emit DepositsOpened(laterSlot, keccak256(model.header), FIRST_UPDATE_SLOT);
        closed.openDeposits(_proof(model, laterSlot, FIRST_UPDATE_SLOT));
        assertTrue(closed.depositsOpen());
    }

    /// Claim: nobody needs a key. Shows: an address that holds no role opens the bridge. Matters: the opening must not
    /// depend on an operator who could withhold it.
    function test_open_needsNoKey() public {
        BeaconProofVerifier.OpeningProof memory proof = _honestProof(closed);
        vm.prank(attacker);
        closed.openDeposits(proof);
        assertTrue(closed.depositsOpen());
    }

    // ================================================================ refusals of the opening

    /// Claim: a slot at which the own light client stored no block cannot carry an opening. Shows: the exact error with
    /// the slot, and the flag stays false. Matters: only a stored block of the other chain is evidence.
    function test_open_refusesAnUnstoredRemoteSlot() public {
        BeaconProofVerifier.OpeningProof memory proof = _honestProof(closed);
        proof.remoteSlot += 1;
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.OpeningSlotNotStored.selector, proof.remoteSlot));
        closed.openDeposits(proof);
        assertFalse(closed.depositsOpen());
    }

    /// Claim: a header that is not the stored block cannot carry an opening, even with a state root that fits its own
    /// proofs. Shows: the error names the stored hash and the hash of the header. Matters: the header is the link
    /// between the stored block and the state that the proof reads.
    function test_open_refusesAHeaderThatIsNotTheStoredBlock() public {
        BeaconProofVerifier.OpeningProof memory proof = _honestProof(closed);
        bytes32 expected = lightClientForA.executionBlockHashes(proof.remoteSlot);
        proof.remoteHeaderRlp = _header(keccak256("another state root"));
        vm.expectRevert(
            abi.encodeWithSelector(
                BeaconProofVerifier.OpeningHeaderMismatch.selector, expected, keccak256(proof.remoteHeaderRlp)
            )
        );
        closed.openDeposits(proof);
        assertFalse(closed.depositsOpen());
    }

    /// Claim: the proof must be about the account of the remote light client. Shows: the proof of the honest state, given
    /// to a bridge that names the other light client of the fixture, reverts and does not open it. Matters: a contract
    /// that is not the remote light client proves nothing about it.
    function test_open_refusesAnotherAccount() public {
        BeaconProofVerifier.OpeningProof memory proof = _honestProof(closed);
        vm.chainId(CHAIN_A);
        MessageBridge other = new MessageBridge(
            address(lightClientForA),
            CHAIN_A,
            CHAIN_B,
            DESTINATION_BRIDGE,
            MessageBridge.BridgeTerms(0, address(lightClientForA)),
            DEFAULT_CAPELLA_ERA,
            address(gateA)
        );
        vm.expectRevert();
        other.openDeposits(proof);
        assertFalse(other.depositsOpen());
    }

    /// Claim: a slot with no entry fails. Shows: the proof of the entry of the first update slot does not prove the next
    /// slot. Matters: the entry must be the one for the slot that the proof names.
    function test_open_refusesAnotherStoredSlot() public {
        BeaconProofVerifier.OpeningProof memory proof = _honestProof(closed);
        proof.storedSlot = FIRST_UPDATE_SLOT + 1;
        vm.expectRevert();
        closed.openDeposits(proof);
        assertFalse(closed.depositsOpen());
    }

    /// Claim: an account that does not decode to four fields is refused with `OpeningProofMalformed`. Matters: an
    /// account of another shape must not be read at the position of the storage root.
    function test_open_refusesAMalformedAccount() public {
        _remoteFollows(lightClientForB, FIRST_UPDATE_SLOT);
        Model memory model =
            _model(lightClientForB, FIRST_UPDATE_SLOT, _rlpBytes(_trimmed(_execHash(FIRST_UPDATE_SLOT))));
        model.accountLeaf = _leaf(
            abi.encodePacked(keccak256(abi.encodePacked(address(lightClientForB)))),
            _account(keccak256(model.entryLeaf), address(lightClientForB), 3)
        );
        model.header = _header(keccak256(model.accountLeaf));
        uint64 remoteSlot = _ownStores(lightClientForA, model.header);
        vm.expectRevert(BeaconProofVerifier.OpeningProofMalformed.selector);
        closed.openDeposits(_proof(model, remoteSlot, FIRST_UPDATE_SLOT));
    }

    /// Claim: a header with no state root item is refused with `OpeningProofMalformed`. Matters: the read of the state
    /// root must not run past the end of the header.
    function test_open_refusesAShortHeader() public {
        bytes[] memory items = new bytes[](3);
        items[0] = _rlpBytes(abi.encodePacked(keccak256("parent")));
        items[1] = _rlpBytes(abi.encodePacked(keccak256("ommers")));
        items[2] = _rlpBytes(abi.encodePacked(address(0xC0FFEE)));
        bytes memory header = _rlpList(items);
        BeaconProofVerifier.OpeningProof memory proof;
        proof.remoteSlot = _ownStores(lightClientForA, header);
        proof.remoteHeaderRlp = header;
        vm.expectRevert(BeaconProofVerifier.OpeningProofMalformed.selector);
        closed.openDeposits(proof);
    }

    /// Claim: a state root item that is not 32 bytes wide is refused with `OpeningProofMalformed`. Shows: a header whose
    /// state root item is 31 bytes reverts. Matters: a short item must not be padded into a state root.
    function test_open_refusesAStateRootThatIsNotThirtyTwoBytes() public {
        bytes[] memory items = new bytes[](6);
        items[0] = _rlpBytes(abi.encodePacked(keccak256("parent")));
        items[1] = _rlpBytes(abi.encodePacked(keccak256("ommers")));
        items[2] = _rlpBytes(abi.encodePacked(address(0xC0FFEE)));
        items[3] = _rlpBytes(new bytes(31));
        items[4] = _rlpBytes(abi.encodePacked(keccak256("transactions root")));
        items[5] = _rlpBytes(abi.encodePacked(keccak256("receipts root")));
        bytes memory header = _rlpList(items);
        BeaconProofVerifier.OpeningProof memory proof;
        proof.remoteSlot = _ownStores(lightClientForA, header);
        proof.remoteHeaderRlp = header;
        vm.expectRevert(BeaconProofVerifier.OpeningProofMalformed.selector);
        closed.openDeposits(proof);
    }

    /// Claim: an account whose storage root item is not 32 bytes wide is refused with `OpeningProofMalformed`, even
    /// though the account has four fields and sits under the state root. Matters: a short item must not be padded into
    /// the storage root that the entry proof is checked against.
    function test_open_refusesAStorageRootThatIsNotThirtyTwoBytes() public {
        _remoteFollows(lightClientForB, FIRST_UPDATE_SLOT);
        Model memory model =
            _model(lightClientForB, FIRST_UPDATE_SLOT, _rlpBytes(_trimmed(_execHash(FIRST_UPDATE_SLOT))));
        bytes[] memory fields = new bytes[](4);
        fields[0] = _rlpBytes(hex"01");
        fields[1] = _rlpBytes("");
        fields[2] = _rlpBytes(new bytes(31));
        fields[3] = _rlpBytes(abi.encodePacked(address(lightClientForB).codehash));
        model.accountLeaf = _leaf(abi.encodePacked(keccak256(abi.encodePacked(address(lightClientForB)))), _rlpList(fields));
        model.header = _header(keccak256(model.accountLeaf));
        uint64 remoteSlot = _ownStores(lightClientForA, model.header);
        vm.expectRevert(BeaconProofVerifier.OpeningProofMalformed.selector);
        closed.openDeposits(_proof(model, remoteSlot, FIRST_UPDATE_SLOT));
    }

    /// Claim: an entry that holds the encoding of the empty value is refused with `OpeningEntryEmpty`. Shows: the error
    /// names the stored slot. Matters: a real trie never holds a zero entry, because a zero value removes the entry, so
    /// this guards the bridge against a decoding gap.
    function test_open_refusesAnEmptyEntry() public {
        _remoteFollows(lightClientForB, FIRST_UPDATE_SLOT);
        Model memory model = _model(lightClientForB, FIRST_UPDATE_SLOT, _rlpBytes(""));
        uint64 remoteSlot = _ownStores(lightClientForA, model.header);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.OpeningEntryEmpty.selector, FIRST_UPDATE_SLOT));
        closed.openDeposits(_proof(model, remoteSlot, FIRST_UPDATE_SLOT));
    }

    // ================================================================ the lock never closes

    /// Claim: the flag is permanent. Shows: a second call with a garbage proof returns without a change and without an
    /// event; a send keeps the flag and moves the nonce; a later call with garbage leaves both the flag and the nonce.
    /// Matters: a bridge that closed again would strand the messages that are in flight.
    function test_open_neverClosesAgain() public {
        closed.openDeposits(_honestProof(closed));
        assertTrue(closed.depositsOpen());

        BeaconProofVerifier.OpeningProof memory garbage;
        vm.recordLogs();
        closed.openDeposits(garbage);
        assertEq(vm.getRecordedLogs().length, 0, "a second call emits nothing");
        assertTrue(closed.depositsOpen());

        _sendFrom(closed);
        closed.openDeposits(garbage);
        assertTrue(closed.depositsOpen(), "a send keeps the flag");
        assertEq(
            uint256(vm.load(address(closed), bytes32(BRIDGE_FLAG_WORD_SLOT))),
            (uint256(1) << BRIDGE_FLAG_BIT_OFFSET) | 1,
            "the nonce moved once and the flag stands"
        );
        _sendFrom(closed);
    }

    // ================================================================ pins to the real contracts

    /// Claim: the bridge reads the mapping `executionBlockHashes` of the light client at slot 3 of its storage layout.
    /// Shows: the entries of followed slots sit at the keys that the model computes for slot 3, and an unstored slot is
    /// empty. Matters: the verifier hard-codes the slot. If the light client changes its layout, this test fails first.
    function test_pin_executionBlockHashesLivesAtDeclaredSlotThree() public {
        _remoteFollows(lightClientForB, FIRST_UPDATE_SLOT);
        _remoteFollows(lightClientForB, FIRST_UPDATE_SLOT + 32);
        assertEq(vm.load(address(lightClientForB), _entrySlot(FIRST_UPDATE_SLOT)), _execHash(FIRST_UPDATE_SLOT));
        assertEq(
            vm.load(address(lightClientForB), _entrySlot(FIRST_UPDATE_SLOT + 32)), _execHash(FIRST_UPDATE_SLOT + 32)
        );
        assertEq(
            vm.load(address(lightClientForB), _entrySlot(FIRST_UPDATE_SLOT + 1)),
            bytes32(0),
            "an unstored slot is empty"
        );
    }

    /// Claim: the helper that opens bridges in other tests writes exactly the bit that `openDeposits` writes. Shows: a
    /// bridge opened with a proof and a bridge opened with the helper hold the same first word, and before the opening
    /// that word is zero. Matters: the unit tests open bridges with the helper. If the real opening wrote another bit,
    /// those tests would run on a state that no bridge reaches.
    function test_pin_helperWritesTheBitThatTheOpeningWrites() public {
        MessageBridge byHelper = _deploySourceBridge(0, address(gateA));
        assertEq(uint256(vm.load(address(byHelper), bytes32(BRIDGE_FLAG_WORD_SLOT))), 0, "closed: the word is zero");
        _openDepositsWithoutProof(byHelper);
        bytes32 helperWord = vm.load(address(byHelper), bytes32(BRIDGE_FLAG_WORD_SLOT));

        MessageBridge byProof = _deploySourceBridge(0, address(gateA));
        byProof.openDeposits(_honestProof(byProof));
        assertEq(vm.load(address(byProof), bytes32(BRIDGE_FLAG_WORD_SLOT)), helperWord, "the same word");
        assertEq(uint256(helperWord), uint256(1) << BRIDGE_FLAG_BIT_OFFSET, "the flag is the only bit");
    }

    // ================================================================ gas

    /// Claim: the lock adds almost nothing to a send. The flag shares a storage word with the nonce, which `_send`
    /// reads anyway, so the check adds no cold read. Shows: the first send of a fresh open bridge, whose storage is cold,
    /// stays below the measured cost plus a margin of 400 gas. Matters: the bound catches a second cold storage read,
    /// which would add 2,100.
    function test_gas_sendAfterOpeningCostsNoColdRead() public {
        _openDepositsWithoutProof(closed);
        vm.prank(MessageFixtures.SENDER);
        uint256 before = gasleft();
        closed.requireToPassMessage(MessageFixtures.TARGET_RECORDER, "x", 100_000);
        uint256 used = before - gasleft();
        console2.log("send gas, open bridge", used);
        assertLt(used, SEND_GAS_MEASURED + 400, "the lock added more than the packed read");
    }

    /// Claim: opening costs one transaction of modest size. Printed for the report.
    function test_gas_openDeposits() public {
        BeaconProofVerifier.OpeningProof memory proof = _honestProof(closed);
        uint256 before = gasleft();
        closed.openDeposits(proof);
        uint256 used = before - gasleft();
        console2.log("openDeposits gas, one-leaf tries", used);
        assertLt(used, 150_000);
    }

    // ================================================================ end to end

    /// Claim: the first message sent after the opening is delivered by the destination bridge, through a receipt that
    /// holds the log that the source bridge really emitted. Shows: the closed source bridge refuses; it opens with a
    /// proof of the state of the remote light client; it sends; a proof built from the recorded log, with a receipts trie
    /// and a transactions trie of one leaf each, makes the destination bridge call the target with the sender, the
    /// identifier, the transaction hash and the data of the send. Matters: the lock exists to make exactly this message
    /// deliverable. The tries have one leaf, so the test does not need a builder of real tries.
    function test_endToEnd_firstMessageAfterOpeningIsDelivered() public {
        MessageBridge source = _deploySourceBridge(0, address(gateA));
        vm.expectRevert(BeaconProofVerifier.DepositsNotOpen.selector);
        _sendFrom(source);

        source.openDeposits(_honestProof(source));
        assertTrue(source.depositsOpen());

        vm.recordLogs();
        vm.prank(MessageFixtures.SENDER);
        bytes32 id = source.requireToPassMessage(MessageFixtures.TARGET_RECORDER, _payload(), 500_000);
        Vm.Log memory log = _sentLog(vm.getRecordedLogs(), address(source));

        // Its receipt and its transaction: one of each, at index 0 (the trie key 0x80).
        bytes memory transaction = "the transaction of the sender";
        bytes memory receiptLeaf = _leaf(hex"80", _receiptOf(log));
        bytes memory transactionLeaf = _leaf(hex"80", transaction);
        Scene memory scene = _sceneWithHeader(
            MessageFixtures.deliver(),
            _defaultParams(),
            _executionHeaderRlp(keccak256(receiptLeaf), keccak256(transactionLeaf), 17)
        );
        scene.proof.receiptProof = new bytes[](1);
        scene.proof.receiptProof[0] = receiptLeaf;
        scene.proof.transactionProof = new bytes[](1);
        scene.proof.transactionProof[0] = transactionLeaf;

        vm.chainId(CHAIN_B);
        bridge.executeMessage(scene.proof);
        assertEq(recorder.callCount(), 1, "the target ran once");
        MessageRecorder.Call memory call = recorder.callAt(0);
        assertEq(call.caller, address(bridge));
        assertEq(call.messageSender, MessageFixtures.SENDER, "the sender of the send");
        assertEq(call.messageId, id, "the identifier of the send");
        assertEq(call.transactionHash, keccak256(transaction), "the hash of the transaction");
        assertEq(call.dataHash, keccak256(_payload()), "the data of the send");
        assertTrue(bridge.messageCallStatus(id), "the call succeeded");
    }

    function _payload() internal pure returns (bytes memory payload) {
        payload = new bytes(70);
        for (uint256 i = 0; i < payload.length; i++) {
            payload[i] = bytes1(uint8(i));
        }
    }

    function _sentLog(Vm.Log[] memory logs, address emitter) internal view returns (Vm.Log memory found) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == sourceBridge.USER_REQUEST_TOPIC()) {
                return logs[i];
            }
        }
        revert("the send emitted no log");
    }

    /// @dev A legacy receipt of a successful transaction with the log: status, gas used, bloom, logs.
    function _receiptOf(Vm.Log memory log) internal pure returns (bytes memory) {
        bytes[] memory topics = new bytes[](log.topics.length);
        for (uint256 i = 0; i < topics.length; i++) {
            topics[i] = _rlpBytes(abi.encodePacked(log.topics[i]));
        }
        bytes[] memory logItems = new bytes[](3);
        logItems[0] = _rlpBytes(abi.encodePacked(log.emitter));
        logItems[1] = _rlpList(topics);
        logItems[2] = _rlpBytes(log.data);
        bytes[] memory logs = new bytes[](1);
        logs[0] = _rlpList(logItems);
        bytes[] memory fields = new bytes[](4);
        fields[0] = _rlpBytes(hex"01");
        fields[1] = _rlpBytes(hex"5208");
        fields[2] = _rlpBytes(new bytes(256));
        fields[3] = _rlpList(logs);
        return _rlpList(fields);
    }
}
