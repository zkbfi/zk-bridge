// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {OracleSP1Verifier} from "../mocks/OracleSP1Verifier.sol";
import {HardenedFixture} from "./utils/HardenedFixture.sol";

/// @notice Tests of the hardened light client: constructor, every revert path of `update`,
/// forward-only head, continuity, committee rotation, cross-chain replay, proof soundness, gas.
contract BeaconLightClientTest is HardenedFixture {
    using stdStorage for StdStorage;

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
            verifier_,
            programVKey,
            genesisRoot,
            slotsPerPeriod,
            LIGHT_CLIENT_GENESIS_TIME,
            LIGHT_CLIENT_SECONDS_PER_SLOT,
            slot,
            headerRoot,
            committee,
            COMMITTEE_101
        );
    }

    /// @dev A genesis time with a realistic size. The clock tests use it with 12 seconds per slot.
    uint64 internal constant CLOCK_GENESIS_TIME = 1_600_000_000;

    function _constructWithClock(uint64 genesisTime, uint64 secondsPerSlot) internal returns (BeaconLightClient) {
        return new BeaconLightClient(
            address(verifier),
            LIGHT_CLIENT_VKEY,
            GENESIS_ROOT_A,
            SLOTS_PER_PERIOD,
            genesisTime,
            secondsPerSlot,
            INITIAL_SLOT,
            INITIAL_HEADER_ROOT,
            COMMITTEE_100,
            COMMITTEE_101
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

    /// Claim: a zero genesis time or zero seconds per slot would make the clock bound meaningless (a zero divisor, or
    /// no bound at all). Shows: both are refused at construction, and the honest values are stored. Matters: G-04.
    function test_G04_constructor_revertsOnZeroClockValues() public {
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.ZeroValue.selector, "genesisTime"));
        _constructWithClock(0, 12);
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.ZeroValue.selector, "secondsPerSlot"));
        _constructWithClock(CLOCK_GENESIS_TIME, 0);

        BeaconLightClient honest = _constructWithClock(CLOCK_GENESIS_TIME, 12);
        assertEq(honest.genesisTime(), CLOCK_GENESIS_TIME);
        assertEq(honest.secondsPerSlot(), 12);
    }

    /// Claim: the next committee may be unknown at the checkpoint. Shows: a zero next committee is accepted.
    /// Matters: the honest path stays open when the checkpoint has no next committee yet.
    function test_H04_constructor_allowsZeroNextCommittee() public {
        BeaconLightClient other = new BeaconLightClient(
            address(verifier),
            LIGHT_CLIENT_VKEY,
            GENESIS_ROOT_A,
            SLOTS_PER_PERIOD,
            LIGHT_CLIENT_GENESIS_TIME,
            LIGHT_CLIENT_SECONDS_PER_SLOT,
            INITIAL_SLOT,
            INITIAL_HEADER_ROOT,
            COMMITTEE_100,
            bytes32(0)
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

    /// Claim: public values of the wrong length are not decoded. Shows: an empty value and a value with one extra
    /// word revert with the actual length. Matters: no trailing bytes can ride along with a signed statement. H-04.
    function test_H04_update_revertsOnWrongLength() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        bytes memory values = abi.encode(output);
        bytes memory proof = _lightClientProof(output);
        assertEq(values.length, 352, "the exact length of eleven words");

        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.InvalidPublicValuesLength.selector, 0));
        client.update(proof, "");

        bytes memory longer = bytes.concat(values, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.InvalidPublicValuesLength.selector, 384));
        client.update(proof, longer);

        client.update(proof, values); // honest path
        assertEq(client.head(), output.newHeadSlot);
    }

    /// Claim: the length 352 is exact. Shows: the old length of ten words (320 bytes) and the length of twelve words
    /// (384 bytes) both revert with `InvalidPublicValuesLength`, even when the oracle signed them, and exactly 352
    /// passes. Matters: the length check runs before the decoder, so a statement with a missing or extra word never
    /// reaches the field checks.
    function test_H04_update_publicValuesLengthIsExactly352() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        bytes memory values = abi.encode(output);
        bytes memory shorter = new bytes(320);
        for (uint256 i = 0; i < 320; i++) shorter[i] = values[i];
        bytes memory longer = bytes.concat(values, bytes32(uint256(1)));

        bytes memory shorterProof = _prove(LIGHT_CLIENT_VKEY, shorter);
        bytes memory longerProof = _prove(LIGHT_CLIENT_VKEY, longer);
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.InvalidPublicValuesLength.selector, 320));
        client.update(shorterProof, shorter);
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.InvalidPublicValuesLength.selector, 384));
        client.update(longerProof, longer);
        assertEq(client.head(), INITIAL_SLOT, "neither malformed statement moved the head");

        client.update(_lightClientProof(output), values); // honest path
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

    /// Claim: a head later than the current slot is refused, with the head and the current slot in the error. A head
    /// at the current slot is accepted, even in the last second of that slot. Shows: at the last second of slot `target`
    /// a head one slot ahead reverts with `HeadInFuture(target + 1, target)` and changes nothing, and a head at `target`
    /// is accepted. Matters: G-04. Without the bound, a dishonest committee could store a head far in the future, and
    /// the head only moves forward, so no honest update could ever follow.
    function test_G04_update_refusesAHeadOneSlotAfterTheCurrentSlotAndAcceptsTheCurrentSlot() public {
        BeaconLightClient timed = _constructWithClock(CLOCK_GENESIS_TIME, 12);
        uint64 target = INITIAL_SLOT + 1_000;
        vm.warp(CLOCK_GENESIS_TIME + uint256(target) * 12 + 11);

        BeaconLightClient.LightClientOutput memory ahead =
            _outputAt(timed, GENESIS_ROOT_A, target + 1, keccak256("one slot ahead"));
        _submitExpectingRevert(timed, ahead, abi.encodeWithSelector(BeaconLightClient.HeadInFuture.selector, target + 1, target));
        assertEq(timed.head(), INITIAL_SLOT, "a refused head changes nothing");

        _submit(timed, _outputAt(timed, GENESIS_ROOT_A, target, keccak256("at the current slot")));
        assertEq(timed.head(), target, "a head at the current slot is accepted");
    }

    /// Claim: a head far in the future is refused, and an honest update still follows. Shows: the forged head reverts
    /// with `HeadInFuture`, then the honest head is accepted. Matters: G-04, the route stays live.
    function test_G04_update_aHeadFarInTheFutureDoesNotBlockTheHonestUpdate() public {
        BeaconLightClient timed = _constructWithClock(CLOCK_GENESIS_TIME, 12);
        uint64 target = INITIAL_SLOT + 1_000;
        vm.warp(CLOCK_GENESIS_TIME + uint256(target) * 12);
        uint64 farSlot = 4_000_000_000_000;
        _submitExpectingRevert(
            timed,
            _outputAt(timed, GENESIS_ROOT_A, farSlot, keccak256("far future")),
            abi.encodeWithSelector(BeaconLightClient.HeadInFuture.selector, farSlot, target)
        );
        _submit(timed, _outputAt(timed, GENESIS_ROOT_A, target, keccak256("honest")));
        assertEq(timed.head(), target);
    }

    /// Claim: before the genesis time the current slot is zero, so every head is in the future. Shows: a head after the
    /// checkpoint reverts with `HeadInFuture(slot, 0)`. Matters: G-04, an early clock must not wrap to a huge slot.
    function test_G04_update_beforeGenesisEveryHeadIsInTheFuture() public {
        BeaconLightClient timed = _constructWithClock(CLOCK_GENESIS_TIME, 12);
        vm.warp(CLOCK_GENESIS_TIME - 1);
        BeaconLightClient.LightClientOutput memory output =
            _outputAt(timed, GENESIS_ROOT_A, INITIAL_SLOT + 1, keccak256("before genesis"));
        _submitExpectingRevert(
            timed, output, abi.encodeWithSelector(BeaconLightClient.HeadInFuture.selector, INITIAL_SLOT + 1, uint64(0))
        );
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

    // ---------------------------------------------------------------- jumps and folded updates

    /// Claim: the committee check still guards a jump of exactly one period that crosses a boundary. Shows: with the
    /// committee of the new period stored, another committee reverts with `SyncCommitteeMismatch`. Matters: H-01.
    /// The removal of the jump cap did not remove the committee continuity of rule 4 for a stored committee.
    function test_H01_update_crossingOnePeriodKeepsTheStoredCommittee() public {
        BeaconLightClient.LightClientOutput memory output =
            _outputAt(client, GENESIS_ROOT_A, INITIAL_SLOT + SLOTS_PER_PERIOD, keccak256("exact"));
        output.syncCommitteeHash = keccak256("attacker committee");
        _submitExpectingRevert(
            client,
            output,
            abi.encodeWithSelector(BeaconLightClient.SyncCommitteeMismatch.selector, COMMITTEE_101, output.syncCommitteeHash)
        );
        output.syncCommitteeHash = COMMITTEE_101;
        _submit(client, output); // honest path
        assertEq(client.periodOf(client.head()), CHECKPOINT_PERIOD + 1);
    }

    /// Claim: a jump of 20000 slots is accepted (rule 2 has no cap). Shows: the head moves, the header root, the
    /// execution block hash and the finalized block are stored, and the empty committee slot of the new period is
    /// written. Matters: HB-01 and the folded update. The program folds up to 64 updates into one proof, so a jump of
    /// several periods must be accepted. The old cap of 8192 slots would have refused it.
    function test_HB01_update_jumpOf20000SlotsIsAccepted() public {
        _assertLargeJumpAccepted(INITIAL_SLOT + 20_000, "jump of 20000");
    }

    /// Claim: a very large jump (10 million slots) is accepted. Shows: the same effects as above. Matters: no cap
    /// means no cap; a relayer that was offline for years can still catch up with one folded proof. The program,
    /// not the contract, limits a fold to 64 updates.
    function test_HB01_update_jumpOfTenMillionSlotsIsAccepted() public {
        _assertLargeJumpAccepted(INITIAL_SLOT + 10_000_000, "jump of ten million");
    }

    function _assertLargeJumpAccepted(uint64 slot, string memory label) internal {
        bytes32 blockHash = keccak256(bytes(label));
        BeaconLightClient.LightClientOutput memory output = _outputAt(client, GENESIS_ROOT_A, slot, blockHash);
        uint64 newPeriod = client.periodOf(slot);
        assertGt(newPeriod, CHECKPOINT_PERIOD + 1, "the jump passes the stored committees");
        assertEq(client.syncCommittees(newPeriod), bytes32(0), "control: nothing is stored for the new period yet");
        assertFalse(client.isFinalizedExecutionBlock(blockHash), "control: not finalized before");
        _submit(client, output);
        assertEq(client.head(), slot);
        assertEq(client.headers(slot), output.newHeaderRoot);
        assertEq(client.executionBlockHashes(slot), blockHash);
        assertTrue(client.isFinalizedExecutionBlock(blockHash));
        assertEq(client.executionBlockNumber(blockHash), output.executionBlockNumber);
        assertEq(client.syncCommittees(newPeriod), output.syncCommitteeHash, "the crossing wrote the new committee");
    }

    /// Claim: a fold across three periods (head in period 100, new head in period 103) with an empty slot for period
    /// 103 writes the committee of the output. Shows: the committee of 103 is stored, the slots of 102 and 104 stay
    /// empty, and the old committees stay. Matters: rule 4. The program proved the chain of handoffs from the bound
    /// start (the program's duty: `light-client/crates/lc-testkit/tests/fold.rs`,
    /// `synthetic_fold_across_three_periods_is_accepted`). The contract only writes the result.
    function test_HB01_update_foldAcrossThreePeriodsWritesAnEmptyCommitteeSlot() public {
        uint64 slot = (CHECKPOINT_PERIOD + 3) * SLOTS_PER_PERIOD + 5;
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD + 3), bytes32(0), "control: the slot is empty before");
        BeaconLightClient.LightClientOutput memory output = _outputAt(client, GENESIS_ROOT_A, slot, keccak256("fold"));
        bytes32 foldedCommittee = output.syncCommitteeHash;
        assertTrue(foldedCommittee != bytes32(0));
        _submit(client, output);

        assertEq(client.head(), slot);
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD + 3), foldedCommittee);
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD + 2), bytes32(0), "a skipped period stays empty");
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD + 4), bytes32(0), "no next committee was claimed");
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD), COMMITTEE_100);
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD + 1), COMMITTEE_101);
    }

    /// Claim: the same fold, when the slot of period 103 already holds a committee, must produce exactly that
    /// committee. Shows: another committee reverts with `SyncCommitteeMismatch(stored, claimed)` and the head does
    /// not move; the stored committee is accepted and stays. Matters: rule 4. A stored committee is never
    /// overwritten, so a folded proof cannot replace a committee that an earlier proof already established.
    /// The slot is filled with `stdstore`, because a head can reach such a state only through a longer history.
    function test_HB01_update_foldAcrossThreePeriodsMustMatchAStoredCommittee() public {
        uint64 period = CHECKPOINT_PERIOD + 3;
        bytes32 stored = keccak256("committee of period 103 stored by an earlier proof");
        stdstore.target(address(client)).sig("syncCommittees(uint64)").with_key(uint256(period)).checked_write(stored);
        assertEq(client.syncCommittees(period), stored, "setup: the slot holds a committee");

        uint64 slot = period * SLOTS_PER_PERIOD + 5;
        BeaconLightClient.LightClientOutput memory forged = _outputAt(client, GENESIS_ROOT_A, slot, keccak256("forged fold"));
        forged.syncCommitteeHash = keccak256("committee of keys the attacker holds");
        _submitExpectingRevert(
            client,
            forged,
            abi.encodeWithSelector(BeaconLightClient.SyncCommitteeMismatch.selector, stored, forged.syncCommitteeHash)
        );
        assertEq(client.head(), INITIAL_SLOT, "the forged fold did not move the head");

        BeaconLightClient.LightClientOutput memory honest = _outputAt(client, GENESIS_ROOT_A, slot, keccak256("honest fold"));
        assertEq(honest.syncCommitteeHash, stored, "the honest fold names the stored committee");
        _submit(client, honest); // honest path
        assertEq(client.head(), slot);
        assertEq(client.syncCommittees(period), stored, "the stored committee is unchanged");
    }

    /// Claim: crossing exactly one period into an empty slot writes the committee of the output, and the written
    /// committee is then fixed. Shows: the slot is written, and the next output in that period must equal it.
    /// Matters: rule 4 for a start with an empty next slot. The program proved the handoff. The matching Rust test
    /// for what the program refuses is `synthetic_first_step_cannot_cross_without_a_known_next_committee` in
    /// `light-client/crates/lc-testkit/tests/fold.rs`.
    function test_HB01_update_crossingOnePeriodIntoEmptySlotWritesIt() public {
        BeaconLightClient bare = _clientWithoutNextCommittee();
        uint64 slot = (CHECKPOINT_PERIOD + 1) * SLOTS_PER_PERIOD + 3;
        BeaconLightClient.LightClientOutput memory crossing = _outputAt(bare, GENESIS_ROOT_A, slot, keccak256("crossing"));
        assertEq(bare.syncCommittees(CHECKPOINT_PERIOD + 1), bytes32(0), "control: the slot is empty before");
        _submit(bare, crossing);
        assertEq(bare.head(), slot);
        assertEq(bare.syncCommittees(CHECKPOINT_PERIOD + 1), crossing.syncCommitteeHash);

        // Written once: another committee for the same period is now refused (rule 3).
        BeaconLightClient.LightClientOutput memory other = _nextOutput(bare, GENESIS_ROOT_A, keccak256("later"));
        other.syncCommitteeHash = keccak256("a different committee for the same period");
        _submitExpectingRevert(
            bare,
            other,
            abi.encodeWithSelector(
                BeaconLightClient.SyncCommitteeMismatch.selector, crossing.syncCommitteeHash, other.syncCommitteeHash
            )
        );
        other.syncCommitteeHash = crossing.syncCommitteeHash;
        _submit(bare, other); // honest path
    }

    /// Claim: a crossing that also proves a next committee fills the slot after the new period. Shows: the slot of
    /// period 102 holds the proven value after the crossing into 101 from a client with an empty 101 slot.
    /// Matters: rule 5 together with rule 4 (both writes in one update).
    function test_HB01_update_crossingWritesTheCommitteeAndTheProvenNextCommittee() public {
        BeaconLightClient bare = _clientWithoutNextCommittee();
        uint64 slot = (CHECKPOINT_PERIOD + 1) * SLOTS_PER_PERIOD + 3;
        BeaconLightClient.LightClientOutput memory crossing = _outputAt(bare, GENESIS_ROOT_A, slot, keccak256("crossing"));
        crossing.nextSyncCommitteeHash = COMMITTEE_102;
        _submit(bare, crossing);
        assertEq(bare.syncCommittees(CHECKPOINT_PERIOD + 1), crossing.syncCommitteeHash);
        assertEq(bare.syncCommittees(CHECKPOINT_PERIOD + 2), COMMITTEE_102);
    }

    /// Claim: a head may only move forward, however large the allowed jump is. Shows: a slot equal to the head
    /// reverts with `HeadNotAdvancing`, while a large forward jump is accepted. Matters: rule 2 is the only
    /// slot rule left, so it must hold for every slot value.
    function test_HB01_update_onlyForwardJumpsAreAccepted() public {
        BeaconLightClient.LightClientOutput memory same = _outputAt(client, GENESIS_ROOT_A, INITIAL_SLOT, keccak256("same"));
        _submitExpectingRevert(
            client, same, abi.encodeWithSelector(BeaconLightClient.HeadNotAdvancing.selector, INITIAL_SLOT, INITIAL_SLOT)
        );
        _submit(client, _outputAt(client, GENESIS_ROOT_A, INITIAL_SLOT + 1_000_000, keccak256("far"))); // honest path
        assertEq(client.head(), INITIAL_SLOT + 1_000_000);
    }

    /// Claim: the starting store is checked before progress. Shows: an output with a wrong starting next committee and
    /// a head that does not advance reverts with `StartNextSyncCommitteeMismatch`, not `HeadNotAdvancing`.
    /// Matters: the order of checks is part of the documented contract rules (rule 1 before rule 2).
    function test_HB01_update_startCheckRunsBeforeTheProgressCheck() public {
        BeaconLightClient.LightClientOutput memory output = _outputAt(client, GENESIS_ROOT_A, INITIAL_SLOT, keccak256("both"));
        output.startNextSyncCommitteeHash = keccak256("invented");
        _submitExpectingRevert(
            client,
            output,
            abi.encodeWithSelector(
                BeaconLightClient.StartNextSyncCommitteeMismatch.selector, COMMITTEE_101, output.startNextSyncCommitteeHash
            )
        );
        output.startNextSyncCommitteeHash = COMMITTEE_101;
        _submitExpectingRevert(
            client, output, abi.encodeWithSelector(BeaconLightClient.HeadNotAdvancing.selector, INITIAL_SLOT, INITIAL_SLOT)
        );
    }

    // ---------------------------------------------------------------- starting store (HB-01)

    /// Claim: the starting next committee must equal the stored next committee. Shows: a wrong value reverts with
    /// `StartNextSyncCommitteeMismatch(expected, actual)` with exactly those two values, and the honest value is
    /// accepted. Matters: HB-01. The program takes its starting store as private input; this check ties that store to
    /// what the contract holds, so a caller cannot start the program from an invented store.
    function test_HB01_update_startNextCommitteeMustMatchTheStoredSlot() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        output.startNextSyncCommitteeHash = keccak256("some other next committee");
        _submitExpectingRevert(
            client,
            output,
            abi.encodeWithSelector(
                BeaconLightClient.StartNextSyncCommitteeMismatch.selector, COMMITTEE_101, output.startNextSyncCommitteeHash
            )
        );
        assertEq(client.head(), INITIAL_SLOT);

        output.startNextSyncCommitteeHash = COMMITTEE_101;
        _submit(client, output); // honest path
        assertEq(client.head(), output.newHeadSlot);
    }

    /// Claim: zero equals zero. A client built with an empty next committee accepts an output whose starting next
    /// committee is zero. Shows: the update is accepted and the empty slot stays empty. Matters: the honest path stays
    /// open when the checkpoint has no next committee yet (the prover then starts with no next committee too).
    function test_HB01_update_zeroStartNextCommitteeMatchesAnEmptyStoredSlot() public {
        BeaconLightClient bare = _clientWithoutNextCommittee();
        BeaconLightClient.LightClientOutput memory output = _nextOutput(bare, GENESIS_ROOT_A, keccak256("b"));
        assertEq(output.startNextSyncCommitteeHash, bytes32(0), "the honest start is zero");
        _submit(bare, output);
        assertEq(bare.head(), output.newHeadSlot);
        assertEq(bare.syncCommittees(CHECKPOINT_PERIOD + 1), bytes32(0));
    }

    /// Claim: a stored next committee cannot be hidden behind a zero. Shows: a stored non-zero slot against a zero
    /// starting next committee reverts with `StartNextSyncCommitteeMismatch(stored, 0)`. Matters: the contract refuses
    /// an output whose store differs from its own, rather than accept it (docs: "If the contract stores a next
    /// committee, the prover's initial store must carry it").
    function test_HB01_update_storedNextCommitteeAgainstZeroOutputIsRefused() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        output.startNextSyncCommitteeHash = bytes32(0);
        _submitExpectingRevert(
            client,
            output,
            abi.encodeWithSelector(BeaconLightClient.StartNextSyncCommitteeMismatch.selector, COMMITTEE_101, bytes32(0))
        );
        output.startNextSyncCommitteeHash = COMMITTEE_101;
        _submit(client, output); // honest path
    }

    /// Claim: an invented starting next committee is refused when the stored slot is empty. Shows: an output that
    /// claims a made-up committee as the start reverts with `StartNextSyncCommitteeMismatch(0, invented)`, the slot
    /// stays empty, and the head does not move. Matters: HB-01 path (a). Before the fix the attacker invented the
    /// committee, signed a forged head with keys they hold, and crossed into the empty slot. Now the invention
    /// must appear in the public output as the start, and the contract holds zero. The program's own duty is to refuse
    /// a next-period signature that the finalized header does not cross: see
    /// `synthetic_invented_next_committee_in_the_initial_store_is_exposed` in
    /// `light-client/crates/lc-testkit/tests/fold.rs` and `verify_fold_with_layout` in
    /// `light-client/crates/lc-core/src/update.rs`.
    function test_HB01_update_inventedStartingNextCommitteeIsRefusedWhenTheSlotIsEmpty() public {
        BeaconLightClient bare = _clientWithoutNextCommittee();
        uint64 slot = (CHECKPOINT_PERIOD + 1) * SLOTS_PER_PERIOD + 3;
        bytes32 invented = keccak256("committee of keys the attacker holds");
        BeaconLightClient.LightClientOutput memory forged = _outputAt(bare, GENESIS_ROOT_A, slot, keccak256("forged head"));
        forged.startNextSyncCommitteeHash = invented;
        forged.syncCommitteeHash = invented;
        _submitExpectingRevert(
            bare, forged, abi.encodeWithSelector(BeaconLightClient.StartNextSyncCommitteeMismatch.selector, bytes32(0), invented)
        );
        assertEq(bare.syncCommittees(CHECKPOINT_PERIOD + 1), bytes32(0), "the empty slot stays empty");
        assertEq(bare.head(), INITIAL_SLOT);

        // Control: the same crossing with the true (empty) start is accepted by the contract.
        BeaconLightClient.LightClientOutput memory honest = _outputAt(bare, GENESIS_ROOT_A, slot, keccak256("honest head"));
        assertEq(honest.startNextSyncCommitteeHash, bytes32(0));
        _submit(bare, honest);
        assertEq(bare.head(), slot);
    }

    /// Claim: an invented starting next committee is refused when a next committee is stored. Shows: another value
    /// reverts with `StartNextSyncCommitteeMismatch(stored, invented)`, and the stored value is accepted. Matters:
    /// HB-01 path (b): the attacker cannot swap the stored next committee for another one in the program's start.
    function test_HB01_update_inventedStartingNextCommitteeIsRefusedWhenOneIsStored() public {
        uint64 slot = (CHECKPOINT_PERIOD + 1) * SLOTS_PER_PERIOD + 3;
        bytes32 invented = keccak256("committee of keys the attacker holds");
        BeaconLightClient.LightClientOutput memory forged = _outputAt(client, GENESIS_ROOT_A, slot, keccak256("forged head"));
        forged.startNextSyncCommitteeHash = invented;
        forged.syncCommitteeHash = invented;
        _submitExpectingRevert(
            client, forged, abi.encodeWithSelector(BeaconLightClient.StartNextSyncCommitteeMismatch.selector, COMMITTEE_101, invented)
        );
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD + 1), COMMITTEE_101, "the stored committee is unchanged");

        BeaconLightClient.LightClientOutput memory honest = _outputAt(client, GENESIS_ROOT_A, slot, keccak256("honest head"));
        _submit(client, honest); // honest path
        assertEq(client.head(), slot);
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

    /// Claim: a zero committee hash is refused with its own error, in the head period and at a crossing. Shows: zero
    /// reverts with `EmptySyncCommitteeHash` (not a mismatch), also when the slot of the new period is empty and a
    /// zero would be written. Matters: writing zero would leave the new head without a committee, and a zero hash
    /// must never read as "no committee, accept anything".
    function test_H04_update_revertsOnEmptyCommittee() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("b"));
        output.syncCommitteeHash = bytes32(0);
        _submitExpectingRevert(client, output, _selector(BeaconLightClient.EmptySyncCommitteeHash.selector));

        // The crossing into an empty slot: the case where the contract would write the zero.
        uint64 farSlot = (CHECKPOINT_PERIOD + 5) * SLOTS_PER_PERIOD + 1;
        BeaconLightClient.LightClientOutput memory crossing = _outputAt(client, GENESIS_ROOT_A, farSlot, keccak256("far"));
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD + 5), bytes32(0));
        crossing.syncCommitteeHash = bytes32(0);
        _submitExpectingRevert(client, crossing, _selector(BeaconLightClient.EmptySyncCommitteeHash.selector));
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD + 5), bytes32(0), "no zero was written");

        crossing.syncCommitteeHash = keccak256("honest far committee");
        _submit(client, crossing); // honest path
        assertEq(client.syncCommittees(CHECKPOINT_PERIOD + 5), crossing.syncCommitteeHash);
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

    /// A light client whose checkpoint has no next committee. The tests below start from it.
    function _clientWithoutNextCommittee() internal returns (BeaconLightClient) {
        return new BeaconLightClient(
            address(verifier),
            LIGHT_CLIENT_VKEY,
            GENESIS_ROOT_A,
            SLOTS_PER_PERIOD,
            LIGHT_CLIENT_GENESIS_TIME,
            LIGHT_CLIENT_SECONDS_PER_SLOT,
            INITIAL_SLOT,
            INITIAL_HEADER_ROOT,
            COMMITTEE_100,
            bytes32(0)
        );
    }

    /// Claim (path b): a same-period update that carries a non-zero next committee fills an empty next slot, and a
    /// later different non-zero next committee is refused. Shows: the fill, the `NextSyncCommitteeMismatch`, and that a
    /// zero next value changes nothing. Matters: this is the only way a next slot gets filled after construction.
    /// The contract relies on the program's rule that it outputs a non-zero next committee only when that update proves it
    /// from the attested state, and never a carried value. The contract cannot check that rule itself.
    /// The matching Rust test is `synthetic_next_committee_hash_counts_only_what_this_fold_proved` in
    /// `light-client/crates/lc-testkit/tests/fold.rs`.
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
    /// and 342 Merkle proofs. Shows: the public values are a fixed 352 bytes of hashes (so committee size cannot enter
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
}
