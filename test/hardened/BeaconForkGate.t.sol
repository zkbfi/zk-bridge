// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {GateSupport} from "./utils/GateSupport.sol";
import {
    GateGenuineBeaconRoots,
    GateAnswersZero,
    GateAnswersShort,
    GateAnswersLong,
    GateAnswersGarbage,
    GateAlwaysReverts
} from "./utils/GateMocks.sol";
import {WithdrawalScenes} from "./utils/WithdrawalScenes.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";
import {MessageRecorder} from "./utils/MessageTargets.sol";

/// @notice Tests of `BeaconForkGate` (hole HB-02, window 1) and of its use by the message bridge. The beacon roots contract is
/// modelled by `GateBeaconRootsMock` (same ring buffer), and the genuine EIP-4788 runtime code is used where the
/// behavior of the real code matters. State trees are real sparse Merkle trees hashed with SHA-256.
contract BeaconForkGateTest is GateSupport {
    BeaconForkGate internal gate;
    /// @dev Epoch E, three slots in.
    uint256 internal constant NOW_SLOTS = 3;

    event ForkConfirmed(uint256 indexed epoch, bytes4 version);
    event GateSealedByFork(bytes4 version, uint64 slot);
    event BeaconRootsDetected();

    function setUp() public override {
        super.setUp();
        _warpIntoEpoch(EPOCH_E, NOW_SLOTS);
        _etchMock();
        gate = _newGate(BeaconForkGate.GateMode.Enforcing);
    }

    // ---------------------------------------------------------------- shortcuts

    /// @dev The slot of the block time of `setUp`, which is also the deployment slot of `gate`.
    function _slotNow() internal pure returns (uint64) {
        return _slotIn(EPOCH_E, NOW_SLOTS);
    }

    /// @dev Honest evidence for Electra (depth 6) at the current block time, header in epoch E.
    function _good() internal returns (bytes memory) {
        return _honestEvidence(block.timestamp, _slotNow(), 6, ELECTRA);
    }

    function _err(bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(selector);
    }

    // ================================================================ constructor

    /// Claim: every empty or zero configuration value is refused with its own name. Shows: six reverts, each
    /// `ZeroValue(name)`. Control: the same call with all values set deploys. Matters: a gate with zero timing
    /// would divide by zero or never confirm.
    function test_HB02_constructor_zeroValuesRefused() public {
        BeaconForkGate.SupportedVersion[] memory versions = _oneVersion(ELECTRA, 6);
        uint8[] memory depths = _depths(6);
        BeaconForkGate.SupportedVersion[] memory none = new BeaconForkGate.SupportedVersion[](0);
        uint8[] memory noDepths = new uint8[](0);
        BeaconForkGate.GateMode mode = BeaconForkGate.GateMode.Enforcing;

        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ZeroValue.selector, "beaconRoots"));
        new BeaconForkGate(address(0), mode, ETHEREUM_GENESIS, 12, 32, versions, depths, address(0));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ZeroValue.selector, "genesisTime"));
        new BeaconForkGate(BEACON_ROOTS, mode, 0, 12, 32, versions, depths, address(0));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ZeroValue.selector, "secondsPerSlot"));
        new BeaconForkGate(BEACON_ROOTS, mode, ETHEREUM_GENESIS, 0, 32, versions, depths, address(0));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ZeroValue.selector, "slotsPerEpoch"));
        new BeaconForkGate(BEACON_ROOTS, mode, ETHEREUM_GENESIS, 12, 0, versions, depths, address(0));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ZeroValue.selector, "supportedVersions"));
        new BeaconForkGate(BEACON_ROOTS, mode, ETHEREUM_GENESIS, 12, 32, none, depths, address(0));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ZeroValue.selector, "sealDepths"));
        new BeaconForkGate(BEACON_ROOTS, mode, ETHEREUM_GENESIS, 12, 32, versions, noDepths, address(0));

        BeaconForkGate control = new BeaconForkGate(BEACON_ROOTS, mode, ETHEREUM_GENESIS, 12, 32, versions, depths, address(0));
        assertEq(control.beaconRoots(), BEACON_ROOTS, "the control deploys with the honest values");
    }

    /// Claim: seven supported versions are refused, six are accepted. Shows: `TooManySupportedVersions(7)`; six
    /// deploy. Matters: the versions are packed into one word of six entries; a seventh would be cut silently.
    function test_HB02_constructor_tooManySupportedVersions() public {
        BeaconForkGate.SupportedVersion[] memory seven = new BeaconForkGate.SupportedVersion[](7);
        for (uint256 i = 0; i < 7; i++) {
            seven[i] = BeaconForkGate.SupportedVersion(bytes4(uint32(0x10000000 + i)), 5);
        }
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.TooManySupportedVersions.selector, 7));
        _gateWith(BeaconForkGate.GateMode.Enforcing, seven, _depths(5));

        BeaconForkGate.SupportedVersion[] memory six = new BeaconForkGate.SupportedVersion[](6);
        for (uint256 i = 0; i < 6; i++) {
            six[i] = seven[i];
        }
        BeaconForkGate six_ = _gateWith(BeaconForkGate.GateMode.Enforcing, six, _depths(5));
        assertEq(six_.supportedVersions().length, 6, "six entries fit");
    }

    /// Claim: the same version twice is refused with the version in the error. Shows: `DuplicateSupportedVersion`
    /// for entries 0 and 1 and for entries 0 and 2 (not only neighbours). Control: distinct versions deploy.
    /// Matters: with a duplicate the second depth would never be used, a silent misconfiguration.
    function test_HB02_constructor_duplicateVersionRefused() public {
        BeaconForkGate.SupportedVersion[] memory versions = new BeaconForkGate.SupportedVersion[](3);
        versions[0] = BeaconForkGate.SupportedVersion(CAPELLA, 5);
        versions[1] = BeaconForkGate.SupportedVersion(CAPELLA, 6);
        versions[2] = BeaconForkGate.SupportedVersion(DENEB, 5);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.DuplicateSupportedVersion.selector, CAPELLA));
        _gateWith(BeaconForkGate.GateMode.Enforcing, versions, _depths(5));

        versions[1] = BeaconForkGate.SupportedVersion(DENEB, 6);
        versions[2] = BeaconForkGate.SupportedVersion(CAPELLA, 5);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.DuplicateSupportedVersion.selector, CAPELLA));
        _gateWith(BeaconForkGate.GateMode.Enforcing, versions, _depths(5));

        versions[2] = BeaconForkGate.SupportedVersion(ELECTRA, 6);
        _gateWith(BeaconForkGate.GateMode.Enforcing, versions, _depths(5));
    }

    /// Claim: a state depth of 0 or above 31 is refused, for supported versions and for seal depths. Shows:
    /// `StateDepthOutOfRange(depth)` in four cases, and depth 1 and 31 are accepted. Matters: depth 0 would make a
    /// proof of length 2 pass for a version leaf in the fork container itself.
    function test_HB02_constructor_stateDepthOutOfRange() public {
        BeaconForkGate.GateMode mode = BeaconForkGate.GateMode.Enforcing;
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.StateDepthOutOfRange.selector, 0));
        _gateWith(mode, _oneVersion(ELECTRA, 0), _depths(6));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.StateDepthOutOfRange.selector, 32));
        _gateWith(mode, _oneVersion(ELECTRA, 32), _depths(6));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.StateDepthOutOfRange.selector, 0));
        _gateWith(mode, _oneVersion(ELECTRA, 6), _depths(0));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.StateDepthOutOfRange.selector, 32));
        _gateWith(mode, _oneVersion(ELECTRA, 6), _depths(32));

        BeaconForkGate edge = _gateWith(mode, _oneVersion(ELECTRA, 31), _depths(1));
        assertEq(edge.supportedVersions()[0].stateDepth, 31, "depth 31 is the largest accepted");
        assertEq(edge.sealDepths()[0], 1, "depth 1 is the smallest accepted");
    }

    /// Claim: the getters of the immutable settings return what the constructor got. Shows: all five values and the
    /// mode, for both modes. Matters: the deploy script and the audit read these values.
    function test_HB02_constructor_settingsAreReadable() public {
        assertEq(gate.beaconRoots(), BEACON_ROOTS);
        assertEq(uint256(gate.mode()), uint256(BeaconForkGate.GateMode.Enforcing));
        assertEq(gate.genesisTime(), ETHEREUM_GENESIS);
        assertEq(gate.secondsPerSlot(), 12);
        assertEq(gate.slotsPerEpoch(), 32);
        assertEq(gate.MAX_SUPPORTED_VERSIONS(), 6);
        assertEq(gate.MAX_STATE_DEPTH(), 31);
        BeaconForkGate detecting = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
        assertEq(uint256(detecting.mode()), uint256(BeaconForkGate.GateMode.DetectBeaconRoots));
    }

    // ================================================================ getters

    /// Claim: `supportedVersions()` and `sealDepths()` return exactly the configuration of the Ethereum table.
    /// Shows: four entries in order with their depths, seal depths 5, 6, 7. Matters: the deploy check reads these.
    function test_HB02_getters_returnTheConfiguration() public view {
        BeaconForkGate.SupportedVersion[] memory versions = gate.supportedVersions();
        assertEq(versions.length, 4);
        assertEq(versions[0].version, CAPELLA);
        assertEq(versions[0].stateDepth, 5);
        assertEq(versions[1].version, DENEB);
        assertEq(versions[1].stateDepth, 5);
        assertEq(versions[2].version, ELECTRA);
        assertEq(versions[2].stateDepth, 6);
        assertEq(versions[3].version, FULU);
        assertEq(versions[3].stateDepth, 6);
        uint8[] memory depths = gate.sealDepths();
        assertEq(depths.length, 3);
        assertEq(depths[0], 5);
        assertEq(depths[1], 6);
        assertEq(depths[2], 7);
    }

    /// Claim: six entries with distinct versions and depths round-trip bit for bit through the packed word. Shows:
    /// all six versions and depths are returned unchanged, including the extreme depths 1 and 31 and version 0xffffffff.
    /// Matters: the packing is 40 bits per entry; a shift error corrupts the last entry first.
    function test_HB02_getters_sixEntryPackingRoundTrips() public {
        BeaconForkGate.SupportedVersion[] memory six = new BeaconForkGate.SupportedVersion[](6);
        six[0] = BeaconForkGate.SupportedVersion(0x00000001, 1);
        six[1] = BeaconForkGate.SupportedVersion(0xffffffff, 31);
        six[2] = BeaconForkGate.SupportedVersion(0x0000036c, 5);
        six[3] = BeaconForkGate.SupportedVersion(0x80000000, 17);
        six[4] = BeaconForkGate.SupportedVersion(0x01020304, 2);
        six[5] = BeaconForkGate.SupportedVersion(0xa5a5a5a5, 30);
        BeaconForkGate packed = _gateWith(BeaconForkGate.GateMode.Enforcing, six, _depths(5, 6, 7));
        BeaconForkGate.SupportedVersion[] memory back = packed.supportedVersions();
        assertEq(back.length, 6);
        for (uint256 i = 0; i < 6; i++) {
            assertEq(back[i].version, six[i].version, "version round trips");
            assertEq(back[i].stateDepth, six[i].stateDepth, "depth round trips");
        }
    }

    /// Claim: for any count of 1 to 6 distinct versions and any depths 1 to 31, the getter returns the input.
    /// Shows: a fuzz over a base version and depth seeds (versions are base + index, so they are distinct).
    /// Matters: the packing must hold for all values, not only the hand picked ones.
    function testFuzz_HB02_getters_packingRoundTrips(uint32 base, uint8[6] memory depthSeeds, uint8 countSeed) public {
        uint256 count = 1 + (countSeed % 6);
        BeaconForkGate.SupportedVersion[] memory input = new BeaconForkGate.SupportedVersion[](count);
        for (uint256 i = 0; i < count; i++) {
            unchecked {
                input[i] = BeaconForkGate.SupportedVersion(bytes4(base + uint32(i)), 1 + (depthSeeds[i] % 31));
            }
        }
        BeaconForkGate fuzzed = _gateWith(BeaconForkGate.GateMode.Enforcing, input, _depths(5));
        BeaconForkGate.SupportedVersion[] memory back = fuzzed.supportedVersions();
        assertEq(back.length, count);
        for (uint256 i = 0; i < count; i++) {
            assertEq(back[i].version, input[i].version);
            assertEq(back[i].stateDepth, input[i].stateDepth);
        }
    }

    /// Claim: seal depths come back in ascending order without duplicates (the gate stores a bit mask). Shows:
    /// configuring 7, 5, 7 returns 5, 7. Matters: documents that the getter returns the set, not the input order.
    function test_HB02_getters_sealDepthsAreASortedSet() public {
        uint8[] memory input = _depths(7, 5, 7);
        BeaconForkGate other = _gateWith(BeaconForkGate.GateMode.Enforcing, _oneVersion(ELECTRA, 6), input);
        uint8[] memory depths = other.sealDepths();
        assertEq(depths.length, 2);
        assertEq(depths[0], 5);
        assertEq(depths[1], 7);
    }

    // ================================================================ epoch maths

    /// Claim: `currentEpoch()` equals `(t - genesis) / 12 / 32` at known times. Shows: the first and last second of
    /// epoch 0 and 1, the Capella activation epoch 194048 (hand computed from the genesis time), and epoch E.
    /// Matters: an off by one epoch lets a stale confirmation cover the epoch of a fork.
    function test_HB02_epoch_currentEpochFollowsTheFormula() public {
        vm.warp(ETHEREUM_GENESIS);
        assertEq(gate.currentEpoch(), 0);
        vm.warp(ETHEREUM_GENESIS + 383);
        assertEq(gate.currentEpoch(), 0, "the last second of epoch 0");
        vm.warp(ETHEREUM_GENESIS + 384);
        assertEq(gate.currentEpoch(), 1, "the first second of epoch 1");
        vm.warp(1_606_824_023 + 194_048 * 384 - 1);
        assertEq(gate.currentEpoch(), 194_047);
        vm.warp(1_606_824_023 + 194_048 * 384);
        assertEq(gate.currentEpoch(), 194_048, "the Capella activation epoch");
        _warpIntoEpoch(EPOCH_E, 31);
        assertEq(gate.currentEpoch(), EPOCH_E);
    }

    /// Claim: a block time before genesis is refused. Shows: `BeforeGenesis(timestamp, genesisTime)` from `admit`,
    /// `confirm` (and the view). Control: at genesis the same call is a normal refusal of missing evidence.
    /// Matters: the subtraction must not wrap around into a huge epoch.
    function test_HB02_epoch_beforeGenesisRefused() public {
        vm.warp(ETHEREUM_GENESIS - 1);
        bytes memory expected =
            abi.encodeWithSelector(BeaconForkGate.BeforeGenesis.selector, uint256(ETHEREUM_GENESIS - 1), ETHEREUM_GENESIS);
        vm.expectRevert(expected);
        gate.admit("");
        vm.expectRevert(expected);
        gate.confirm("");
        vm.expectRevert(expected);
        gate.currentEpoch();

        vm.warp(ETHEREUM_GENESIS);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, 0));
        gate.admit("");
    }

    /// Claim: a gate with the PulseChain timing (10 seconds per slot, genesis from its fixture) computes epochs of 320
    /// seconds and confirms the Capella version `0x0000036c` at depth 5 like the Ethereum gate does. Shows: epoch
    /// numbers at known times, a confirmation in epoch 3 (the Capella epoch there) and a refusal in epoch 4 without
    /// evidence. Matters: both chains use one contract with different timing.
    function test_HB02_epoch_pulsechainTimingBehavesTheSame() public {
        string memory genesisJson = vm.readFile("light-client/tests/fixtures/pulsechain/genesis.json");
        uint64 genesis = uint64(vm.parseUint(vm.parseJsonString(genesisJson, ".response.data.genesis_time")));
        assertEq(genesis, 1_683_785_555, "the fixture holds the PulseChain genesis time");
        BeaconForkGate pulse = new BeaconForkGate(
            BEACON_ROOTS,
            BeaconForkGate.GateMode.DetectBeaconRoots,
            genesis,
            10,
            32,
            _oneVersion(0x0000036c, 5),
            _depths(5, 6, 7),
            address(0)
        );
        vm.warp(genesis + 319);
        assertEq(pulse.currentEpoch(), 0);
        vm.warp(genesis + 320);
        assertEq(pulse.currentEpoch(), 1);
        vm.warp(genesis + 3 * 320 + 10);
        assertEq(pulse.currentEpoch(), 3);

        bytes memory evidence = _honestEvidence(block.timestamp, 3 * 32 + 1, 5, 0x0000036c);
        vm.expectEmit(true, false, false, true, address(pulse));
        emit ForkConfirmed(3, 0x0000036c);
        pulse.admit(evidence);
        (uint64 epoch, bool exists) = pulse.confirmedEpoch();
        assertEq(epoch, 3);
        assertTrue(exists);
        pulse.admit("");

        vm.warp(genesis + 4 * 320);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, 4));
        pulse.admit("");
    }

    // ================================================================ confirmation by epoch

    /// Claim: a confirmation in epoch E admits later sends in E with no evidence, but not in E + 1. Shows: the
    /// state before and after, the event, `admit("")` in E, and `ForkNotConfirmed(E + 1)` after one epoch.
    /// Control: with evidence for the new epoch the next epoch is admitted again. Matters: a version change
    /// happens at an epoch boundary, so a confirmation must not outlive its epoch.
    function test_HB02_confirmation_coversOnlyItsEpoch() public {
        (uint64 before_, bool existsBefore) = gate.confirmedEpoch();
        assertEq(before_, 0);
        assertFalse(existsBefore, "nothing is confirmed yet");

        bytes memory evidence = _good();
        vm.expectEmit(true, false, false, true, address(gate));
        emit ForkConfirmed(EPOCH_E, ELECTRA);
        gate.admit(evidence);
        (uint64 epoch, bool exists) = gate.confirmedEpoch();
        assertEq(epoch, EPOCH_E);
        assertTrue(exists);

        gate.admit("");
        _warpIntoEpoch(EPOCH_E, 31);
        gate.admit("");

        _warpIntoEpoch(EPOCH_E + 1, 0);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E + 1));
        gate.admit("");

        _warpIntoEpoch(EPOCH_E + 1, 3);
        gate.admit(_honestEvidence(block.timestamp, _slotIn(EPOCH_E + 1, 1), 6, ELECTRA));
        (epoch,) = gate.confirmedEpoch();
        assertEq(epoch, EPOCH_E + 1, "the next epoch needs its own proof");
    }

    /// Claim: any caller may `confirm`, and a second `confirm` in the same epoch changes nothing and takes no
    /// evidence. Shows: a keeper address confirms, a second call with empty bytes emits no event. Control: the
    /// send path then admits with no evidence. Matters: a keeper can pre-pay the proof for senders.
    function test_HB02_confirmation_anyCallerCanConfirmAndRepeatIsANoOp() public {
        bytes memory evidence = _good();
        vm.prank(makeAddr("keeper"));
        vm.expectEmit(true, false, false, true, address(gate));
        emit ForkConfirmed(EPOCH_E, ELECTRA);
        gate.confirm(evidence);

        vm.recordLogs();
        vm.prank(makeAddr("another keeper"));
        gate.confirm("");
        gate.confirm(evidence);
        assertEq(vm.getRecordedLogs().length, 0, "a repeat confirms nothing again");
        gate.admit("");
    }

    /// Claim: empty evidence in an unconfirmed epoch reverts `ForkNotConfirmed(epoch)`. Shows: the exact epoch in
    /// the error. Control: the same call with honest evidence succeeds. Matters: this is the refusal that keeps
    /// senders from posting messages that nobody can deliver after an unknown fork.
    function test_HB02_confirmation_emptyEvidenceRefused() public {
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        gate.admit("");
        gate.admit(_good());
    }

    /// Claim: a header from the previous epoch is refused, a header from the first or the last slot of the current
    /// epoch is accepted, and a header from a later epoch is refused. Shows: `HeaderNotInCurrentEpoch(header
    /// epoch, current epoch)` for the last slot of E - 1 and the first slot of E + 1. Matters: only a header of the
    /// current epoch shows the version of the block where the send lands.
    function test_HB02_confirmation_headerEpochRules() public {
        uint256 timestamp = block.timestamp;
        bytes memory previous = _honestEvidence(timestamp, _slotIn(EPOCH_E, 0) - 1, 6, ELECTRA);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.HeaderNotInCurrentEpoch.selector, EPOCH_E - 1, EPOCH_E));
        gate.confirm(previous);
        bytes memory later = _honestEvidence(timestamp + 12, _slotIn(EPOCH_E + 1, 0), 6, ELECTRA);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.HeaderNotInCurrentEpoch.selector, EPOCH_E + 1, EPOCH_E));
        gate.confirm(later);

        bytes memory first = _honestEvidence(timestamp + 24, _slotIn(EPOCH_E, 0), 6, ELECTRA);
        gate.confirm(first);
        (uint64 epoch,) = gate.confirmedEpoch();
        assertEq(epoch, EPOCH_E, "the first slot of the epoch counts");

        BeaconForkGate fresh = _newGate(BeaconForkGate.GateMode.Enforcing);
        bytes memory last = _honestEvidence(timestamp + 36, _slotIn(EPOCH_E, 31), 6, ELECTRA);
        fresh.confirm(last);
        (epoch,) = fresh.confirmedEpoch();
        assertEq(epoch, EPOCH_E, "the last slot of the epoch counts");
    }

    // ================================================================ other reverts of confirm

    /// Claim: a header whose root differs from the root in the beacon roots contract is refused with both roots in
    /// the error. Shows: `HeaderRootMismatch(expected, actual)` for a header with a changed proposer index.
    /// Control: the untouched header passes. Matters: the root from the protocol is the only trust anchor.
    function test_HB02_revert_headerRootMismatch() public {
        StateTreeAndHeader memory built = _builtElectra(block.timestamp);
        BeaconBlockHeader memory forged = _header(_slotNow(), built.tree.stateRoot);
        forged.proposerIndex += 1;
        bytes32 forgedRoot = SSZ.hashTreeRootMemory(forged);
        vm.expectRevert(
            abi.encodeWithSelector(BeaconForkGate.HeaderRootMismatch.selector, SSZ.hashTreeRootMemory(built.header), forgedRoot)
        );
        gate.confirm(_evidence(block.timestamp, forged, ELECTRA, built.tree.currentBranch));
        gate.confirm(_evidence(block.timestamp, built.header, ELECTRA, built.tree.currentBranch));
    }

    /// Claim: a version that the gate does not support cannot confirm. Shows: `UnsupportedVersion(version)` for
    /// the unknown fork even with a valid proof of it. Control: a supported version with a valid proof passes.
    /// Matters: confirmation is the allow list.
    function test_HB02_revert_unsupportedVersionCannotConfirm() public {
        bytes memory unknown = _honestEvidence(block.timestamp, _slotNow(), 6, UNKNOWN_FORK);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.UnsupportedVersion.selector, UNKNOWN_FORK));
        gate.confirm(unknown);
        gate.confirm(_honestEvidence(block.timestamp + 12, _slotNow(), 6, FULU));
    }

    /// Claim: a proof of one supported version cannot confirm another supported version of the same depth. Shows:
    /// a tree holding Electra with the claim Fulu is `ForkProofInvalid`. Control: the honest claim passes.
    /// Matters: the leaf, not the claim, decides.
    function test_HB02_revert_forkProofInvalidForAWrongLeafOrSibling() public {
        StateTreeAndHeader memory built = _builtElectra(block.timestamp);
        vm.expectRevert(_err(BeaconForkGate.ForkProofInvalid.selector));
        gate.confirm(_evidence(block.timestamp, built.header, FULU, built.tree.currentBranch));

        bytes32[] memory flipped = _resize(built.tree.currentBranch, built.tree.currentBranch.length);
        flipped[3] = bytes32(uint256(flipped[3]) ^ 1);
        vm.expectRevert(_err(BeaconForkGate.ForkProofInvalid.selector));
        gate.confirm(_evidence(block.timestamp, built.header, ELECTRA, flipped));

        gate.confirm(_evidence(block.timestamp, built.header, ELECTRA, built.tree.currentBranch));
    }

    /// Claim: a timestamp that the beacon roots contract does not hold is refused. Shows:
    /// `BeaconRootUnavailable(timestamp)` for a timestamp never written, and for timestamp zero. Control: a written
    /// timestamp works. Matters: an empty answer must never be read as a root.
    function test_HB02_revert_beaconRootUnavailable() public {
        StateTreeAndHeader memory built = _builtElectra(block.timestamp);
        bytes memory unwritten = _evidence(block.timestamp + 5, built.header, ELECTRA, built.tree.currentBranch);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.BeaconRootUnavailable.selector, block.timestamp + 5));
        gate.confirm(unwritten);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.BeaconRootUnavailable.selector, 0));
        gate.confirm(_evidence(0, built.header, ELECTRA, built.tree.currentBranch));
        gate.confirm(_evidence(block.timestamp, built.header, ELECTRA, built.tree.currentBranch));
    }

    // ================================================================ previous_version

    /// Claim: a proof of `Fork.previous_version` neither confirms nor seals. Shows: on one state tree, the
    /// previous-version branch with its (supported) value is `ForkProofInvalid` in `confirm`, and with an
    /// unsupported value `ForkProofInvalid` in `seal`. Control: the current-version branch of the SAME tree confirms,
    /// and a tree with an unknown current version seals. Matters: if the caller could pick the index, a proof of the
    /// old version would seal the gate before any fork, or confirm after one.
    function test_HB02_previousVersionProofNeitherConfirmsNorSeals() public {
        StateTree memory tree = _stateTree(6, ELECTRA, FULU);
        BeaconBlockHeader memory header = _header(_slotNow(), tree.stateRoot);
        _plant(block.timestamp, SSZ.hashTreeRootMemory(header));
        vm.expectRevert(_err(BeaconForkGate.ForkProofInvalid.selector));
        gate.confirm(_evidence(block.timestamp, header, FULU, tree.previousBranch));
        gate.confirm(_evidence(block.timestamp, header, ELECTRA, tree.currentBranch));

        StateTree memory sealTree = _stateTree(6, UNKNOWN_FORK, ALTAIR);
        BeaconBlockHeader memory sealHeader = _header(_slotNow(), sealTree.stateRoot);
        _plant(block.timestamp + 12, SSZ.hashTreeRootMemory(sealHeader));
        vm.expectRevert(_err(BeaconForkGate.ForkProofInvalid.selector));
        gate.seal(_evidence(block.timestamp + 12, sealHeader, ALTAIR, sealTree.previousBranch));
        assertFalse(gate.isSealed(), "the previous version did not seal");
        gate.seal(_evidence(block.timestamp + 12, sealHeader, UNKNOWN_FORK, sealTree.currentBranch));
        assertTrue(gate.isSealed());
    }

    // ================================================================ every pair of depths

    /// Claim: for every claimed depth c and true depth t in 5..7 with c != t, the confirm path refuses. Shows, per
    /// pair: the branch of the true tree is `BranchLengthMismatch(c + 2, t + 2)`, and the same branch cut or
    /// extended to length c + 2 is `ForkProofInvalid`. Control: c == t confirms. Matters: a wrong depth lands inside a
    /// leaf field or a fixed container, so passing would need a SHA-256 preimage (design: "wrong depth, every pair").
    function test_HB02_depth_confirmRefusesEveryWrongPair() public {
        for (uint256 claimed = 5; claimed <= 7; claimed++) {
            for (uint256 actual = 5; actual <= 7; actual++) {
                _checkConfirmPair(claimed, actual);
            }
        }
    }

    function _checkConfirmPair(uint256 claimed, uint256 actual) internal {
        BeaconForkGate pair = _gateWith(BeaconForkGate.GateMode.Enforcing, _oneVersion(ELECTRA, uint8(claimed)), _depths(5, 6, 7));
        StateTree memory tree = _stateTree(actual, ELECTRA, DENEB);
        BeaconBlockHeader memory header = _header(_slotNow(), tree.stateRoot);
        uint256 timestamp = block.timestamp + 100 * claimed + actual;
        _plant(timestamp, SSZ.hashTreeRootMemory(header));
        if (claimed == actual) {
            pair.confirm(_evidence(timestamp, header, ELECTRA, tree.currentBranch));
            (uint64 epoch,) = pair.confirmedEpoch();
            assertEq(epoch, EPOCH_E, "the matching depth confirms");
            return;
        }
        vm.expectRevert(abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, claimed + 2, actual + 2));
        pair.confirm(_evidence(timestamp, header, ELECTRA, tree.currentBranch));
        vm.expectRevert(_err(BeaconForkGate.ForkProofInvalid.selector));
        pair.confirm(_evidence(timestamp, header, ELECTRA, _resize(tree.currentBranch, claimed + 2)));
    }

    /// Claim: on the seal path the depth comes from the branch length, and a branch of length c + 2 over a tree of
    /// another depth t is refused. Shows: for each c != t in 5..7, `ForkProofInvalid`. Control: c == t seals.
    /// Matters: the seal path has no configured depth to compare against, so a mixed up depth must fail on the
    /// hash, not pass.
    function test_HB02_depth_sealRefusesEveryWrongPair() public {
        for (uint256 claimed = 5; claimed <= 7; claimed++) {
            for (uint256 actual = 5; actual <= 7; actual++) {
                _checkSealPair(claimed, actual);
            }
        }
    }

    function _checkSealPair(uint256 claimed, uint256 actual) internal {
        BeaconForkGate pair = _gateWith(BeaconForkGate.GateMode.Enforcing, _oneVersion(ELECTRA, 6), _depths(5, 6, 7));
        StateTree memory tree = _stateTree(actual, UNKNOWN_FORK, ALTAIR);
        BeaconBlockHeader memory header = _header(_slotNow(), tree.stateRoot);
        uint256 timestamp = block.timestamp + 100 * claimed + actual;
        _plant(timestamp, SSZ.hashTreeRootMemory(header));
        bytes memory evidence = _evidence(timestamp, header, UNKNOWN_FORK, _resize(tree.currentBranch, claimed + 2));
        if (claimed == actual) {
            pair.seal(evidence);
            assertTrue(pair.isSealed(), "the matching depth seals");
            return;
        }
        vm.expectRevert(_err(BeaconForkGate.ForkProofInvalid.selector));
        pair.seal(evidence);
        assertFalse(pair.isSealed());
    }

    /// Claim: a seal branch whose length implies a depth outside the allowed set is refused. Shows:
    /// `SealDepthNotAllowed(0)` for 0, 1 and 2 siblings, `SealDepthNotAllowed(1)`, 2, 3, 4 for lengths 3 to 6,
    /// (8) for length 10, (98) for 100 siblings; a gate that allows only depth 5 refuses depth 6 with
    /// `SealDepthNotAllowed(6)`. Control: the honest depth 6 branch seals on the full gate (depths 5, 6 and 7 are covered by the
    /// seal depth test).
    /// Matters: the depth is a shifted bit mask, and a huge or tiny length must not shift out of range.
    function test_HB02_depth_sealLengthsOutsideTheSetRefused() public {
        StateTree memory tree = _stateTree(6, UNKNOWN_FORK, ALTAIR);
        BeaconBlockHeader memory header = _header(_slotNow(), tree.stateRoot);
        _plant(block.timestamp, SSZ.hashTreeRootMemory(header));
        uint256[9] memory lengths = [uint256(0), 1, 2, 3, 4, 5, 6, 10, 100];
        uint256[9] memory reported = [uint256(0), 0, 0, 1, 2, 3, 4, 8, 98];
        for (uint256 i = 0; i < lengths.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.SealDepthNotAllowed.selector, reported[i]));
            gate.seal(_evidence(block.timestamp, header, UNKNOWN_FORK, _resize(tree.currentBranch, lengths[i])));
        }

        BeaconForkGate fiveOnly = _gateWith(BeaconForkGate.GateMode.Enforcing, _oneVersion(ELECTRA, 6), _depths(5));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.SealDepthNotAllowed.selector, 6));
        fiveOnly.seal(_evidence(block.timestamp, header, UNKNOWN_FORK, tree.currentBranch));
        assertFalse(fiveOnly.isSealed());

        // control: depth 6 is in the full set and seals with the honest branch
        gate.seal(_evidence(block.timestamp, header, UNKNOWN_FORK, tree.currentBranch));
        assertTrue(gate.isSealed());
    }

    // ================================================================ seal

    /// Claim: a seal with a supported version is refused. Shows: `VersionIsSupported(version)` for each of the four
    /// supported versions with a valid proof of it. Control: an unknown version seals. Matters: otherwise anybody
    /// could close the gate with a proof of an ordinary state.
    function test_HB02_seal_supportedVersionRefused() public {
        bytes4[4] memory supported = [CAPELLA, DENEB, ELECTRA, FULU];
        for (uint256 i = 0; i < supported.length; i++) {
            bytes memory evidence = _honestEvidence(block.timestamp + i, _slotNow(), 6, supported[i]);
            vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.VersionIsSupported.selector, supported[i]));
            gate.seal(evidence);
        }
        assertFalse(gate.isSealed());
        gate.seal(_honestEvidence(block.timestamp + 10, _slotNow(), 6, UNKNOWN_FORK));
        assertTrue(gate.isSealed());
    }

    /// Claim: a seal with an unknown version closes the gate for good. Shows: the event with version and slot; then
    /// `admit` reverts `GateSealed` in a confirmed epoch, with valid evidence, and with none; `confirm` and a second
    /// `seal` revert `GateSealed`; a later epoch is no different. Control: before the seal the same send passes.
    /// Matters: a sealed route must stay sealed: after an unknown fork no state is trustworthy.
    function test_HB02_seal_closesTheGateForGood() public {
        gate.admit(_good());
        gate.admit("");
        assertFalse(gate.isSealed());

        bytes memory sealEvidence = _honestEvidence(block.timestamp + 12, _slotNow(), 6, UNKNOWN_FORK);
        vm.expectEmit(false, false, false, true, address(gate));
        emit GateSealedByFork(UNKNOWN_FORK, _slotNow());
        gate.seal(sealEvidence);
        assertTrue(gate.isSealed());

        bytes memory sealedError = _err(BeaconForkGate.GateSealed.selector);
        vm.expectRevert(sealedError);
        gate.admit("");
        bytes memory valid = _honestEvidence(block.timestamp + 24, _slotNow(), 6, ELECTRA);
        vm.expectRevert(sealedError);
        gate.admit(valid);
        bytes memory validForConfirm = _honestEvidence(block.timestamp + 36, _slotNow(), 6, ELECTRA);
        vm.expectRevert(sealedError);
        gate.confirm(validForConfirm);
        vm.expectRevert(sealedError);
        gate.seal(sealEvidence);

        _warpIntoEpoch(EPOCH_E + 5, 4);
        bytes memory nextEpoch = _honestEvidence(block.timestamp, _slotIn(EPOCH_E + 5, 1), 6, ELECTRA);
        vm.expectRevert(sealedError);
        gate.admit(nextEpoch);
        assertTrue(gate.isSealed(), "sealed never clears");
    }

    /// Claim: a seal works with a matching tree of depth 5, 6 and 7. Shows: three fresh gates, each sealed by a
    /// tree of its depth, with the event. Matters: depth 7 is the reserved room for a fork past 64 state fields.
    function test_HB02_seal_worksAtEverySealDepth() public {
        for (uint256 depth = 5; depth <= 7; depth++) {
            BeaconForkGate fresh = _newGate(BeaconForkGate.GateMode.Enforcing);
            bytes memory evidence = _honestEvidence(block.timestamp + depth, _slotNow(), depth, UNKNOWN_FORK);
            vm.expectEmit(false, false, false, true, address(fresh));
            emit GateSealedByFork(UNKNOWN_FORK, _slotNow());
            fresh.seal(evidence);
            assertTrue(fresh.isSealed());
        }
    }

    /// Claim: a seal needs no epoch rule, only the slot bounds. Shows: a gate deployed in an earlier epoch is sealed
    /// by a header of that earlier epoch, after the deployment slot, while the beacon roots contract still returns
    /// it; the same header is refused by `confirm`. Matters: a recent proof of an unknown version is enough to
    /// close the route, and the seal must not wait for an epoch.
    function test_HB02_seal_acceptsAHeaderFromAPreviousEpoch() public {
        _warpIntoEpoch(EPOCH_E - 3, 6);
        BeaconForkGate early = _newGate(BeaconForkGate.GateMode.Enforcing);
        _warpIntoEpoch(EPOCH_E, NOW_SLOTS);
        bytes memory old = _honestEvidence(block.timestamp, _slotIn(EPOCH_E - 3, 7), 6, UNKNOWN_FORK);
        // control for the epoch rule: the same kind of header with a supported version is refused by confirm
        bytes memory oldSupported = _honestEvidence(block.timestamp + 12, _slotIn(EPOCH_E - 3, 7), 6, ELECTRA);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.HeaderNotInCurrentEpoch.selector, EPOCH_E - 3, EPOCH_E));
        early.confirm(oldSupported);

        early.seal(old);
        assertTrue(early.isSealed());
    }

    /// Claim: a header from before the deployment cannot seal, even with an unlisted version. Shows:
    /// `SealEvidenceTooOld(slot, deploymentSlot)` one slot before the deployment slot, and the gate stays open.
    /// Control: a header at the deployment slot seals. Matters: when a gate is deployed after a fork that the route
    /// does not list, the ring buffer can still hold older headers with a version that the gate does not list, so such a
    /// header must not close the gate.
    function test_HB02_seal_headerBeforeDeploymentRefused() public {
        assertEq(gate.deploymentSlot(), _slotNow(), "the deployment slot is the slot of the deployment block");
        uint64 tooOld = _slotNow() - 1;
        bytes memory evidence = _honestEvidence(block.timestamp, tooOld, 6, UNKNOWN_FORK);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.SealEvidenceTooOld.selector, tooOld, _slotNow()));
        gate.seal(evidence);
        assertFalse(gate.isSealed());

        gate.seal(_honestEvidence(block.timestamp + 12, _slotNow(), 6, UNKNOWN_FORK));
        assertTrue(gate.isSealed(), "a header at the deployment slot seals");
    }

    /// Claim: a header older than the last confirmed header cannot seal, even with an unlisted version. Shows: after
    /// a confirmation at slot s, `SealEvidenceTooOld(s - 1, s)` for a header one slot older (both after the
    /// deployment slot); after a confirmation in a later epoch the bound moves up to the new header.
    /// Control: a header at s seals. Matters: a supported version proven live at s means any older unlisted version
    /// is stale, because fork versions only move forward.
    function test_HB02_seal_headerOlderThanLastConfirmationRefused() public {
        uint64 confirmedSlot = _slotIn(EPOCH_E, 10);
        gate.confirm(_honestEvidence(block.timestamp, confirmedSlot, 6, ELECTRA));

        uint64 older = confirmedSlot - 1;
        assertGt(older, gate.deploymentSlot(), "the header is newer than the deployment");
        bytes memory evidence = _honestEvidence(block.timestamp + 12, older, 6, UNKNOWN_FORK);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.SealEvidenceTooOld.selector, older, confirmedSlot));
        gate.seal(evidence);
        assertFalse(gate.isSealed());

        // a later epoch confirms with a higher header; the bound follows it
        _warpIntoEpoch(EPOCH_E + 1, 3);
        uint64 laterSlot = _slotIn(EPOCH_E + 1, 1);
        gate.confirm(_honestEvidence(block.timestamp, laterSlot, 6, ELECTRA));
        bytes memory stale = _honestEvidence(block.timestamp + 12, confirmedSlot, 6, UNKNOWN_FORK);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.SealEvidenceTooOld.selector, confirmedSlot, laterSlot));
        gate.seal(stale);

        gate.seal(_honestEvidence(block.timestamp + 24, laterSlot, 6, UNKNOWN_FORK));
        assertTrue(gate.isSealed(), "a header at the confirmed slot seals");
    }

    /// Claim: a header at or after both bounds with an unlisted version still seals (the real fork case). Shows: a
    /// confirmation at slot s in epoch E, then a fork in the next epoch: a header newer than s with an unlisted
    /// version seals and emits the event with its slot. Matters: the new rule must not stop a real fork from closing
    /// the route.
    function test_HB02_seal_headerAfterBothBoundsSeals() public {
        gate.confirm(_honestEvidence(block.timestamp, _slotIn(EPOCH_E, 10), 6, ELECTRA));
        _warpIntoEpoch(EPOCH_E + 2, 4);
        uint64 forkSlot = _slotIn(EPOCH_E + 2, 2);
        bytes memory evidence = _honestEvidence(block.timestamp, forkSlot, 6, UNKNOWN_FORK);
        vm.expectEmit(false, false, false, true, address(gate));
        emit GateSealedByFork(UNKNOWN_FORK, forkSlot);
        gate.seal(evidence);
        assertTrue(gate.isSealed());
    }

    // ================================================================ ring buffer

    /// Claim: a timestamp that left the ring buffer is refused by the model. Shows: after a second root is written
    /// 8191 seconds later in the same ring slot, the first timestamp is `BeaconRootUnavailable`, and the second works.
    /// Control: before the overwrite the first one worked. Matters: old roots must not be accepted from a slot that
    /// the ring buffer reused.
    function test_HB02_ringBuffer_mockRefusesAnOverwrittenTimestamp() public {
        uint256 first = block.timestamp;
        StateTree memory tree = _stateTree(6, ELECTRA, DENEB);
        BeaconBlockHeader memory header = _header(_slotNow(), tree.stateRoot);
        _plant(first, SSZ.hashTreeRootMemory(header));
        bytes memory evidence = _evidence(first, header, ELECTRA, tree.currentBranch);
        BeaconForkGate before_ = _newGate(BeaconForkGate.GateMode.Enforcing);
        before_.confirm(evidence);

        _plant(first + 8191, keccak256("a later root"));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.BeaconRootUnavailable.selector, first));
        gate.confirm(evidence);
    }

    /// Claim: the same refusal happens inside the genuine EIP-4788 code. Shows: the system address writes a root at
    /// time T, `confirm` with timestamp T works, a second write at T + 8191 reuses the ring slot, and then `confirm`
    /// with T reverts `BeaconRootUnavailable(T)`. Matters: it proves the model and the real code agree, so the
    /// gate was tested against the real revert behavior.
    function test_HB02_ringBuffer_genuineCodeRefusesAnOverwrittenTimestamp() public {
        _etchGenuine();
        uint256 first = block.timestamp;
        StateTree memory tree = _stateTree(6, ELECTRA, DENEB);
        BeaconBlockHeader memory header = _header(_slotNow(), tree.stateRoot);
        _setGenuine(SSZ.hashTreeRootMemory(header));
        bytes memory evidence = _evidence(first, header, ELECTRA, tree.currentBranch);
        BeaconForkGate before_ = _newGate(BeaconForkGate.GateMode.Enforcing);
        before_.confirm(evidence);

        vm.warp(first + 8191);
        _setGenuine(keccak256("a later root"));
        vm.warp(first);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.BeaconRootUnavailable.selector, first));
        gate.confirm(evidence);
    }

    // ================================================================ genuine code constant

    /// Claim: the recorded runtime code is the 97 bytes of EIP-4788 and hashes to the recorded value. Shows: the
    /// length, the hash, and that the code starts with `CALLER PUSH20 <system address>`. Matters: the genuine code is
    /// the basis of the tests above, so a changed byte must fail here.
    function test_HB02_genuineCode_matchesTheRecordedHash() public pure {
        bytes memory code = GateGenuineBeaconRoots.code();
        assertEq(code.length, 97);
        assertEq(keccak256(code), GateGenuineBeaconRoots.RECORDED_HASH);
        assertEq(bytes4(code), bytes4(0x3373ffff), "CALLER PUSH20 0xffff...");
    }

    // ================================================================ detection mode

    function _detecting() internal returns (BeaconForkGate) {
        return _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
    }

    /// Claim: with no code at the beacon roots address, detection mode admits every send and stays in detection.
    /// Shows: `admit("")` passes, `enforcing()` stays false, even in several epochs. Matters: PulseChain has no
    /// EIP-4788 today and its messages must keep sending.
    function test_HB02_detection_admitsWithNoCodeAtTheAddress() public {
        vm.etch(BEACON_ROOTS, "");
        BeaconForkGate detecting = _detecting();
        detecting.admit("");
        _warpIntoEpoch(EPOCH_E + 9, 1);
        detecting.admit("");
        assertFalse(detecting.enforcing());
    }

    /// Claim: with the genuine code at the address and empty storage, every read reverts and the probe reads that
    /// as absent. Shows: `admit("")` passes, `enforcing()` stays false, `confirm` and `seal` revert
    /// `BeaconRootsAbsent`. Control: after the system address writes a root, the probe sees it and the same call
    /// no longer passes without evidence. Matters: anybody can replay the keyless deployment on a chain without
    /// EIP-4788; it must not switch the gate on.
    function test_HB02_detection_genuineCodeWithEmptyStorageIsAbsent() public {
        _etchGenuine();
        BeaconForkGate detecting = _detecting();
        detecting.admit("");
        assertFalse(detecting.enforcing());
        vm.expectRevert(_err(BeaconForkGate.BeaconRootsAbsent.selector));
        detecting.confirm("");
        vm.expectRevert(_err(BeaconForkGate.BeaconRootsAbsent.selector));
        detecting.seal("");

        _setGenuine(keccak256("a real root"));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        detecting.admit("");
    }

    /// Claim: an answer that is zero, short (31 bytes), long (64 bytes), garbage, or a revert is read as absent.
    /// Shows: for each of the five variants, `admit("")` passes, `enforcing()` stays false and `confirm` reverts
    /// `BeaconRootsAbsent`. Control: a model that returns a real root switches the gate. Matters: the probe
    /// must accept exactly one answer shape, a 32 byte non-zero word.
    function test_HB02_detection_malformedAnswersAreAbsent() public {
        address[5] memory variants = [
            address(new GateAnswersZero()),
            address(new GateAnswersShort()),
            address(new GateAnswersLong()),
            address(new GateAnswersGarbage()),
            address(new GateAlwaysReverts())
        ];
        for (uint256 i = 0; i < variants.length; i++) {
            vm.etch(BEACON_ROOTS, variants[i].code);
            BeaconForkGate detecting = _detecting();
            detecting.admit("");
            assertFalse(detecting.enforcing(), "a malformed answer is absence");
            vm.expectRevert(_err(BeaconForkGate.BeaconRootsAbsent.selector));
            detecting.confirm("");
        }
        _etchMock();
        _plant(block.timestamp, keccak256("a root"));
        BeaconForkGate control = _detecting();
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        control.admit("");
    }

    /// Claim: once a root appears, detection mode becomes enforcing for good, and the sequence is: before the
    /// root, a send with no evidence passes; with the root, the SAME call reverts `ForkNotConfirmed` (the revert
    /// also undoes the switch, so `enforcing()` is still false); with evidence, the call passes, emits
    /// `BeaconRootsDetected` and `ForkConfirmed`, and `enforcing()` is true. Then the same epoch admits with no
    /// evidence. Matters: the switch is a state change that the first accepted call must leave behind.
    function test_HB02_detection_switchesToEnforcingForGood() public {
        BeaconForkGate detecting = _detecting();
        detecting.admit("");
        assertFalse(detecting.enforcing());

        bytes memory evidence = _good();
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        detecting.admit("");
        assertFalse(detecting.enforcing(), "a reverted call leaves no switch behind");

        vm.expectEmit(address(detecting));
        emit BeaconRootsDetected();
        vm.expectEmit(true, false, false, true, address(detecting));
        emit ForkConfirmed(EPOCH_E, ELECTRA);
        detecting.admit(evidence);
        assertTrue(detecting.enforcing());
        detecting.admit("");
    }

    /// Claim: after detection, the gate stays enforcing when the root disappears. Shows: the beacon roots
    /// contract is replaced by an answer of zero, then removed; in the next epoch the send without a confirmation
    /// reverts `ForkNotConfirmed(E + 1)` both times. Control: a gate that never detected admits in the same
    /// situation. Matters: otherwise an attacker who can break the answer (or a chain that drops the contract)
    /// switches the gate off.
    function test_HB02_detection_staysEnforcingWhenTheRootDisappears() public {
        BeaconForkGate detecting = _detecting();
        BeaconForkGate neverDetected = _detecting();
        detecting.confirm(_good());
        assertTrue(detecting.enforcing());
        assertFalse(neverDetected.enforcing());

        vm.etch(BEACON_ROOTS, address(new GateAnswersZero()).code);
        _warpIntoEpoch(EPOCH_E + 1, 2);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E + 1));
        detecting.admit("");
        neverDetected.admit("");

        vm.etch(BEACON_ROOTS, "");
        _warpIntoEpoch(EPOCH_E + 2, 2);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E + 2));
        detecting.admit("");
        neverDetected.admit("");
    }

    /// Claim: in detection mode `confirm` and `seal` first need a working probe, and with roots they detect and
    /// then act. Shows: both revert `BeaconRootsAbsent` with no roots; with roots, `confirm(evidence)` detects
    /// (event) and confirms, and `seal(evidence)` detects and seals on a second gate. Matters: a keeper or a
    /// sealer must not be able to act before the probe has seen the contract.
    function test_HB02_detection_confirmAndSealNeedAWorkingProbe() public {
        BeaconForkGate detectingForConfirm = _detecting();
        BeaconForkGate detectingForSeal = _detecting();
        vm.etch(BEACON_ROOTS, "");
        vm.expectRevert(_err(BeaconForkGate.BeaconRootsAbsent.selector));
        detectingForConfirm.confirm("");
        vm.expectRevert(_err(BeaconForkGate.BeaconRootsAbsent.selector));
        detectingForSeal.seal("");

        _etchMock();
        bytes memory good = _good();
        bytes memory unknown = _honestEvidence(block.timestamp + 12, _slotNow(), 6, UNKNOWN_FORK);
        _plant(block.timestamp, SSZ.hashTreeRootMemory(_headerOf(good)));
        vm.expectEmit(address(detectingForConfirm));
        emit BeaconRootsDetected();
        detectingForConfirm.confirm(good);
        assertTrue(detectingForConfirm.enforcing());

        vm.expectEmit(address(detectingForSeal));
        emit BeaconRootsDetected();
        detectingForSeal.seal(unknown);
        assertTrue(detectingForSeal.isSealed());
        assertTrue(detectingForSeal.enforcing());
    }

    /// Claim: in detection mode after the first PulseChain-style fork (a root present, an unknown version), a send
    /// reverts, and anybody can seal. Shows: no confirmation exists for the unknown version; seal works.
    /// Matters: this is the planned behavior in the documents: the old route closes itself at the fork.
    function test_HB02_detection_unknownForkAfterDetectionCanBeSealed() public {
        BeaconForkGate detecting = _detecting();
        detecting.admit("");
        bytes memory unknown = _honestEvidence(block.timestamp, _slotNow(), 5, UNKNOWN_FORK);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.UnsupportedVersion.selector, UNKNOWN_FORK));
        detecting.admit(unknown);
        vm.prank(makeAddr("anybody"));
        detecting.seal(unknown);
        vm.expectRevert(_err(BeaconForkGate.GateSealed.selector));
        detecting.admit("");
    }

    // ================================================================ enforcing mode without a contract

    /// Claim: in `Enforcing` mode the gate applies the rules from deployment, with no code at the address. Shows:
    /// `admit("")` reverts `ForkNotConfirmed`, and `confirm` and `seal` revert `BeaconRootUnavailable`.
    /// Control: with the model installed and honest evidence, the same gate admits. Matters: Ethereum must never
    /// fall back to open sending.
    function test_HB02_enforcing_appliesFromDeploymentEvenWithNoCode() public {
        StateTreeAndHeader memory built = _builtElectra(block.timestamp);
        bytes memory unknown = _honestEvidence(block.timestamp + 12, _slotNow(), 6, UNKNOWN_FORK);
        vm.etch(BEACON_ROOTS, "");
        assertTrue(gate.enforcing());
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        gate.admit("");
        bytes memory evidence = _evidence(block.timestamp, built.header, ELECTRA, built.tree.currentBranch);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.BeaconRootUnavailable.selector, block.timestamp));
        gate.confirm(evidence);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.BeaconRootUnavailable.selector, block.timestamp + 12));
        gate.seal(unknown);

        _etchMock();
        _plant(block.timestamp, SSZ.hashTreeRootMemory(built.header));
        gate.admit(evidence);
    }

    /// Claim: with the genuine code and empty storage, an enforcing gate refuses (it does not treat a reverting
    /// contract as absence). Shows: `admit("")` reverts `ForkNotConfirmed`, and `confirm` reverts
    /// `BeaconRootUnavailable`. Matters: the absence rule belongs to detection mode only.
    function test_HB02_enforcing_genuineCodeWithEmptyStorageStillRefuses() public {
        // the tree is built but its root is NOT written: the genuine code keeps empty storage
        StateTree memory tree = _stateTree(6, ELECTRA, DENEB);
        BeaconBlockHeader memory header = _header(_slotNow(), tree.stateRoot);
        _etchGenuine();
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        gate.admit("");
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.BeaconRootUnavailable.selector, block.timestamp));
        gate.confirm(_evidence(block.timestamp, header, ELECTRA, tree.currentBranch));
    }

    // ================================================================ the fork table of the light-client program

    /// Claim: `supportedVersions` equals the fork table of the light-client program, from its fixtures: the forks
    /// of `chains.<chain>.forkSchedule` in order, their versions from the chain specification and their state
    /// depths from `forks.<name>.currentSyncCommitteeGindex` (gindex 54 is depth 5, 86 is depth 6). Shows: the
    /// Ethereum gate matches Capella, Deneb, Electra, Fulu and the PulseChain gate matches Capella. Forks before
    /// Capella are not listed: their blocks have no execution payload, so the route never supports them. Gloas is
    /// not listed: its layout is unknown to the program (no fixture), so sends stop at that fork until the route is
    /// redeployed. Matters: a version in the gate that the program cannot read would let sends pass that
    /// can never be delivered; a missing one would stop sends in a supported fork.
    function test_HB02_forkTable_gateEqualsTheLightClientProgramTable() public {
        string memory gindices = vm.readFile("light-client/tests/fixtures/gindices.json");
        _assertGateEqualsFixtures(gate, gindices, "ethereum", "light-client/tests/fixtures/ethereum/chain_spec.json");

        BeaconForkGate pulse = new BeaconForkGate(
            BEACON_ROOTS,
            BeaconForkGate.GateMode.DetectBeaconRoots,
            1_683_785_555,
            10,
            32,
            _oneVersion(0x0000036c, 5),
            _depths(5, 6, 7),
            address(0)
        );
        _assertGateEqualsFixtures(pulse, gindices, "pulsechain", "light-client/tests/fixtures/pulsechain/chain_spec.json");
    }

    function _assertGateEqualsFixtures(
        BeaconForkGate subject,
        string memory gindices,
        string memory chainName,
        string memory specPath
    ) internal view {
        string memory spec = vm.readFile(specPath);
        string[] memory names = _forkNames(gindices, chainName);
        BeaconForkGate.SupportedVersion[] memory configured = subject.supportedVersions();
        assertGt(names.length, 0, "the fixture lists forks");
        assertEq(configured.length, names.length, "same number of forks");
        for (uint256 i = 0; i < names.length; i++) {
            bytes memory versionBytes = vm.parseBytes(
                vm.parseJsonString(spec, string.concat(".response.data.", vm.toUppercase(names[i]), "_FORK_VERSION"))
            );
            assertEq(versionBytes.length, 4);
            uint256 gindex = vm.parseUint(
                vm.parseJsonString(gindices, string.concat(".forks.", names[i], ".currentSyncCommitteeGindex"))
            );
            assertEq(configured[i].version, bytes4(versionBytes), string.concat("version of ", names[i]));
            assertEq(configured[i].stateDepth, _floorLog2(gindex), string.concat("depth of ", names[i]));
        }
        _assertExcludedForksAreAbsent(subject, spec, gindices, names);
    }

    /// @dev Every other version in the chain specification (before Capella, and Gloas or an unscheduled Deneb) is
    /// not supported, and no state layout exists for it in the program fixtures.
    function _assertExcludedForksAreAbsent(
        BeaconForkGate subject,
        string memory spec,
        string memory gindices,
        string[] memory included
    ) internal view {
        string[6] memory others = ["GENESIS", "ALTAIR", "BELLATRIX", "GLOAS", "DENEB", "ELECTRA"];
        BeaconForkGate.SupportedVersion[] memory configured = subject.supportedVersions();
        for (uint256 i = 0; i < others.length; i++) {
            string memory key = string.concat(".response.data.", others[i], "_FORK_VERSION");
            if (!vm.keyExistsJson(spec, key)) continue;
            bytes4 version = bytes4(vm.parseBytes(vm.parseJsonString(spec, key)));
            bool listedInTheProgram = _contains(included, vm.toLowercase(others[i]));
            bool inTheGate = false;
            for (uint256 j = 0; j < configured.length; j++) {
                if (configured[j].version == version) inTheGate = true;
            }
            assertEq(inTheGate, listedInTheProgram, string.concat("the gate lists ", others[i], " only if the program does"));
        }
        assertFalse(vm.keyExistsJson(gindices, ".forks.gloas"), "Gloas has no state layout in the program fixtures");
        assertFalse(vm.keyExistsJson(gindices, ".forks.phase0"), "phase0 has no execution payload layout");
        assertFalse(vm.keyExistsJson(gindices, ".forks.bellatrix"), "bellatrix has no capella layout");
    }

    function _forkNames(string memory gindices, string memory chainName) internal view returns (string[] memory names) {
        uint256 count;
        while (vm.keyExistsJson(gindices, string.concat(".chains.", chainName, ".forkSchedule[", vm.toString(count), "].fork"))) {
            count++;
        }
        names = new string[](count);
        for (uint256 i = 0; i < count; i++) {
            names[i] = vm.parseJsonString(
                gindices, string.concat(".chains.", chainName, ".forkSchedule[", vm.toString(i), "].fork")
            );
        }
    }

    function _contains(string[] memory haystack, string memory needle) internal pure returns (bool) {
        for (uint256 i = 0; i < haystack.length; i++) {
            if (keccak256(bytes(haystack[i])) == keccak256(bytes(needle))) return true;
        }
        return false;
    }

    function _floorLog2(uint256 value) internal pure returns (uint256 result) {
        while (value > 1) {
            value >>= 1;
            result++;
        }
    }

    /// Claim: an Ethereum gate never supports the versions before Capella or the version after Fulu, and a PulseChain
    /// gate never supports the Deneb value `0xffffffff` (never scheduled there). Shows: confirm with a valid proof of
    /// each such version is `UnsupportedVersion`. Control: Capella passes. Matters: the excluded forks have no
    /// execution payload, or a layout the program cannot read.
    function test_HB02_forkTable_excludedVersionsCannotConfirm() public {
        bytes4[5] memory excluded = [bytes4(0x00000000), ALTAIR, 0x02000000, UNKNOWN_FORK, 0xffffffff];
        for (uint256 i = 0; i < excluded.length; i++) {
            bytes memory evidence = _honestEvidence(block.timestamp + i, _slotNow(), 5, excluded[i]);
            vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.UnsupportedVersion.selector, excluded[i]));
            gate.confirm(evidence);
        }
        gate.confirm(_honestEvidence(block.timestamp + 20, _slotNow(), 5, CAPELLA));
    }

    // ================================================================ message bridge integration

    event UserRequestForAffirmation(bytes32 indexed messageId, bytes encodedData);

    /// @dev The low bits of a message identifier are the send counter of the bridge.
    function _counterOf(bytes32 messageId) internal pure returns (uint64) {
        return uint64(uint256(messageId));
    }

    /// Claim: with an enforcing gate, a send in an unconfirmed epoch is refused; after `confirm` the send works; a
    /// second sender in the same epoch sends with no `confirm`. Shows: `ForkNotConfirmed(E)` first, then the gate event
    /// and the bridge event in one call pair, then a second send by another account that emits no gate event. Matters: the bridge gives
    /// the gate empty evidence, so the first poster of an epoch pays for the proof and every later poster rides on it.
    function test_HB02_bridge_confirmThenSendThenLaterSendersNeedNoConfirm() public {
        MessageBridge sender = _bridgeWithGate(address(gate));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        _send(sender, alice);

        bytes memory evidence = _good();
        vm.recordLogs();
        bytes32 first = _confirmThenSend(sender, gate, alice, evidence);
        Vm.Log[] memory confirmLogs = vm.getRecordedLogs();
        assertEq(confirmLogs.length, 2, "one gate event and one message");
        assertEq(confirmLogs[0].emitter, address(gate));
        assertEq(confirmLogs[0].topics[0], ForkConfirmed.selector, "the gate confirms the epoch");
        assertEq(uint256(confirmLogs[0].topics[1]), EPOCH_E);
        assertEq(confirmLogs[1].emitter, address(sender));
        assertEq(confirmLogs[1].topics[0], UserRequestForAffirmation.selector, "the bridge logs the message");

        vm.recordLogs();
        bytes32 second = _send(sender, bob);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "the second send logs only the message");
        assertEq(logs[0].emitter, address(sender), "the log is the message of the bridge");
        assertEq(_counterOf(first), 0, "the refused send spent no counter value");
        assertEq(_counterOf(second), 1);
    }

    /// Claim: a send in a new epoch without a confirmation reverts and sends nothing. Shows: `ForkNotConfirmed(E + 1)`,
    /// no log, and no counter spent: the next honest send carries the next counter value. Control: the send in E passed.
    /// Matters: the refusal is the protection after an unknown fork, and it must leave no trace of a message.
    function test_HB02_bridge_newEpochWithoutConfirmationSendsNothing() public {
        MessageBridge sender = _bridgeWithGate(address(gate));
        bytes32 inE = _confirmThenSend(sender, gate, alice, _good());
        assertEq(_counterOf(inE), 0);

        _warpIntoEpoch(EPOCH_E + 1, 2);
        vm.recordLogs();
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E + 1));
        _send(sender, bob);
        assertEq(vm.getRecordedLogs().length, 0, "no message is logged");

        bytes memory evidence = _honestEvidence(block.timestamp, _slotIn(EPOCH_E + 1, 1), 6, ELECTRA);
        bytes32 next = _confirmThenSend(sender, gate, bob, evidence);
        assertEq(_counterOf(next), 1, "the refused send spent no counter value");
    }

    /// Claim: after a seal every send reverts `GateSealed`, in a confirmed epoch and after a fresh confirmation attempt.
    /// Shows: the revert for a plain send, and the revert of `confirm` with valid evidence. Control: the send before the
    /// seal passes. Matters: an unknown fork must stop sends at once.
    function test_HB02_bridge_sendAfterSealReverts() public {
        MessageBridge sender = _bridgeWithGate(address(gate));
        _confirmThenSend(sender, gate, alice, _good());
        gate.seal(_honestEvidence(block.timestamp + 12, _slotNow(), 6, UNKNOWN_FORK));

        vm.expectRevert(_err(BeaconForkGate.GateSealed.selector));
        _send(sender, alice);
        bytes memory valid = _honestEvidence(block.timestamp + 24, _slotNow(), 6, ELECTRA);
        vm.expectRevert(_err(BeaconForkGate.GateSealed.selector));
        gate.confirm(valid);
        vm.expectRevert(_err(BeaconForkGate.GateSealed.selector));
        _send(sender, bob);
    }

    /// Claim: with the genuine runtime code, an enforcing gate reads a real root end to end through a bridge send.
    /// Shows: the send is refused before the confirmation, `confirm` and the send work, and the second send needs no
    /// evidence. Matters: the whole path runs against the real runtime code, not only the model.
    function test_HB02_genuineCode_endToEndEnforcingSend() public {
        _etchGenuine();
        StateTree memory tree = _stateTree(6, ELECTRA, DENEB);
        BeaconBlockHeader memory header = _header(_slotNow(), tree.stateRoot);
        _setGenuine(SSZ.hashTreeRootMemory(header));
        MessageBridge sender = _bridgeWithGate(address(gate));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        _send(sender, alice);
        _confirmThenSend(sender, gate, alice, _evidence(block.timestamp, header, ELECTRA, tree.currentBranch));
        bytes32 second = _send(sender, bob);
        assertEq(_counterOf(second), 1);
    }

    // ================================================================ helpers for tests above

    struct StateTreeAndHeader {
        StateTree tree;
        BeaconBlockHeader header;
    }

    /// @dev An Electra tree and header in epoch E, with the header root planted under `timestamp`.
    function _builtElectra(uint256 timestamp) internal returns (StateTreeAndHeader memory built) {
        built.tree = _stateTree(6, ELECTRA, DENEB);
        built.header = _header(_slotNow(), built.tree.stateRoot);
        _plant(timestamp, SSZ.hashTreeRootMemory(built.header));
    }

    /// @dev The header inside encoded evidence.
    function _headerOf(bytes memory evidence) internal pure returns (BeaconBlockHeader memory) {
        return abi.decode(evidence, (BeaconForkGate.ForkEvidence)).header;
    }
}

