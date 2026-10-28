// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {ForkShape} from "../../src/hardened/ForkShape.sol";
import {GateSupport} from "./utils/GateSupport.sol";

/// @notice `BeaconForkGate` on a Gloas state. The Gloas `BeaconState` is a progressive container, so the version leaf sits
/// at the fixed index 169 (7 siblings) and the genesis validators root leaf at node 40 (5 siblings). The gate holds no
/// Gloas name: it tries each allowed shape at its own positions. The evidence of most tests is REAL: the finalized header
/// of a Sepolia beacon node, the root of its real state (3.6 MB of SSZ, hashed by `lc-core`), the branch of its
/// `fork.current_version` (0x90000076, Gloas; the previous version is 0x90000075, Fulu) and the branch of its
/// `genesis_validators_root` (the file `test/hardened/fixtures/gloas_genesis_validators_root.json`).
contract GloasGateTest is GateSupport {
    /// @dev The previous fork version of the real Sepolia state.
    bytes4 internal constant SEPOLIA_FULU = 0x90000075;
    /// @dev The current fork version of the real Sepolia state.
    bytes4 internal constant SEPOLIA_GLOAS = 0x90000076;
    /// @dev The real version branch and header.
    string internal constant FIXTURE = "light-client/tests/fixtures/sepolia/gloas_fork_version.json";
    /// @dev The real genesis validators root branch over the same state.
    string internal constant GENESIS_FIXTURE = "test/hardened/fixtures/gloas_genesis_validators_root.json";
    /// @dev The genesis data that the Sepolia node reports.
    string internal constant SEPOLIA_GENESIS = "light-client/tests/fixtures/sepolia/genesis.json";

    /// @dev The real header with its two branches.
    struct Real {
        BeaconBlockHeader header;
        bytes32[] branch;
        bytes32[] genesisBranch;
        bytes32 genesisValidatorsRoot;
    }

    function setUp() public override {
        super.setUp();
        _etchMock();
    }

    /// @dev Reads the real fixtures and checks that they belong together.
    function _real() internal view returns (Real memory out) {
        string memory json = vm.readFile(FIXTURE);
        out.header = BeaconBlockHeader({
            slot: uint64(vm.parseUint(vm.parseJsonString(json, ".response.header.slot"))),
            proposerIndex: uint64(vm.parseUint(vm.parseJsonString(json, ".response.header.proposer_index"))),
            parentRoot: vm.parseJsonBytes32(json, ".response.header.parent_root"),
            stateRoot: vm.parseJsonBytes32(json, ".response.header.state_root"),
            bodyRoot: vm.parseJsonBytes32(json, ".response.header.body_root")
        });
        out.branch = vm.parseJsonBytes32Array(json, ".response.branch");
        assertEq(out.branch.length, 7);
        assertEq(
            vm.parseJsonBytes32(json, ".response.state_root"), out.header.stateRoot, "the state is the header state"
        );

        string memory genesisJson = vm.readFile(GENESIS_FIXTURE);
        out.genesisBranch = vm.parseJsonBytes32Array(genesisJson, ".branch");
        assertEq(out.genesisBranch.length, 5);
        assertEq(
            vm.parseJsonBytes32(genesisJson, ".stateRoot"), out.header.stateRoot, "the branch is over the same state"
        );
        out.genesisValidatorsRoot = vm.parseJsonBytes32(genesisJson, ".genesisValidatorsRoot");
        string memory chainJson = vm.readFile(SEPOLIA_GENESIS);
        assertEq(
            out.genesisValidatorsRoot,
            vm.parseJsonBytes32(chainJson, ".response.data.genesis_validators_root"),
            "the leaf is the genesis validators root that the Sepolia node reports"
        );
    }

    /// @dev Warps into the epoch of the real header, plants its root for the current time, and returns the evidence.
    function _evidenceFor(Real memory real, bytes4 version, bytes32[] memory branch, bytes32[] memory genesisBranch)
        internal
        returns (bytes memory)
    {
        _warpIntoEpoch(real.header.slot / 32, 0);
        _plant(block.timestamp, SSZ.hashTreeRootMemory(real.header));
        return _evidence(block.timestamp, real.header, version, branch, genesisBranch);
    }

    /// @dev A gate that follows the Sepolia beacon chain. It holds no version name.
    function _gloasGate(Real memory real) internal returns (BeaconForkGate) {
        return _gateFollowing(BeaconForkGate.GateMode.Enforcing, real.genesisValidatorsRoot);
    }

    /// Claim: the real Gloas evidence confirms the epoch on a gate with no Gloas name, and the event names the epoch and
    /// the version. Shows: the version branch (7 entries) verifies at 169 and not at 141, the genesis validators root
    /// branch (5 entries) verifies at node 40 against the same real state root, and `confirm` emits `ForkConfirmed`.
    /// Control: the same version branch with a branch of another length is refused (see the exactness test). Matters:
    /// index 141 on a true Gloas state lands in a different field, so only the progressive position can prove the
    /// version. The seven-entry ambiguity (plain depth 5 and Gloas) is settled on real data, with no name in the
    /// configuration.
    function test_realGloasEvidenceConfirms() public {
        Real memory real = _real();
        assertTrue(
            SSZ.isValidBranchMemory(bytes32(SEPOLIA_GLOAS), real.branch, 169, real.header.stateRoot),
            "the real version branch verifies at 169"
        );
        assertFalse(
            SSZ.isValidBranchMemory(bytes32(SEPOLIA_GLOAS), real.branch, 141, real.header.stateRoot),
            "the same branch fails at the plain depth 5 position"
        );
        assertTrue(
            SSZ.isValidBranchMemory(real.genesisValidatorsRoot, real.genesisBranch, 40, real.header.stateRoot),
            "the real genesis validators root branch verifies at node 40"
        );
        bytes memory evidence = _evidenceFor(real, SEPOLIA_GLOAS, real.branch, real.genesisBranch);
        BeaconForkGate gate = _gloasGate(real);
        vm.expectEmit(true, false, false, true, address(gate));
        emit BeaconForkGate.ForkConfirmed(real.header.slot / 32, SEPOLIA_GLOAS);
        gate.confirm(evidence);
        (uint64 epoch, bool exists) = gate.confirmedEpoch();
        assertTrue(exists);
        assertEq(epoch, real.header.slot / 32);
    }

    /// Claim: the real Gloas proof proves the CURRENT version only, with the exact branch. Shows: a claim of the previous
    /// version with the real branch, a flipped entry of the branch, and a branch cut to 6 entries or extended to 8 or 9
    /// entries are refused: `ForkProofInvalid` for the first two and for lengths 8 and 9 (a plain depth 6 or 7 position
    /// that the state does not hold), `ShapeNotAllowed(4)` for 6 entries and `ShapeNotAllowed(8)` for 10 entries.
    /// Control: the honest evidence passes. Matters: the length of the branch names the shape, and the hash decides.
    function test_realGloasEvidenceIsExact() public {
        Real memory real = _real();
        BeaconForkGate gate = _gloasGate(real);
        bytes memory previous = _evidenceFor(real, SEPOLIA_FULU, real.branch, real.genesisBranch);
        vm.expectRevert(BeaconForkGate.ForkProofInvalid.selector);
        gate.confirm(previous);

        bytes32[] memory flipped = _resize(real.branch, 7);
        flipped[3] = bytes32(uint256(flipped[3]) ^ 1);
        bytes memory flippedEvidence = _evidenceFor(real, SEPOLIA_GLOAS, flipped, real.genesisBranch);
        vm.expectRevert(BeaconForkGate.ForkProofInvalid.selector);
        gate.confirm(flippedEvidence);

        uint256[2] memory refusedByTheHash = [uint256(8), 9];
        for (uint256 i = 0; i < refusedByTheHash.length; i++) {
            bytes memory longer =
                _evidenceFor(real, SEPOLIA_GLOAS, _resize(real.branch, refusedByTheHash[i]), real.genesisBranch);
            vm.expectRevert(BeaconForkGate.ForkProofInvalid.selector);
            gate.confirm(longer);
        }
        uint256[2] memory refusedByTheShape = [uint256(6), 10];
        uint256[2] memory shapeDepth = [uint256(4), 8];
        for (uint256 i = 0; i < refusedByTheShape.length; i++) {
            bytes memory odd =
                _evidenceFor(real, SEPOLIA_GLOAS, _resize(real.branch, refusedByTheShape[i]), real.genesisBranch);
            vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ShapeNotAllowed.selector, shapeDepth[i]));
            gate.confirm(odd);
        }

        gate.confirm(_evidenceFor(real, SEPOLIA_GLOAS, real.branch, real.genesisBranch));
    }

    /// Claim: the real Gloas evidence must also bring the real genesis validators root branch. Shows: with the version
    /// branch honest, a genesis branch cut to 4 entries, extended to 6, and flipped in one entry each give
    /// `GenesisValidatorsRootBranchInvalid`, and a gate that follows another chain gives the same error for the honest
    /// branch. Control: the honest pair confirms. Matters: the genesis validators root pins the gate to the right
    /// chain and to the shape that the version proved.
    function test_realGloasEvidenceNeedsTheRealGenesisBranch() public {
        Real memory real = _real();
        bytes32[] memory flipped = _resize(real.genesisBranch, 5);
        flipped[2] = bytes32(uint256(flipped[2]) ^ 1);
        bytes32[][3] memory wrong = [_resize(real.genesisBranch, 4), _resize(real.genesisBranch, 6), flipped];
        for (uint256 i = 0; i < wrong.length; i++) {
            BeaconForkGate gate = _gloasGate(real);
            bytes memory evidence = _evidenceFor(real, SEPOLIA_GLOAS, real.branch, wrong[i]);
            vm.expectRevert(BeaconForkGate.GenesisValidatorsRootBranchInvalid.selector);
            gate.confirm(evidence);
        }
        BeaconForkGate foreign = _gateFollowing(BeaconForkGate.GateMode.Enforcing, GENESIS_ROOT_B);
        bytes memory honest = _evidenceFor(real, SEPOLIA_GLOAS, real.branch, real.genesisBranch);
        vm.expectRevert(BeaconForkGate.GenesisValidatorsRootBranchInvalid.selector);
        foreign.confirm(honest);

        _gloasGate(real).confirm(honest);
    }

    /// Claim: a valid Gloas proof never seals, because the progressive shape is allowed, and a forged plain depth 5
    /// branch at 169 does not seal either. Shows: `seal` with the real evidence reverts `ShapeIsAllowed(255)` and
    /// `isSealed` stays false. A forged branch (the two inner entries of a `Fork` container, then the five siblings of
    /// field 10 of a true depth 5 state) reverts `ForkProofInvalid`. Control: the honest plain depth 5 evidence is the
    /// allowed shape 5, so it is `ShapeIsAllowed(5)`. Matters: on a true depth 5 state, node 42 at depth 5 is state field
    /// 10, and a node below it is not a field of the tree. Passing would need a SHA-256 preimage. After Gloas the next
    /// fork is progressive too, and its shape is judged the same way.
    function test_progressiveSealRefusesTheAllowedShapeAndForgedProofs() public {
        Real memory real = _real();
        bytes memory evidence = _evidenceFor(real, SEPOLIA_GLOAS, real.branch, real.genesisBranch);
        BeaconForkGate gate = _gloasGate(real); // deployed at the epoch of the real header, so the header is not too old
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ShapeIsAllowed.selector, PROGRESSIVE_SHAPE));
        gate.seal(evidence);
        assertFalse(gate.isSealed());

        assertEq(SSZ.depthOf(169 >> 2), 5, "the parent of the Fork container leaf at 169 is node 42, at depth 5");
        bytes32[] memory forged = _forgedBelowAPlainField();
        bytes memory forgedEvidence = _evidenceFor(real, SEPOLIA_GLOAS, forged, real.genesisBranch);
        vm.expectRevert(BeaconForkGate.ForkProofInvalid.selector);
        gate.seal(forgedEvidence);
        assertFalse(gate.isSealed());

        StateTree memory plainFive = _stateTreeWithGenesis(5, UNKNOWN_FORK, ALTAIR, real.genesisValidatorsRoot);
        BeaconBlockHeader memory header = _header(real.header.slot + 1, plainFive.stateRoot);
        _plant(block.timestamp + 12, SSZ.hashTreeRootMemory(header));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ShapeIsAllowed.selector, uint8(5)));
        gate.seal(_evidenceOf(block.timestamp + 12, header, UNKNOWN_FORK, plainFive));
    }

    /// @dev Seven entries that claim to lead from a version leaf at 169 to the root of a true depth 5 state: two entries
    /// inside the `Fork` container, then the five siblings of state field 10.
    function _forgedBelowAPlainField() internal pure returns (bytes32[] memory forged) {
        uint256[] memory gindices = new uint256[](2);
        bytes32[] memory leaves = new bytes32[](2);
        gindices[0] = 32 + 10;
        leaves[0] = keccak256("field 10");
        gindices[1] = 32 + 11;
        leaves[1] = keccak256("field 11");
        (, bytes32[][] memory branches) = _gateSparseTree(gindices, leaves);
        forged = new bytes32[](7);
        forged[0] = keccak256("inside the Fork container 0");
        forged[1] = keccak256("inside the Fork container 1");
        for (uint256 i = 0; i < 5; i++) {
            forged[2 + i] = branches[0][i];
        }
    }

    /// Claim: the fixture of `lc-core` names the position 169 with 7 siblings, the same numbers as the gate. Matters: the
    /// Rust program and the Solidity gate read the version of the state at one shared position.
    function test_fixtureNamesThePosition() public view {
        string memory gindices = vm.readFile("light-client/tests/fixtures/gindices.json");
        assertEq(vm.parseJsonUint(gindices, ".gloas.forkVersionGindex"), ForkShape.versionGindex(PROGRESSIVE_SHAPE));
        assertEq(
            vm.parseJsonUint(gindices, ".gloas.forkVersionBranchLength"),
            ForkShape.versionBranchLength(PROGRESSIVE_SHAPE)
        );
    }
}
