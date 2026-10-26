// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {GateSupport} from "./utils/GateSupport.sol";

/// @notice `BeaconForkGate` for a Gloas route. The Gloas `BeaconState` is a progressive container, so the version leaf sits
/// at the fixed index 169 (7 siblings) and not at `((2**depth + 3) * 4) + 1`. The gate marks such a layout with
/// `PROGRESSIVE_STATE_DEPTH` (255), in a supported version and in the seal depths. The evidence of most tests is REAL: the
/// finalized header of a Sepolia beacon node, the root of its real state (3.6 MB of SSZ, hashed by `lc-core`) and the branch
/// of its `fork.current_version` (0x90000076, Gloas; the previous version is 0x90000075, Fulu).
contract GloasGateTest is GateSupport {
    bytes4 internal constant SEPOLIA_FULU = 0x90000075;
    bytes4 internal constant SEPOLIA_GLOAS = 0x90000076;
    uint8 internal constant PROGRESSIVE = 255;
    string internal constant FIXTURE = "light-client/tests/fixtures/sepolia/gloas_fork_version.json";

    struct Real {
        BeaconBlockHeader header;
        bytes32[] branch;
    }

    function setUp() public override {
        super.setUp();
        _etchMock();
    }

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
        assertEq(vm.parseJsonBytes32(json, ".response.state_root"), out.header.stateRoot, "the state is the header state");
    }

    /// @dev Warps into the epoch of the real header, plants its root for the current time, and returns the evidence.
    function _evidenceFor(Real memory real, bytes4 version, bytes32[] memory branch) internal returns (bytes memory) {
        _warpIntoEpoch(real.header.slot / 32, 0);
        _plant(block.timestamp, SSZ.hashTreeRootMemory(real.header));
        return _evidence(block.timestamp, real.header, version, branch);
    }

    function _versions(bytes4 a, uint8 depthA, bytes4 b, uint8 depthB)
        internal
        pure
        returns (BeaconForkGate.SupportedVersion[] memory out)
    {
        out = new BeaconForkGate.SupportedVersion[](2);
        out[0] = BeaconForkGate.SupportedVersion(a, depthA);
        out[1] = BeaconForkGate.SupportedVersion(b, depthB);
    }

    function _gloasGate() internal returns (BeaconForkGate) {
        return _gateWith(
            BeaconForkGate.GateMode.Enforcing,
            _versions(SEPOLIA_FULU, 6, SEPOLIA_GLOAS, PROGRESSIVE),
            _depths(5, 6, 7, PROGRESSIVE)
        );
    }

    function _depths(uint8 a, uint8 b) internal pure returns (uint8[] memory out) {
        out = new uint8[](2);
        out[0] = a;
        out[1] = b;
    }

    function _depths(uint8 a, uint8 b, uint8 c, uint8 d) internal pure returns (uint8[] memory out) {
        out = new uint8[](4);
        out[0] = a;
        out[1] = b;
        out[2] = c;
        out[3] = d;
    }

    /// Claim: the real Gloas evidence confirms the epoch on a gate whose Gloas entry is progressive, and the event names
    /// the epoch and the version. Control: the same evidence is refused when the route lists Gloas with the plain depth 5
    /// (the branch length fits, the index 141 does not) and with depth 6 (the branch length does not fit). Matters: the
    /// gate takes the position from its configuration, never from the caller.
    function test_realGloasEvidenceConfirms() public {
        Real memory real = _real();
        bytes memory evidence = _evidenceFor(real, SEPOLIA_GLOAS, real.branch);
        BeaconForkGate gate = _gloasGate();
        vm.expectEmit(true, false, false, true, address(gate));
        emit BeaconForkGate.ForkConfirmed(real.header.slot / 32, SEPOLIA_GLOAS);
        gate.confirm(evidence);
        (uint64 epoch, bool exists) = gate.confirmedEpoch();
        assertTrue(exists);
        assertEq(epoch, real.header.slot / 32);

        BeaconForkGate plainFive = _gateWith(
            BeaconForkGate.GateMode.Enforcing, _oneVersion(SEPOLIA_GLOAS, 5), _depths(5, 6, 7, PROGRESSIVE)
        );
        vm.expectRevert(BeaconForkGate.ForkProofInvalid.selector);
        plainFive.confirm(evidence);
        BeaconForkGate plainSix = _gateWith(
            BeaconForkGate.GateMode.Enforcing, _oneVersion(SEPOLIA_GLOAS, 6), _depths(5, 6, 7, PROGRESSIVE)
        );
        vm.expectRevert(abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, 8, 7));
        plainSix.confirm(evidence);
    }

    /// Claim: the progressive proof proves the CURRENT version only. A claim of the previous version with the real branch,
    /// a flipped entry of the branch, and a branch of another length are refused. Control: the honest evidence passes.
    function test_realGloasEvidenceIsExact() public {
        Real memory real = _real();
        BeaconForkGate gate = _gateWith(
            BeaconForkGate.GateMode.Enforcing,
            _versions(SEPOLIA_FULU, PROGRESSIVE, SEPOLIA_GLOAS, PROGRESSIVE),
            _depths(5, 6, 7, PROGRESSIVE)
        );
        bytes memory previous = _evidenceFor(real, SEPOLIA_FULU, real.branch);
        vm.expectRevert(BeaconForkGate.ForkProofInvalid.selector);
        gate.confirm(previous);

        bytes32[] memory flipped = _resize(real.branch, 7);
        flipped[3] = bytes32(uint256(flipped[3]) ^ 1);
        bytes memory flippedEvidence = _evidenceFor(real, SEPOLIA_GLOAS, flipped);
        vm.expectRevert(BeaconForkGate.ForkProofInvalid.selector);
        gate.confirm(flippedEvidence);

        bytes memory longer = _evidenceFor(real, SEPOLIA_GLOAS, _resize(real.branch, 8));
        vm.expectRevert(abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, 7, 8));
        gate.confirm(longer);

        gate.confirm(_evidenceFor(real, SEPOLIA_GLOAS, real.branch));
    }

    /// Claim: a seal needs the progressive marker in the seal depths to accept a branch of a progressive state. Shows: the
    /// real Gloas evidence seals a gate that does not list Gloas and lists 255; with the seal depths 5, 6 and 7
    /// the plain index is tried and fails with `ForkProofInvalid`; with only 6 and 7 it reverts `SealDepthNotAllowed(5)`. A gate that lists Gloas as supported
    /// refuses to seal on it. Matters: after Gloas the next fork is progressive too, and the gate must be able to seal on it.
    function test_progressiveSeal() public {
        Real memory real = _real();
        bytes memory evidence = _evidenceFor(real, SEPOLIA_GLOAS, real.branch);

        BeaconForkGate fulu = _gateWith(BeaconForkGate.GateMode.Enforcing, _oneVersion(SEPOLIA_FULU, 6), _depths(5, 6, 7, PROGRESSIVE));
        vm.expectEmit(false, false, false, true, address(fulu));
        emit BeaconForkGate.GateSealedByFork(SEPOLIA_GLOAS, real.header.slot);
        fulu.seal(evidence);
        assertTrue(fulu.isSealed());

        BeaconForkGate plainOnly = _gateWith(BeaconForkGate.GateMode.Enforcing, _oneVersion(SEPOLIA_FULU, 6), _depths(5, 6, 7));
        vm.expectRevert(BeaconForkGate.ForkProofInvalid.selector);
        plainOnly.seal(evidence);

        BeaconForkGate sixSeven = _gateWith(BeaconForkGate.GateMode.Enforcing, _oneVersion(SEPOLIA_FULU, 6), _depths(6, 7));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.SealDepthNotAllowed.selector, 5));
        sixSeven.seal(evidence);

        BeaconForkGate progressiveOnly =
            _gateWith(BeaconForkGate.GateMode.Enforcing, _oneVersion(SEPOLIA_FULU, 6), _depths(PROGRESSIVE));
        progressiveOnly.seal(evidence);
        assertTrue(progressiveOnly.isSealed());

        BeaconForkGate supported = _gloasGate();
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.VersionIsSupported.selector, SEPOLIA_GLOAS));
        supported.seal(evidence);
    }

    /// Claim: a seal with the progressive marker refuses a forged branch, and a gate that allows only the marker still
    /// refuses a plain depth 5 proof (the index 169 does not fit it). A gate with both marker and depth 5 seals on a plain
    /// depth 5 proof. Matters: trying the progressive index too opens no new proof of an unsupported version.
    function test_progressiveSealRefusesForgedAndPlainProofs() public {
        Real memory real = _real();
        bytes32[] memory forged = _resize(real.branch, 7);
        forged[6] = bytes32(uint256(forged[6]) ^ 1);
        bytes memory forgedEvidence = _evidenceFor(real, SEPOLIA_GLOAS, forged);
        BeaconForkGate gate = _gateWith(BeaconForkGate.GateMode.Enforcing, _oneVersion(SEPOLIA_FULU, 6), _depths(5, PROGRESSIVE));
        vm.expectRevert(BeaconForkGate.ForkProofInvalid.selector);
        gate.seal(forgedEvidence);

        BeaconForkGate onlyMarker =
            _gateWith(BeaconForkGate.GateMode.Enforcing, _oneVersion(SEPOLIA_FULU, 6), _depths(PROGRESSIVE));
        bytes memory plainFive = _honestEvidence(block.timestamp + 12, uint64(real.header.slot + 1), 5, UNKNOWN_FORK);
        vm.expectRevert(BeaconForkGate.ForkProofInvalid.selector);
        onlyMarker.seal(plainFive);

        gate.seal(plainFive);
        assertTrue(gate.isSealed(), "depth 5 and the marker: the plain proof seals");
    }

    /// Claim: the configuration accepts the marker 255 and still refuses 0 and every other value above 31, for a version and
    /// for a seal depth. The getters return the marker, last in the seal depths. Matters: the sentinel opens one value.
    function test_configurationAcceptsOnlyTheMarkerAbove31() public {
        uint8[3] memory refused = [uint8(0), 32, 254];
        for (uint256 i = 0; i < refused.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.StateDepthOutOfRange.selector, refused[i]));
            _gateWith(BeaconForkGate.GateMode.Enforcing, _oneVersion(SEPOLIA_GLOAS, refused[i]), _depths(5));
            vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.StateDepthOutOfRange.selector, refused[i]));
            _gateWith(BeaconForkGate.GateMode.Enforcing, _oneVersion(SEPOLIA_GLOAS, 5), _depths(refused[i]));
        }
        BeaconForkGate gate = _gloasGate();
        assertEq(gate.PROGRESSIVE_STATE_DEPTH(), PROGRESSIVE);
        BeaconForkGate.SupportedVersion[] memory back = gate.supportedVersions();
        assertEq(back[0].stateDepth, 6);
        assertEq(back[1].stateDepth, PROGRESSIVE);
        assertEq(back[1].version, SEPOLIA_GLOAS);
        uint8[] memory depths = gate.sealDepths();
        assertEq(depths.length, 4);
        assertEq(depths[3], PROGRESSIVE);
    }

    /// Claim: the fixture of `lc-core` names the position 169 with 7 siblings, the same numbers as the gate.
    function test_fixtureNamesThePosition() public view {
        string memory gindices = vm.readFile("light-client/tests/fixtures/gindices.json");
        assertEq(vm.parseJsonUint(gindices, ".gloas.forkVersionGindex"), 169);
        assertEq(vm.parseJsonUint(gindices, ".gloas.forkVersionBranchLength"), 7);
    }
}
