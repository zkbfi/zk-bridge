// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IDepositGate} from "./IDepositGate.sol";
import {IForkRegistry} from "./IForkRegistry.sol";
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
/// A third mode, `DetectBeaconRootsAndRegistry` (PulseChain), adds two things to detection. First, execution canaries:
/// one tiny probe contract that runs one new opcode per call (`TSTORE`, `MCOPY`, `BLOBBASEFEE`, `CLZ`, chosen by the
/// first byte of the calldata), and a call to the first BLS12-381 precompile. A PulseChain consensus fork almost always arrives with an execution fork, and the first canary
/// that works switches the gate to enforcing for good. Second, a fork observation registry: while its latest observed
/// version is not supported, every deposit is refused, and `seal()` with empty evidence closes the gate for good.
///
/// The runtime code of the gate avoids `MCOPY`, `TSTORE` and `TLOAD`, because PulseChain rejects them. The probe holds
/// those opcodes on purpose, as a separate contract that the constructor deploys from raw bytes.
contract BeaconForkGate is IDepositGate {
    /// @notice The behavior of the gate before it has seen a beacon root.
    enum GateMode {
        /// @dev The rules apply from the first call (Ethereum).
        Enforcing,
        /// @dev The gate admits every deposit until the beacon roots contract answers with a root (PulseChain).
        /// Execution canaries also switch it to enforcing.
        DetectBeaconRoots,
        /// @dev As `DetectBeaconRoots`, and the gate also refuses while the fork registry shows an unsupported version.
        DetectBeaconRootsAndRegistry
    }

    /// @notice The execution canaries, in the order the gate tries them.
    enum Canary {
        TransientStorage,
        MemoryCopy,
        BlobBaseFee,
        CountLeadingZeros,
        Bls12381Precompile
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
        uint64 highestConfirmedSlot;
    }

    /// @notice The most supported versions a gate holds. They are packed into one immutable word, 5 bytes each.
    uint256 public constant MAX_SUPPORTED_VERSIONS = 6;
    /// @notice The largest state depth the gate accepts in its configuration.
    uint8 public constant MAX_STATE_DEPTH = 31;
    /// @dev The depth of the `Fork` container (three fields).
    uint256 private constant FORK_DEPTH = 2;
    /// @dev The position of `fork` among the `BeaconState` fields.
    uint256 private constant FORK_FIELD_INDEX = 3;

    /// @notice The gas forwarded to each call of the opcode probe. The costliest path (`TSTORE`, which costs 100 gas by
    /// itself) needs 167, measured, and the others need 97 to 126. The cap leaves room for a later repricing of a
    /// cheap opcode. A call
    /// whose opcode is not valid burns all its gas, so this is also the most that one canary can cost.
    uint256 public constant PROBE_GAS = 400;
    /// @notice The gas forwarded to the BLS12-381 precompile canary. `BLS12_G1ADD` costs 375 gas (EIP-2537). The cap
    /// leaves room for a later repricing and still bounds a mock that burns gas.
    uint256 public constant PRECOMPILE_GAS = 2_000;
    /// @notice The address of `BLS12_G1ADD` (EIP-2537, "Specification": G1ADD is 0x0b, G1MSM 0x0c, G2ADD 0x0d,
    /// G2MSM 0x0e, PAIRING_CHECK 0x0f, MAP_FP_TO_G1 0x10, MAP_FP2_TO_G2 0x11).
    address public constant BLS_G1_ADD = address(0x0b);
    /// @notice The word the probe returns when its opcode ran.
    uint256 public constant PROBE_WORD = 1;

    /// @dev The runtime code of the opcode probe. It reads the first byte of the calldata as a selector, from 1 to 4
    /// in the order of the `Canary` enum (selector = index + 1). Each selector jumps to its own path. A path runs
    /// exactly one new opcode and then returns the word 1. Any other selector, and empty calldata, reverts. `PUSH0`
    /// (0x5f) is EIP-3855, live in Shanghai. The jump targets are byte offsets in this code, and a test fails if one
    /// is wrong.
    ///
    ///   00  5f 35 60f8 1c        PUSH0 CALLDATALOAD PUSH1 0xf8 SHR       selector on the stack
    ///   05  80 6001 14 6024 57   DUP1 PUSH1 1 EQ PUSH1 0x24 JUMPI        selector 1: TSTORE path
    ///   0c  80 6002 14 602c 57   selector 2: MCOPY path
    ///   13  80 6003 14 6035 57   selector 3: BLOBBASEFEE path
    ///   1a  80 6004 14 603b 57   selector 4: CLZ path
    ///   21  5f 5f fd             PUSH0 PUSH0 REVERT                      unknown selector
    ///   24  5b 6001 5f 5d 603f 56        JUMPDEST, key 0 value 1 TSTORE, jump to the return
    ///   2c  5b 6020 5f 5f 5e 603f 56     JUMPDEST, copy 32 bytes from 0 to 0 (MCOPY), jump to the return
    ///   35  5b 4a 50 603f 56             JUMPDEST BLOBBASEFEE POP, jump to the return
    ///   3b  5b 5f 1e 50                  JUMPDEST PUSH0 CLZ POP, falls into the return
    ///   3f  5b 6001 5f52 60205f f3       JUMPDEST, store 1 in memory, RETURN 32 bytes
    /// Opcode values: TSTORE 0x5d (EIP-1153), MCOPY 0x5e (EIP-5656), BLOBBASEFEE 0x4a (EIP-7516), CLZ 0x1e (EIP-7939).
    bytes private constant PROBE_RUNTIME =
        hex"5f3560f81c" hex"80600114" hex"602457" hex"80600214" hex"602c57" hex"80600314" hex"603557" hex"80600414"
        hex"603b57" hex"5f5ffd" hex"5b60015f5d603f56" hex"5b60205f5f5e603f56" hex"5b4a50603f56" hex"5b5f1e50"
        hex"5b60015f5260205ff3";
    /// @dev The generator of G1 on BLS12-381 (EIP-2537 encoding: each field element is 64 bytes, big endian, with 16
    /// leading zero bytes). Source: the BLS12-381 parameters; the point satisfies y^2 = x^3 + 4 modulo the field prime.
    /// Adding the point at infinity (128 zero bytes) to it must return it unchanged. Held as 32 byte words so that the
    /// bytes are push data in the runtime code, never a data section.
    bytes32 private constant BLS_G1_X_HIGH = 0x0000000000000000000000000000000017f1d3a73197d7942695638c4fa9ac0f;
    bytes32 private constant BLS_G1_X_LOW = 0xc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb;
    bytes32 private constant BLS_G1_Y_HIGH = 0x0000000000000000000000000000000008b3f481e3aaa0f1a09e30ed741d8ae4;
    bytes32 private constant BLS_G1_Y_LOW = 0xfcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1;

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
    /// @notice A registry address is set in a mode that has no registry, or missing in the mode that needs one.
    error ForkRegistryMismatch(GateMode mode, address forkRegistry);
    /// @notice The fork registry address holds no code.
    error ForkRegistryHasNoCode(address forkRegistry);
    /// @notice The opcode probe contract did not deploy.
    error ProbeDeploymentFailed();
    /// @notice The fork registry shows an observed fork version that the route does not support.
    error UnsupportedObservedVersion(bytes4 version, uint64 slot);
    /// @notice `seal` with empty evidence needs an unsupported observed version in the registry, and there is none.
    error NoUnsupportedObservation();
    /// @notice The block time is before the genesis time of the chain.
    error BeforeGenesis(uint256 timestamp, uint64 genesisTime);
    /// @notice A seal proof is older than the newest evidence that the gate trusts.
    error SealEvidenceTooOld(uint64 slot, uint64 minimumSlot);

    /// @notice Emitted once, when detection mode first reads a beacon root and the gate becomes enforcing.
    event BeaconRootsDetected();
    /// @notice Emitted when a proof confirms a supported fork version for an epoch.
    event ForkConfirmed(uint256 indexed epoch, bytes4 version);
    /// @notice Emitted once, when an execution canary first works and the gate becomes enforcing.
    event ExecutionCanaryFired(Canary canary);
    /// @notice Emitted when a proof of an unsupported version seals the gate for good.
    event GateSealedByFork(bytes4 version, uint64 slot);

    /// @notice The beacon roots contract (EIP-4788): 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02.
    address public immutable beaconRoots;
    /// @notice Whether the gate starts enforcing or starts in detection mode.
    GateMode public immutable mode;
    /// @notice The fork observation registry. Zero except in `DetectBeaconRootsAndRegistry` mode.
    IForkRegistry public immutable forkRegistry;
    /// @notice The one probe contract for the four opcode canaries (`TSTORE`, `MCOPY`, `BLOBBASEFEE`, `CLZ`). The
    /// first byte of the calldata picks the opcode.
    address public immutable opcodeProbe;
    /// @notice The genesis time of the beacon chain of this chain, in seconds.
    uint64 public immutable genesisTime;
    /// @notice Seconds per slot (12 on Ethereum, 10 on PulseChain).
    uint64 public immutable secondsPerSlot;
    /// @notice Slots per epoch (32 on both).
    uint64 public immutable slotsPerEpoch;
    /// @notice The slot of the block that deployed the gate (zero when that block is before genesis). A seal proof
    /// from an earlier slot is refused.
    uint64 public immutable deploymentSlot;

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
    /// @param forkRegistry_ The fork observation registry. It must hold code in `DetectBeaconRootsAndRegistry` mode
    /// and must be zero in every other mode.
    constructor(
        address beaconRoots_,
        GateMode mode_,
        uint64 genesisTime_,
        uint64 secondsPerSlot_,
        uint64 slotsPerEpoch_,
        SupportedVersion[] memory supportedVersions_,
        uint8[] memory sealDepths_,
        address forkRegistry_
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
        if ((mode_ == GateMode.DetectBeaconRootsAndRegistry) != (forkRegistry_ != address(0))) {
            revert ForkRegistryMismatch(mode_, forkRegistry_);
        }
        if (forkRegistry_ != address(0) && forkRegistry_.code.length == 0) revert ForkRegistryHasNoCode(forkRegistry_);

        beaconRoots = beaconRoots_;
        mode = mode_;
        genesisTime = genesisTime_;
        secondsPerSlot = secondsPerSlot_;
        slotsPerEpoch = slotsPerEpoch_;
        deploymentSlot = block.timestamp < genesisTime_ ? 0 : uint64((block.timestamp - genesisTime_) / secondsPerSlot_);
        _packedVersions = _pack(supportedVersions_);
        _versionCount = supportedVersions_.length;
        _sealDepthMask = _maskOf(sealDepths_);
        forkRegistry = IForkRegistry(forkRegistry_);
        opcodeProbe = _deployProbe(PROBE_RUNTIME);

        if (mode_ == GateMode.Enforcing) _state.enforcing = true;
    }

    // ------------------------------------------------------------------ entry points

    /// @inheritdoc IDepositGate
    /// @dev Step 0 refuses a sealed gate. Step 1 asks the registry (registry mode only). Step 2 detects in detection
    /// mode: the beacon roots probe, then the execution canaries. Step 3 returns when the epoch is confirmed.
    /// Step 4 decodes the evidence and confirms. Empty evidence in an unconfirmed epoch reverts.
    function admit(bytes calldata evidence) external override {
        GateState memory state = _state;
        if (state.isSealed) revert GateSealed();
        _requireObservedVersionSupported();
        if (!state.enforcing) {
            if (!_detectAndEnter()) return;
            state.enforcing = true;
        }
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
        if (_state.isSealed) revert GateSealed();
        _requireObservedVersionSupported();
        GateState memory state = _wake();
        uint256 epoch = _currentEpoch();
        if (state.hasConfirmedEpoch && state.confirmedEpoch == epoch) return;
        _confirm(abi.decode(evidence, (ForkEvidence)), epoch);
    }

    /// @notice Seals the gate for good, given a proof of a fork version the route does not support. There is no epoch
    /// rule, but the header must not be older than the deployment slot or the newest header that a confirmation
    /// accepted (`SealEvidenceTooOld`). Fork versions only move forward, so an unknown version at or after a slot
    /// where a supported version was live cannot be a stale one. Without this rule, an old header that the beacon
    /// roots ring buffer still holds could seal the gate. In detection mode it first needs a working probe.
    /// Withdrawals are not affected.
    /// @param evidence An `abi.encode` of a `ForkEvidence`. The branch length must imply a depth in `sealDepths`.
    /// In registry mode, empty evidence seals from the registry instead: it succeeds when the registry shows an unsupported version.
    function seal(bytes calldata evidence) external {
        if (_state.isSealed) revert GateSealed();
        if (evidence.length == 0 && address(forkRegistry) != address(0)) {
            _sealFromRegistry();
            return;
        }
        _wake();
        ForkEvidence memory proof = abi.decode(evidence, (ForkEvidence));
        (bool supported,) = _lookup(proof.version);
        if (supported) revert VersionIsSupported(proof.version);

        _requireBeaconHeader(proof);
        uint64 minimumSlot = _state.highestConfirmedSlot > deploymentSlot ? _state.highestConfirmedSlot : deploymentSlot;
        if (proof.header.slot < minimumSlot) revert SealEvidenceTooOld(proof.header.slot, minimumSlot);
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

    /// @dev Detection mode: a working probe or canary is needed, then the gate enforces. Returns the state after the
    /// switch.
    function _wake() private returns (GateState memory state) {
        state = _state;
        if (state.enforcing) return state;
        if (!_detectAndEnter()) revert BeaconRootsAbsent();
        state.enforcing = true;
    }

    /// @dev Runs the detectors in order: the beacon roots probe, then the canaries. The first that works sets
    /// `enforcing` for good. Returns whether one worked. A revert later in the same call undoes the switch.
    function _detectAndEnter() private returns (bool) {
        if (_beaconRootsPresent()) {
            _state.enforcing = true;
            emit BeaconRootsDetected();
            return true;
        }
        (bool fired, Canary canary) = _firedCanary();
        if (!fired) return false;
        _state.enforcing = true;
        emit ExecutionCanaryFired(canary);
        return true;
    }

    /// @dev The first canary that works, in the order of the `Canary` enum.
    function _firedCanary() private returns (bool fired, Canary canary) {
        if (_probeFires(Canary.TransientStorage)) return (true, Canary.TransientStorage);
        if (_probeFires(Canary.MemoryCopy)) return (true, Canary.MemoryCopy);
        if (_probeFires(Canary.BlobBaseFee)) return (true, Canary.BlobBaseFee);
        if (_probeFires(Canary.CountLeadingZeros)) return (true, Canary.CountLeadingZeros);
        if (_blsPrecompileWorks()) return (true, Canary.Bls12381Precompile);
        return (false, Canary.TransientStorage);
    }

    /// @dev Calls the opcode probe once for one canary, with `PROBE_GAS`. The calldata is one byte: the index of the
    /// canary plus one. The canary works when the call succeeds and returns exactly the word 1. A call whose opcode is
    /// not valid fails and costs only the forwarded gas. Each call runs one path alone, so a missing opcode fails only
    /// its own canary. A plain `CALL` is used, not `STATICCALL`, because `TSTORE` is a state change and fails in a
    /// static context (EIP-1153).
    function _probeFires(Canary canary) private returns (bool) {
        address probe = opcodeProbe;
        uint256 selector = uint256(uint8(canary)) + 1;
        bool ok;
        uint256 size;
        uint256 word;
        assembly {
            let scratch := mload(0x40)
            mstore8(scratch, selector)
            mstore(add(scratch, 0x20), 0)
            ok := call(PROBE_GAS, probe, 0, scratch, 1, add(scratch, 0x20), 0x20)
            size := returndatasize()
            word := mload(add(scratch, 0x20))
        }
        return ok && size == 32 && word == PROBE_WORD;
    }

    /// @dev Calls `BLS12_G1ADD` with the generator and the point at infinity. A chain that has the precompile
    /// returns the generator (128 bytes). A chain without it treats the address as an empty account: the call
    /// succeeds and returns nothing, so the size check rejects it.
    function _blsPrecompileWorks() private view returns (bool) {
        bool ok;
        uint256 size;
        bool same;
        bytes32 xHigh = BLS_G1_X_HIGH;
        bytes32 xLow = BLS_G1_X_LOW;
        bytes32 yHigh = BLS_G1_Y_HIGH;
        bytes32 yLow = BLS_G1_Y_LOW;
        assembly {
            let input := mload(0x40)
            mstore(input, xHigh)
            mstore(add(input, 0x20), xLow)
            mstore(add(input, 0x40), yHigh)
            mstore(add(input, 0x60), yLow)
            mstore(add(input, 0x80), 0)
            mstore(add(input, 0xa0), 0)
            mstore(add(input, 0xc0), 0)
            mstore(add(input, 0xe0), 0)
            let output := add(input, 0x100)
            ok := staticcall(PRECOMPILE_GAS, 0x0b, input, 0x100, output, 0x80)
            size := returndatasize()
            same := and(
                and(eq(mload(output), xHigh), eq(mload(add(output, 0x20)), xLow)),
                and(eq(mload(add(output, 0x40)), yHigh), eq(mload(add(output, 0x60)), yLow))
            )
        }
        return ok && size == 0x80 && same;
    }

    /// @dev Registry mode: refuses while the latest observed version is set and not supported.
    function _requireObservedVersionSupported() private view {
        IForkRegistry registry = forkRegistry;
        if (address(registry) == address(0)) return;
        (bytes4 version, uint64 slot) = registry.latestObserved();
        if (slot == 0) return;
        (bool supported,) = _lookup(version);
        if (!supported) revert UnsupportedObservedVersion(version, slot);
    }

    /// @dev Seals from the registry, with no proof: the registry already holds a proven unsupported version.
    function _sealFromRegistry() private {
        (bytes4 version, uint64 slot) = forkRegistry.latestObserved();
        if (slot == 0) revert NoUnsupportedObservation();
        (bool supported,) = _lookup(version);
        if (supported) revert NoUnsupportedObservation();
        _state.isSealed = true;
        emit GateSealedByFork(version, slot);
    }

    /// @dev Deploys raw runtime code with `create`. The init code copies the runtime code and returns it:
    /// `PUSH1 len DUP1 PUSH1 9 PUSH0 CODECOPY PUSH0 RETURN`.
    function _deployProbe(bytes memory runtime) private returns (address probe) {
        bytes memory initCode = abi.encodePacked(hex"60", uint8(runtime.length), hex"8060095f395ff3", runtime);
        assembly {
            probe := create(0, add(initCode, 0x20), mload(initCode))
        }
        if (probe == address(0)) revert ProbeDeploymentFailed();
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

        GateState memory state = _state;
        state.confirmedEpoch = uint64(epoch);
        state.hasConfirmedEpoch = true;
        if (proof.header.slot > state.highestConfirmedSlot) state.highestConfirmedSlot = proof.header.slot;
        _state = state;
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