/// @notice Delivery does not depend on the gate. A destination bridge with a sealed gate still delivers.
contract BeaconForkGateDeliveryTest is GateSupport, MessageScenes {
    function setUp() public override(WithdrawalScenes, MessageScenes) {
        super.setUp();
        _warpIntoEpoch(EPOCH_E, 3);
        _etchMock();
    }

    /// Claim: a destination bridge whose gate is sealed still delivers a valid message, and a send through it reverts.
    /// Shows: the gate is sealed, the send reverts `GateSealed`, and `executeMessage` calls the target once. Control: the
    /// same bridge cannot send, so the seal is real for it. Matters: a seal must never trap a message that a user already
    /// has a right to. Delivery never calls the gate.
    function test_HB02_bridge_deliveryStillWorksAfterSeal() public {
        BeaconForkGate sealedGate = _newGate(BeaconForkGate.GateMode.Enforcing);
        bytes4 unknown = UNKNOWN_FORK;
        sealedGate.seal(_honestEvidence(block.timestamp, _slotIn(EPOCH_E, 3), 6, unknown));
        assertTrue(sealedGate.isSealed());

        MessageBridge destination = _deployDestinationBridge(lightClientForB, 0, DEFAULT_CAPELLA_ERA, address(sealedGate));
        _openDepositsWithoutProof(destination);
        _registerBridge(destination);
        Scene memory scene = _messageScene(destination);
        MessageFixtures.Named memory named = MessageFixtures.deliver();

        vm.chainId(CHAIN_B);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.GateSealed.selector));
        destination.requireToPassMessage(makeAddr("target"), hex"c0ffee", 100_000);

        destination.executeMessage(_messageProof(scene, named));
        assertEq(recorder.callCount(), 1, "the target ran once");
        assertTrue(destination.messageCallStatus(named.messageId), "the status records success");
    }
}
