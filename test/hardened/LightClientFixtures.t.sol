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
/// therefore seeds the vault's layout table directly in storage (slots 4 and 5), with the slot ranges that the schedule
/// implies. The self-validation itself is covered by `ForkLayout.t.sol`.
///
/// Reading the directory needs `fs_permissions` for `light-client/tests/fixtures/withdrawal`. Without it the test skips.
contract LightClientFixturesTest is Test {
    string internal constant DIRECTORY = "light-client/tests/fixtures/withdrawal";
    uint256 internal constant STATE_LAYOUTS_SLOT = 4;
    uint256 internal constant BODY_LAYOUTS_SLOT = 5;
    uint64 internal constant SLOTS_PER_EPOCH = 32;
    address internal constant FIXTURE_REMOTE_TOKEN = address(0xb2);

    uint256 internal accepted;
    uint256 internal rejected;

    function listFixtures() external view returns (VmSafe.DirEntry[] memory) {
        return vm.readDir(DIRECTORY);
    }

    /// Claim: the Solidity vault and the Rust reference agree on every fixture. Shows: for each file, `withdraw` with the
    /// fixture calldata succeeds exactly when Rust says accept, and an accepted deposit pays the logged amount to the
    /// logged recipient and marks the logged nonce. Matters: two independent implementations of the check (the build
    /// contract requires them to agree on accept and reject).
    function test_R2_04_rustFixturesAgreeWithSolidityVault() public {
        VmSafe.DirEntry[] memory entries;
        try this.listFixtures() returns (VmSafe.DirEntry[] memory found) {
            entries = found;
        } catch {
            vm.skip(true, "fs_permissions does not allow reading light-client/tests/fixtures/withdrawal");
        }
        for (uint256 i = 0; i < entries.length; i++) {
            if (!_endsWith(entries[i].path, ".json")) continue;
            _runFixture(vm.readFile(entries[i].path), entries[i].path);
        }
        console2.log("accepted fixtures", accepted);
        console2.log("rejected fixtures", rejected);
        assertGt(accepted, 0, "at least one accept fixture ran");
        assertGt(rejected, 0, "at least one reject fixture ran");
    }

    function _runFixture(string memory json, string memory path) internal {
        (BridgeVault vault, MockERC20 localToken) = _deployFor(json);
        (bool ok, bytes memory returned) = address(vault).call(vm.parseJsonBytes(json, ".calldata"));
        bool expectAccept = keccak256(bytes(vm.parseJsonString(json, ".expected.result"))) == keccak256("accept");
        assertEq(ok, expectAccept, string.concat("vault and Rust disagree on ", path));
        if (!expectAccept) {
            rejected++;
            _assertSameReason(vm.parseJsonString(json, ".expected.reason"), returned, path);
            return;
        }
        accepted++;
        _assertPaid(json, vault, localToken, path);
    }

    /// @dev The Rust reason and the Solidity error must name the same failed check. Some checks have two Solidity
    /// errors (a wrong branch length is reported as a length error, not as a failed hash).
    function _assertSameReason(string memory rustReason, bytes memory returned, string memory path) internal pure {
        bytes4 selector = bytes4(returned);
        bytes32 reason = keccak256(bytes(rustReason));
        bool matches;
        if (reason == keccak256("AnchorNotStored")) matches = selector == BridgeVault.AnchorNotStored.selector;
        if (reason == keccak256("InvalidBlockHashBranch")) {
            matches = selector == BridgeVault.BlockHashBranchInvalid.selector || selector == SSZ.BranchLengthMismatch.selector;
        }
        if (reason == keccak256("InvalidBlockRootsBranch")) {
            matches = selector == BridgeVault.BlockRootsBranchInvalid.selector || selector == SSZ.BranchLengthMismatch.selector;
        }
        if (reason == keccak256("ReceiptProofInvalid")) matches = selector == bytes4(0x08c379a0); // MerkleTrie `require` string
        if (reason == keccak256("DepositOutsideHistoricalWindow")) {
            matches = selector == BridgeVault.DepositOutsideWindow.selector || selector == BridgeVault.DepositNotBeforeAnchor.selector;
        }
        if (reason == keccak256("ReceiptFailed")) matches = selector == BridgeVault.ReceiptFailed.selector;
        if (reason == keccak256("LogEmitterMismatch")) matches = selector == BridgeVault.WrongEmitter.selector;
        if (reason == keccak256("LogIndexOutOfRange")) matches = selector == BridgeVault.LogIndexOutOfRange.selector;
        if (reason == keccak256("LogTopicMismatch")) matches = selector == BridgeVault.WrongEventTopic.selector;
        if (reason == keccak256("TargetChainMismatch")) matches = selector == BridgeVault.WrongTargetChain.selector;
        assertTrue(matches, string.concat("Solidity error differs from the Rust reason ", rustReason, " in ", path));
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
        vault = new BridgeVault(
            address(client), localChain, localChain == 369 ? 1 : 369, vm.parseJsonAddress(json, ".remoteVault"), pairs, 0
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
            address(0xdead), keccak256("light client program"), keccak256("genesis"), 8192, slot, headerRoot, keccak256("committee"), keccak256("next"), 8192
        );
    }

    /// @dev Writes the layout rows of the fixture's fork schedule into the vault's two layout arrays. Each row covers the
    /// slots from its activation epoch up to the slot before the next row, and the last row covers the rest.
    /// The fixtures name the `block_roots` position as `base * 8192`. The vault stores `base`.
    function _seedLayouts(BridgeVault vault, string memory json) internal {
        uint256 count;
        while (vm.keyExistsJson(json, string.concat(".sourceForkSchedule[", vm.toString(count), "]"))) count++;
        uint256 stateCount;
        uint256 bodyCount;
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
            _writeLayout(address(vault), STATE_LAYOUTS_SLOT, stateCount++, rootsBase, first, last);
            _writeLayout(address(vault), BODY_LAYOUTS_SLOT, bodyCount++, hashGindex, first, last);
        }
        vm.store(address(vault), bytes32(STATE_LAYOUTS_SLOT), bytes32(stateCount));
        vm.store(address(vault), bytes32(BODY_LAYOUTS_SLOT), bytes32(bodyCount));
        assertEq(vault.stateLayouts().length, stateCount, "state layouts seeded");
        assertEq(vault.bodyLayouts().length, bodyCount, "body layouts seeded");
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
