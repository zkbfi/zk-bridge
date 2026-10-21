// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISP1Verifier} from "./ISP1Verifier.sol";
import {IBeaconLightClient} from "./IBeaconLightClient.sol";
import {BeaconClock} from "./BeaconClock.sol";

/// @title BeaconLightClient
/// @notice Tracks the finalized beacon chain of one source chain with zero-knowledge proofs of the
/// Altair light-client protocol. It follows the shape of the Succinct SP1 Helios contract.
/// @dev Every past head stays stored forever, because withdrawals use it as an anchor. A head may jump any distance:
/// the program folds 1 to 64 updates into one proof, and the vault proves an old deposit through
/// `state.historical_summaries` when the anchor is more than 8192 slots away.
/// One proof check per update, whatever the committee size, because the contract stores only
/// committee hashes. The contract has no owner, no upgrade path, and no pause.
contract BeaconLightClient is IBeaconLightClient {
    /// @notice The public values of the light-client program, in `abi.encode` order.
    struct LightClientOutput {
        bytes32 genesisValidatorsRoot;
        bytes32 previousHeaderRoot;
        uint64 previousHeadSlot;
        bytes32 previousSyncCommitteeHash;
        bytes32 startNextSyncCommitteeHash;
        bytes32 newHeaderRoot;
        uint64 newHeadSlot;
        bytes32 executionBlockHash;
        uint64 executionBlockNumber;
        bytes32 syncCommitteeHash;
        bytes32 nextSyncCommitteeHash;
    }

    /// @dev Both fields share one storage slot.
    struct FinalizedBlock {
        bool finalized;
        uint64 number;
    }

    /// @notice The size of the encoded output: eleven static words.
    uint256 public constant PUBLIC_VALUES_LENGTH = 352;

    /// @notice A constructor argument is zero.
    error ZeroValue(string name);
    /// @notice The public values do not have the length of an encoded `LightClientOutput`.
    error InvalidPublicValuesLength(uint256 actual);
    /// @notice The output belongs to another chain (cross-chain replay).
    error GenesisValidatorsRootMismatch(bytes32 expected, bytes32 actual);
    /// @notice The output builds on another head slot than the stored head.
    error PreviousHeadSlotMismatch(uint64 expected, uint64 actual);
    /// @notice The output builds on another header root than the stored one.
    error PreviousHeaderRootMismatch(bytes32 expected, bytes32 actual);
    /// @notice The output builds on another committee than the stored one.
    error PreviousSyncCommitteeMismatch(bytes32 expected, bytes32 actual);
    /// @notice The output starts from another next committee than the stored one (zero equals zero). This binds the
    /// private starting store of the program, so a caller cannot invent a starting next committee.
    error StartNextSyncCommitteeMismatch(bytes32 expected, bytes32 actual);
    /// @notice The new head slot is not past the stored head.
    error HeadNotAdvancing(uint64 head, uint64 newHeadSlot);
    /// @notice The new head slot is later than the current slot, which `block.timestamp` implies.
    error HeadInFuture(uint64 newHeadSlot, uint64 currentSlot);
    /// @notice The new header root is zero.
    error EmptyHeaderRoot();
    /// @notice The execution block hash is zero.
    error EmptyExecutionBlockHash();
    /// @notice The committee hash of the new head is zero. The program never outputs a zero committee.
    error EmptySyncCommitteeHash();
    /// @notice The committee in the output differs from the stored committee for its period.
    error SyncCommitteeMismatch(bytes32 expected, bytes32 actual);
    /// @notice The next committee differs from the stored next committee.
    error NextSyncCommitteeMismatch(bytes32 expected, bytes32 actual);

    /// @notice Emitted when the head moves forward.
    event HeadUpdated(uint64 indexed slot, bytes32 indexed headerRoot, bytes32 indexed executionBlockHash);

    /// @notice The proof system that checks light-client proofs.
    /// @dev Pass a specific verifier contract for the proof system and version, never Succinct's ownable gateway.
    /// The gateway owner can add and remove verifiers, which would give one key power over this contract.
    ISP1Verifier public immutable verifier;
    /// @notice The verification key of the light-client program.
    bytes32 public immutable programVKey;
    /// @notice The genesis validators root of the tracked chain. It binds the contract to one chain.
    bytes32 public immutable genesisValidatorsRoot;
    /// @notice The number of slots in a sync committee period.
    uint64 public immutable slotsPerPeriod;
    /// @notice The genesis time of the tracked beacon chain, in seconds.
    uint64 public immutable genesisTime;
    /// @notice The seconds per slot of the tracked beacon chain.
    uint64 public immutable secondsPerSlot;

    /// @notice The slot of the latest finalized header.
    uint64 public head;
    /// @notice Finalized beacon header roots by slot.
    mapping(uint64 slot => bytes32 headerRoot) public override headers;
    /// @notice Sync committee hashes by period.
    mapping(uint64 period => bytes32 committeeHash) public syncCommittees;

    /// @notice The execution block hash of each stored head, by slot. Vault layout checks compare against it.
    mapping(uint64 slot => bytes32 blockHash) public override executionBlockHashes;

    mapping(bytes32 blockHash => FinalizedBlock) private _finalizedBlocks;

    /// @param verifier_ A specific SP1 verifier contract. It is not the ownable gateway.
    /// @param programVKey_ The verification key of the light-client program.
    /// @param genesisValidatorsRoot_ The genesis validators root of the tracked chain.
    /// @param slotsPerPeriod_ Slots per sync committee period (8192 on Ethereum and PulseChain).
    /// @param genesisTime_ Genesis time of the tracked beacon chain, in seconds. It bounds the head by the clock.
    /// @param secondsPerSlot_ Seconds per slot of the tracked beacon chain.
    /// @param initialSlot The slot of the trusted checkpoint.
    /// @param initialHeaderRoot The header root of the trusted checkpoint.
    /// @param initialSyncCommitteeHash The committee hash for the period of the checkpoint.
    /// @param initialNextSyncCommitteeHash The committee hash for the next period, or zero.
    constructor(
        address verifier_,
        bytes32 programVKey_,
        bytes32 genesisValidatorsRoot_,
        uint64 slotsPerPeriod_,
        uint64 genesisTime_,
        uint64 secondsPerSlot_,
        uint64 initialSlot,
        bytes32 initialHeaderRoot,
        bytes32 initialSyncCommitteeHash,
        bytes32 initialNextSyncCommitteeHash
    ) {
        if (verifier_ == address(0)) revert ZeroValue("verifier");
        if (programVKey_ == bytes32(0)) revert ZeroValue("programVKey");
        if (genesisValidatorsRoot_ == bytes32(0)) revert ZeroValue("genesisValidatorsRoot");
        if (slotsPerPeriod_ == 0) revert ZeroValue("slotsPerPeriod");
        if (genesisTime_ == 0) revert ZeroValue("genesisTime");
        if (secondsPerSlot_ == 0) revert ZeroValue("secondsPerSlot");
        if (initialSlot == 0) revert ZeroValue("initialSlot");
        if (initialHeaderRoot == bytes32(0)) revert ZeroValue("initialHeaderRoot");
        if (initialSyncCommitteeHash == bytes32(0)) revert ZeroValue("initialSyncCommitteeHash");

        verifier = ISP1Verifier(verifier_);
        programVKey = programVKey_;
        genesisValidatorsRoot = genesisValidatorsRoot_;
        slotsPerPeriod = slotsPerPeriod_;
        genesisTime = genesisTime_;
        secondsPerSlot = secondsPerSlot_;

        uint64 period = initialSlot / slotsPerPeriod_;
        head = initialSlot;
        headers[initialSlot] = initialHeaderRoot;
        syncCommittees[period] = initialSyncCommitteeHash;
        syncCommittees[period + 1] = initialNextSyncCommitteeHash;
    }

    /// @notice Moves the head to a newer finalized header, given a proof of the light-client program.
    /// @dev Anyone can call it. The checks run in a fixed order, and the proof check comes last.
    /// @param proof The SP1 proof.
    /// @param publicValues The `abi.encode` of a `LightClientOutput`.
    function update(bytes calldata proof, bytes calldata publicValues) external {
        if (publicValues.length != PUBLIC_VALUES_LENGTH) revert InvalidPublicValuesLength(publicValues.length);
        LightClientOutput memory output = abi.decode(publicValues, (LightClientOutput));

        _requireStoredStart(output);
        bool writesNewCommittee = _requireProgress(output);

        verifier.verifyProof(programVKey, publicValues, proof);

        head = output.newHeadSlot;
        headers[output.newHeadSlot] = output.newHeaderRoot;
        executionBlockHashes[output.newHeadSlot] = output.executionBlockHash;
        _finalizedBlocks[output.executionBlockHash] =
            FinalizedBlock({finalized: true, number: output.executionBlockNumber});
        uint64 newPeriod = output.newHeadSlot / slotsPerPeriod;
        // Rule 4: a crossing into a period with no stored committee writes it. The program proved the chain of
        // handoffs from the bound start (`previousSyncCommitteeHash` and `startNextSyncCommitteeHash`).
        if (writesNewCommittee) syncCommittees[newPeriod] = output.syncCommitteeHash;
        // Rule 5: the next slot is written only when the program proved a next committee and the slot is still empty.
        if (output.nextSyncCommitteeHash != bytes32(0) && syncCommittees[newPeriod + 1] == bytes32(0)) {
            syncCommittees[newPeriod + 1] = output.nextSyncCommitteeHash;
        }

        emit HeadUpdated(output.newHeadSlot, output.newHeaderRoot, output.executionBlockHash);
    }

    /// @notice Whether the execution block hash sits in a finalized beacon header.
    /// @param blockHash The execution block hash.
    function isFinalizedExecutionBlock(bytes32 blockHash) external view returns (bool) {
        return _finalizedBlocks[blockHash].finalized;
    }

    /// @notice The block number of a finalized execution block, or zero when it is not finalized.
    /// @param blockHash The execution block hash.
    function executionBlockNumber(bytes32 blockHash) external view returns (uint64) {
        return _finalizedBlocks[blockHash].number;
    }

    /// @notice The sync committee period of a slot.
    /// @param slot The beacon slot.
    function periodOf(uint64 slot) public view returns (uint64) {
        return slot / slotsPerPeriod;
    }

    /// @dev The genesis validators root and the starting store. Rule 1: the output names the stored head, header root,
    /// committee and next committee (zero equals zero), so the private starting store of the program is bound.
    function _requireStoredStart(LightClientOutput memory output) private view {
        if (output.genesisValidatorsRoot != genesisValidatorsRoot) {
            revert GenesisValidatorsRootMismatch(genesisValidatorsRoot, output.genesisValidatorsRoot);
        }
        uint64 currentHead = head;
        if (output.previousHeadSlot != currentHead) revert PreviousHeadSlotMismatch(currentHead, output.previousHeadSlot);
        bytes32 currentHeaderRoot = headers[currentHead];
        if (output.previousHeaderRoot != currentHeaderRoot) {
            revert PreviousHeaderRootMismatch(currentHeaderRoot, output.previousHeaderRoot);
        }
        uint64 headPeriod = currentHead / slotsPerPeriod;
        bytes32 currentCommittee = syncCommittees[headPeriod];
        if (output.previousSyncCommitteeHash != currentCommittee) {
            revert PreviousSyncCommitteeMismatch(currentCommittee, output.previousSyncCommitteeHash);
        }
        bytes32 currentNextCommittee = syncCommittees[headPeriod + 1];
        if (output.startNextSyncCommitteeHash != currentNextCommittee) {
            revert StartNextSyncCommitteeMismatch(currentNextCommittee, output.startNextSyncCommitteeHash);
        }
    }

    /// @dev Rules 2 to 5, the checks on the new head. Rule 2a is the clock bound. Returns whether the caller must write
    /// the committee of the new period (rule 4, empty slot).
    function _requireProgress(LightClientOutput memory output) private view returns (bool writesNewCommittee) {
        uint64 currentHead = head;
        // Rule 2: the head only moves forward. There is no jump cap.
        if (output.newHeadSlot <= currentHead) revert HeadNotAdvancing(currentHead, output.newHeadSlot);
        // Rule 2a: the head is not later than the current slot. The program has no clock, so only the contract can
        // refuse a head from the future. Without the rule, a head far ahead would block every honest update for good.
        uint64 currentSlot = BeaconClock.slotAt(block.timestamp, genesisTime, secondsPerSlot);
        if (output.newHeadSlot > currentSlot) revert HeadInFuture(output.newHeadSlot, currentSlot);
        if (output.newHeaderRoot == bytes32(0)) revert EmptyHeaderRoot();
        if (output.executionBlockHash == bytes32(0)) revert EmptyExecutionBlockHash();
        uint64 newPeriod = output.newHeadSlot / slotsPerPeriod;
        writesNewCommittee = _requireNewCommittee(currentHead / slotsPerPeriod, newPeriod, output.syncCommitteeHash);
        _requireNextCommitteeConsistent(newPeriod, output.nextSyncCommitteeHash);
    }

    /// @dev Rules 3 and 4. In the head period the output must equal the stored committee. In a later period it must
    /// equal the stored committee when one is stored. When the slot is empty the function reports that the caller must
    /// write it: the folded program proved the handoffs from a start that rules 1 bound to stored values.
    /// A zero committee hash is refused, because writing zero would leave the new head with no committee.
    /// `periodOf` is the only source of a period; the caller names none.
    function _requireNewCommittee(uint64 headPeriod, uint64 newPeriod, bytes32 committeeHash)
        private
        view
        returns (bool writesNewCommittee)
    {
        if (committeeHash == bytes32(0)) revert EmptySyncCommitteeHash();
        bytes32 stored = syncCommittees[newPeriod];
        if (newPeriod > headPeriod && stored == bytes32(0)) return true;
        if (stored != committeeHash) revert SyncCommitteeMismatch(stored, committeeHash);
        return false;
    }

    /// @dev A non-zero next committee must equal the stored next committee when one is stored. A zero value changes
    /// nothing. The contract relies on the program to output a non-zero value only when that update proves it from the
    /// attested state (the program's rule: no carried values).
    function _requireNextCommitteeConsistent(uint64 newPeriod, bytes32 nextCommitteeHash) private view {
        if (nextCommitteeHash == bytes32(0)) return;
        bytes32 storedNext = syncCommittees[newPeriod + 1];
        if (storedNext == bytes32(0)) return;
        if (storedNext != nextCommitteeHash) revert NextSyncCommitteeMismatch(storedNext, nextCommitteeHash);
    }
}
