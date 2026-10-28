// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {ForkShape} from "../../src/hardened/ForkShape.sol";
import {GateSupport} from "./utils/GateSupport.sol";

/// @notice Tests of the genesis validators root branch of `BeaconForkGate` (threat T20, decision D3). The version
/// branch alone does not pin the shape of the state. On a true depth 7 state, position 169 is state field 41, which no
/// specification defines. The gate therefore also requires a branch of `genesis_validators_root` (state field 1) at the
/// position of the same shape, with the value that the gate holds as an immutable. These tests build real sparse trees
/// hashed with SHA-256, and each attack test has an honest control.
contract BeaconForkGateGenesisRootTest is GateSupport {
    BeaconForkGate internal gate;
    /// @dev Epoch E, three slots in.
    uint256 internal constant NOW_SLOTS = 3;

    function setUp() public override {
        super.setUp();
        _warpIntoEpoch(EPOCH_E, NOW_SLOTS);
        _etchMock();
        gate = _newGate(BeaconForkGate.GateMode.Enforcing);
    }

    /// @dev The slot of the block time of `setUp`.
    function _slotNow() internal pure returns (uint64) {
        return _slotIn(EPOCH_E, NOW_SLOTS);
    }

    /// @dev A true depth 7 state. Field 41 (node 169) holds `version`, as a hostile chain might make it. The real
    /// `Fork` container (nodes 524 to 527) holds `ELECTRA`, and field 1 (node 129) holds `genesisRoot`.
    function _depthSevenWithVersionInField41(bytes4 version, bytes32 genesisRoot)
        internal
        pure
        returns (StateTree memory tree)
    {
        uint256[] memory gindices = new uint256[](4);
        bytes32[] memory leaves = new bytes32[](4);
        gindices[0] = HAND_PROGRESSIVE_VERSION_GINDEX;
        leaves[0] = bytes32(version);
        gindices[1] = _handGindex(7, 1);
        leaves[1] = bytes32(ELECTRA);
        gindices[2] = _handGenesisGindex(7);
        leaves[2] = genesisRoot;
        gindices[3] = (2 ** 7) + 5;
        leaves[3] = keccak256("state field 5");
        (bytes32 root, bytes32[][] memory branches) = _gateSparseTree(gindices, leaves);
        tree.depth = 7;
        tree.stateRoot = root;
        tree.currentBranch = branches[0];
        tree.previousBranch = branches[1];
        tree.genesisValidatorsRootBranch = branches[2];
    }

    /// @dev A true depth 5 state with the version at its honest position 141, `atNode33` at node 33 (state field 1)
    /// and `atNode40` at node 40 (state field 8, the position of the progressive form). The tree carries the branch of
    /// node 33. The second result is the branch of node 40.
    function _depthFiveWithRoots(bytes32 atNode33, bytes32 atNode40)
        internal
        pure
        returns (StateTree memory tree, bytes32[] memory branchOfNode40)
    {
        uint256[] memory gindices = new uint256[](3);
        bytes32[] memory leaves = new bytes32[](3);
        gindices[0] = _handGindex(5, 1);
        leaves[0] = bytes32(ELECTRA);
        gindices[1] = _handGenesisGindex(5);
        leaves[1] = atNode33;
        gindices[2] = HAND_PROGRESSIVE_GENESIS_GINDEX;
        leaves[2] = atNode40;
        (bytes32 root, bytes32[][] memory branches) = _gateSparseTree(gindices, leaves);
        tree.depth = 5;
        tree.stateRoot = root;
        tree.currentBranch = branches[0];
        tree.previousBranch = branches[0];
        tree.genesisValidatorsRootBranch = branches[1];
        branchOfNode40 = branches[2];
    }

    /// @dev Plants the header of `tree` and returns evidence with the given genesis validators root branch.
    function _plantedWith(uint256 timestamp, StateTree memory tree, bytes4 version, bytes32[] memory genesisBranch)
        internal
        returns (bytes memory)
    {
        BeaconBlockHeader memory header = _header(_slotNow(), tree.stateRoot);
        _plant(timestamp, SSZ.hashTreeRootMemory(header));
        return _evidence(timestamp, header, version, tree.currentBranch, genesisBranch);
    }

    /// Claim: a seven entry version proof at position 169 on a true depth 7 state does not confirm, even when state
    /// field 41 holds a version-like leaf, because the genesis validators root cannot be shown at the position of the
    /// progressive form (node 40). Shows: on a synthetic depth 7 state whose field 41 holds `UNKNOWN_FORK`, the version
    /// branch of 169 verifies, yet `confirm` reverts `GenesisValidatorsRootBranchInvalid` for a genesis validators root
    /// branch cut to five entries and for the true seven entry branch, and `seal` gives the same error. Control: the
    /// honest progressive state with `GENESIS_ROOT_A` at node 40 confirms, and so does the honest depth 7 state.
    /// Matters: node 40 on a depth 7 state is the root of a subtree of four fields, a hash that cannot equal the genesis
    /// validators root. Field 41 is the one landing of the version position that no specification rules out. This
    /// check closes it: without the branch, sends would go on into a route that cannot deliver them.
    function test_HB02_genesisRoot_confirmRequiresTheGenesisValidatorsRootAtTheClaimedShape() public {
        StateTree memory hostile = _depthSevenWithVersionInField41(UNKNOWN_FORK, GENESIS_ROOT_A);
        assertEq(hostile.currentBranch.length, 7, "the branch of field 41 has seven entries, like the progressive one");
        BeaconBlockHeader memory header = _header(_slotNow(), hostile.stateRoot);
        assertTrue(
            SSZ.isValidBranchMemory(
                bytes32(UNKNOWN_FORK), hostile.currentBranch, HAND_PROGRESSIVE_VERSION_GINDEX, hostile.stateRoot
            ),
            "the version branch of field 41 verifies at 169, so the version alone would pass"
        );
        _plant(block.timestamp, SSZ.hashTreeRootMemory(header));

        bytes memory expected = _err(BeaconForkGate.GenesisValidatorsRootBranchInvalid.selector);
        bytes32[] memory cut = _resize(hostile.genesisValidatorsRootBranch, 5);
        vm.expectRevert(expected);
        gate.confirm(_evidence(block.timestamp, header, UNKNOWN_FORK, hostile.currentBranch, cut));
        vm.expectRevert(expected);
        gate.confirm(
            _evidence(block.timestamp, header, UNKNOWN_FORK, hostile.currentBranch, hostile.genesisValidatorsRootBranch)
        );
        vm.expectRevert(expected);
        gate.seal(_evidence(block.timestamp, header, UNKNOWN_FORK, hostile.currentBranch, cut));
        (, bool confirmed) = gate.confirmedEpoch();
        assertFalse(confirmed, "nothing was confirmed");
        assertFalse(gate.isSealed(), "nothing was sealed");

        // controls
        BeaconForkGate progressive = _newGate(BeaconForkGate.GateMode.Enforcing);
        progressive.confirm(_honestProgressiveEvidence(block.timestamp + 12, _slotNow(), UNKNOWN_FORK));
        (, bool progressiveConfirmed) = progressive.confirmedEpoch();
        assertTrue(progressiveConfirmed, "the honest progressive state confirms");
        BeaconForkGate plainSeven = _newGate(BeaconForkGate.GateMode.Enforcing);
        plainSeven.confirm(_honestEvidence(block.timestamp + 24, _slotNow(), 7, ELECTRA));
        (, bool plainConfirmed) = plainSeven.confirmedEpoch();
        assertTrue(plainConfirmed, "the honest depth 7 state confirms with its own genesis validators root branch");
    }

    /// Claim: a genesis validators root branch of the right shape but with another root is refused for every allowed
    /// shape. Shows: for the shapes 5, 6, 7 and progressive, a state that holds `GENESIS_ROOT_B` at its genesis position
    /// gives `GenesisValidatorsRootBranchInvalid`, and the gate that follows `GENESIS_ROOT_B` accepts the same state.
    /// Control: the state with `GENESIS_ROOT_A` confirms on the gate that follows chain A. Matters: the root is an
    /// immutable of the gate, never read from the evidence. A caller who picks the root could prove any value.
    function test_HB02_genesisRoot_aForeignRootIsRefusedAtEveryShape() public {
        uint8[4] memory shapes = [uint8(5), 6, 7, PROGRESSIVE_SHAPE];
        for (uint256 i = 0; i < shapes.length; i++) {
            StateTree memory foreign = shapes[i] == PROGRESSIVE_SHAPE
                ? _progressiveTreeWithGenesis(UNKNOWN_FORK, ALTAIR, GENESIS_ROOT_B)
                : _stateTreeWithGenesis(shapes[i], UNKNOWN_FORK, ALTAIR, GENESIS_ROOT_B);
            bytes memory evidence =
                _plantedWith(block.timestamp + 12 * i, foreign, UNKNOWN_FORK, foreign.genesisValidatorsRootBranch);
            BeaconForkGate followsA = _newGate(BeaconForkGate.GateMode.Enforcing, GENESIS_ROOT_A);
            vm.expectRevert(_err(BeaconForkGate.GenesisValidatorsRootBranchInvalid.selector));
            followsA.confirm(evidence);

            BeaconForkGate followsB = _newGate(BeaconForkGate.GateMode.Enforcing, GENESIS_ROOT_B);
            followsB.confirm(evidence);
            (, bool confirmed) = followsB.confirmedEpoch();
            assertTrue(confirmed, "the gate that follows chain B accepts the state of chain B");
        }
    }

    /// Claim: the genesis validators root branch must have exactly the length of the shape that the version proved.
    /// Shows: for each allowed shape, a branch one entry shorter and one entry longer than the true one gives
    /// `GenesisValidatorsRootBranchInvalid`, and an empty branch does too. Control: the true branch confirms.
    /// Matters: a branch with leading zero entries or a missing entry must not reach the hash check, as in the
    /// light-client program, where branch checks are exact.
    function test_HB02_genesisRoot_theBranchLengthIsExact() public {
        uint8[4] memory shapes = [uint8(5), 6, 7, PROGRESSIVE_SHAPE];
        for (uint256 i = 0; i < shapes.length; i++) {
            StateTree memory tree = shapes[i] == PROGRESSIVE_SHAPE
                ? _progressiveTree(UNKNOWN_FORK, ALTAIR)
                : _stateTree(shapes[i], UNKNOWN_FORK, ALTAIR);
            uint256 trueLength = tree.genesisValidatorsRootBranch.length;
            uint256[3] memory wrongLengths = [trueLength - 1, trueLength + 1, 0];
            for (uint256 j = 0; j < wrongLengths.length; j++) {
                BeaconForkGate fresh = _newGate(BeaconForkGate.GateMode.Enforcing);
                bytes memory evidence = _plantedWith(
                    block.timestamp + 12 * (i * 4 + j),
                    tree,
                    UNKNOWN_FORK,
                    _resize(tree.genesisValidatorsRootBranch, wrongLengths[j])
                );
                vm.expectRevert(_err(BeaconForkGate.GenesisValidatorsRootBranchInvalid.selector));
                fresh.confirm(evidence);
            }
            BeaconForkGate control = _newGate(BeaconForkGate.GateMode.Enforcing);
            control.confirm(
                _plantedWith(block.timestamp + 12 * (i * 4 + 3), tree, UNKNOWN_FORK, tree.genesisValidatorsRootBranch)
            );
            (, bool confirmed) = control.confirmedEpoch();
            assertTrue(confirmed, "the true branch confirms");
        }
    }

    /// Claim: the genesis validators root must be proven at the position of the shape that the version proved, not at
    /// the position of another shape. Shows: a true depth 5 state with a valid version proof at 141 and the genesis
    /// validators root at node 40 (the progressive position, a plain field 8) gives `GenesisValidatorsRootBranchInvalid`
    /// for the five entry branch of node 40. Control: the same state with the root at node 33 confirms. Matters: the two
    /// branches have the same length in the plain depth 5 and the progressive shapes. Each shape needs its own pair of
    /// positions, or a mix of the two could prove a shape that the state does not have.
    function test_HB02_genesisRoot_mustSitAtTheShapeThatTheVersionProved() public {
        (StateTree memory mixed, bytes32[] memory branchOfNode40) =
            _depthFiveWithRoots(keccak256("some other field 1"), GENESIS_ROOT_A);
        assertEq(branchOfNode40.length, 5);
        bytes memory evidence = _plantedWith(block.timestamp, mixed, ELECTRA, branchOfNode40);
        vm.expectRevert(_err(BeaconForkGate.GenesisValidatorsRootBranchInvalid.selector));
        gate.confirm(evidence);

        (StateTree memory honest,) = _depthFiveWithRoots(GENESIS_ROOT_A, keccak256("some other field 8"));
        BeaconForkGate control = _newGate(BeaconForkGate.GateMode.Enforcing);
        control.confirm(_plantedWith(block.timestamp + 12, honest, ELECTRA, honest.genesisValidatorsRootBranch));
        (, bool confirmed) = control.confirmedEpoch();
        assertTrue(confirmed, "with the root at node 33 the same state confirms");
    }

    /// @dev An external wrapper, so that `vm.expectRevert` sees the revert of the library call.
    function checkMemoryBranch(bytes32[] memory branch, uint256 generalizedIndex) external pure returns (bool) {
        return SSZ.isValidBranchMemory(bytes32(0), branch, generalizedIndex, bytes32(0));
    }

    /// Claim: the branch check for evidence held in memory treats a branch of the wrong length as an error and not as a
    /// failed check. Shows: at node 33 (depth 5), a branch of 4 and a branch of 6 entries revert
    /// `BranchLengthMismatch(5, length)`, and a branch of 5 entries returns false without a revert. Matters: the gate
    /// compares the length of each branch with its shape before it calls this check, so the check never fails on a
    /// length in the gate. It is the second line of defense: a future caller that skips the length comparison still
    /// cannot read a short or padded branch as a branch of another depth.
    function test_HB02_genesisRoot_aMemoryBranchOfTheWrongLengthIsAnError() public {
        uint256 node = ForkShape.genesisValidatorsRootGindex(5);
        assertEq(node, 33);
        uint256[2] memory wrongLengths = [uint256(4), 6];
        for (uint256 i = 0; i < wrongLengths.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, uint256(5), wrongLengths[i]));
            this.checkMemoryBranch(new bytes32[](wrongLengths[i]), node);
        }
        assertFalse(this.checkMemoryBranch(new bytes32[](5), node), "the exact length is a failed check, not an error");
    }
}
