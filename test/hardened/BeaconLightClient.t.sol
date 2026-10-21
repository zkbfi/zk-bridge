// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {OracleSP1Verifier} from "../../src/mocks/OracleSP1Verifier.sol";
import {LightClientSync} from "../../src/LightClientSync.sol";
import {Committee} from "../utils/Committee.sol";
import {HardenedFixture} from "./utils/HardenedFixture.sol";

/// @notice Tests of the hardened light client: constructor, every revert path of `update`,
/// forward-only head, continuity, committee rotation, cross-chain replay, proof soundness, gas.
contract BeaconLightClientTest is HardenedFixture {
    BeaconLightClient internal client;

    event HeadUpdated(uint64 indexed slot, bytes32 indexed headerRoot, bytes32 indexed executionBlockHash);

    function setUp() public override {
        super.setUp();
        client = lightClientForB;
    }

    // ================================================================ constructor

    function _construct(
        address verifier_,
        bytes32 programVKey,
        bytes32 genesisRoot,
        uint64 slotsPerPeriod,
        uint64 slot,
        bytes32 headerRoot,
        bytes32 committee
    ) internal returns (BeaconLightClient) {
        return new BeaconLightClient(
            verifier_, programVKey, genesisRoot, slotsPerPeriod, slot, headerRoot, committee, COMMITTEE_101, SLOTS_PER_HISTORICAL_ROOT
        );
    }

    /// Claim: the checkpoint is the only trust assumption. Shows: the constructor stores exactly the
    /// checkpoint. Matters: a wrong stored value would anchor the light client on a wrong chain.
    /// H-01 / R2-09.
    function test_R2_09_constructor_storesCheckpoint() public view {
        assertEq(client.head(), INITIAL_SLOT);
        assertEq(client.headers(INITIAL_SLOT), INITIAL_HEADER_ROOT);
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD), COMMITTEE_100);
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD + 1), COMMITTEE_101);
        assertEq(client.genesisValidatorsRoot(), GENESIS_ROOT_A, "bound to chain A");
        assertEq(client.programVKey(), LIGHT_CLIENT_VKEY);
        assertEq(address(client.verifier()), address(verifier));
        assertEq(client.slotsPerPeriod(), SLOTS_PER_PERIOD);
        assertEq(client.periodOf(INITIAL_SLOT), CHECKPOINT_PERIOD);
    }

    /// Claim: a zero verifier would make every update fail or pass silently. Shows: it is refused at construction.
    /// Matters: a bad deployment must fail fast, not lock a bridge. H-04.
    function test_H04_constructor_revertsOnZeroVerifier() public {
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.ZeroValue.selector, "verifier"));
        _construct(address(0), LIGHT_CLIENT_VKEY, GENESIS_ROOT_A, SLOTS_PER_PERIOD, INITIAL_SLOT, INITIAL_HEADER_ROOT, COMMITTEE_100);
    }

    /// Claim: a zero program key accepts proofs of no program. Shows: refused. Matters: H-04 (what the proof proves).
    function test_H04_constructor_revertsOnZeroProgramKey() public {
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.ZeroValue.selector, "programVKey"));
        _construct(address(verifier), bytes32(0), GENESIS_ROOT_A, SLOTS_PER_PERIOD, INITIAL_SLOT, INITIAL_HEADER_ROOT, COMMITTEE_100);
    }

    /// Claim: a zero genesis validators root removes the chain binding. Shows: refused. Matters: R2-09 and H-01.
    function test_R2_09_constructor_revertsOnZeroGenesisRoot() public {
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.ZeroValue.selector, "genesisValidatorsRoot"));
        _construct(address(verifier), LIGHT_CLIENT_VKEY, bytes32(0), SLOTS_PER_PERIOD, INITIAL_SLOT, INITIAL_HEADER_ROOT, COMMITTEE_100);
    }

    /// Claim: zero slots per period would divide by zero in every update. Shows: refused. Matters: fail fast.
    function test_H08_constructor_revertsOnZeroSlotsPerPeriod() public {
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.ZeroValue.selector, "slotsPerPeriod"));
        _construct(address(verifier), LIGHT_CLIENT_VKEY, GENESIS_ROOT_A, 0, INITIAL_SLOT, INITIAL_HEADER_ROOT, COMMITTEE_100);
    }

    /// Claim: slot zero is genesis and never a real checkpoint. Shows: refused. Matters: an unset slot stays visible.
    function test_H08_constructor_revertsOnZeroInitialSlot() public {
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.ZeroValue.selector, "initialSlot"));
        _construct(address(verifier), LIGHT_CLIENT_VKEY, GENESIS_ROOT_A, SLOTS_PER_PERIOD, 0, INITIAL_HEADER_ROOT, COMMITTEE_100);
    }

    /// Claim: a zero header root cannot anchor continuity. Shows: refused. Matters: H-08.
    function test_H08_constructor_revertsOnZeroHeaderRoot() public {
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.ZeroValue.selector, "initialHeaderRoot"));
        _construct(address(verifier), LIGHT_CLIENT_VKEY, GENESIS_ROOT_A, SLOTS_PER_PERIOD, INITIAL_SLOT, bytes32(0), COMMITTEE_100);
    }

    /// Claim: a zero committee hash cannot anchor committee continuity. Shows: refused. Matters: H-04.
    function test_H04_constructor_revertsOnZeroCommittee() public {
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.ZeroValue.selector, "initialSyncCommitteeHash"));
        _construct(address(verifier), LIGHT_CLIENT_VKEY, GENESIS_ROOT_A, SLOTS_PER_PERIOD, INITIAL_SLOT, INITIAL_HEADER_ROOT, bytes32(0));
    }

    /// Claim: the next committee may be unknown at the checkpoint. Shows: a zero next committee is accepted.
    /// Matters: the honest path stays open when the checkpoint has no next committee yet.
    function test_H04_constructor_allowsZeroNextCommittee() public {
        BeaconLightClient other = new BeaconLightClient(
            address(verifier), LIGHT_CLIENT_VKEY, GENESIS_ROOT_A, SLOTS_PER_PERIOD, INITIAL_SLOT, INITIAL_HEADER_ROOT, COMMITTEE_100, bytes32(0), SLOTS_PER_HISTORICAL_ROOT
        );
        assertEq(other.syncCommittees(CHECKPOINT_PERIOD + 1), bytes32(0));
    }

    // ================================================================ honest update

    /// Claim: an honest update moves the head, stores the header, marks the block finalized, emits the event.
    /// Shows: all four effects. Matters: H-08 (the vault trusts exactly this mark).
    function test_H08_update_honestPathStoresFinalizedBlock() public {
        bytes32 blockHash = keccak256("execution block 1");
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, blockHash);
        assertFalse(client.isFinalizedExecutionBlock(blockHash), "not finalized before the update");

        bytes memory proof = _lightClientProof(output);
        vm.expectEmit(true, true, true, true, address(client));
        emit HeadUpdated(output.newHeadSlot, output.newHeaderRoot, blockHash);
        client.update(proof, abi.encode(output));

        assertEq(client.head(), output.newHeadSlot);
        assertEq(client.headers(output.newHeadSlot), output.newHeaderRoot);
        assertEq(client.executionBlockHashes(output.newHeadSlot), blockHash, "the vault layout check reads this");
        assertTrue(client.isFinalizedExecutionBlock(blockHash));
        assertEq(client.executionBlockNumber(blockHash), output.executionBlockNumber);
    }

    /// Claim: only blocks that an update named are finalized. Shows: an arbitrary hash is not, and its number is zero.
    /// Matters: H-08 (no default-true).
    function test_H08_isFinalizedExecutionBlock_falseForUnknownHash() public view {
        assertFalse(client.isFinalizedExecutionBlock(keccak256("never attested")));
        assertEq(client.executionBlockNumber(keccak256("never attested")), 0);
    }

    /// Claim: several updates in one period all work (the revision-1 contract locked a period, H-07). Shows: 5 in a row.
    /// Matters: later deposits do not wait for the next period.
    function test_H08_update_manyUpdatesInOnePeriod() public {
        for (uint256 i = 1; i <= 5; i++) {
            _finalize(client, GENESIS_ROOT_A, keccak256(abi.encode("block", i)));
        }
        assertEq(client.head(), INITIAL_SLOT + 5 * 32);
        assertTrue(client.isFinalizedExecutionBlock(keccak256(abi.encode("block", uint256(3)))));
    }

    // ================================================================ revert paths

    /// Claim: public values of the wrong length are not decoded. Shows: short and long values revert with the length.
    /// Matters: no trailing bytes can ride along with a signed statement. H-04.
    function test_H04_update_revertsOnWrongLength() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        bytes memory values = abi.encode(output);
        bytes memory proof = _lightClientProof(output);

        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.InvalidPublicValuesLength.selector, 0));
        client.update(proof, "");

        bytes memory longer = bytes.concat(values, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.InvalidPublicValuesLength.selector, 352));
        client.update(proof, longer);

        client.update(proof, values); // honest path
        assertEq(client.head(), output.newHeadSlot);
    }

    /// Claim: an output for another chain is refused (cross-chain replay). Shows: a statement with chain B's
    /// genesis validators root, signed by the oracle, fails on the chain A client and passes on the chain B client.
    /// Matters: R2-09 and H-01. In revision 2 one signed update was valid on every client that shared the committee.
    function test_R2_09_update_revertsOnOtherGenesisValidatorsRoot() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_B, keccak256("b"));
        bytes memory proof = _lightClientProof(output);
        bytes memory values = abi.encode(output);

        vm.expectRevert(
            abi.encodeWithSelector(BeaconLightClient.GenesisValidatorsRootMismatch.selector, GENESIS_ROOT_A, GENESIS_ROOT_B)
        );
        client.update(proof, values);

        // Honest path: the very same bytes work on the client that tracks chain B.
        lightClientForA.update(proof, values);
        assertEq(lightClientForA.head(), output.newHeadSlot);
    }

    /// Claim: cross-chain replay of a whole signed update fails in both directions. Shows: the update signed for
    /// chain A does not move the chain B client. Matters: H-01 (one signed update must not install state elsewhere).
    function test_H01_update_signedUpdateDoesNotReplayOnTheOtherChain() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        bytes memory proof = _lightClientProof(output);
        bytes memory values = abi.encode(output);

        vm.expectRevert(
            abi.encodeWithSelector(BeaconLightClient.GenesisValidatorsRootMismatch.selector, GENESIS_ROOT_B, GENESIS_ROOT_A)
        );
        lightClientForA.update(proof, values);
        assertEq(lightClientForA.head(), INITIAL_SLOT, "the other client did not move");

        client.update(proof, values); // honest path
        assertEq(client.head(), output.newHeadSlot);
    }

    /// Claim: the output must build on the stored head slot. Shows: a stale or future previous slot reverts.
    /// Matters: H-08 (the head moves forward only, along one chain of headers).
    function test_H08_update_revertsOnWrongPreviousHeadSlot() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        output.previousHeadSlot = INITIAL_SLOT - 1;
        _submitExpectingRevert(
            client,
            output,
            abi.encodeWithSelector(BeaconLightClient.PreviousHeadSlotMismatch.selector, INITIAL_SLOT, INITIAL_SLOT - 1)
        );

        output.previousHeadSlot = INITIAL_SLOT;
        _submit(client, output); // honest path
        assertEq(client.head(), output.newHeadSlot);
    }

    /// Claim: header continuity. The output must build on the stored header root, even when the proof is valid.
    /// Shows: a signed output with another previous root reverts. Matters: H-08 and H-01 (a fork cannot be spliced in).
    function test_H08_update_revertsOnWrongPreviousHeaderRoot() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        output.previousHeaderRoot = keccak256("a header of a forked chain");
        _submitExpectingRevert(client, output, 
            abi.encodeWithSelector(
                BeaconLightClient.PreviousHeaderRootMismatch.selector, INITIAL_HEADER_ROOT, output.previousHeaderRoot
            )
        );

        output.previousHeaderRoot = INITIAL_HEADER_ROOT;
        _submit(client, output); // honest path
        assertEq(client.head(), output.newHeadSlot);
    }

    /// Claim: committee continuity. The output must build on the stored committee. Shows: another previous committee
    /// reverts. Matters: H-01 (nobody can swap the committee that signs the next step) and H-04.
    function test_H01_update_revertsOnWrongPreviousCommittee() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        output.previousSyncCommitteeHash = keccak256("attacker committee");
        _submitExpectingRevert(client, output, 
            abi.encodeWithSelector(
                BeaconLightClient.PreviousSyncCommitteeMismatch.selector, COMMITTEE_100, output.previousSyncCommitteeHash
            )
        );

        output.previousSyncCommitteeHash = COMMITTEE_100;
        _submit(client, output); // honest path
        assertEq(client.head(), output.newHeadSlot);
    }

    /// Claim: the head moves forward only. Shows: the same slot and an older slot revert with `HeadNotAdvancing`.
    /// Matters: H-08 (a replayed old finalized header cannot roll back the head).
    function test_H08_update_revertsWhenHeadDoesNotAdvance() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        output.newHeadSlot = INITIAL_SLOT;
        _submitExpectingRevert(client, output, abi.encodeWithSelector(BeaconLightClient.HeadNotAdvancing.selector, INITIAL_SLOT, INITIAL_SLOT));

        output.newHeadSlot = INITIAL_SLOT - 10;
        _submitExpectingRevert(client, output, abi.encodeWithSelector(BeaconLightClient.HeadNotAdvancing.selector, INITIAL_SLOT, INITIAL_SLOT - 10));

        output.newHeadSlot = INITIAL_SLOT + 1;
        _submit(client, output); // honest path
        assertEq(client.head(), INITIAL_SLOT + 1);
    }

    /// Claim: after a successful update the old output is dead. Shows: replaying it reverts with the previous-slot
    /// check, and an output built on the old head cannot move the head backward. Matters: H-08.
    function test_H08_update_replayedOutputIsRejected() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        bytes memory proof = _lightClientProof(output);
        bytes memory values = abi.encode(output);
        client.update(proof, values);

        vm.expectRevert(
            abi.encodeWithSelector(BeaconLightClient.PreviousHeadSlotMismatch.selector, output.newHeadSlot, INITIAL_SLOT)
        );
        client.update(proof, values);
        assertEq(client.head(), output.newHeadSlot);
    }

    /// Claim: a head moves at most `slotsPerHistoricalRoot` (8192) slots, so every deposit block stays inside the
    /// `state.block_roots` window of some stored anchor. Shows: a jump of exactly 8192 succeeds, 8193 reverts with
    /// `HeadJumpTooLarge`, and a jump of two periods reverts too. Matters: without the bound anyone could post
    /// maximal-skip updates and strand deposits that no stored anchor reaches.
    function test_H08_update_jumpOfExactlyWindowSucceedsAndOneMoreReverts() public {
        uint64 window = client.slotsPerHistoricalRoot();
        assertEq(window, 8192);
        BeaconLightClient.LightClientOutput memory tooFar =
            _outputAt(client, GENESIS_ROOT_A, INITIAL_SLOT + window + 1, keccak256("too far"));
        _submitExpectingRevert(
            client, tooFar, abi.encodeWithSelector(BeaconLightClient.HeadJumpTooLarge.selector, INITIAL_SLOT, INITIAL_SLOT + window + 1)
        );

        BeaconLightClient.LightClientOutput memory twoPeriods =
            _outputAt(client, GENESIS_ROOT_A, INITIAL_SLOT + 2 * SLOTS_PER_PERIOD, keccak256("two periods"));
        twoPeriods.syncCommitteeHash = COMMITTEE_102;
        _submitExpectingRevert(
            client, twoPeriods, abi.encodeWithSelector(BeaconLightClient.HeadJumpTooLarge.selector, INITIAL_SLOT, INITIAL_SLOT + 2 * SLOTS_PER_PERIOD)
        );

        _submit(client, _outputAt(client, GENESIS_ROOT_A, INITIAL_SLOT + window, keccak256("exact"))); // honest path
        assertEq(client.head(), INITIAL_SLOT + window);
        assertEq(client.periodOf(client.head()), CHECKPOINT_PERIOD + 1, "an exact jump crosses one boundary");
    }

    /// Claim: the committee check still guards a maximal jump that crosses a boundary. Shows: the stored next
    /// committee is required at the crossing. Matters: H-01 (the jump bound replaced the period rule, not the
    /// committee continuity).
    function test_H01_update_maximalJumpAcrossBoundaryKeepsCommitteeContinuity() public {
        BeaconLightClient.LightClientOutput memory output =
            _outputAt(client, GENESIS_ROOT_A, INITIAL_SLOT + SLOTS_PER_HISTORICAL_ROOT, keccak256("exact"));
        output.syncCommitteeHash = keccak256("attacker committee");
        _submitExpectingRevert(
            client, output, abi.encodeWithSelector(BeaconLightClient.SyncCommitteeMismatch.selector, COMMITTEE_101, output.syncCommitteeHash)
        );
        output.syncCommitteeHash = COMMITTEE_101;
        _submit(client, output); // honest path
    }

    /// Claim: the window must not exceed a period, because a longer jump could skip a committee. Shows: the
    /// constructor errors for zero and for a window larger than the period. Matters: H-04 / H-08.
    function test_H08_constructor_validatesHistoricalRootWindow() public {
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.ZeroValue.selector, "slotsPerHistoricalRoot"));
        new BeaconLightClient(address(verifier), LIGHT_CLIENT_VKEY, GENESIS_ROOT_A, SLOTS_PER_PERIOD, INITIAL_SLOT, INITIAL_HEADER_ROOT, COMMITTEE_100, COMMITTEE_101, 0);
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.HistoricalRootWindowTooLarge.selector, uint64(8193), SLOTS_PER_PERIOD));
        new BeaconLightClient(address(verifier), LIGHT_CLIENT_VKEY, GENESIS_ROOT_A, SLOTS_PER_PERIOD, INITIAL_SLOT, INITIAL_HEADER_ROOT, COMMITTEE_100, COMMITTEE_101, 8193);
        BeaconLightClient small = new BeaconLightClient(address(verifier), LIGHT_CLIENT_VKEY, GENESIS_ROOT_A, SLOTS_PER_PERIOD, INITIAL_SLOT, INITIAL_HEADER_ROOT, COMMITTEE_100, COMMITTEE_101, 64);
        assertEq(small.slotsPerHistoricalRoot(), 64);
    }

    /// Claim: every past head stays stored, because withdrawals use it as an anchor. Shows: after several updates all
    /// earlier header roots and execution block hashes are still there. Matters: H-08.
    function test_H08_update_pastHeadsStayStored() public {
        bytes32[] memory roots = new bytes32[](4);
        uint64[] memory slots = new uint64[](4);
        for (uint256 i = 0; i < 4; i++) {
            BeaconLightClient.LightClientOutput memory output =
                _nextOutput(client, GENESIS_ROOT_A, keccak256(abi.encode("block", i)));
            roots[i] = output.newHeaderRoot;
            slots[i] = output.newHeadSlot;
            _submit(client, output);
        }
        for (uint256 i = 0; i < 4; i++) {
            assertEq(client.headers(slots[i]), roots[i]);
            assertTrue(client.isFinalizedExecutionBlock(keccak256(abi.encode("block", i))));
        }
        assertEq(client.headers(INITIAL_SLOT), INITIAL_HEADER_ROOT);
    }

    /// Claim: a zero committee hash is refused. Shows: zero reverts as a mismatch with the stored committee. Matters:
    /// a zero hash must never read as "no committee, accept anything".
    function test_H04_update_revertsOnEmptyCommittee() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        output.syncCommitteeHash = bytes32(0);
        _submitExpectingRevert(
            client, output, abi.encodeWithSelector(BeaconLightClient.SyncCommitteeMismatch.selector, COMMITTEE_100, bytes32(0))
        );
    }

    /// Claim: an empty header root is refused. Shows: zero reverts. Matters: the next update must build on a real root.
    function test_H08_update_revertsOnEmptyHeaderRoot() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        output.newHeaderRoot = bytes32(0);
        _submitExpectingRevert(client, output, _selector(BeaconLightClient.EmptyHeaderRoot.selector));
    }

    /// Claim: a zero execution block hash is refused. Shows: zero reverts. Matters: the vault never accepts a zero hash.
    function test_H08_update_revertsOnEmptyExecutionBlockHash() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, bytes32(0));
        _submitExpectingRevert(client, output, _selector(BeaconLightClient.EmptyExecutionBlockHash.selector));
        assertFalse(client.isFinalizedExecutionBlock(bytes32(0)));
    }

    /// Claim: the committee of the head period cannot change inside the period. Shows: another committee hash for
    /// the same period reverts. Matters: H-01 (committee hijack).
    function test_H01_update_revertsOnCommitteeChangeInsidePeriod() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        output.syncCommitteeHash = keccak256("attacker committee");
        _submitExpectingRevert(client, output, 
            abi.encodeWithSelector(BeaconLightClient.SyncCommitteeMismatch.selector, COMMITTEE_100, output.syncCommitteeHash)
        );

        output.syncCommitteeHash = COMMITTEE_100;
        _submit(client, output); // honest path
    }

    /// Claim: committee continuity across a boundary. The new period's committee must equal the stored next
    /// committee. Shows: an attacker committee for period 101 reverts. Matters: H-01 (the revision-2 hijack of the
    /// committee at a rotation).
    function test_H01_update_revertsOnWrongCommitteeAtRotation() public {
        uint64 slot = (CHECKPOINT_PERIOD + 1) * SLOTS_PER_PERIOD + 3;
        BeaconLightClient.LightClientOutput memory output = _outputAt(client, GENESIS_ROOT_A, slot, keccak256("b"));
        output.syncCommitteeHash = keccak256("attacker committee");
        _submitExpectingRevert(client, output, 
            abi.encodeWithSelector(BeaconLightClient.SyncCommitteeMismatch.selector, COMMITTEE_101, output.syncCommitteeHash)
        );

        output.syncCommitteeHash = COMMITTEE_101;
        _submit(client, output); // honest path
        assertEq(client.head(), slot);
    }

    /// Claim: a stored next committee cannot be replaced. Shows: a different next committee hash reverts.
    /// Matters: H-01 (the attacker cannot install the committee for the period after next).
    function test_H01_update_revertsOnNextCommitteeChange() public {
        uint64 slot = (CHECKPOINT_PERIOD + 1) * SLOTS_PER_PERIOD + 3;
        // First honest crossing stores committee 102 as the next committee of period 101.
        BeaconLightClient.LightClientOutput memory crossing = _outputAt(client, GENESIS_ROOT_A, slot, keccak256("b"));
        crossing.nextSyncCommitteeHash = COMMITTEE_102;
        _submit(client, crossing);
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD + 2), COMMITTEE_102);

        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b2"));
        output.nextSyncCommitteeHash = keccak256("attacker next committee");
        _submitExpectingRevert(client, output, 
            abi.encodeWithSelector(
                BeaconLightClient.NextSyncCommitteeMismatch.selector, COMMITTEE_102, output.nextSyncCommitteeHash
            )
        );

        output.nextSyncCommitteeHash = COMMITTEE_102;
        _submit(client, output); // honest path
    }

    // ================================================================ committee rotation

    /// Claim: the client rotates committees across a period boundary and keeps going in the new period.
    /// Shows: after the crossing, the head period is 101, the stored committee for 102 is the new next committee,
    /// and an output that still names committee 100 as previous is rejected. Matters: H-08 / H-04 (liveness over
    /// many periods with no trusted party).
    function test_H08_update_committeeRotationAcrossPeriodBoundary() public {
        uint64 slot = (CHECKPOINT_PERIOD + 1) * SLOTS_PER_PERIOD + 3;
        BeaconLightClient.LightClientOutput memory crossing = _outputAt(client, GENESIS_ROOT_A, slot, keccak256("cross"));
        crossing.nextSyncCommitteeHash = COMMITTEE_102;
        _submit(client, crossing);

        assertEq(client.periodOf(client.head()), CHECKPOINT_PERIOD + 1);
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD + 1), COMMITTEE_101);
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD + 2), COMMITTEE_102);

        // The next update must name committee 101 as previous.
        BeaconLightClient.LightClientOutput memory stale = _nextOutput(client, GENESIS_ROOT_A, keccak256("after"));
        stale.previousSyncCommitteeHash = COMMITTEE_100;
        _submitExpectingRevert(client, stale, 
            abi.encodeWithSelector(BeaconLightClient.PreviousSyncCommitteeMismatch.selector, COMMITTEE_101, COMMITTEE_100)
        );

        _finalize(client, GENESIS_ROOT_A, keccak256("after")); // honest path
        // And the rotation continues into period 102.
        uint64 nextPeriodSlot = (CHECKPOINT_PERIOD + 2) * SLOTS_PER_PERIOD + 1;
        _submit(client, _outputAt(client, GENESIS_ROOT_A, nextPeriodSlot, keccak256("cross again")));
        assertEq(client.periodOf(client.head()), CHECKPOINT_PERIOD + 2);
    }

    /// A light client whose checkpoint has no next committee. The attack tests below start from it.
    function _clientWithoutNextCommittee() internal returns (BeaconLightClient) {
        return new BeaconLightClient(
            address(verifier), LIGHT_CLIENT_VKEY, GENESIS_ROOT_A, SLOTS_PER_PERIOD, INITIAL_SLOT, INITIAL_HEADER_ROOT, COMMITTEE_100, bytes32(0), SLOTS_PER_HISTORICAL_ROOT
        );
    }

    /// Claim (path a of the forged next committee): with an empty next slot, an update that crosses into the next
    /// period with a committee hash of the attacker's choice is refused. Shows: the crossing reverts with
    /// `NextSyncCommitteeUnknown`, and the slot stays empty. Matters: the program takes the next committee as private
    /// input, so a caller could sign a forged head with keys they hold. The contract never fills an empty slot from the
    /// output. Before this fix the contract stored the attacker's hash and accepted the forged head.
    function test_H01_update_crossingIntoEmptyNextSlotRevertsWithAttackerCommittee() public {
        BeaconLightClient bare = _clientWithoutNextCommittee();
        uint64 slot = (CHECKPOINT_PERIOD + 1) * SLOTS_PER_PERIOD + 3;
        BeaconLightClient.LightClientOutput memory forged = _outputAt(bare, GENESIS_ROOT_A, slot, keccak256("forged head"));
        forged.syncCommitteeHash = keccak256("committee of keys the attacker holds");
        _submitExpectingRevert(
            bare, forged, abi.encodeWithSelector(BeaconLightClient.NextSyncCommitteeUnknown.selector, CHECKPOINT_PERIOD + 1)
        );
        assertEq(bare.syncCommittees(CHECKPOINT_PERIOD + 1), bytes32(0), "the empty slot stays empty");
        assertEq(bare.head(), INITIAL_SLOT);
    }

    /// Control for path (a): the same crossing is accepted when the next slot holds the right hash, and refused with
    /// the attacker's hash. Shows: acceptance and a mismatch on the filled slot. Matters: the revert above comes from the
    /// empty slot, not from some other rule.
    function test_H01_update_crossingIntoFilledNextSlotRequiresTheStoredCommittee() public {
        uint64 slot = (CHECKPOINT_PERIOD + 1) * SLOTS_PER_PERIOD + 3;
        BeaconLightClient.LightClientOutput memory forged = _outputAt(client, GENESIS_ROOT_A, slot, keccak256("forged head"));
        forged.syncCommitteeHash = keccak256("committee of keys the attacker holds");
        _submitExpectingRevert(
            client, forged, abi.encodeWithSelector(BeaconLightClient.SyncCommitteeMismatch.selector, COMMITTEE_101, forged.syncCommitteeHash)
        );
        BeaconLightClient.LightClientOutput memory honest = _outputAt(client, GENESIS_ROOT_A, slot, keccak256("honest head"));
        assertEq(honest.syncCommitteeHash, COMMITTEE_101);
        _submit(client, honest);
        assertEq(client.head(), slot);
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD + 1), COMMITTEE_101, "the stored committee is unchanged");
    }

    /// Claim: with a zero initial next committee, the first crossing update reverts until a same-period update fills the
    /// slot. Shows: a crossing with the right hash still reverts; after a same-period update proves the next committee,
    /// the crossing is accepted. Matters: liveness is kept (any relayer fills the slot with a proven update), and nobody
    /// can skip that step.
    function test_H08_update_crossingWaitsForASamePeriodUpdateThatFillsTheSlot() public {
        BeaconLightClient bare = _clientWithoutNextCommittee();
        uint64 crossingSlot = (CHECKPOINT_PERIOD + 1) * SLOTS_PER_PERIOD + 3;
        BeaconLightClient.LightClientOutput memory early = _outputAt(bare, GENESIS_ROOT_A, crossingSlot, keccak256("early"));
        early.syncCommitteeHash = COMMITTEE_101; // the right hash, but the contract does not know it yet
        _submitExpectingRevert(
            bare, early, abi.encodeWithSelector(BeaconLightClient.NextSyncCommitteeUnknown.selector, CHECKPOINT_PERIOD + 1)
        );

        // A same-period update whose program output proves the next committee fills the slot.
        BeaconLightClient.LightClientOutput memory fill = _nextOutput(bare, GENESIS_ROOT_A, keccak256("fill"));
        fill.nextSyncCommitteeHash = COMMITTEE_101;
        _submit(bare, fill);
        assertEq(bare.syncCommittees(CHECKPOINT_PERIOD + 1), COMMITTEE_101);

        BeaconLightClient.LightClientOutput memory crossing = _outputAt(bare, GENESIS_ROOT_A, crossingSlot, keccak256("crossing"));
        _submit(bare, crossing);
        assertEq(bare.head(), crossingSlot);
    }

    /// Claim (path b): a same-period update that carries a non-zero next committee fills an empty next slot, and a
    /// later different non-zero next committee is refused. Shows: the fill, the `NextSyncCommitteeMismatch`, and that a
    /// zero next value changes nothing. Matters: this is the only way a next slot gets filled after construction.
    /// The contract relies on the program's rule that it outputs a non-zero next committee only when that update proves it
    /// from the attested state, and never a carried value. The contract cannot check that rule itself.
    function test_H01_update_nextSlotFilledOnlyByProvenNonZeroValueAndNeverChanged() public {
        BeaconLightClient bare = _clientWithoutNextCommittee();
        BeaconLightClient.LightClientOutput memory zeroNext = _nextOutput(bare, GENESIS_ROOT_A, keccak256("zero next"));
        assertEq(zeroNext.nextSyncCommitteeHash, bytes32(0));
        _submit(bare, zeroNext);
        assertEq(bare.syncCommittees(CHECKPOINT_PERIOD + 1), bytes32(0), "a zero next value changes nothing");

        BeaconLightClient.LightClientOutput memory proven = _nextOutput(bare, GENESIS_ROOT_A, keccak256("proven next"));
        proven.nextSyncCommitteeHash = COMMITTEE_101;
        _submit(bare, proven);
        assertEq(bare.syncCommittees(CHECKPOINT_PERIOD + 1), COMMITTEE_101);

        BeaconLightClient.LightClientOutput memory other = _nextOutput(bare, GENESIS_ROOT_A, keccak256("other next"));
        other.nextSyncCommitteeHash = keccak256("a different next committee");
        _submitExpectingRevert(
            bare, other, abi.encodeWithSelector(BeaconLightClient.NextSyncCommitteeMismatch.selector, COMMITTEE_101, other.nextSyncCommitteeHash)
        );

        BeaconLightClient.LightClientOutput memory again = _nextOutput(bare, GENESIS_ROOT_A, keccak256("same next"));
        again.nextSyncCommitteeHash = COMMITTEE_101;
        _submit(bare, again); // the same value is fine
        assertEq(bare.syncCommittees(CHECKPOINT_PERIOD + 1), COMMITTEE_101);
    }

    // ================================================================ proof soundness

    /// Claim: a proof the oracle did not sign is rejected. Shows: a signature by another key reverts with
    /// `InvalidProof`, and the head stays. Matters: H-04. The state moves only when a sound proof exists.
    function test_H04_update_revertsOnProofNotSignedByOracle() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        bytes memory values = abi.encode(output);
        bytes32 digest = keccak256(abi.encodePacked(LIGHT_CLIENT_VKEY, sha256(values)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(keccak256("not the oracle")), digest);

        vm.expectRevert(OracleSP1Verifier.InvalidProof.selector);
        client.update(abi.encodePacked(r, s, v), values);
        assertEq(client.head(), INITIAL_SLOT);

        client.update(_lightClientProof(output), values); // honest path
        assertEq(client.head(), output.newHeadSlot);
    }

    /// Claim: an empty proof, a short proof, and a proof of 65 bytes of zeros are all rejected.
    /// Shows: three `InvalidProof` reverts. Matters: H-04 (no default accept).
    function test_H04_update_revertsOnMalformedProofs() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        bytes memory values = abi.encode(output);
        vm.expectRevert(OracleSP1Verifier.InvalidProof.selector);
        client.update("", values);
        vm.expectRevert(OracleSP1Verifier.InvalidProof.selector);
        client.update(hex"01", values);
        vm.expectRevert(OracleSP1Verifier.InvalidProof.selector);
        client.update(new bytes(65), values);
        client.update(_lightClientProof(output), values); // honest path
    }

    /// Claim: a proof binds the exact public values. Shows: an attacker who takes a signed update and swaps the
    /// execution block hash fails. Matters: H-01 / H-08 (the attacker cannot mark a block of their choice finalized).
    function test_H08_update_revertsWhenPublicValuesDifferFromProvenValues() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("real block"));
        bytes memory proof = _lightClientProof(output);
        output.executionBlockHash = keccak256("attacker block");

        vm.expectRevert(OracleSP1Verifier.InvalidProof.selector);
        client.update(proof, abi.encode(output));
        assertFalse(client.isFinalizedExecutionBlock(keccak256("attacker block")));
    }

    /// Claim: a proof for the withdrawal program is not a proof for the light-client program. Shows: the key is
    /// part of the digest. Matters: H-04 (programs cannot stand in for each other).
    function test_H04_update_revertsOnProofOfAnotherProgram() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        bytes memory values = abi.encode(output);
        bytes memory wrongProgramProof = _prove(keccak256("some other program"), values);
        bytes memory rightProof = _prove(LIGHT_CLIENT_VKEY, values);
        vm.expectRevert(OracleSP1Verifier.InvalidProof.selector);
        client.update(wrongProgramProof, values);
        client.update(rightProof, values); // honest path
    }

    // ================================================================ gas

    /// Claim: an update costs one proof check, whatever the committee size (H-15). Revision 1 verified 342 signatures
    /// and 342 Merkle proofs. Shows: the public values are a fixed 320 bytes of hashes (so committee size cannot enter
    /// the calldata or the loop), and 5 updates in a row cost the same gas within a narrow band.
    /// Bound: three new storage slots (header root, execution block hash of the head, finalized block, 3 x 22.1k), one
    /// head write (about 5k), cold reads of the stored state (about 8k), the oracle check (3k for ecrecover plus sha256),
    /// calldata, and the event. Measured: about 86k for the first update and 80.7k after. The test allows 120k. A real SP1
    /// verifier call adds its own cost outside this contract.
    /// Matters: a relayer pays a small, fixed cost, so relaying stays affordable without a fee.
    function test_H15_gas_updateCostIsFlatAndSmall() public {
        uint256 lowest = type(uint256).max;
        uint256 highest;
        for (uint256 i = 1; i <= 5; i++) {
            BeaconLightClient.LightClientOutput memory output =
                _nextOutput(client, GENESIS_ROOT_A, keccak256(abi.encode("gas block", i)));
            bytes memory values = abi.encode(output);
            bytes memory proof = _lightClientProof(output);
            assertEq(values.length, client.PUBLIC_VALUES_LENGTH(), "fixed size, independent of committee size");
            uint256 before = gasleft();
            client.update(proof, values);
            uint256 used = before - gasleft();
            console2.log("update gas", i, used);
            if (used < lowest) lowest = used;
            if (used > highest) highest = used;
        }
        assertLt(highest, 120_000, "an update stays under 120k gas");
        assertLt(highest - lowest, 10_000, "gas does not grow from one update to the next");
    }

    /// Claim: the hardened update is far cheaper than the revision-1 update with 342 signatures (H-15). Shows: the
    /// measured gas of both and a ratio of at least 10. Matters: the cost that made relaying irrational is gone.
    function test_H15_gas_cheaperThanRevisionOneUpdate() public {
        Committee.Set memory honest = Committee.build("chainA");
        LightClientSync legacy = new LightClientSync(honest.root, 1);
        Committee.Signed memory signed = Committee.attest(honest, keccak256("header"), 1, Committee.THRESHOLD);
        uint256 beforeLegacy = gasleft();
        legacy.updateSyncState(1, keccak256("header"), signed.signatures, signed.proofs, honest.root);
        uint256 legacyGas = beforeLegacy - gasleft();

        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        bytes memory values = abi.encode(output);
        bytes memory proof = _lightClientProof(output);
        uint256 beforeHardened = gasleft();
        client.update(proof, values);
        uint256 hardenedGas = beforeHardened - gasleft();

        console2.log("revision 1 update gas", legacyGas);
        console2.log("hardened update gas", hardenedGas);
        assertGt(legacyGas, hardenedGas * 10);
    }
}
