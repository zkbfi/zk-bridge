// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconForkGate} from "../../../src/hardened/BeaconForkGate.sol";
import {BridgeVault} from "../../../src/hardened/BridgeVault.sol";
import {BeaconBlockHeader, SSZ} from "../../../src/hardened/SSZ.sol";
import {WithdrawalScenes} from "./WithdrawalScenes.sol";
import {GateBeaconRootsMock, GateGenuineBeaconRoots} from "./GateMocks.sol";

/// @title GateSupport
/// @notice Builders for the fork gate tests: a model of the beacon roots contract, real sparse state trees, headers,
/// evidence, and time helpers. The generalized index of the version leaf is computed here by hand, not by the gate.
abstract contract GateSupport is WithdrawalScenes {
    /// @dev Ethereum timing, the same as `_newGate`.
    uint64 internal constant ETHEREUM_GENESIS = 1_606_824_023;
    uint256 internal constant SECONDS_PER_EPOCH = 12 * 32;
    /// @dev A test epoch ("E"). The block time of most tests sits three slots into it.
    uint256 internal constant EPOCH_E = 300_000;

    bytes4 internal constant CAPELLA = 0x03000000;
    bytes4 internal constant DENEB = 0x04000000;
    bytes4 internal constant ELECTRA = 0x05000000;
    bytes4 internal constant FULU = 0x06000000;
    /// @dev Not in the Ethereum table: the version after Fulu in the light-client program (excluded there too).
    bytes4 internal constant UNKNOWN_FORK = 0x07000000;
    bytes4 internal constant ALTAIR = 0x01000000;

    /// @notice A real sparse state tree and the two branches that the tests need.
    /// @param depth The depth of the state tree.
    /// @param stateRoot The root.
    /// @param currentBranch The branch of `Fork.current_version` (length depth + 2).
    /// @param previousBranch The branch of `Fork.previous_version` (length depth + 2).
    struct StateTree {
        uint256 depth;
        bytes32 stateRoot;
        bytes32[] currentBranch;
        bytes32[] previousBranch;
    }

    // ---------------------------------------------------------------- time

    function _epochStart(uint256 epoch) internal pure returns (uint256) {
        return ETHEREUM_GENESIS + epoch * SECONDS_PER_EPOCH;
    }

    /// @notice Moves the block time to `slotsIntoEpoch` slots after the start of `epoch`.
    function _warpIntoEpoch(uint256 epoch, uint256 slotsIntoEpoch) internal {
        vm.warp(_epochStart(epoch) + slotsIntoEpoch * 12);
    }

    // ---------------------------------------------------------------- the beacon roots contract

    /// @notice Puts the model of the beacon roots contract at the standard address.
    function _etchMock() internal {
        vm.etch(BEACON_ROOTS, address(new GateBeaconRootsMock()).code);
    }

    /// @notice Writes a root into the model for a timestamp.
    function _plant(uint256 timestamp, bytes32 root) internal {
        GateBeaconRootsMock(BEACON_ROOTS).plant(timestamp, root);
    }

    /// @notice Puts the genuine runtime code at the standard address, with empty storage.
    function _etchGenuine() internal {
        vm.etch(BEACON_ROOTS, GateGenuineBeaconRoots.code());
    }

    /// @notice Writes a root into the genuine code as the system address does: the call carries only the 32 byte root,
    /// and the contract stores it under the current block time.
    function _setGenuine(bytes32 root) internal {
        vm.prank(GateGenuineBeaconRoots.SYSTEM_ADDRESS);
        (bool ok,) = BEACON_ROOTS.call(abi.encode(root));
        require(ok, "genuine set failed");
    }

    // ---------------------------------------------------------------- gates

    function _gateWith(
        BeaconForkGate.GateMode mode,
        BeaconForkGate.SupportedVersion[] memory versions,
        uint8[] memory depths
    ) internal returns (BeaconForkGate) {
        return new BeaconForkGate(BEACON_ROOTS, mode, ETHEREUM_GENESIS, 12, 32, versions, depths, address(0));
    }

    function _oneVersion(bytes4 version, uint8 depth) internal pure returns (BeaconForkGate.SupportedVersion[] memory out) {
        out = new BeaconForkGate.SupportedVersion[](1);
        out[0] = BeaconForkGate.SupportedVersion(version, depth);
    }

    function _depths(uint8 a, uint8 b, uint8 c) internal pure returns (uint8[] memory out) {
        out = new uint8[](3);
        out[0] = a;
        out[1] = b;
        out[2] = c;
    }

    function _depths(uint8 a) internal pure returns (uint8[] memory out) {
        out = new uint8[](1);
        out[0] = a;
    }

    // ---------------------------------------------------------------- state trees

    /// @notice The generalized index of `Fork.current_version` for a state of `depth`, computed by hand: the state
    /// field `fork` is field 3, so its node is `2**depth + 3`. Inside the three field `Fork` container (depth 2)
    /// the leaf is at `* 4 + 1`.
    function _handGindex(uint256 depth, uint256 forkField) internal pure returns (uint256) {
        return ((2 ** depth + 3) * 4) + forkField;
    }

    /// @notice Builds a real sparse state tree of `depth` that holds `currentVersion` as `Fork.current_version`
    /// and `previousVersion` as `Fork.previous_version`, plus other leaves so that the siblings are not all zero.
    function _stateTree(uint256 depth, bytes4 currentVersion, bytes4 previousVersion)
        internal
        pure
        returns (StateTree memory tree)
    {
        uint256[] memory gindices = new uint256[](5);
        bytes32[] memory leaves = new bytes32[](5);
        gindices[0] = _handGindex(depth, 1);
        leaves[0] = bytes32(currentVersion);
        gindices[1] = _handGindex(depth, 0);
        leaves[1] = bytes32(previousVersion);
        // the epoch field of the Fork container, then two other state fields
        gindices[2] = _handGindex(depth, 2);
        leaves[2] = keccak256("fork epoch");
        gindices[3] = (2 ** depth) + 2;
        leaves[3] = keccak256("state field 2");
        gindices[4] = (2 ** depth) + 4;
        leaves[4] = keccak256("state field 4");
        (bytes32 root, bytes32[][] memory branches) = _gateSparseTree(gindices, leaves);
        tree.depth = depth;
        tree.stateRoot = root;
        tree.currentBranch = branches[0];
        tree.previousBranch = branches[1];
    }

    /// @notice The root and the branches of a sparse tree: given leaves, zero elsewhere. Every index has the same depth.
    function _gateSparseTree(uint256[] memory gindices, bytes32[] memory leaves)
        internal
        pure
        returns (bytes32 root, bytes32[][] memory branches)
    {
        uint256 depth = SSZ.depthOf(gindices[0]);
        uint256 count = gindices.length;
        branches = new bytes32[][](count);
        uint256[] memory index = new uint256[](count);
        bytes32[] memory value = new bytes32[](count);
        bytes32 zero = bytes32(0);
        for (uint256 k = 0; k < count; k++) {
            branches[k] = new bytes32[](depth);
            index[k] = gindices[k];
            value[k] = leaves[k];
        }
        for (uint256 level = 0; level < depth; level++) {
            bytes32[] memory next = new bytes32[](count);
            for (uint256 k = 0; k < count; k++) {
                bytes32 sibling = zero;
                for (uint256 j = 0; j < count; j++) {
                    if (index[j] == (index[k] ^ 1)) sibling = value[j];
                }
                branches[k][level] = sibling;
                next[k] = index[k] & 1 == 1
                    ? sha256(abi.encodePacked(sibling, value[k]))
                    : sha256(abi.encodePacked(value[k], sibling));
            }
            for (uint256 k = 0; k < count; k++) {
                index[k] >>= 1;
                value[k] = next[k];
            }
            zero = sha256(abi.encodePacked(zero, zero));
        }
        root = value[0];
    }

    /// @notice A copy of `branch` cut or extended to `length` (the extension uses fixed filler hashes).
    function _resize(bytes32[] memory branch, uint256 length) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = i < branch.length ? branch[i] : keccak256(abi.encode("filler", i));
        }
    }

    // ---------------------------------------------------------------- headers and evidence

    function _header(uint64 slot, bytes32 stateRoot) internal pure returns (BeaconBlockHeader memory) {
        return BeaconBlockHeader({
            slot: slot,
            proposerIndex: 77,
            parentRoot: keccak256(abi.encode("parent", slot)),
            stateRoot: stateRoot,
            bodyRoot: keccak256(abi.encode("body", slot))
        });
    }

    /// @notice A slot inside `epoch` (`offset` slots from its first slot).
    function _slotIn(uint256 epoch, uint256 offset) internal pure returns (uint64) {
        return uint64(epoch * 32 + offset);
    }

    function _evidence(uint256 timestamp, BeaconBlockHeader memory header, bytes4 version, bytes32[] memory branch)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(BeaconForkGate.ForkEvidence(timestamp, header, version, branch));
    }

    /// @notice Honest evidence: a state of `depth` whose current version is `version`, a header at `slot` that holds
    /// it, and the header root planted in the model under `timestamp`.
    function _honestEvidence(uint256 timestamp, uint64 slot, uint256 depth, bytes4 version)
        internal
        returns (bytes memory)
    {
        StateTree memory tree = _stateTree(depth, version, 0x02000000);
        BeaconBlockHeader memory header = _header(slot, tree.stateRoot);
        _plant(timestamp, SSZ.hashTreeRootMemory(header));
        return _evidence(timestamp, header, version, tree.currentBranch);
    }

    // ---------------------------------------------------------------- vault with a gate

    /// @notice A vault on chain A that uses `gate`, with one token pair.
    function _vaultWithGate(address gate) internal returns (BridgeVault) {
        BridgeVault.TokenPair[] memory pairs = new BridgeVault.TokenPair[](1);
        pairs[0] = BridgeVault.TokenPair(address(tokenOnA), address(tokenOnB), 18);
        vm.chainId(CHAIN_A);
        return new BridgeVault(
            address(lightClientForA), CHAIN_A, CHAIN_B, address(vaultB), pairs, BridgeVault.DepositTerms(0, address(0), address(0), 0, 0), DEFAULT_CAPELLA_ERA, gate
        );
    }

    /// @notice Mints and approves for `user`, then deposits on `vault` with `evidence`.
    function _depositWithEvidence(BridgeVault vault, address user, uint256 amount, bytes memory evidence) internal {
        tokenOnA.mint(user, amount);
        vm.chainId(CHAIN_A);
        vm.startPrank(user);
        tokenOnA.approve(address(vault), amount);
        vault.deposit(address(tokenOnA), bob, amount, 0, evidence);
        vm.stopPrank();
    }
}
