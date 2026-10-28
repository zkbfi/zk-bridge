// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {ForkShape} from "../../src/hardened/ForkShape.sol";
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

    // ================================================================ constructor

    /// Claim: every empty or zero configuration value is refused with its own name. Shows: five reverts, each
    /// `ZeroValue(name)`, the last one for the genesis validators root. Control: the same call with all values set
    /// deploys. Matters: a gate with zero timing would divide by zero or never confirm, and a gate with a zero genesis
    /// validators root would pin the shape to a leaf that no real chain holds.
    function test_HB02_constructor_zeroValuesRefused() public {
        BeaconForkGate.GateMode mode = BeaconForkGate.GateMode.Enforcing;

        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ZeroValue.selector, "beaconRoots"));
        new BeaconForkGate(address(0), mode, ETHEREUM_GENESIS, 12, 32, GENESIS_ROOT_A, address(0));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ZeroValue.selector, "genesisTime"));
        new BeaconForkGate(BEACON_ROOTS, mode, 0, 12, 32, GENESIS_ROOT_A, address(0));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ZeroValue.selector, "secondsPerSlot"));
        new BeaconForkGate(BEACON_ROOTS, mode, ETHEREUM_GENESIS, 0, 32, GENESIS_ROOT_A, address(0));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ZeroValue.selector, "slotsPerEpoch"));
        new BeaconForkGate(BEACON_ROOTS, mode, ETHEREUM_GENESIS, 12, 0, GENESIS_ROOT_A, address(0));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ZeroValue.selector, "genesisValidatorsRoot"));
        new BeaconForkGate(BEACON_ROOTS, mode, ETHEREUM_GENESIS, 12, 32, bytes32(0), address(0));

        BeaconForkGate control =
            new BeaconForkGate(BEACON_ROOTS, mode, ETHEREUM_GENESIS, 12, 32, GENESIS_ROOT_A, address(0));
        assertEq(control.beaconRoots(), BEACON_ROOTS, "the control deploys with the honest values");
    }

    /// Claim: the getters of the immutable settings return what the constructor got. Shows: all five values, the
    /// genesis validators root, and the mode, for both modes. Matters: the deploy script and the audit read these
    /// values, and the script compares the genesis validators root with the light client of the other chain.
    function test_HB02_constructor_settingsAreReadable() public {
        assertEq(gate.beaconRoots(), BEACON_ROOTS);
        assertEq(uint256(gate.mode()), uint256(BeaconForkGate.GateMode.Enforcing));
        assertEq(gate.genesisTime(), ETHEREUM_GENESIS);
        assertEq(gate.secondsPerSlot(), 12);
        assertEq(gate.slotsPerEpoch(), 32);
        assertEq(gate.genesisValidatorsRoot(), GENESIS_ROOT_A);
        BeaconForkGate detecting = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots, GENESIS_ROOT_B);
        assertEq(uint256(detecting.mode()), uint256(BeaconForkGate.GateMode.DetectBeaconRoots));
        assertEq(
            detecting.genesisValidatorsRoot(), GENESIS_ROOT_B, "the root is the one that was passed, not a constant"
        );
    }

    // ================================================================ getters

    /// Claim: `allowedShapes()` returns the plain depths 5, 6 and 7 and then the progressive marker 255, once each, in
    /// the order in which the gate tries them. Shows: four entries, no duplicate, and the same list from every mode.
    /// Matters: the configuration holds shapes, not names. The set is written in one place (`ForkShape`), so the deploy
    /// check and the registry path read the same four values, and a duplicate would be a silent misconfiguration.
    function test_HB02_getters_allowedShapesAreTheFourShapes() public {
        uint8[] memory shapes = gate.allowedShapes();
        assertEq(shapes.length, 4);
        assertEq(shapes[0], 5);
        assertEq(shapes[1], 6);
        assertEq(shapes[2], 7);
        assertEq(shapes[3], PROGRESSIVE_SHAPE);
        for (uint256 i = 0; i < shapes.length; i++) {
            for (uint256 j = i + 1; j < shapes.length; j++) {
                assertTrue(shapes[i] != shapes[j], "no shape is listed twice");
            }
        }
        uint8[] memory detecting = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots).allowedShapes();
        assertEq(keccak256(abi.encode(detecting)), keccak256(abi.encode(shapes)), "every mode has the same set");
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
        bytes memory expected = abi.encodeWithSelector(
            BeaconForkGate.BeforeGenesis.selector, uint256(ETHEREUM_GENESIS - 1), ETHEREUM_GENESIS
        );
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
            BEACON_ROOTS, BeaconForkGate.GateMode.DetectBeaconRoots, genesis, 10, 32, GENESIS_ROOT_A, address(0)
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
            abi.encodeWithSelector(
                BeaconForkGate.HeaderRootMismatch.selector, SSZ.hashTreeRootMemory(built.header), forgedRoot
            )
        );
        gate.confirm(_evidenceOf(block.timestamp, forged, ELECTRA, built.tree));
        gate.confirm(_evidenceOf(block.timestamp, built.header, ELECTRA, built.tree));
    }

    /// Claim: a version that no list ever held confirms when its proof has an allowed shape. Shows: the unlisted
    /// version `UNKNOWN_FORK` with a valid depth 6 proof emits `ForkConfirmed(epoch, UNKNOWN_FORK)` and confirms the
    /// epoch. Control: the same proof at depth 8, a shape outside the allowed set, is `ShapeNotAllowed(8)`, so the
    /// shape decides and the name does not. Matters: this is the core of the one rule. The gate has no list of names to
    /// keep up to date, and a fork of the same shape cannot stop the route by surprise.
    function test_HB02_revert_unlistedVersionAtAnAllowedShapeConfirms() public {
        bytes memory unlisted = _honestEvidence(block.timestamp, _slotNow(), 6, UNKNOWN_FORK);
        vm.expectEmit(true, false, false, true, address(gate));
        emit ForkConfirmed(EPOCH_E, UNKNOWN_FORK);
        gate.confirm(unlisted);
        (uint64 epoch, bool exists) = gate.confirmedEpoch();
        assertTrue(exists, "the unlisted version confirmed");
        assertEq(epoch, EPOCH_E);

        BeaconForkGate other = _newGate(BeaconForkGate.GateMode.Enforcing);
        bytes memory wrongShape = _sealEvidence(block.timestamp + 12, _slotNow(), UNKNOWN_FORK);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ShapeNotAllowed.selector, DISALLOWED_DEPTH));
        other.confirm(wrongShape);
    }

    /// Claim: a proof of one version cannot confirm another version at the same shape. Shows: a tree holding Electra
    /// with the claim Fulu is `ForkProofInvalid`, and so is a flipped entry of the branch. Control: the honest claim passes.
    /// Matters: the leaf, not the claim, decides.
    function test_HB02_revert_forkProofInvalidForAWrongLeafOrSibling() public {
        StateTreeAndHeader memory built = _builtElectra(block.timestamp);
        vm.expectRevert(_err(BeaconForkGate.ForkProofInvalid.selector));
        gate.confirm(_evidenceOf(block.timestamp, built.header, FULU, built.tree));

        bytes32[] memory flipped = _resize(built.tree.currentBranch, built.tree.currentBranch.length);
        flipped[3] = bytes32(uint256(flipped[3]) ^ 1);
        vm.expectRevert(_err(BeaconForkGate.ForkProofInvalid.selector));
        gate.confirm(_evidence(block.timestamp, built.header, ELECTRA, flipped, built.tree.genesisValidatorsRootBranch));

        gate.confirm(_evidenceOf(block.timestamp, built.header, ELECTRA, built.tree));
    }

    /// Claim: a timestamp that the beacon roots contract does not hold is refused. Shows:
    /// `BeaconRootUnavailable(timestamp)` for a timestamp never written, and for timestamp zero. Control: a written
    /// timestamp works. Matters: an empty answer must never be read as a root.
    function test_HB02_revert_beaconRootUnavailable() public {
        StateTreeAndHeader memory built = _builtElectra(block.timestamp);
        bytes memory unwritten = _evidenceOf(block.timestamp + 5, built.header, ELECTRA, built.tree);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.BeaconRootUnavailable.selector, block.timestamp + 5));
        gate.confirm(unwritten);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.BeaconRootUnavailable.selector, 0));
        gate.confirm(_evidenceOf(0, built.header, ELECTRA, built.tree));
        gate.confirm(_evidenceOf(block.timestamp, built.header, ELECTRA, built.tree));
    }

    // ================================================================ previous_version

    /// Claim: a proof of `Fork.previous_version` neither confirms nor seals. Shows: on one state tree, the
    /// previous-version branch is `ForkProofInvalid` in `confirm`, and on a state tree of a disallowed depth it is
    /// `ForkProofInvalid` in `seal`. Control: the current-version branch of the SAME tree confirms, and the
    /// current-version branch of the disallowed tree seals. Matters: the previous version leaf sits next to the current
    /// one. If the caller could pick the index, a proof of the old version would seal the gate before any fork, or
    /// confirm after one.
    function test_HB02_previousVersionProofNeitherConfirmsNorSeals() public {
        StateTree memory tree = _stateTree(6, ELECTRA, FULU);
        BeaconBlockHeader memory header = _header(_slotNow(), tree.stateRoot);
        _plant(block.timestamp, SSZ.hashTreeRootMemory(header));
        vm.expectRevert(_err(BeaconForkGate.ForkProofInvalid.selector));
        gate.confirm(_evidence(block.timestamp, header, FULU, tree.previousBranch, tree.genesisValidatorsRootBranch));
        gate.confirm(_evidenceOf(block.timestamp, header, ELECTRA, tree));

        StateTree memory sealTree = _stateTree(DISALLOWED_DEPTH, UNKNOWN_FORK, ALTAIR);
        BeaconBlockHeader memory sealHeader = _header(_slotNow(), sealTree.stateRoot);
        _plant(block.timestamp + 12, SSZ.hashTreeRootMemory(sealHeader));
        vm.expectRevert(_err(BeaconForkGate.ForkProofInvalid.selector));
        gate.seal(
            _evidence(
                block.timestamp + 12, sealHeader, ALTAIR, sealTree.previousBranch, sealTree.genesisValidatorsRootBranch
            )
        );
        assertFalse(gate.isSealed(), "the previous version did not seal");
        gate.seal(_evidenceOf(block.timestamp + 12, sealHeader, UNKNOWN_FORK, sealTree));
        assertTrue(gate.isSealed());
    }

    // ================================================================ every pair of shapes

    /// @dev The shapes of the soundness table: the three allowed plain depths, the first disallowed depth, and the
    /// progressive form.
    function _tableShapes() internal pure returns (uint8[5] memory) {
        return [uint8(5), 6, 7, uint8(DISALLOWED_DEPTH), PROGRESSIVE_SHAPE];
    }

    /// @dev The number of entries in the version branch of a shape of the table.
    function _versionLength(uint8 shape) internal pure returns (uint256) {
        if (shape == PROGRESSIVE_SHAPE) return 7;
        return uint256(shape) + 2;
    }

    /// @dev The number of entries in the genesis validators root branch of a shape of the table.
    function _genesisLength(uint8 shape) internal pure returns (uint256) {
        if (shape == PROGRESSIVE_SHAPE) return 5;
        return shape;
    }

    /// @dev A tree of a shape of the table that holds `UNKNOWN_FORK` as its current version.
    function _treeOfShape(uint8 shape) internal pure returns (StateTree memory) {
        if (shape == PROGRESSIVE_SHAPE) return _progressiveTree(UNKNOWN_FORK, ALTAIR);
        return _stateTree(shape, UNKNOWN_FORK, ALTAIR);
    }

    /// Claim: for every claimed shape c and true shape t in {5, 6, 7, 8, progressive} with c != t, both `confirm` and
    /// `seal` refuse a proof that claims c over a tree of shape t, and the gate stays open. The caller claims a shape
    /// only through the length of the branch. Shows, per pair: the true branch cut or extended to the lengths of c is
    /// `ForkProofInvalid` on `seal`, and on `confirm` it is `ForkProofInvalid` when c is allowed and
    /// `ShapeNotAllowed(8)` when c is 8. The pairs (5, progressive) and (progressive, 5) have the same branch length,
    /// so the cut changes nothing: the honest proof stays valid and confirms as the true shape. Control: c == t
    /// confirms for the allowed shapes, `ShapeNotAllowed(8)` for 8, and `seal` gives `ShapeIsAllowed(t)` for the
    /// allowed shapes and seals for 8. Matters: this is the soundness table of the gate. A wrong shape lands on a leaf
    /// field (`genesis_time`, `eth1_deposit_index`), on the length of a list, inside the `Fork` container, or above the
    /// fields, and none of those nodes can hold a version leaf, so passing would need a SHA-256 preimage.
    function test_HB02_depth_confirmAndSealRefuseEveryWrongPair() public {
        uint8[5] memory shapes = _tableShapes();
        for (uint256 claimedIndex = 0; claimedIndex < shapes.length; claimedIndex++) {
            for (uint256 actualIndex = 0; actualIndex < shapes.length; actualIndex++) {
                _checkPair(shapes[claimedIndex], shapes[actualIndex], 2 * (claimedIndex * 5 + actualIndex));
            }
        }
    }

    /// @dev Checks one cell of the soundness table: evidence that claims `claimed` over a true tree of shape `actual`, on `confirm` and on `seal`. `slotOffset` keeps the planted timestamps apart.
    function _checkPair(uint8 claimed, uint8 actual, uint256 slotOffset) internal {
        StateTree memory tree = _treeOfShape(actual);
        BeaconBlockHeader memory header = _header(_slotNow(), tree.stateRoot);
        uint256 confirmTime = block.timestamp + 12 * slotOffset;
        uint256 sealTime = confirmTime + 12;
        _plant(confirmTime, SSZ.hashTreeRootMemory(header));
        _plant(sealTime, SSZ.hashTreeRootMemory(header));
        bytes32[] memory versionBranch = _resize(tree.currentBranch, _versionLength(claimed));
        bytes32[] memory genesisBranch = _resize(tree.genesisValidatorsRootBranch, _genesisLength(claimed));
        BeaconForkGate confirmGate = _newGate(BeaconForkGate.GateMode.Enforcing);
        BeaconForkGate sealGate = _newGate(BeaconForkGate.GateMode.Enforcing);

        // The same branch length means the same branch: the proof is the honest proof of the true shape.
        bool sameLength = _versionLength(claimed) == _versionLength(actual);
        if (sameLength) claimed = actual;

        if (claimed == actual && actual != DISALLOWED_DEPTH) {
            confirmGate.confirm(_evidence(confirmTime, header, UNKNOWN_FORK, versionBranch, genesisBranch));
            (, bool confirmed) = confirmGate.confirmedEpoch();
            assertTrue(confirmed, "an honest proof of an allowed shape confirms");
            vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ShapeIsAllowed.selector, actual));
            sealGate.seal(_evidence(sealTime, header, UNKNOWN_FORK, versionBranch, genesisBranch));
            assertFalse(sealGate.isSealed(), "an allowed shape does not seal");
            return;
        }
        if (claimed == actual) {
            vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ShapeNotAllowed.selector, DISALLOWED_DEPTH));
            confirmGate.confirm(_evidence(confirmTime, header, UNKNOWN_FORK, versionBranch, genesisBranch));
            sealGate.seal(_evidence(sealTime, header, UNKNOWN_FORK, versionBranch, genesisBranch));
            assertTrue(sealGate.isSealed(), "an honest proof of the disallowed shape seals");
            return;
        }
        bytes memory expectedOnConfirm = claimed == DISALLOWED_DEPTH
            ? abi.encodeWithSelector(BeaconForkGate.ShapeNotAllowed.selector, DISALLOWED_DEPTH)
            : _err(BeaconForkGate.ForkProofInvalid.selector);
        vm.expectRevert(expectedOnConfirm);
        confirmGate.confirm(_evidence(confirmTime, header, UNKNOWN_FORK, versionBranch, genesisBranch));
        vm.expectRevert(_err(BeaconForkGate.ForkProofInvalid.selector));
        sealGate.seal(_evidence(sealTime, header, UNKNOWN_FORK, versionBranch, genesisBranch));
        assertFalse(sealGate.isSealed(), "a wrong shape never seals");
        (, bool anyConfirmed) = confirmGate.confirmedEpoch();
        assertFalse(anyConfirmed, "a wrong shape never confirms");
    }

    /// Claim: a seal branch whose length implies a depth below 5 or above 31 is refused with the depth in the error,
    /// even when the branch is a valid proof. Shows: `SealDepthNotAllowed(depth)` for honest proofs at the depths 2, 3
    /// and 4, for cut branches of 0 to 3 entries (depths 0, 0, 0 and 1), and for 34 and 100 entries (32 and 98).
    /// Control: a branch extended to 11 and to 33 entries (depths 9 and 31) is inside the range and fails on the hash with
    /// `ForkProofInvalid`, and the honest depth 8 proof seals. Matters: the landing table shows that a false seal at a
    /// depth below 5 is infeasible (it lands above the fields or on a hash). The bound keeps the rule simple, and a
    /// huge or tiny length must not reach the position arithmetic.
    function test_HB02_depth_sealLengthsOutsideTheRangeRefused() public {
        for (uint256 depth = 2; depth <= 4; depth++) {
            bytes memory valid = _sealEvidenceAtDepth(block.timestamp + depth, depth);
            vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.SealDepthNotAllowed.selector, depth));
            gate.seal(valid);
        }
        StateTree memory tree = _stateTree(DISALLOWED_DEPTH, UNKNOWN_FORK, ALTAIR);
        BeaconBlockHeader memory header = _header(_slotNow(), tree.stateRoot);
        _plant(block.timestamp, SSZ.hashTreeRootMemory(header));
        uint256[6] memory lengths = [uint256(0), 1, 2, 3, 34, 100];
        uint256[6] memory reported = [uint256(0), 0, 0, 1, 32, 98];
        for (uint256 i = 0; i < lengths.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.SealDepthNotAllowed.selector, reported[i]));
            gate.seal(
                _evidence(
                    block.timestamp,
                    header,
                    UNKNOWN_FORK,
                    _resize(tree.currentBranch, lengths[i]),
                    tree.genesisValidatorsRootBranch
                )
            );
        }
        uint256[2] memory insideTheRange = [uint256(11), 33];
        for (uint256 i = 0; i < insideTheRange.length; i++) {
            vm.expectRevert(_err(BeaconForkGate.ForkProofInvalid.selector));
            gate.seal(
                _evidence(
                    block.timestamp,
                    header,
                    UNKNOWN_FORK,
                    _resize(tree.currentBranch, insideTheRange[i]),
                    tree.genesisValidatorsRootBranch
                )
            );
        }
        assertFalse(gate.isSealed());

        // control: the honest depth 8 branch seals
        gate.seal(_evidenceOf(block.timestamp, header, UNKNOWN_FORK, tree));
        assertTrue(gate.isSealed());
    }

    /// @dev Plants a tree of `depth` and returns seal evidence for it.
    function _sealEvidenceAtDepth(uint256 timestamp, uint256 depth) internal returns (bytes memory) {
        return _honestEvidence(timestamp, _slotNow(), depth, UNKNOWN_FORK);
    }

    // ================================================================ seal

    /// Claim: a valid proof at an allowed shape never seals, whatever version it names. Shows: for the shapes 5, 6, 7
    /// and progressive, with the versions `UNKNOWN_FORK` and `ELECTRA`, `seal` reverts `ShapeIsAllowed(shape)`, and
    /// `isSealed` stays false. Control: a valid depth 8 proof, in the same gate, seals. Matters: a seal needs a
    /// disallowed shape, not an unknown name. Otherwise anybody could close the gate with a proof of an ordinary
    /// state.
    function test_HB02_seal_refusesEveryAllowedShape() public {
        uint8[4] memory allowed = [uint8(5), 6, 7, PROGRESSIVE_SHAPE];
        bytes4[2] memory versions = [UNKNOWN_FORK, ELECTRA];
        for (uint256 i = 0; i < allowed.length; i++) {
            for (uint256 j = 0; j < versions.length; j++) {
                uint256 timestamp = block.timestamp + 12 * (i * 2 + j);
                bytes memory evidence = allowed[i] == PROGRESSIVE_SHAPE
                    ? _honestProgressiveEvidence(timestamp, _slotNow(), versions[j])
                    : _honestEvidence(timestamp, _slotNow(), allowed[i], versions[j]);
                vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ShapeIsAllowed.selector, allowed[i]));
                gate.seal(evidence);
            }
        }
        assertFalse(gate.isSealed());
        gate.seal(_sealEvidence(block.timestamp + 100, _slotNow(), UNKNOWN_FORK));
        assertTrue(gate.isSealed());
    }

    /// Claim: a valid proof of a disallowed shape seals the gate for good, and the next calls revert. Shows: a valid
    /// depth 8 proof emits `GateSealedByFork(version, slot)`; then `admit`, `confirm` and `seal` revert `GateSealed`.
    /// Control: the same proof with a flipped branch entry is `ForkProofInvalid` and does not seal. Matters: this is
    /// the seal trigger. A state that the route cannot read has no accepted proof, and the seal stops the sends for good.
    function test_HB02_seal_acceptsAValidProofOfADisallowedShape() public {
        bytes memory valid = _sealEvidence(block.timestamp, _slotNow(), UNKNOWN_FORK);
        StateTree memory tree = _stateTree(DISALLOWED_DEPTH, UNKNOWN_FORK, 0x02000000);
        bytes32[] memory flipped = _resize(tree.currentBranch, tree.currentBranch.length);
        flipped[2] = bytes32(uint256(flipped[2]) ^ 1);
        BeaconBlockHeader memory header = _header(_slotNow(), tree.stateRoot);
        vm.expectRevert(_err(BeaconForkGate.ForkProofInvalid.selector));
        gate.seal(_evidence(block.timestamp, header, UNKNOWN_FORK, flipped, tree.genesisValidatorsRootBranch));
        assertFalse(gate.isSealed(), "a forged branch did not seal");

        vm.expectEmit(false, false, false, true, address(gate));
        emit GateSealedByFork(UNKNOWN_FORK, _slotNow());
        gate.seal(valid);
        assertTrue(gate.isSealed());

        bytes memory sealedError = _err(BeaconForkGate.GateSealed.selector);
        vm.expectRevert(sealedError);
        gate.admit("");
        vm.expectRevert(sealedError);
        gate.confirm(valid);
        vm.expectRevert(sealedError);
        gate.seal(valid);
    }

    /// Claim: a seal with an unknown version closes the gate for good. Shows: the event with version and slot; then
    /// `admit` reverts `GateSealed` in a confirmed epoch, with valid evidence, and with none; `confirm` and a second
    /// `seal` revert `GateSealed`; a later epoch is no different. Control: before the seal the same send passes.
    /// Matters: a sealed route must stay sealed: after an unknown fork no state is trustworthy.
    function test_HB02_seal_closesTheGateForGood() public {
        gate.admit(_good());
        gate.admit("");
        assertFalse(gate.isSealed());

        bytes memory sealEvidence = _sealEvidence(block.timestamp + 12, _slotNow(), UNKNOWN_FORK);
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

    /// Claim: a seal works at every depth from the first disallowed depth up to the largest accepted depth. Shows:
    /// four fresh gates, each sealed by a valid tree of depth 8, 9, 16 and 31, with the event. Control: the allowed
    /// depths 5, 6 and 7 do not seal (see `test_HB02_seal_refusesEveryAllowedShape`). Matters: depth 8 is the room for a
    /// fork past 128 state fields, and a fork may jump further. Every depth above the allowed set must stop the sends.
    function test_HB02_seal_worksAtEveryDisallowedDepth() public {
        uint8[4] memory depths = [uint8(8), 9, 16, 31];
        for (uint256 i = 0; i < depths.length; i++) {
            BeaconForkGate fresh = _newGate(BeaconForkGate.GateMode.Enforcing);
            bytes memory evidence = _honestEvidence(block.timestamp + 12 * i, _slotNow(), depths[i], UNKNOWN_FORK);
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
        bytes memory old = _sealEvidence(block.timestamp, _slotIn(EPOCH_E - 3, 7), UNKNOWN_FORK);
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
        bytes memory evidence = _sealEvidence(block.timestamp, tooOld, UNKNOWN_FORK);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.SealEvidenceTooOld.selector, tooOld, _slotNow()));
        gate.seal(evidence);
        assertFalse(gate.isSealed());

        gate.seal(_sealEvidence(block.timestamp + 12, _slotNow(), UNKNOWN_FORK));
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
        bytes memory evidence = _sealEvidence(block.timestamp + 12, older, UNKNOWN_FORK);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.SealEvidenceTooOld.selector, older, confirmedSlot));
        gate.seal(evidence);
        assertFalse(gate.isSealed());

        // a later epoch confirms with a higher header; the bound follows it
        _warpIntoEpoch(EPOCH_E + 1, 3);
        uint64 laterSlot = _slotIn(EPOCH_E + 1, 1);
        gate.confirm(_honestEvidence(block.timestamp, laterSlot, 6, ELECTRA));
        bytes memory stale = _sealEvidence(block.timestamp + 12, confirmedSlot, UNKNOWN_FORK);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.SealEvidenceTooOld.selector, confirmedSlot, laterSlot));
        gate.seal(stale);

        gate.seal(_sealEvidence(block.timestamp + 24, laterSlot, UNKNOWN_FORK));
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
        bytes memory evidence = _sealEvidence(block.timestamp, forkSlot, UNKNOWN_FORK);
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
        bytes memory evidence = _evidenceOf(first, header, ELECTRA, tree);
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
        bytes memory evidence = _evidenceOf(first, header, ELECTRA, tree);
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
        bytes memory unknown = _sealEvidence(block.timestamp + 12, _slotNow(), UNKNOWN_FORK);
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

    /// Claim: in detection mode after the first PulseChain-style fork (a root present, a state shape outside the allowed
    /// set), a send reverts, and anybody can seal. Shows: the proof of the new shape is `ShapeNotAllowed(8)` for `admit`,
    /// so no confirmation exists for it; `seal` works for any caller. Control: an unlisted version at an allowed shape
    /// is admitted. Matters: this is the planned behavior in the documents: the old route closes itself at the fork.
    function test_HB02_detection_aShapeOutsideTheAllowedSetAfterDetectionCanBeSealed() public {
        BeaconForkGate detecting = _detecting();
        detecting.admit("");
        bytes memory shifted = _sealEvidence(block.timestamp, _slotNow(), UNKNOWN_FORK);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ShapeNotAllowed.selector, DISALLOWED_DEPTH));
        detecting.admit(shifted);
        vm.prank(makeAddr("anybody"));
        detecting.seal(shifted);
        vm.expectRevert(_err(BeaconForkGate.GateSealed.selector));
        detecting.admit("");

        BeaconForkGate other = _detecting();
        other.admit(_honestEvidence(block.timestamp + 12, _slotNow(), 5, UNKNOWN_FORK));
        assertTrue(other.enforcing(), "an unlisted version at an allowed shape is admitted");
    }

    // ================================================================ enforcing mode without a contract

    /// Claim: in `Enforcing` mode the gate applies the rules from deployment, with no code at the address. Shows:
    /// `admit("")` reverts `ForkNotConfirmed`, and `confirm` and `seal` revert `BeaconRootUnavailable`.
    /// Control: with the model installed and honest evidence, the same gate admits. Matters: Ethereum must never
    /// fall back to open sending.
    function test_HB02_enforcing_appliesFromDeploymentEvenWithNoCode() public {
        StateTreeAndHeader memory built = _builtElectra(block.timestamp);
        bytes memory unknown = _sealEvidence(block.timestamp + 12, _slotNow(), UNKNOWN_FORK);
        vm.etch(BEACON_ROOTS, "");
        assertTrue(gate.enforcing());
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        gate.admit("");
        bytes memory evidence = _evidenceOf(block.timestamp, built.header, ELECTRA, built.tree);
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
        gate.confirm(_evidenceOf(block.timestamp, header, ELECTRA, tree));
    }

    // ================================================================ the layouts of the light-client program

    /// Claim: the allowed shapes of the gate equal the layouts that the light-client program accepts, and the seal
    /// shapes are exactly the depths above that set, up to 31. The program has no fork table: the length of the finality
    /// branch names the layout, and the fixture `program` key lists the plain depths (a finality branch of d + 1
    /// entries) and the one progressive length. Shows: the plain shapes of the gate equal `program.plainStateDepths`
    /// in order, each finality length is its depth plus one, and the progressive marker comes last. Then, for every
    /// depth from 5 to 31, a valid proof seals a fresh gate when the depth is outside the program set, and is
    /// `ShapeIsAllowed(depth)` when it is inside. Matters: a shape in the gate that the program cannot read would let
    /// sends pass that can never be delivered; a program shape missing from the gate would stop sends in a layout that
    /// the program supports.
    function test_HB02_forkShape_gateShapesEqualTheLightClientProgramAllowedSet() public {
        string memory gindices = vm.readFile("light-client/tests/fixtures/gindices.json");
        uint256[] memory programDepths = vm.parseJsonUintArray(gindices, ".program.plainStateDepths");
        uint256[] memory lengths = vm.parseJsonUintArray(gindices, ".program.finalityBranchLengths");
        uint256[] memory progressiveLengths =
            vm.parseJsonUintArray(gindices, ".program.progressiveFinalityBranchLengths");
        assertEq(progressiveLengths.length, 1, "the program has one progressive layout");
        assertEq(lengths.length, programDepths.length + 1, "one finality length per layout");
        assertEq(lengths[lengths.length - 1], progressiveLengths[0], "the progressive layout is the last one");

        uint8[] memory shapes = gate.allowedShapes();
        assertEq(shapes.length, programDepths.length + 1, "the gate and the program have the same number of shapes");
        for (uint256 i = 0; i < programDepths.length; i++) {
            assertEq(shapes[i], programDepths[i], "the plain shapes are the plain depths of the program");
            assertEq(lengths[i], programDepths[i] + 1, "a plain finality branch has one entry more than the depth");
        }
        assertEq(shapes[shapes.length - 1], PROGRESSIVE_SHAPE, "the progressive marker comes last");

        for (uint256 depth = 5; depth <= 31; depth++) {
            bool inTheProgram = _contains(programDepths, depth);
            BeaconForkGate fresh = _newGate(BeaconForkGate.GateMode.Enforcing);
            bytes memory evidence = _honestEvidence(block.timestamp + 12 * depth, _slotNow(), depth, UNKNOWN_FORK);
            if (inTheProgram) {
                vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ShapeIsAllowed.selector, uint8(depth)));
            }
            fresh.seal(evidence);
            assertEq(fresh.isSealed(), !inTheProgram, "a depth seals exactly when the program cannot read it");
        }
    }

    /// Claim: the generalized indices of `ForkShape` equal the ones in `light-client/crates/lc-core/src/layout.rs`
    /// and in the fixture. Shows: the version leaf is at 141, 269, 525 for the plain depths 5, 6, 7 and at 169 for the
    /// progressive form; the genesis validators root leaf is at 33, 65, 129 and 40; the branch lengths are 7, 8, 9, 7
    /// for the version and 5, 6, 7, 5 for the genesis validators root. The progressive version index also equals
    /// `gloas.forkVersionGindex` and its length equals `gloas.forkVersionBranchLength` in `gindices.json`, and each plain
    /// depth of the program matches the committee index of its fork in the same file (`2**d + 22`). The numbers are
    /// written as literals here, so a change in either place fails. Matters: the gate and the program agree on the
    /// position of the two leaves only if these numbers agree. A drift in one position would make the gate accept shapes
    /// that the program refuses, or the other way round.
    function test_HB02_forkShape_positionsEqualTheLightClientLayout() public view {
        uint8[4] memory shapes = [uint8(5), 6, 7, PROGRESSIVE_SHAPE];
        uint256[4] memory versionPositions = [uint256(141), 269, 525, 169];
        uint256[4] memory versionLengths = [uint256(7), 8, 9, 7];
        uint256[4] memory genesisPositions = [uint256(33), 65, 129, 40];
        uint256[4] memory genesisLengths = [uint256(5), 6, 7, 5];
        for (uint256 i = 0; i < shapes.length; i++) {
            assertEq(ForkShape.versionGindex(shapes[i]), versionPositions[i], "version position");
            assertEq(ForkShape.versionBranchLength(shapes[i]), versionLengths[i], "version branch length");
            assertEq(
                ForkShape.genesisValidatorsRootGindex(shapes[i]),
                genesisPositions[i],
                "genesis validators root position"
            );
            assertEq(
                ForkShape.genesisValidatorsRootBranchLength(shapes[i]),
                genesisLengths[i],
                "genesis validators root branch length"
            );
            assertEq(_floorLog2(versionPositions[i]), versionLengths[i], "a branch has floor(log2(index)) entries");
            assertEq(_floorLog2(genesisPositions[i]), genesisLengths[i], "a branch has floor(log2(index)) entries");
        }
        string memory gindices = vm.readFile("light-client/tests/fixtures/gindices.json");
        assertEq(vm.parseJsonUint(gindices, ".gloas.forkVersionGindex"), ForkShape.versionGindex(PROGRESSIVE_SHAPE));
        assertEq(
            vm.parseJsonUint(gindices, ".gloas.forkVersionBranchLength"),
            ForkShape.versionBranchLength(PROGRESSIVE_SHAPE)
        );
        assertEq(
            vm.parseJsonUint(gindices, ".forks.capella.currentSyncCommitteeGindex"), 32 + 22, "depth 5 committee index"
        );
        assertEq(
            vm.parseJsonUint(gindices, ".forks.electra.currentSyncCommitteeGindex"), 64 + 22, "depth 6 committee index"
        );
    }

    /// @dev Whether `needle` is in `haystack`.
    function _contains(uint256[] memory haystack, uint256 needle) internal pure returns (bool) {
        for (uint256 i = 0; i < haystack.length; i++) {
            if (haystack[i] == needle) return true;
        }
        return false;
    }

    /// @dev The floor of the base two logarithm. The number of entries in a branch to a generalized index.
    function _floorLog2(uint256 value) internal pure returns (uint256 result) {
        while (value > 1) {
            value >>= 1;
            result++;
        }
    }

    /// Claim: names never decide. The versions before Capella, the value `0xffffffff` and a version that no list ever
    /// held all confirm at an allowed shape, and the same proofs at depth 8 are `ShapeNotAllowed(8)`. Shows: for five
    /// names, a valid depth 5 proof confirms a fresh gate, and a valid depth 8 proof is refused with the depth. Matters:
    /// the version-name list is gone on both chains. Whether a name is meaningful is the business of the light client,
    /// which reads fixed positions and fails closed on a state it cannot read. The gate only judges the shape.
    function test_HB02_forkShape_everyNameConfirmsAtAnAllowedShapeAndNoneAtADisallowedOne() public {
        bytes4[5] memory names = [bytes4(0x00000000), ALTAIR, 0x02000000, UNKNOWN_FORK, 0xffffffff];
        for (uint256 i = 0; i < names.length; i++) {
            BeaconForkGate fresh = _newGate(BeaconForkGate.GateMode.Enforcing);
            fresh.confirm(_honestEvidence(block.timestamp + 12 * i, _slotNow(), 5, names[i]));
            (, bool confirmed) = fresh.confirmedEpoch();
            assertTrue(confirmed, "the name did not matter");

            BeaconForkGate other = _newGate(BeaconForkGate.GateMode.Enforcing);
            bytes memory wrongShape = _sealEvidence(block.timestamp + 12 * (i + 10), _slotNow(), names[i]);
            vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ShapeNotAllowed.selector, DISALLOWED_DEPTH));
            other.confirm(wrongShape);
        }
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
        gate.seal(_sealEvidence(block.timestamp + 12, _slotNow(), UNKNOWN_FORK));

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
        _confirmThenSend(sender, gate, alice, _evidenceOf(block.timestamp, header, ELECTRA, tree));
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
        sealedGate.seal(_sealEvidence(block.timestamp, _slotIn(EPOCH_E, 3), UNKNOWN_FORK));
        assertTrue(sealedGate.isSealed());

        MessageBridge destination =
            _deployDestinationBridge(lightClientForB, 0, DEFAULT_CAPELLA_ERA, address(sealedGate));
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
