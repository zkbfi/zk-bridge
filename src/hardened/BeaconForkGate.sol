// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IDepositGate} from "./IDepositGate.sol";
import {BeaconBlockHeader, SSZ} from "./SSZ.sol";

/// @title BeaconForkGate
/// @notice Refuses a deposit unless the chain's current fork version is one the route supports (hole HB-02, window 1).
/// The gate reads the chain's own recent beacon block roots through EIP-4788 and requires a proof that
/// `state.fork.current_version` is a supported version, in the current epoch. A fork version changes only at an epoch
/// boundary, so a proof from the current epoch covers the block that the deposit lands in. After a fork that the route
/// does not know, no such proof exists and deposits revert with the tokens still in the wallet of the user.
/// @dev Two modes, chosen at deployment from an enum. `Enforcing` (Ethereum) applies the rules from the first call.
/// `DetectBeaconRoots` (PulseChain, which has no EIP-4788 today) probes the beacon roots contract on each call and
/// admits every deposit while the contract is absent. The first call that sees a root switches the gate to enforcing
/// for good. There is no owner and no key: only the protocol writes roots, through the system address, so the probe
/// cannot be spoofed. A replay of the keyless deployment of the genuine code on a chain without EIP-4788 leaves its
/// storage empty, so every read reverts and the gate stays in detection mode.
///
/// The generalized index of the version leaf is computed here from the configured depth, never taken from the caller.
/// If the caller could choose it, a proof of `Fork.previous_version` would pass for the current version.
///
/// The gate is deployed on both chains and avoids `MCOPY`, `TSTORE` and `TLOAD`, because PulseChain rejects them.
contract BeaconForkGate is IDepositGate {
    /// @notice The behavior of the gate before it has seen a beacon root.
    enum GateMode {
        /// @dev The rules apply from the first call (Ethereum).
        Enforcing,
        /// @dev The gate admits every deposit until the beacon roots contract answers with a root (PulseChain).
        DetectBeaconRoots
    }

    /// @notice A supported fork version and the depth of the `BeaconState` tree in that fork.
    /// @param version The value of `Fork.current_version`.
    /// @param stateDepth The depth of the `BeaconState` tree: 5 up to 32 fields, 6 up to 64 fields.
    struct SupportedVersion {
        bytes4 version;
        uint8 stateDepth;
    }

    /// @notice The proof that the chain is in a given fork version.
    /// @param timestamp The timestamp key of the beacon roots contract. It holds the parent beacon block root.
    /// @param header A beacon block header whose root the beacon roots contract returns for `timestamp`.
    /// @param version The claimed `Fork.current_version` of the state of that header.
    /// @param branch The branch from the version leaf to `header.stateRoot`, deepest first.
    struct ForkEvidence {
        uint256 timestamp;
        BeaconBlockHeader header;
        bytes4 version;
        bytes32[] branch;
    }

    /// @dev One storage slot: the gate reads it once for the cheapest deposit.
    struct GateState {
        uint64 confirmedEpoch;
        bool hasConfirmedEpoch;
        bool isSealed;
        bool enforcing;
    }

    /// @notice The most supported versions a gate holds. They are packed into one immutable word, 5 bytes each.
    uint256 public constant MAX_SUPPORTED_VERSIONS = 6;
    /// @notice The largest state depth the gate accepts in its configuration.
    uint8 public constant MAX_STATE_DEPTH = 31;
    /// @dev The depth of the `Fork` container (three fields).
    uint256 private constant FORK_DEPTH = 2;
    /// @dev The position of `fork` among the `BeaconState` fields.
    uint256 private constant FORK_FIELD_INDEX = 3;

    /// @notice A constructor argument is zero or empty.
    error ZeroValue(string name);
    /// @notice The configuration lists more than `MAX_SUPPORTED_VERSIONS` versions.
    error TooManySupportedVersions(uint256 count);
    /// @notice A supported version appears twice.
    error DuplicateSupportedVersion(bytes4 version);
    /// @notice A state depth is zero or above `MAX_STATE_DEPTH`.
    error StateDepthOutOfRange(uint8 depth);
    /// @notice The gate is sealed. No deposit passes, and the seal never clears.
    error GateSealed();
    /// @notice The epoch has no confirmation and the deposit brought no evidence.
    error ForkNotConfirmed(uint256 epoch);
    /// @notice Detection mode only: the beacon roots contract returns no root, so the gate cannot confirm or seal.
    error BeaconRootsAbsent();
    /// @notice The beacon roots contract returned no root for the timestamp (out of its ring buffer, or empty).
    error BeaconRootUnavailable(uint256 timestamp);
    /// @notice The header does not hash to the beacon root of the timestamp.
    error HeaderRootMismatch(bytes32 expected, bytes32 actual);
    /// @notice The header is not from the current epoch.
    error HeaderNotInCurrentEpoch(uint256 headerEpoch, uint256 currentEpoch);
    /// @notice The version is not one the route supports.
    error UnsupportedVersion(bytes4 version);
    /// @notice A seal needs a version the route does not support, and this one is supported.
    error VersionIsSupported(bytes4 version);
    /// @notice The branch of a seal proof implies a state depth that the gate does not allow.
    error SealDepthNotAllowed(uint256 depth);
    /// @notice The branch does not lead from the version to the state root.
    error ForkProofInvalid();
    /// @notice The block time is before the genesis time of the chain.
    error BeforeGenesis(uint256 timestamp, uint64 genesisTime);

    /// @notice Emitted once, when detection mode first reads a beacon root and the gate becomes enforcing.
    event BeaconRootsDetected();
    /// @notice Emitted when a proof confirms a supported fork version for an epoch.
    event ForkConfirmed(uint256 indexed epoch, bytes4 version);
    /// @notice Emitted when a proof of an unsupported version seals the gate for good.
    event GateSealedByFork(bytes4 version, uint64 slot);

    /// @notice The beacon roots contract (EIP-4788): 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02.
    address public immutable beaconRoots;
    /// @notice Whether the gate starts enforcing or starts in detection mode.
    GateMode public immutable mode;
    /// @notice The genesis time of the beacon chain of this chain, in seconds.
    uint64 public immutable genesisTime;
    /// @notice Seconds per slot (12 on Ethereum, 10 on PulseChain).
    uint64 public immutable secondsPerSlot;
    /// @notice Slots per epoch (32 on both).
    uint64 public immutable slotsPerEpoch;

    /// @dev The supported versions, 5 bytes each: the version, then the depth. Entry `i` sits at byte `5 * i`.
    bytes32 private immutable _packedVersions;
    uint256 private immutable _versionCount;
    /// @dev Bit `d` is set when depth `d` is allowed for a seal proof.
    uint256 private immutable _sealDepthMask;

    GateState private _state;

    /// @param beaconRoots_ The EIP-4788 contract address.
    /// @param mode_ `Enforcing` or `DetectBeaconRoots`.
    /// @param genesisTime_ Genesis time of the beacon chain.
    /// @param secondsPerSlot_ Seconds per slot.
    /// @param slotsPerEpoch_ Slots per epoch.
    /// @param supportedVersions_ The `(version, state depth)` pairs. They must equal the fork table of the route's
    /// light-client program.
    /// @param sealDepths_ The state depths allowed in a seal proof: 5, 6 and 7. Depth 7 covers a future fork that
    /// crosses 64 state fields.
    constructor(
        address beaconRoots_,
        GateMode mode_,
        uint64 genesisTime_,
        uint64 secondsPerSlot_,
        uint64 slotsPerEpoch_,
        SupportedVersion[] memory supportedVersions_,
        uint8[] memory sealDepths_
    ) {
        if (beaconRoots_ == address(0)) revert ZeroValue("beaconRoots");
        if (genesisTime_ == 0) revert ZeroValue("genesisTime");
        if (secondsPerSlot_ == 0) revert ZeroValue("secondsPerSlot");
        if (slotsPerEpoch_ == 0) revert ZeroValue("slotsPerEpoch");
        if (supportedVersions_.length == 0) revert ZeroValue("supportedVersions");
        if (supportedVersions_.length > MAX_SUPPORTED_VERSIONS) {
            revert TooManySupportedVersions(supportedVersions_.length);
        }
        if (sealDepths_.length == 0) revert ZeroValue("sealDepths");

        beaconRoots = beaconRoots_;
        mode = mode_;
        genesisTime = genesisTime_;
        secondsPerSlot = secondsPerSlot_;
        slotsPerEpoch = slotsPerEpoch_;
        _packedVersions = _pack(supportedVersions_);
        _versionCount = supportedVersions_.length;
        _sealDepthMask = _maskOf(sealDepths_);

        if (mode_ == GateMode.Enforcing) _state.enforcing = true;
    }

    // ------------------------------------------------------------------ entry points

    /// @inheritdoc IDepositGate
    /// @dev Step 0 probes in detection mode. Step 1 refuses a sealed gate. Step 2 returns when the epoch is confirmed.
    /// Step 3 decodes the evidence and confirms. Empty evidence in an unconfirmed epoch reverts.
    function admit(bytes calldata evidence) external override {
        GateState memory state = _state;
        if (!state.enforcing) {
            if (!_beaconRootsPresent()) return;
            _enterEnforcing();
            state.enforcing = true;
        }
        if (state.isSealed) revert GateSealed();
        uint256 epoch = _currentEpoch();
        if (state.hasConfirmedEpoch && state.confirmedEpoch == epoch) return;
        if (evidence.length == 0) revert ForkNotConfirmed(epoch);
        _confirm(abi.decode(evidence, (ForkEvidence)), epoch);
    }

    /// @notice Confirms the supported fork version for the current epoch with no deposit. Anyone may call it, for
    /// example a keeper. It runs the same checks as `admit`. A confirmed epoch makes the call do nothing.
    /// In detection mode it first needs a working probe.
    /// @param evidence An `abi.encode` of a `ForkEvidence`.
    function confirm(bytes calldata evidence) external {
        GateState memory state = _wake();
        if (state.isSealed) revert GateSealed();
        uint256 epoch = _currentEpoch();
        if (state.hasConfirmedEpoch && state.confirmedEpoch == epoch) return;
        _confirm(abi.decode(evidence, (ForkEvidence)), epoch);
    }

    /// @notice Seals the gate for good, given a proof of a fork version the route does not support. There is no epoch
    /// rule: any recent proven state with an unknown current version is enough. In detection mode it first needs a
    /// working probe. Withdrawals are not affected.
    /// @param evidence An `abi.encode` of a `ForkEvidence`. The branch length must imply a depth in `sealDepths`.
    function seal(bytes calldata evidence) external {
        GateState memory state = _wake();
        if (state.isSealed) revert GateSealed();
        ForkEvidence memory proof = abi.decode(evidence, (ForkEvidence));
        (bool supported,) = _lookup(proof.version);
        if (supported) revert VersionIsSupported(proof.version);

        _requireBeaconHeader(proof);
        if (proof.branch.length < FORK_DEPTH + 1) revert SealDepthNotAllowed(0);
        uint256 depth = proof.branch.length - FORK_DEPTH;
        if (depth > MAX_STATE_DEPTH || (_sealDepthMask >> depth) & 1 == 0) revert SealDepthNotAllowed(depth);
        _requireVersionLeaf(proof, depth);

        _state.isSealed = true;
        emit GateSealedByFork(proof.version, proof.header.slot);
    }

    // ------------------------------------------------------------------ views

    /// @notice Whether the gate applies its rules. True from deployment in `Enforcing` mode, and after detection.
    function enforcing() external view returns (bool) {
        return _state.enforcing;
    }

    /// @notice Whether a seal proof closed the gate. (`sealed` is a reserved word in Solidity.)
    function isSealed() external view returns (bool) {
        return _state.isSealed;
    }

    /// @notice The last epoch confirmed by a proof, and whether any epoch was confirmed.
    function confirmedEpoch() external view returns (uint64 epoch, bool exists) {
        GateState memory state = _state;
        return (state.confirmedEpoch, state.hasConfirmedEpoch);
    }

    /// @notice The epoch of the current block.
    function currentEpoch() external view returns (uint256) {
        return _currentEpoch();
    }

    /// @notice The supported `(version, state depth)` pairs, in configuration order.
    function supportedVersions() external view returns (SupportedVersion[] memory versions) {
        uint256 count = _versionCount;
        bytes32 packed = _packedVersions;
        versions = new SupportedVersion[](count);
        for (uint256 i = 0; i < count; i++) {
            versions[i] = _unpack(packed, i);
        }
    }

    /// @notice The state depths allowed in a seal proof, in ascending order.
    function sealDepths() external view returns (uint8[] memory depths) {
        uint256 mask = _sealDepthMask;
        uint256 count;
        for (uint256 depth = 0; depth <= MAX_STATE_DEPTH; depth++) {
            if ((mask >> depth) & 1 == 1) count++;
        }
        depths = new uint8[](count);
        uint256 next;
        for (uint256 depth = 0; depth <= MAX_STATE_DEPTH; depth++) {
            if ((mask >> depth) & 1 == 1) depths[next++] = uint8(depth);
        }
    }

    // ------------------------------------------------------------------ internals

    /// @dev Detection mode: a working probe is needed, then the gate enforces. Returns the state after the switch.
    function _wake() private returns (GateState memory state) {
        state = _state;
        if (state.enforcing) return state;
        if (!_beaconRootsPresent()) revert BeaconRootsAbsent();
        _enterEnforcing();
        state.enforcing = true;
    }

    function _enterEnforcing() private {
        _state.enforcing = true;
        emit BeaconRootsDetected();
    }

    /// @dev The probe. The beacon roots contract is present when it returns exactly 32 non-zero bytes for the
    /// timestamp of this block. A call that fails, a short or long answer, or a zero word means absent. The answer is
    /// copied into one scratch word, so a long answer costs nothing extra.
    function _beaconRootsPresent() private view returns (bool present) {
        address target = beaconRoots;
        uint256 lookupKey = block.timestamp;
        uint256 word;
        uint256 size;
        bool ok;
        assembly {
            let scratch := mload(0x40)
            mstore(scratch, lookupKey)
            ok := staticcall(gas(), target, scratch, 0x20, scratch, 0x20)
            size := returndatasize()
            word := mload(scratch)
        }
        return ok && size == 32 && word != 0;
    }

    /// @dev The beacon root for a timestamp, or zero when the call fails or does not return 32 bytes.
    function _beaconRootAt(uint256 lookupKey) private view returns (bytes32 root) {
        address target = beaconRoots;
        uint256 size;
        bool ok;
        assembly {
            let scratch := mload(0x40)
            mstore(scratch, lookupKey)
            ok := staticcall(gas(), target, scratch, 0x20, scratch, 0x20)
            size := returndatasize()
            root := mload(scratch)
        }
        if (!ok || size != 32) return bytes32(0);
        return root;
    }

    function _currentEpoch() private view returns (uint256) {
        if (block.timestamp < genesisTime) revert BeforeGenesis(block.timestamp, genesisTime);
        return (block.timestamp - genesisTime) / secondsPerSlot / slotsPerEpoch;
    }

    /// @dev The checks of a confirmation, then the write.
    function _confirm(ForkEvidence memory proof, uint256 epoch) private {
        _requireBeaconHeader(proof);
        uint256 headerEpoch = proof.header.slot / slotsPerEpoch;
        if (headerEpoch != epoch) revert HeaderNotInCurrentEpoch(headerEpoch, epoch);
        (bool supported, uint8 depth) = _lookup(proof.version);
        if (!supported) revert UnsupportedVersion(proof.version);
        _requireVersionLeaf(proof, depth);

        _state.confirmedEpoch = uint64(epoch);
        _state.hasConfirmedEpoch = true;
        emit ForkConfirmed(epoch, proof.version);
    }

    /// @dev The header must be the block whose root the beacon roots contract holds for the timestamp.
    function _requireBeaconHeader(ForkEvidence memory proof) private view {
        bytes32 root = _beaconRootAt(proof.timestamp);
        if (root == bytes32(0)) revert BeaconRootUnavailable(proof.timestamp);
        bytes32 headerRoot = SSZ.hashTreeRootMemory(proof.header);
        if (headerRoot != root) revert HeaderRootMismatch(root, headerRoot);
    }

    /// @dev The version, right-padded to 32 bytes, must be the leaf at `BeaconState.fork.current_version`. The index
    /// is computed here: field 3 of the state, then field 1 of the three-field `Fork` container.
    function _requireVersionLeaf(ForkEvidence memory proof, uint256 stateDepth) private pure {
        uint256 forkIndex = (uint256(1) << stateDepth) + FORK_FIELD_INDEX;
        uint256 gindex = forkIndex * 4 + 1;
        if (!SSZ.isValidBranchMemory(bytes32(proof.version), proof.branch, gindex, proof.header.stateRoot)) {
            revert ForkProofInvalid();
        }
    }

    function _lookup(bytes4 version) private view returns (bool found, uint8 depth) {
        uint256 count = _versionCount;
        bytes32 packed = _packedVersions;
        for (uint256 i = 0; i < count; i++) {
            SupportedVersion memory entry = _unpack(packed, i);
            if (entry.version == version) return (true, entry.stateDepth);
        }
        return (false, 0);
    }

    function _pack(SupportedVersion[] memory versions) private pure returns (bytes32 packed) {
        uint256 word;
        for (uint256 i = 0; i < versions.length; i++) {
            SupportedVersion memory entry = versions[i];
            if (entry.stateDepth == 0 || entry.stateDepth > MAX_STATE_DEPTH) revert StateDepthOutOfRange(entry.stateDepth);
            for (uint256 j = 0; j < i; j++) {
                if (versions[j].version == entry.version) revert DuplicateSupportedVersion(entry.version);
            }
            uint256 entryBits = (uint256(uint32(entry.version)) << 8) | entry.stateDepth;
            word |= entryBits << (256 - 40 * (i + 1));
        }
        return bytes32(word);
    }

    function _unpack(bytes32 packed, uint256 index) private pure returns (SupportedVersion memory entry) {
        uint256 entryBits = (uint256(packed) >> (256 - 40 * (index + 1))) & 0xFFFFFFFFFF;
        entry.version = bytes4(uint32(entryBits >> 8));
        entry.stateDepth = uint8(entryBits);
    }

    function _maskOf(uint8[] memory depths) private pure returns (uint256 mask) {
        for (uint256 i = 0; i < depths.length; i++) {
            if (depths[i] == 0 || depths[i] > MAX_STATE_DEPTH) revert StateDepthOutOfRange(depths[i]);
            mask |= uint256(1) << depths[i];
        }
    }
}
