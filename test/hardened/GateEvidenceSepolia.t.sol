// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {GateSupport} from "./utils/GateSupport.sol";

/// @notice The evidence that the TypeScript builder (`buildGateEvidence` of `@zkb/data`) made for one real Sepolia epoch,
/// fed byte for byte to the real gate. The file `fixtures/gate_evidence_sepolia.json` holds the latest block, the root
/// that the beacon roots contract returned for its time, and the `confirm` calldata, recorded read-only from public
/// endpoints by `explorer/data/scripts/capture-gate-fixture.mjs`. The genuine EIP-4788 code holds the root here, written
/// as the system address writes it, so the ring buffer is the real one.
contract GateEvidenceSepoliaTest is GateSupport {
    string internal constant FIXTURE = "test/hardened/fixtures/gate_evidence_sepolia.json";
    /// @dev The Sepolia beacon chain: genesis time and seconds per slot.
    uint64 internal constant SEPOLIA_GENESIS = 1_655_733_600;

    struct Recorded {
        uint256 timestamp;
        bytes32 beaconRoot;
        bytes32 genesisValidatorsRoot;
        uint256 epoch;
        bytes4 version;
        bytes calldata_;
        bytes encoded;
        BeaconBlockHeader header;
    }

    BeaconForkGate internal gate;
    Recorded internal recorded;

    function setUp() public override {
        super.setUp();
        string memory json = vm.readFile(FIXTURE);
        recorded.timestamp = vm.parseJsonUint(json, ".block.timestamp");
        recorded.beaconRoot = vm.parseJsonBytes32(json, ".beaconRootCall.answer");
        recorded.genesisValidatorsRoot = vm.parseJsonBytes32(json, ".reads.genesisValidatorsRoot");
        recorded.epoch = vm.parseJsonUint(json, ".expected.epoch");
        recorded.version = bytes4(vm.parseJsonBytes(json, ".expected.forkVersion"));
        recorded.calldata_ = vm.parseJsonBytes(json, ".expected.calldata");
        recorded.encoded = vm.parseJsonBytes(json, ".expected.encoded");
        recorded.header = BeaconBlockHeader({
            slot: uint64(vm.parseJsonUint(json, ".expected.header.slot")),
            proposerIndex: uint64(vm.parseJsonUint(json, ".expected.header.proposerIndex")),
            parentRoot: vm.parseJsonBytes32(json, ".expected.header.parentRoot"),
            stateRoot: vm.parseJsonBytes32(json, ".expected.header.stateRoot"),
            bodyRoot: vm.parseJsonBytes32(json, ".expected.header.bodyRoot")
        });
        assertEq(vm.parseJsonBytes32(json, ".block.parentBeaconBlockRoot"), recorded.beaconRoot, "the block names the root");

        // The block of the recorded time: the protocol writes its parent beacon block root into the genuine contract.
        vm.warp(recorded.timestamp);
        _etchGenuine();
        _setGenuine(recorded.beaconRoot);
        gate = new BeaconForkGate(
            BEACON_ROOTS, BeaconForkGate.GateMode.Enforcing, SEPOLIA_GENESIS, 12, 32, recorded.genesisValidatorsRoot, address(0)
        );
        // The confirmation lands in the next block.
        vm.warp(recorded.timestamp + 12);
    }

    function test_theRecordedHeaderHashesToTheRecordedRoot() public view {
        assertEq(SSZ.hashTreeRootMemory(recorded.header), recorded.beaconRoot);
        assertEq(recorded.header.slot / 32, recorded.epoch, "the header is in the epoch of the next block");
    }

    function test_theCalldataIsConfirmOfTheEncodedEvidence() public view {
        assertEq(recorded.calldata_, abi.encodeCall(BeaconForkGate.confirm, (recorded.encoded)));
        BeaconForkGate.ForkEvidence memory decoded = abi.decode(recorded.encoded, (BeaconForkGate.ForkEvidence));
        assertEq(decoded.timestamp, recorded.timestamp);
        assertEq(decoded.version, recorded.version);
        assertEq(decoded.branch.length, 7, "the progressive version branch");
        assertEq(decoded.genesisValidatorsRootBranch.length, 5, "the progressive genesis validators root branch");
    }

    function test_theRecordedCalldataConfirmsTheEpoch() public {
        vm.expectEmit(true, false, false, true, address(gate));
        emit BeaconForkGate.ForkConfirmed(recorded.epoch, recorded.version);
        (bool ok,) = address(gate).call(recorded.calldata_);
        assertTrue(ok, "confirm");
        (uint64 epoch, bool exists) = gate.confirmedEpoch();
        assertTrue(exists);
        assertEq(epoch, recorded.epoch);
        // A send in the epoch now passes with no evidence.
        gate.admit("");
    }

    function test_theConfirmationHoldsUntilTheEndOfTheEpoch() public {
        (bool ok,) = address(gate).call(recorded.calldata_);
        assertTrue(ok);
        vm.warp(SEPOLIA_GENESIS + (recorded.epoch + 1) * 32 * 12 - 1);
        gate.admit("");
        vm.warp(SEPOLIA_GENESIS + (recorded.epoch + 1) * 32 * 12);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, recorded.epoch + 1));
        gate.admit("");
    }

    function test_theEvidenceIsRefusedInTheNextEpoch() public {
        vm.warp(SEPOLIA_GENESIS + (recorded.epoch + 1) * 32 * 12);
        vm.expectRevert(
            abi.encodeWithSelector(BeaconForkGate.HeaderNotInCurrentEpoch.selector, recorded.epoch, recorded.epoch + 1)
        );
        gate.confirm(recorded.encoded);
    }

    function test_aTamperedVersionBranchIsRefused() public {
        BeaconForkGate.ForkEvidence memory evidence = abi.decode(recorded.encoded, (BeaconForkGate.ForkEvidence));
        evidence.branch[3] = bytes32(uint256(evidence.branch[3]) ^ 1);
        vm.expectRevert(_err(BeaconForkGate.ForkProofInvalid.selector));
        gate.confirm(abi.encode(evidence));
    }

    function test_aClaimOfAnotherVersionIsRefused() public {
        BeaconForkGate.ForkEvidence memory evidence = abi.decode(recorded.encoded, (BeaconForkGate.ForkEvidence));
        // The previous version of Sepolia (Fulu), at the position of the current one.
        evidence.version = 0x90000075;
        vm.expectRevert(_err(BeaconForkGate.ForkProofInvalid.selector));
        gate.confirm(abi.encode(evidence));
    }

    function test_aTamperedGenesisValidatorsRootBranchIsRefused() public {
        BeaconForkGate.ForkEvidence memory evidence = abi.decode(recorded.encoded, (BeaconForkGate.ForkEvidence));
        evidence.genesisValidatorsRootBranch[0] = bytes32(0);
        vm.expectRevert(_err(BeaconForkGate.GenesisValidatorsRootBranchInvalid.selector));
        gate.confirm(abi.encode(evidence));
    }

    function test_aTamperedHeaderIsRefused() public {
        BeaconForkGate.ForkEvidence memory evidence = abi.decode(recorded.encoded, (BeaconForkGate.ForkEvidence));
        evidence.header.proposerIndex += 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                BeaconForkGate.HeaderRootMismatch.selector, recorded.beaconRoot, SSZ.hashTreeRootMemory(evidence.header)
            )
        );
        gate.confirm(abi.encode(evidence));
    }

    function test_anotherTimestampIsRefused() public {
        BeaconForkGate.ForkEvidence memory evidence = abi.decode(recorded.encoded, (BeaconForkGate.ForkEvidence));
        evidence.timestamp += 12;
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.BeaconRootUnavailable.selector, evidence.timestamp));
        gate.confirm(abi.encode(evidence));
    }

    function test_aGateOfAnotherChainRefusesTheEvidence() public {
        BeaconForkGate other = new BeaconForkGate(
            BEACON_ROOTS, BeaconForkGate.GateMode.Enforcing, SEPOLIA_GENESIS, 12, 32, bytes32(uint256(1)), address(0)
        );
        vm.expectRevert(_err(BeaconForkGate.GenesisValidatorsRootBranchInvalid.selector));
        other.confirm(recorded.encoded);
    }

    /// @notice The gas of `confirm` with the recorded evidence, measured around the call in the test: it includes the cold
    /// accesses and the copy of 836 bytes of calldata. The node estimated 79,050 gas for the whole transaction on Sepolia
    /// (the `estimatedGas` of the fixture), base cost and calldata included. The bound catches a regression.
    function test_gasOfTheRecordedConfirmation() public {
        bytes memory encoded = recorded.encoded;
        uint256 before = gasleft();
        gate.confirm(encoded);
        uint256 used = before - gasleft();
        emit log_named_uint("confirm gas, around the call", used);
        assertLt(used, 100_000);
    }
}
