// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {AmbMessageCodec} from "../../src/hardened/AmbMessageCodec.sol";
import {SSZ} from "../../src/hardened/SSZ.sol";
import {MessageRecorder} from "./utils/MessageTargets.sol";

/// @notice Runs every JSON fixture that the Rust reference writes under `light-client/tests/fixtures/message/` through a
/// real `MessageBridge`. Each fixture holds the exact `executeMessage` calldata and the Rust verdict. The bridge must
/// agree: deliver when Rust accepts (the target sees the data and the context), reject when Rust rejects.
///
/// The fixtures carry a fixed fork schedule, while the bridge validates its layouts from stored light-client data. The
/// test therefore seeds the bridge's three layout tables directly in storage (slots 6, 7 and 8), with the slot ranges
/// that the schedule implies. The self-validation itself is covered by `ForkLayout.t.sol`.
///
/// Every fixture runs against a new bridge, so no delivery mark carries over. The target sits at the address that the
/// message names, and the recorder code stands there. The fixtures run with their own gas limits (at most 300000), and
/// no fixture is skipped.
///
/// Reading the directory needs `fs_permissions` for `light-client/tests/fixtures/message`. The test fails without it.
contract LightClientFixturesTest is Test {
    string internal constant DIRECTORY = "light-client/tests/fixtures/message";
    /// @dev The storage slots of the layout tables of `MessageBridge`, as `forge inspect MessageBridge storage-layout`
    /// reports them. `test_R2_04_layoutSlotsAreThoseOfTheBridge` pins them.
    uint256 internal constant STATE_LAYOUTS_SLOT = 6;
    uint256 internal constant BODY_LAYOUTS_SLOT = 7;
    uint256 internal constant HISTORICAL_LAYOUTS_SLOT = 8;
    /// @dev The number of fixture files the Rust reference writes. A change in the set must be a deliberate change here.
    uint256 internal constant EXPECTED_FIXTURE_COUNT = 100;
    /// @dev The bridge never calls its deposit gate during `executeMessage`, so any non-zero address stands in for it.
    address internal constant UNUSED_GATE = address(0x6a7e);
    uint64 internal constant SLOTS_PER_EPOCH = 32;

    uint256 internal accepted;
    uint256 internal rejected;
    uint256 internal acceptedHistorical;
    uint256 internal acceptedHistoricalCapella;
    uint256 internal acceptedHistoricalElectra;
    uint256 internal recentGasTotal;
    uint256 internal recentGasCount;
    uint256 internal historicalGasTotal;
    uint256 internal historicalGasCount;

    function listFixtures() external view returns (VmSafe.DirEntry[] memory) {
        return vm.readDir(DIRECTORY);
    }

    /// Claim: the Solidity bridge and the Rust reference agree on every fixture. Shows: for each file, `executeMessage`
    /// with the fixture calldata succeeds exactly when Rust says accept. An accepted message calls the target once with
    /// the logged data, shows it the logged identifier, sender, source chain and transaction hash, and is marked as
    /// delivered with a successful call. A rejected fixture fails with the Solidity error that names the same failed
    /// check as the Rust reason, and the target is not called. The set has exactly 100 files, and both the capella and the
    /// electra layout have at least four accepted historical-path fixtures. Matters: two independent implementations of
    /// the check (the build contract requires them to agree on accept and reject). The accept fixtures are the control of
    /// the reject fixtures: the same set-up delivers an honest proof.
    function test_R2_04_rustFixturesAgreeWithSolidityBridge() public {
        VmSafe.DirEntry[] memory entries = vm.readDir(DIRECTORY);
        uint256 fixtureCount;
        for (uint256 i = 0; i < entries.length; i++) {
            if (!_endsWith(entries[i].path, ".json")) continue;
            fixtureCount++;
            _runFixture(vm.readFile(entries[i].path), entries[i].path);
        }
        console2.log("fixtures", fixtureCount);
        console2.log("accepted fixtures", accepted);
        console2.log("rejected fixtures", rejected);
        console2.log("accepted historical fixtures", acceptedHistorical);
        if (recentGasCount > 0) console2.log("average gas of an accepted recent message", recentGasTotal / recentGasCount);
        if (historicalGasCount > 0) {
            console2.log("average gas of an accepted historical message", historicalGasTotal / historicalGasCount);
        }
        assertEq(fixtureCount, EXPECTED_FIXTURE_COUNT, "the fixture set has the expected size");
        assertEq(accepted + rejected, fixtureCount, "every fixture ran");
        assertGt(accepted, 0, "at least one accept fixture ran");
        assertGt(rejected, 0, "at least one reject fixture ran");
        assertGe(acceptedHistoricalCapella, 4, "capella layout: at least four historical accept fixtures");
        assertGe(acceptedHistoricalElectra, 4, "electra layout: at least four historical accept fixtures");
    }

    /// Claim: the layout slots that this test writes are the layout tables of `MessageBridge`. Shows: after a seed of
    /// one schedule row, the public views return that row, and a table that is not seeded stays empty. Matters: a
    /// wrong slot would write into another variable, and every fixture would then fail or pass for the wrong reason.
    function test_R2_04_layoutSlotsAreThoseOfTheBridge() public {
        vm.chainId(1);
        BeaconLightClient client = _client(100, keccak256("header"));
        MessageBridge bridge = _newBridge(client, 1, 369, address(0xa1), 0, type(uint64).max);
        _writeLayout(address(bridge), STATE_LAYOUTS_SLOT, 0, 11, 64, 95);
        _writeLayout(address(bridge), BODY_LAYOUTS_SLOT, 0, 22, 64, 95);
        _writeLayout(address(bridge), HISTORICAL_LAYOUTS_SLOT, 0, 33, 64, 95);
        vm.store(address(bridge), bytes32(STATE_LAYOUTS_SLOT), bytes32(uint256(1)));
        vm.store(address(bridge), bytes32(BODY_LAYOUTS_SLOT), bytes32(uint256(1)));
        vm.store(address(bridge), bytes32(HISTORICAL_LAYOUTS_SLOT), bytes32(uint256(1)));
        BeaconProofVerifier.StateLayout[] memory states = bridge.stateLayouts();
        BeaconProofVerifier.BodyLayout[] memory bodies = bridge.bodyLayouts();
        BeaconProofVerifier.HistoricalLayout[] memory histories = bridge.historicalLayouts();
        assertEq(states.length, 1, "one state layout");
        assertEq(bodies.length, 1, "one body layout");
        assertEq(histories.length, 1, "one historical layout");
        assertEq(states[0].blockRootsGindex, 11, "state gindex");
        assertEq(bodies[0].blockHashGindex, 22, "body gindex");
        assertEq(histories[0].historicalSummariesGindex, 33, "historical gindex");
        assertEq(states[0].firstSlot, 64, "first slot");
        assertEq(states[0].lastSlot, 95, "last slot");
    }

    function _runFixture(string memory json, string memory path) internal {
        MessageBridge bridge = _deployFor(json);
        bool expectAccept = keccak256(bytes(vm.parseJsonString(json, ".expected.result"))) == keccak256("accept");
        bytes memory callData = vm.parseJsonBytes(json, ".calldata");
        if (!expectAccept) {
            (bool rejectedOk, bytes memory returned) = address(bridge).call(callData);
            assertFalse(rejectedOk, string.concat("bridge accepts what Rust rejects in ", path));
            rejected++;
            _assertSameReason(json, returned, path);
            return;
        }
        // The recorder is built at the address that the message names. Its storage may hold calls of earlier fixtures.
        address target = vm.parseJsonAddress(json, ".expected.message.executor");
        vm.etch(target, type(MessageRecorder).runtimeCode);
        uint256 callsBefore = MessageRecorder(target).callCount();
        uint256 gasBefore = gasleft();
        (bool ok,) = address(bridge).call(callData);
        uint256 gasUsed = gasBefore - gasleft();
        assertTrue(ok, string.concat("bridge rejects what Rust accepts in ", path));
        accepted++;
        _assertDelivered(json, bridge, MessageRecorder(target), callsBefore, path);
        _countAccepted(json, gasUsed);
    }

    /// @dev The target got one call. It saw the logged data and the logged context, and the bridge marks the message.
    function _assertDelivered(
        string memory json,
        MessageBridge bridge,
        MessageRecorder recorder,
        uint256 callsBefore,
        string memory path
    ) internal view {
        string memory message = ".expected.message";
        assertEq(recorder.callCount(), callsBefore + 1, string.concat("target called once in ", path));
        MessageRecorder.Call memory last = recorder.callAt(callsBefore);
        bytes32 id = vm.parseJsonBytes32(json, string.concat(message, ".messageId"));
        assertEq(last.caller, address(bridge), string.concat("caller in ", path));
        assertEq(last.messageSender, vm.parseJsonAddress(json, string.concat(message, ".sender")), string.concat("sender in ", path));
        assertEq(last.messageId, id, string.concat("message identifier in ", path));
        assertEq(
            last.sourceChainId,
            bytes32(vm.parseUint(vm.parseJsonString(json, string.concat(message, ".sourceChainId")))),
            string.concat("source chain in ", path)
        );
        assertEq(
            last.transactionHash,
            vm.parseJsonBytes32(json, string.concat(message, ".sourceTransactionHash")),
            string.concat("transaction hash in ", path)
        );
        assertEq(last.dataHash, keccak256(vm.parseJsonBytes(json, string.concat(message, ".data"))), string.concat("data in ", path));
        uint256 gasLimit = vm.parseUint(vm.parseJsonString(json, string.concat(message, ".gasLimit")));
        assertLe(last.gasAtEntry, gasLimit, string.concat("target gas within the limit in ", path));
        assertTrue(bridge.messageCallStatus(id), string.concat("call status true in ", path));
        assertEq(bridge.failedMessageDataHash(id), bytes32(0), string.concat("no failure record in ", path));
    }

    /// @dev Counts an accepted fixture by its ancestry path and its layout, and adds its gas to the matching total.
    function _countAccepted(string memory json, uint256 gasUsed) internal {
        bytes32 ancestryPath = keccak256(bytes(vm.parseJsonString(json, ".ancestryPath")));
        if (ancestryPath == keccak256("recent")) {
            recentGasTotal += gasUsed;
            recentGasCount++;
            return;
        }
        assertEq(ancestryPath, keccak256("historical"), "the ancestry path is recent or historical");
        acceptedHistorical++;
        historicalGasTotal += gasUsed;
        historicalGasCount++;
        bytes32 layout = keccak256(bytes(vm.parseJsonString(json, ".layout")));
        if (layout == keccak256("capella")) acceptedHistoricalCapella++;
        if (layout == keccak256("electra")) acceptedHistoricalElectra++;
    }

    /// @dev The Rust reason and the Solidity error must name the same failed check. A branch of the wrong length is
    /// reported by `SSZ.isValidBranch` as a length error with the exact lengths, not as a failed hash. The fixture
    /// name says which of the two the case is, so the ancestry cases are held to the exact error. The trie proofs of
    /// the receipt and the transaction fail in `MerkleTrie` with an `Error(string)` revert, which carries no custom
    /// error, so the test holds those two reasons to that selector. The reasons `HeaderDecode`, `ReceiptDecode`,
    /// `MalformedMessage`, `HistoricalIndexOutOfRange` and `UnsupportedFork` have no fixture in the set. They map to
    /// `MalformedExecutionHeader`, `MalformedReceipt`, `AmbMessageCodec.MalformedMessage`, `HistoricalIndexOutOfRange`
    /// and `LayoutNotValidated`, so a later fixture with one of them is checked too.
    function _assertSameReason(string memory json, bytes memory returned, string memory path) internal pure {
        string memory rustReason = vm.parseJsonString(json, ".expected.reason");
        bytes4 selector = bytes4(returned);
        bytes32 reason = keccak256(bytes(rustReason));
        bool matches;
        if (reason == keccak256("IndexMismatch")) matches = selector == MessageBridge.IndexMismatch.selector;
        if (reason == keccak256("AnchorNotStored")) matches = selector == BeaconProofVerifier.AnchorNotStored.selector;
        if (reason == keccak256("DepositNotBeforeAnchor")) matches = selector == BeaconProofVerifier.DepositNotBeforeAnchor.selector;
        if (reason == keccak256("DepositBeforeCapella")) matches = _isDepositBeforeCapellaEra(json, returned);
        if (reason == keccak256("HistoricalIndexOutOfRange")) matches = selector == BeaconProofVerifier.HistoricalIndexOutOfRange.selector;
        if (reason == keccak256("InvalidAncestryBranch")) matches = selector == _expectedAncestrySelector(json);
        if (reason == keccak256("InvalidBlockHashBranch")) {
            matches = selector == BeaconProofVerifier.BlockHashBranchInvalid.selector || selector == SSZ.BranchLengthMismatch.selector;
        }
        if (reason == keccak256("HeaderDecode")) matches = selector == BeaconProofVerifier.MalformedExecutionHeader.selector;
        // MerkleTrie `require` string
        if (reason == keccak256("ReceiptProofInvalid")) matches = selector == bytes4(0x08c379a0);
        if (reason == keccak256("TransactionProofInvalid")) matches = selector == bytes4(0x08c379a0);
        if (reason == keccak256("ReceiptDecode")) matches = selector == BeaconProofVerifier.MalformedReceipt.selector;
        if (reason == keccak256("ReceiptFailed")) matches = selector == BeaconProofVerifier.ReceiptFailed.selector;
        if (reason == keccak256("LogIndexOutOfRange")) matches = selector == BeaconProofVerifier.LogIndexOutOfRange.selector;
        if (reason == keccak256("LogEmitterMismatch")) matches = selector == BeaconProofVerifier.WrongEmitter.selector;
        if (reason == keccak256("LogTopicMismatch")) matches = selector == BeaconProofVerifier.WrongEventTopic.selector;
        if (reason == keccak256("LogMalformed")) matches = selector == BeaconProofVerifier.MalformedLog.selector;
        if (reason == keccak256("MalformedEventData")) matches = selector == MessageBridge.MalformedEventData.selector;
        if (reason == keccak256("MalformedMessage")) matches = selector == AmbMessageCodec.MalformedMessage.selector;
        if (reason == keccak256("MessageIdMismatch")) matches = selector == MessageBridge.MessageIdMismatch.selector;
        if (reason == keccak256("MessageVersionInvalid")) matches = selector == MessageBridge.MessageVersionInvalid.selector;
        if (reason == keccak256("WrongSourceChain")) matches = selector == MessageBridge.WrongSourceChain.selector;
        if (reason == keccak256("WrongDestinationChain")) matches = selector == MessageBridge.WrongDestinationChain.selector;
        if (reason == keccak256("UnknownDataType")) matches = selector == MessageBridge.UnknownDataType.selector;
        if (reason == keccak256("UnsupportedFork")) matches = selector == BeaconProofVerifier.LayoutNotValidated.selector;
        assertTrue(matches, string.concat("Solidity error differs from the Rust reason ", rustReason, " in ", path));
    }

    /// @dev A padded or short branch, and a branch built for the other path (it has the other depth), fail on length.
    /// Every other ancestry rejection has the right length and a wrong hash.
    function _expectedAncestrySelector(string memory json) internal pure returns (bytes4) {
        string memory description = vm.parseJsonString(json, ".name");
        if (_contains(description, "padded") || _contains(description, "short") || _contains(description, "distance_with")) {
            return SSZ.BranchLengthMismatch.selector;
        }
        return BeaconProofVerifier.AncestryBranchInvalid.selector;
    }

    function _contains(string memory text, string memory part) internal pure returns (bool) {
        bytes memory a = bytes(text);
        bytes memory b = bytes(part);
        if (a.length < b.length) return false;
        for (uint256 i = 0; i + b.length <= a.length; i++) {
            bool same = true;
            for (uint256 j = 0; j < b.length && same; j++) {
                same = a[i + j] == b[j];
            }
            if (same) return true;
        }
        return false;
    }

    /// @dev True when the revert is `DepositBeforeCapellaEra(sourceEra, capellaEra)` with the fixture's capella era
    /// and a source era below it.
    function _isDepositBeforeCapellaEra(string memory json, bytes memory returned) internal pure returns (bool) {
        if (bytes4(returned) != BeaconProofVerifier.DepositBeforeCapellaEra.selector) return false;
        bytes memory arguments = new bytes(returned.length - 4);
        for (uint256 i = 0; i < arguments.length; i++) {
            arguments[i] = returned[i + 4];
        }
        (uint64 sourceEra, uint64 capellaEra) = abi.decode(arguments, (uint64, uint64));
        uint64 fixtureCapellaEra = uint64(vm.parseUint(vm.parseJsonString(json, ".capellaEra")));
        return capellaEra == fixtureCapellaEra && sourceEra < capellaEra;
    }

    /// @dev A light client that stores the anchor (or not, when the fixture says the root is zero), and a new bridge with
    /// the fixture's chains and remote bridge, and the seeded layouts.
    function _deployFor(string memory json) internal returns (MessageBridge bridge) {
        uint64 localChain = uint64(vm.parseUint(vm.parseJsonString(json, ".localChainId")));
        vm.chainId(localChain);
        BeaconLightClient client = _clientFor(json);
        bridge = _newBridge(
            client,
            localChain,
            uint64(vm.parseUint(vm.parseJsonString(json, ".remoteChainId"))),
            vm.parseJsonAddress(json, ".remoteBridge"),
            uint64(vm.parseUint(vm.parseJsonString(json, ".capellaEra"))),
            uint64(vm.parseUint(vm.parseJsonString(json, ".gloasForkSlot")))
        );
        _seedLayouts(bridge, json);
    }

    function _newBridge(
        BeaconLightClient client,
        uint64 localChain,
        uint64 remoteChain,
        address remoteBridge,
        uint64 capellaEra,
        uint64 gloasForkSlot
    ) internal returns (MessageBridge) {
        return new MessageBridge(
            address(client),
            localChain,
            remoteChain,
            remoteBridge,
            MessageBridge.BridgeTerms(0, makeAddr("remote light client"), gloasForkSlot),
            capellaEra,
            UNUSED_GATE
        );
    }

    function _clientFor(string memory json) internal returns (BeaconLightClient) {
        uint64 anchorSlot = uint64(vm.parseUint(vm.parseJsonString(json, ".anchorSlot")));
        bytes32 storedRoot = vm.parseBytes32(vm.parseJsonString(json, ".storedAnchorHeaderRoot"));
        if (storedRoot == bytes32(0)) return _client(anchorSlot - 1, keccak256("some other header"));
        return _client(anchorSlot, storedRoot);
    }

    function _client(uint64 slot, bytes32 headerRoot) internal returns (BeaconLightClient) {
        return new BeaconLightClient(
            address(0xdead),
            keccak256("light client program"),
            keccak256("genesis"),
            8192,
            1,
            1,
            slot,
            headerRoot,
            keccak256("committee"),
            keccak256("next")
        );
    }

    /// @dev Writes the layout rows of the fixture's fork schedule into the bridge's three layout arrays. Each row covers the
    /// slots from its activation epoch up to the slot before the next row, and the last row covers the rest.
    /// The fixtures name the `block_roots` position as `base * 8192`. The bridge stores `base`.
    function _seedLayouts(MessageBridge bridge, string memory json) internal {
        uint256 count;
        while (vm.keyExistsJson(json, string.concat(".sourceForkSchedule[", vm.toString(count), "]"))) count++;
        uint256 stateCount;
        uint256 bodyCount;
        uint256 historicalCount;
        for (uint256 i = 0; i < count; i++) {
            string memory row = string.concat(".sourceForkSchedule[", vm.toString(i), "]");
            uint64 first = uint64(vm.parseUint(vm.parseJsonString(json, string.concat(row, ".activationEpoch")))) * SLOTS_PER_EPOCH;
            uint64 last = type(uint64).max;
            if (i + 1 < count) {
                string memory next = string.concat(".sourceForkSchedule[", vm.toString(i + 1), "]");
                last = uint64(vm.parseUint(vm.parseJsonString(json, string.concat(next, ".activationEpoch")))) * SLOTS_PER_EPOCH - 1;
            }
            uint256 rootsBase = vm.parseUint(vm.parseJsonString(json, string.concat(row, ".blockRootsGindexBase"))) / 8192;
            uint256 hashGindex = vm.parseUint(vm.parseJsonString(json, string.concat(row, ".blockHashGindex")));
            uint256 historicalGindex =
                vm.parseUint(vm.parseJsonString(json, string.concat(row, ".historicalSummariesGindex")));
            _writeLayout(address(bridge), STATE_LAYOUTS_SLOT, stateCount++, rootsBase, first, last);
            // A Gloas row names no block hash position (0): a Gloas source reads the fixed bid index.
            if (hashGindex != 0) _writeLayout(address(bridge), BODY_LAYOUTS_SLOT, bodyCount++, hashGindex, first, last);
            _writeLayout(address(bridge), HISTORICAL_LAYOUTS_SLOT, historicalCount++, historicalGindex, first, last);
        }
        vm.store(address(bridge), bytes32(STATE_LAYOUTS_SLOT), bytes32(stateCount));
        vm.store(address(bridge), bytes32(BODY_LAYOUTS_SLOT), bytes32(bodyCount));
        vm.store(address(bridge), bytes32(HISTORICAL_LAYOUTS_SLOT), bytes32(historicalCount));
        assertEq(bridge.stateLayouts().length, stateCount, "state layouts seeded");
        assertEq(bridge.bodyLayouts().length, bodyCount, "body layouts seeded");
        assertEq(bridge.historicalLayouts().length, historicalCount, "historical layouts seeded");
    }

    /// @dev A layout struct takes two slots: the gindex, then `firstSlot` in the low 64 bits and `lastSlot` above them.
    function _writeLayout(address bridge, uint256 arraySlot, uint256 index, uint256 gindex, uint64 first, uint64 last) internal {
        bytes32 base = keccak256(abi.encode(arraySlot));
        vm.store(bridge, bytes32(uint256(base) + 2 * index), bytes32(gindex));
        vm.store(bridge, bytes32(uint256(base) + 2 * index + 1), bytes32(uint256(first) | (uint256(last) << 64)));
    }

    function _endsWith(string memory text, string memory suffix) internal pure returns (bool) {
        bytes memory a = bytes(text);
        bytes memory b = bytes(suffix);
        if (a.length < b.length) return false;
        for (uint256 i = 0; i < b.length; i++) {
            if (a[a.length - b.length + i] != b[i]) return false;
        }
        return true;
    }
}
