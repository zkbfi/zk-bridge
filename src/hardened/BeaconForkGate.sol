// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IDepositGate} from "./IDepositGate.sol";
import {IForkRegistry} from "./IForkRegistry.sol";
import {BeaconClock} from "./BeaconClock.sol";
import {BeaconBlockHeader, SSZ} from "./SSZ.sol";
import {ForkShape} from "./ForkShape.sol";

/// @title BeaconForkGate
/// @notice Refuses a deposit unless the chain's state has a shape that the route can read (hole HB-02, window 1).
/// The rule is the same on both chains: accept any fork version whose state proof has an allowed shape, with the genesis validators root branch
/// proving `genesis_validators_root` at that shape under the same state root. Seal only on a shape outside the allowed
/// set. The shape judging lives in `ForkShape`, one library for the EIP-4788 path and for the registry path. The gate
/// holds no list of fork version names.
/// @dev Two paths bring the evidence. On Ethereum the gate reads the chain's own recent beacon block roots through
/// EIP-4788 and requires a proof of `state.fork.current_version` and a proof of `genesis_validators_root`, both under
/// the state root of a header of the current epoch. A fork version changes only at an epoch boundary, so a proof from the
/// current epoch covers the block that the deposit lands in. PulseChain has no EIP-4788, so its evidence is the fork
/// observation registry: the observation program proves the shape, and the registry stores it next to each version.
/// After a state of a shape that the route cannot read, no accepted proof exists and deposits revert with the tokens
/// still in the wallet of the user.
///
/// Trade-off, on both chains: judging the shape gives up the check that would catch a fork that reorders fields at the
/// same depth. Such a fork passes the gate. The light client then fails closed.
///
/// Three modes, chosen at deployment from an enum. `Enforcing` (Ethereum) applies the rules from the first call.
/// `DetectBeaconRoots` probes the beacon roots contract on each call and admits every deposit while the contract is
/// absent. The first call that sees a root switches the gate to enforcing for good. There is no owner and no key: only
/// the protocol writes roots, through the system address, so the probe cannot be spoofed. A replay of the keyless
/// deployment of the genuine code on a chain without EIP-4788 leaves its storage empty, so every read reverts and the
/// gate stays in detection mode.
///
/// The generalized indices are computed in `ForkShape` from the shape, never taken from the caller. If the caller could
/// choose them, a proof of `Fork.previous_version` would pass for the current version.
///
/// The gate holds `genesisValidatorsRoot` as an immutable. The deploy script checks it against the chain that the route
/// follows.
///
/// `DetectBeaconRootsAndRegistry` (PulseChain) adds two things to detection. First, execution
/// canaries: one tiny probe contract that runs one new opcode per call (`TSTORE`, `MCOPY`, `BLOBBASEFEE`, `CLZ`, chosen
/// by the first byte of the calldata), and a call to the first BLS12-381 precompile. A PulseChain consensus fork almost
/// always arrives with an execution fork, and the first canary that works switches the gate to enforcing for good.
/// Second, a fork observation registry: while its latest observed shape is not allowed, every deposit is refused, and
/// `seal()` with empty evidence closes the gate for good. The canaries and the EIP-4788 probe decide when the gate starts
/// to enforce. They do not decide what it accepts.
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

    /// @notice The proof that the chain is in a given fork version.
    /// @param timestamp The timestamp key of the beacon roots contract. It holds the parent beacon block root.
    /// @param header A beacon block header whose root the beacon roots contract returns for `timestamp`.
    /// @param version The claimed `Fork.current_version` of the state of that header. The gate does not judge its name.
    /// @param branch The branch from the version leaf to `header.stateRoot`, deepest first.
    /// @param genesisValidatorsRootBranch The branch from `genesis_validators_root` (field 1 of the state) to `header.stateRoot`,
    /// deepest first. It pins the shape. A seal proof of a shape outside the allowed set needs no genesis validators root branch.
    struct ForkEvidence {
        uint256 timestamp;
        BeaconBlockHeader header;
        bytes4 version;
        bytes32[] branch;
        bytes32[] genesisValidatorsRootBranch;
    }

    /// @dev One storage slot: the gate reads it once for the cheapest deposit.
    struct GateState {
        uint64 confirmedEpoch;
        bool hasConfirmedEpoch;
        bool isSealed;
        bool enforcing;
        uint64 highestConfirmedSlot;
    }

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
    bytes private constant PROBE_RUNTIME = hex"5f3560f81c" hex"80600114" hex"602457" hex"80600214" hex"602c57"
        hex"80600314" hex"603557" hex"80600414" hex"603b57" hex"5f5ffd" hex"5b60015f5d603f56" hex"5b60205f5f5e603f56"
        hex"5b4a50603f56" hex"5b5f1e50" hex"5b60015f5260205ff3";
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
    /// @notice The version branch has a length that fits no allowed shape. `depth` is the tree depth that the length
    /// implies.
    error ShapeNotAllowed(uint256 depth);
    /// @notice A seal needs a shape outside the allowed set, and the proof shows an allowed one.
    error ShapeIsAllowed(uint8 shape);
    /// @notice The version branch is valid for an allowed shape, but the genesis validators root branch of `genesis_validators_root`
    /// is not valid at that shape under the same state root.
    error GenesisValidatorsRootBranchInvalid();
    /// @notice The branch of a seal proof implies a tree depth below `ForkShape.MIN_SEAL_DEPTH` or above
    /// `ForkShape.MAX_SEAL_DEPTH`.
    error SealDepthNotAllowed(uint256 depth);
    /// @notice The branch does not lead from the version to the state root.
    error ForkProofInvalid();
    /// @notice A registry address is set in a mode that has no registry, or missing in the mode that needs one.
    error ForkRegistryMismatch(GateMode mode, address forkRegistry);
    /// @notice The fork registry address holds no code.
    error ForkRegistryHasNoCode(address forkRegistry);
    /// @notice The opcode probe contract did not deploy.
    error ProbeDeploymentFailed();
    /// @notice The fork registry shows an observed state shape that the route does not allow.
    error ObservedShapeNotAllowed(bytes4 version, uint8 shape, uint64 slot);
    /// @notice `seal` with empty evidence needs an observed shape outside the allowed set in the registry, and there is
    /// none.
    error NoDisallowedObservedShape();
    /// @notice The block time is before the genesis time of the chain.
    error BeforeGenesis(uint256 timestamp, uint64 genesisTime);
    /// @notice A seal proof is older than the newest evidence that the gate trusts.
    error SealEvidenceTooOld(uint64 slot, uint64 minimumSlot);

    /// @notice Emitted once, when detection mode first reads a beacon root and the gate becomes enforcing.
    event BeaconRootsDetected();
    /// @notice Emitted when a proof of an allowed shape confirms the fork version for an epoch.
    event ForkConfirmed(uint256 indexed epoch, bytes4 version);
    /// @notice Emitted once, when an execution canary first works and the gate becomes enforcing.
    event ExecutionCanaryFired(Canary canary);
    /// @notice Emitted when a proof of a shape outside the allowed set seals the gate for good. The registry path
    /// reports the observed version and slot.
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
    /// @notice The `genesis_validators_root` of the beacon chain that the route follows. The genesis validators root leaf must equal it.
    bytes32 public immutable genesisValidatorsRoot;
    /// @notice The genesis time of the beacon chain of this chain, in seconds.
    uint64 public immutable genesisTime;
    /// @notice Seconds per slot (12 on Ethereum, 10 on PulseChain).
    uint64 public immutable secondsPerSlot;
    /// @notice Slots per epoch (32 on both).
    uint64 public immutable slotsPerEpoch;
    /// @notice The slot of the block that deployed the gate (zero when that block is before genesis). A seal proof
    /// from an earlier slot is refused.
    uint64 public immutable deploymentSlot;

    GateState private _state;

    /// @param beaconRoots_ The EIP-4788 contract address.
    /// @param mode_ `Enforcing`, `DetectBeaconRoots` or `DetectBeaconRootsAndRegistry`.
    /// @param genesisTime_ Genesis time of the beacon chain.
    /// @param secondsPerSlot_ Seconds per slot.
    /// @param slotsPerEpoch_ Slots per epoch.
    /// @param genesisValidatorsRoot_ The `genesis_validators_root` of the beacon chain that the route follows. The
    /// deploy script checks it against the chain.
    /// @param forkRegistry_ The fork observation registry. It must hold code in `DetectBeaconRootsAndRegistry` mode
    /// and must be zero in every other mode.
    constructor(
        address beaconRoots_,
        GateMode mode_,
        uint64 genesisTime_,
        uint64 secondsPerSlot_,
        uint64 slotsPerEpoch_,
        bytes32 genesisValidatorsRoot_,
        address forkRegistry_
    ) {
        if (beaconRoots_ == address(0)) revert ZeroValue("beaconRoots");
        if (genesisTime_ == 0) revert ZeroValue("genesisTime");
        if (secondsPerSlot_ == 0) revert ZeroValue("secondsPerSlot");
        if (slotsPerEpoch_ == 0) revert ZeroValue("slotsPerEpoch");
        if (genesisValidatorsRoot_ == bytes32(0)) revert ZeroValue("genesisValidatorsRoot");
        if ((mode_ == GateMode.DetectBeaconRootsAndRegistry) != (forkRegistry_ != address(0))) {
            revert ForkRegistryMismatch(mode_, forkRegistry_);
        }
        if (forkRegistry_ != address(0) && forkRegistry_.code.length == 0) revert ForkRegistryHasNoCode(forkRegistry_);

        beaconRoots = beaconRoots_;
        mode = mode_;
        genesisTime = genesisTime_;
        secondsPerSlot = secondsPerSlot_;
        slotsPerEpoch = slotsPerEpoch_;
        genesisValidatorsRoot = genesisValidatorsRoot_;
        deploymentSlot = BeaconClock.slotAt(block.timestamp, genesisTime_, secondsPerSlot_);
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
        _requireObservedShapeAllowed();
        if (!state.enforcing) {
            if (!_detectAndEnter()) return;
            state.enforcing = true;
        }
        uint256 epoch = _currentEpoch();
        if (state.hasConfirmedEpoch && state.confirmedEpoch == epoch) return;
        if (evidence.length == 0) revert ForkNotConfirmed(epoch);
        _confirm(abi.decode(evidence, (ForkEvidence)), epoch);
    }

    /// @notice Confirms an allowed state shape for the current epoch with no deposit. Anyone may call it, for
    /// example a keeper. It runs the same checks as `admit`. A confirmed epoch makes the call do nothing.
    /// In detection mode it first needs a working probe.
    /// @param evidence An `abi.encode` of a `ForkEvidence`.
    function confirm(bytes calldata evidence) external {
        if (_state.isSealed) revert GateSealed();
        _requireObservedShapeAllowed();
        GateState memory state = _wake();
        uint256 epoch = _currentEpoch();
        if (state.hasConfirmedEpoch && state.confirmedEpoch == epoch) return;
        _confirm(abi.decode(evidence, (ForkEvidence)), epoch);
    }

    /// @notice Seals the gate for good, given a valid version branch at a depth outside the allowed set of shapes. There
    /// is no epoch rule, but the header must not be older than the deployment slot or the newest header that a
    /// confirmation accepted (`SealEvidenceTooOld`). Fork versions only move forward, so a shape outside the allowed set
    /// at or after a slot where an allowed shape was live cannot be a stale one. Without this rule, an old header that
    /// the beacon roots ring buffer still holds could seal the gate. In detection mode it first needs a working probe.
    /// Withdrawals are not affected.
    /// @param evidence An `abi.encode` of a `ForkEvidence`. The version branch length must imply a depth from
    /// `ForkShape.MIN_SEAL_DEPTH` to `ForkShape.MAX_SEAL_DEPTH`. The genesis validators root branch is not read for a disallowed depth.
    /// In registry mode, empty evidence seals from the registry instead: it succeeds when the registry shows a shape
    /// outside the allowed set.
    function seal(bytes calldata evidence) external {
        if (_state.isSealed) revert GateSealed();
        if (evidence.length == 0 && address(forkRegistry) != address(0)) {
            _sealFromRegistry();
            return;
        }
        _wake();
        ForkEvidence memory proof = abi.decode(evidence, (ForkEvidence));

        _requireBeaconHeader(proof);
        uint64 minimumSlot = _state.highestConfirmedSlot > deploymentSlot ? _state.highestConfirmedSlot : deploymentSlot;
        if (proof.header.slot < minimumSlot) revert SealEvidenceTooOld(proof.header.slot, minimumSlot);
        _requireDisallowedShapeProven(proof);

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

    /// @notice The allowed state shapes: plain depths and `ForkShape.PROGRESSIVE`. The set is the same on both chains.
    function allowedShapes() external pure returns (uint8[] memory) {
        return ForkShape.allowedShapes();
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

    /// @dev Registry mode: refuses while the latest observed shape is set and not allowed.
    function _requireObservedShapeAllowed() private view {
        IForkRegistry registry = forkRegistry;
        if (address(registry) == address(0)) return;
        (bytes4 version, uint8 shape, uint64 slot) = registry.latestObserved();
        if (slot == 0) return;
        if (!ForkShape.isAllowed(shape)) revert ObservedShapeNotAllowed(version, shape, slot);
    }

    /// @dev Seals from the registry, with no proof: the registry already holds a proven shape outside the allowed set.
    function _sealFromRegistry() private {
        (bytes4 version, uint8 shape, uint64 slot) = forkRegistry.latestObserved();
        if (slot == 0) revert NoDisallowedObservedShape();
        if (ForkShape.isAllowed(shape)) revert NoDisallowedObservedShape();
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
        _requireAllowedShapeProven(proof);

        GateState memory state = _state;
        state.confirmedEpoch = uint64(epoch);
        state.hasConfirmedEpoch = true;
        if (proof.header.slot > state.highestConfirmedSlot) state.highestConfirmedSlot = proof.header.slot;
        _state = state;
        emit ForkConfirmed(epoch, proof.version);
    }

    /// @dev Judges the evidence with `ForkShape` and reverts unless the shape is allowed and both branches verify.
    function _requireAllowedShapeProven(ForkEvidence memory proof) private view {
        (ForkShape.Verdict verdict,) = _judge(proof);
        if (verdict == ForkShape.Verdict.Allowed) return;
        if (verdict == ForkShape.Verdict.GenesisValidatorsRootProofInvalid) revert GenesisValidatorsRootBranchInvalid();
        if (verdict == ForkShape.Verdict.VersionProofInvalid) revert ForkProofInvalid();
        revert ShapeNotAllowed(ForkShape.depthOfVersionBranch(proof.branch.length));
    }

    /// @dev A seal needs a valid version branch at a depth outside the allowed set, inside the seal bounds.
    function _requireDisallowedShapeProven(ForkEvidence memory proof) private view {
        uint256 depth = ForkShape.depthOfVersionBranch(proof.branch.length);
        if (depth < ForkShape.MIN_SEAL_DEPTH || depth > ForkShape.MAX_SEAL_DEPTH) revert SealDepthNotAllowed(depth);
        (ForkShape.Verdict verdict, uint8 shape) = _judge(proof);
        if (verdict == ForkShape.Verdict.Allowed) revert ShapeIsAllowed(shape);
        if (verdict == ForkShape.Verdict.GenesisValidatorsRootProofInvalid) revert GenesisValidatorsRootBranchInvalid();
        if (verdict == ForkShape.Verdict.VersionProofInvalid) revert ForkProofInvalid();
        if (!ForkShape.provesPlainVersion(proof.header.stateRoot, proof.version, proof.branch, depth)) {
            revert ForkProofInvalid();
        }
    }

    function _judge(ForkEvidence memory proof) private view returns (ForkShape.Verdict, uint8) {
        return ForkShape.judge(proof.header.stateRoot, proof.version, proof.branch, proof.genesisValidatorsRootBranch, genesisValidatorsRoot);
    }

    /// @dev The header must be the block whose root the beacon roots contract holds for the timestamp.
    function _requireBeaconHeader(ForkEvidence memory proof) private view {
        bytes32 root = _beaconRootAt(proof.timestamp);
        if (root == bytes32(0)) revert BeaconRootUnavailable(proof.timestamp);
        bytes32 headerRoot = SSZ.hashTreeRootMemory(proof.header);
        if (headerRoot != root) revert HeaderRootMismatch(root, headerRoot);
    }
}
