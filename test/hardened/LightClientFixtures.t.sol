// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {SSZ} from "../../src/hardened/SSZ.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

/// @notice Runs every JSON fixture that the Rust reference writes under `light-client/tests/fixtures/withdrawal/`
/// through the Solidity vault. Each fixture holds the exact `withdraw` calldata and the Rust verdict. The Solidity vault
/// must agree: accept when Rust accepts (and pay the logged amount), reject when Rust rejects.
///
/// The fixtures carry a fixed fork schedule, while the vault validates its layouts from stored light-client data. The test
/// therefore seeds the vault's three layout tables directly in storage (slots 4, 5 and 6), with the slot ranges that the
/// schedule implies. The self-validation itself is covered by `ForkLayout.t.sol`.
///
/// Reading the directory needs `fs_permissions` for `light-client/tests/fixtures/withdrawal`. The test fails without it.
contract LightClientFixturesTest is Test {
    string internal constant DIRECTORY = "light-client/tests/fixtures/withdrawal";
    uint256 internal constant STATE_LAYOUTS_SLOT = 4;
    uint256 internal constant BODY_LAYOUTS_SLOT = 5;
    uint256 internal constant HISTORICAL_LAYOUTS_SLOT = 6;
    /// @dev The number of fixture files the Rust reference writes. A change in the set must be a deliberate change here.
    uint256 internal constant EXPECTED_FIXTURE_COUNT = 73;
    /// @dev The vault never calls its deposit gate during `withdraw`, so any non-zero address stands in for it.
    address internal constant UNUSED_GATE = address(0x6a7e);
    uint64 internal constant SLOTS_PER_EPOCH = 32;
    address internal constant FIXTURE_REMOTE_TOKEN = address(0xb2);

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

    /// Claim: the Solidity vault and the Rust reference agree on every fixture. Shows: for each file, `withdraw` with the
    /// fixture calldata succeeds exactly when Rust says accept, and an accepted deposit pays the logged amount to the
    /// logged recipient and marks the logged nonce. A rejected fixture fails with the Solidity error that names the same
    /// failed check as the Rust reason. The set has exactly 73 files, and both the capella and the electra layout have
    /// at least four accepted historical-path fixtures. Matters: two independent implementations of the check (the build
    /// contract requires them to agree on accept and reject). The accept fixtures are the control of the reject fixtures:
    /// the same vault set-up pays an honest proof.
    function test_R2_04_rustFixturesAgreeWithSolidityVault() public {
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
        if (recentGasCount > 0) console2.log("average gas of an accepted recent withdraw", recentGasTotal / recentGasCount);
        if (historicalGasCount > 0) {
            console2.log("average gas of an accepted historical withdraw", historicalGasTotal / historicalGasCount);
        }
        assertEq(fixtureCount, EXPECTED_FIXTURE_COUNT, "the fixture set has the expected size");
        assertEq(accepted + rejected, fixtureCount, "every fixture ran");
        assertGt(accepted, 0, "at least one accept fixture ran");
        assertGt(rejected, 0, "at least one reject fixture ran");
        assertGe(acceptedHistoricalCapella, 4, "capella layout: at least four historical accept fixtures");
        assertGe(acceptedHistoricalElectra, 4, "electra layout: at least four historical accept fixtures");
    }

    function _runFixture(string memory json, string memory path) internal {
        (BridgeVault vault, MockERC20 localToken) = _deployFor(json);
        bytes memory callData = vm.parseJsonBytes(json, ".calldata");
        uint256 gasBefore = gasleft();
        (bool ok, bytes memory returned) = address(vault).call(callData);
        uint256 gasUsed = gasBefore - gasleft();
        bool expectAccept = keccak256(bytes(vm.parseJsonString(json, ".expected.result"))) == keccak256("accept");
        assertEq(ok, expectAccept, string.concat("vault and Rust disagree on ", path));
        if (!expectAccept) {
            rejected++;
            _assertSameReason(json, returned, path);
            return;
        }
        accepted++;
        _assertPaid(json, vault, localToken, path);
        _countAccepted(json, gasUsed);
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
    /// description says which of the two the case is, so the ancestry cases are held to the exact error.
    function _assertSameReason(string memory json, bytes memory returned, string memory path) internal view {
        string memory rustReason = vm.parseJsonString(json, ".expected.reason");
        bytes4 selector = bytes4(returned);
        bytes32 reason = keccak256(bytes(rustReason));
        bool matches;
        if (reason == keccak256("AnchorNotStored")) matches = selector == BridgeVault.AnchorNotStored.selector;
        if (reason == keccak256("InvalidBlockHashBranch")) {
            matches = selector == BridgeVault.BlockHashBranchInvalid.selector || selector == SSZ.BranchLengthMismatch.selector;
        }
        if (reason == keccak256("InvalidAncestryBranch")) matches = selector == _expectedAncestrySelector(json);
        if (reason == keccak256("ReceiptProofInvalid")) matches = selector == bytes4(0x08c379a0); // MerkleTrie `require` string
        if (reason == keccak256("DepositNotBeforeAnchor")) matches = selector == BridgeVault.DepositNotBeforeAnchor.selector;
        if (reason == keccak256("DepositBeforeCapella")) {
            matches = _isDepositBeforeCapellaEra(json, returned);
        }
        if (reason == keccak256("ReceiptFailed")) matches = selector == BridgeVault.ReceiptFailed.selector;
        if (reason == keccak256("LogEmitterMismatch")) matches = selector == BridgeVault.WrongEmitter.selector;
        if (reason == keccak256("LogIndexOutOfRange")) matches = selector == BridgeVault.LogIndexOutOfRange.selector;
        if (reason == keccak256("LogTopicMismatch")) matches = selector == BridgeVault.WrongEventTopic.selector;
        if (reason == keccak256("TargetChainMismatch")) matches = selector == BridgeVault.WrongTargetChain.selector;
        assertTrue(matches, string.concat("Solidity error differs from the Rust reason ", rustReason, " in ", path));
    }

    /// @dev A padded or short branch, and a branch built for the other path (it has the other depth), fail on length.
    /// Every other ancestry rejection has the right length and a wrong hash.
    function _expectedAncestrySelector(string memory json) internal view returns (bytes4) {
        string memory description = vm.parseJsonString(json, ".name");
        if (_contains(description, "padded") || _contains(description, "short") || _contains(description, "distance_with")) {
            return SSZ.BranchLengthMismatch.selector;
        }
        return BridgeVault.AncestryBranchInvalid.selector;
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

    /// @dev True when the revert is `DepositBeforeCapellaEra(depositEra, capellaEra)` with the fixture's capella era
    /// and a deposit era below it.
    function _isDepositBeforeCapellaEra(string memory json, bytes memory returned) internal pure returns (bool) {
        if (bytes4(returned) != BridgeVault.DepositBeforeCapellaEra.selector) return false;
        bytes memory arguments = new bytes(returned.length - 4);
        for (uint256 i = 0; i < arguments.length; i++) {
            arguments[i] = returned[i + 4];
        }
        (uint64 depositEra, uint64 capellaEra) = abi.decode(arguments, (uint64, uint64));
        uint64 fixtureCapellaEra = uint64(vm.parseUint(vm.parseJsonString(json, ".capellaEra")));
        return capellaEra == fixtureCapellaEra && depositEra < capellaEra;
    }

    function _assertPaid(string memory json, BridgeVault vault, MockERC20 localToken, string memory path) internal view {
        uint256 amount = vm.parseUint(vm.parseJsonString(json, ".expected.deposit.amount"));
        assertEq(localToken.balanceOf(vm.parseJsonAddress(json, ".expected.deposit.recipient")), amount, string.concat("amount paid in ", path));
        assertTrue(vault.claimed(vm.parseJsonBytes32(json, ".expected.deposit.nonce")), string.concat("nonce marked in ", path));
    }

    /// @dev A light client that stores the anchor (or not, when the fixture says the root is zero), a funded vault
    /// with the fixture's remote vault and token, and the seeded layouts.
    function _deployFor(string memory json) internal returns (BridgeVault vault, MockERC20 localToken) {
        uint64 localChain = uint64(vm.parseUint(vm.parseJsonString(json, ".localChainId")));
        vm.chainId(localChain);
        BeaconLightClient client = _clientFor(json);
        localToken = new MockERC20("Local", "LOC");
        BridgeVault.TokenPair[] memory pairs = new BridgeVault.TokenPair[](1);
        pairs[0] = BridgeVault.TokenPair(address(localToken), FIXTURE_REMOTE_TOKEN, 18);
        uint64 capellaEra = uint64(vm.parseUint(vm.parseJsonString(json, ".capellaEra")));
        vault = new BridgeVault(
            address(client),
            localChain,
            localChain == 369 ? 1 : 369,
            vm.parseJsonAddress(json, ".remoteVault"),
            pairs,
            0,
            capellaEra,
            UNUSED_GATE
        );
        localToken.mint(address(vault), 1_000_000e18);
        _seedLayouts(vault, json);
    }

    function _clientFor(string memory json) internal returns (BeaconLightClient) {
        uint64 anchorSlot = uint64(vm.parseUint(vm.parseJsonString(json, ".anchorSlot")));
        bytes32 storedRoot = vm.parseBytes32(vm.parseJsonString(json, ".storedAnchorHeaderRoot"));
        if (storedRoot == bytes32(0)) return _client(anchorSlot - 1, keccak256("some other header"));
        return _client(anchorSlot, storedRoot);
    }

    function _client(uint64 slot, bytes32 headerRoot) internal returns (BeaconLightClient) {
        return new BeaconLightClient(
            address(0xdead), keccak256("light client program"), keccak256("genesis"), 8192, slot, headerRoot, keccak256("committee"), keccak256("next")
        );
    }

    /// @dev Writes the layout rows of the fixture's fork schedule into the vault's three layout arrays. Each row covers the
    /// slots from its activation epoch up to the slot before the next row, and the last row covers the rest.
    /// The fixtures name the `block_roots` position as `base * 8192`. The vault stores `base`.
    function _seedLayouts(BridgeVault vault, string memory json) internal {
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
            _writeLayout(address(vault), STATE_LAYOUTS_SLOT, stateCount++, rootsBase, first, last);
            _writeLayout(address(vault), BODY_LAYOUTS_SLOT, bodyCount++, hashGindex, first, last);
            _writeLayout(address(vault), HISTORICAL_LAYOUTS_SLOT, historicalCount++, historicalGindex, first, last);
        }
        vm.store(address(vault), bytes32(STATE_LAYOUTS_SLOT), bytes32(stateCount));
        vm.store(address(vault), bytes32(BODY_LAYOUTS_SLOT), bytes32(bodyCount));
        vm.store(address(vault), bytes32(HISTORICAL_LAYOUTS_SLOT), bytes32(historicalCount));
        assertEq(vault.stateLayouts().length, stateCount, "state layouts seeded");
        assertEq(vault.bodyLayouts().length, bodyCount, "body layouts seeded");
        assertEq(vault.historicalLayouts().length, historicalCount, "historical layouts seeded");
    }

    /// @dev A layout struct takes two slots: the gindex, then `firstSlot` in the low 64 bits and `lastSlot` above them.
    function _writeLayout(address vault, uint256 arraySlot, uint256 index, uint256 gindex, uint64 first, uint64 last) internal {
        bytes32 base = keccak256(abi.encode(arraySlot));
        vm.store(vault, bytes32(uint256(base) + 2 * index), bytes32(gindex));
        vm.store(vault, bytes32(uint256(base) + 2 * index + 1), bytes32(uint256(first) | (uint256(last) << 64)));
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
