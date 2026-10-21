// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISP1Verifier} from "./ISP1Verifier.sol";
import {IForkRegistry} from "./IForkRegistry.sol";

/// @notice The part of the light client of the observed chain that the registry reads.
interface IObservedLightClient {
    function head() external view returns (uint64);
    function headers(uint64 slot) external view returns (bytes32);
    function syncCommittees(uint64 period) external view returns (bytes32);
    function slotsPerPeriod() external view returns (uint64);
    function genesisValidatorsRoot() external view returns (bytes32);
    function programVKey() external view returns (bytes32);
}

/// @title ForkRegistry
/// @notice Records the fork versions that a sync committee of the observed chain signed under (hole HB-02 on
/// PulseChain). A sync committee signs under the real current fork version of its chain, so a proof that two thirds of
/// a bound committee signed under version V shows that the chain runs V at that slot. The proof needs no knowledge of
/// the state layout of V. The registry has no owner and no way to remove an entry.
/// @dev The observation program has its own verification key, different from the light client program. A proof of one
/// program therefore never passes the other contract. The start fields are checked against the light client exactly as
/// the light client checks its own updates (rule 1). The observation never moves the head of the light client.
contract ForkRegistry is IForkRegistry {
    /// @notice The public values of the observation program, in `abi.encode` order.
    struct ForkObservation {
        bytes32 genesisValidatorsRoot;
        bytes32 previousHeaderRoot;
        uint64 previousHeadSlot;
        bytes32 previousSyncCommitteeHash;
        bytes32 startNextSyncCommitteeHash;
        bytes4 observedVersion;
        uint64 observedAttestedSlot;
    }

    /// @dev One storage slot.
    struct Latest {
        bytes4 version;
        uint64 slot;
    }

    /// @notice The size of the encoded observation: seven static words.
    uint256 public constant PUBLIC_VALUES_LENGTH = 224;

    /// @notice A constructor argument is zero.
    error ZeroValue(string name);
    /// @notice The observation key equals the light client key, so the two kinds of proof could be swapped.
    error ObservationKeyEqualsLightClientKey(bytes32 key);
    /// @notice The public values do not have the length of an encoded `ForkObservation`.
    error InvalidPublicValuesLength(uint256 actual);
    /// @notice The observation belongs to another chain.
    error GenesisValidatorsRootMismatch(bytes32 expected, bytes32 actual);
    /// @notice The observation starts from another head slot than the stored head.
    error PreviousHeadSlotMismatch(uint64 expected, uint64 actual);
    /// @notice The observation starts from another header root than the stored one.
    error PreviousHeaderRootMismatch(bytes32 expected, bytes32 actual);
    /// @notice The observation starts from another committee than the stored one.
    error PreviousSyncCommitteeMismatch(bytes32 expected, bytes32 actual);
    /// @notice The observation starts from another next committee than the stored one (zero equals zero).
    error StartNextSyncCommitteeMismatch(bytes32 expected, bytes32 actual);
    /// @notice The attested slot is not past the head of the light client (replay of an old observation).
    error ObservationNotFresh(uint64 head, uint64 observedAttestedSlot);

    /// @notice Emitted for every accepted observation.
    event ForkObserved(bytes4 indexed version, uint64 slot);

    /// @notice The light client of the observed chain, deployed on this chain.
    IObservedLightClient public immutable lightClient;
    /// @notice The proof system that checks observation proofs.
    ISP1Verifier public immutable verifier;
    /// @notice The verification key of the observation program.
    bytes32 public immutable observationProgramVKey;

    /// @notice The lowest attested slot seen for a version, or zero when never seen.
    mapping(bytes4 version => uint64 slot) public firstSeenSlot;
    Latest private _latest;

    /// @param lightClient_ The light client of the observed chain on this chain.
    /// @param verifier_ A specific SP1 verifier contract, not the ownable gateway.
    /// @param observationProgramVKey_ The key of the observation program. It must differ from the light client key.
    constructor(address lightClient_, address verifier_, bytes32 observationProgramVKey_) {
        if (lightClient_ == address(0)) revert ZeroValue("lightClient");
        if (verifier_ == address(0)) revert ZeroValue("verifier");
        if (observationProgramVKey_ == bytes32(0)) revert ZeroValue("observationProgramVKey");
        bytes32 lightClientKey = IObservedLightClient(lightClient_).programVKey();
        if (lightClientKey == observationProgramVKey_) revert ObservationKeyEqualsLightClientKey(lightClientKey);
        lightClient = IObservedLightClient(lightClient_);
        verifier = ISP1Verifier(verifier_);
        observationProgramVKey = observationProgramVKey_;
    }

    /// @notice Records a proven observation. Anyone may call it.
    /// @dev Checks run in a fixed order and the proof check comes last, like `BeaconLightClient.update`.
    /// @param proof The proof of the observation program.
    /// @param publicValues The `abi.encode` of a `ForkObservation`.
    function observe(bytes calldata proof, bytes calldata publicValues) external {
        if (publicValues.length != PUBLIC_VALUES_LENGTH) revert InvalidPublicValuesLength(publicValues.length);
        ForkObservation memory observation = abi.decode(publicValues, (ForkObservation));
        _requireStoredStart(observation);

        verifier.verifyProof(observationProgramVKey, publicValues, proof);

        bytes4 version = observation.observedVersion;
        uint64 slot = observation.observedAttestedSlot;
        uint64 first = firstSeenSlot[version];
        if (first == 0 || slot < first) firstSeenSlot[version] = slot;
        if (slot > _latest.slot) _latest = Latest({version: version, slot: slot});
        emit ForkObserved(version, slot);
    }

    /// @notice The version seen under the highest attested slot, or zero when nothing was observed.
    function latestObservedVersion() external view returns (bytes4) {
        return _latest.version;
    }

    /// @inheritdoc IForkRegistry
    function latestObserved() external view override returns (bytes4 version, uint64 slot) {
        Latest memory latest = _latest;
        return (latest.version, latest.slot);
    }

    /// @dev Freshness (the attested slot is strictly past the head), then light-client rule 1 for the five start fields.
    function _requireStoredStart(ForkObservation memory observation) private view {
        IObservedLightClient client = lightClient;
        uint64 head = client.head();
        // Freshness first: an observation at or before the head is a replay, whatever its start fields say.
        if (observation.observedAttestedSlot <= head) {
            revert ObservationNotFresh(head, observation.observedAttestedSlot);
        }
        bytes32 genesisRoot = client.genesisValidatorsRoot();
        if (observation.genesisValidatorsRoot != genesisRoot) {
            revert GenesisValidatorsRootMismatch(genesisRoot, observation.genesisValidatorsRoot);
        }
        if (observation.previousHeadSlot != head) revert PreviousHeadSlotMismatch(head, observation.previousHeadSlot);
        bytes32 headerRoot = client.headers(head);
        if (observation.previousHeaderRoot != headerRoot) {
            revert PreviousHeaderRootMismatch(headerRoot, observation.previousHeaderRoot);
        }
        uint64 period = head / client.slotsPerPeriod();
        bytes32 committee = client.syncCommittees(period);
        if (observation.previousSyncCommitteeHash != committee) {
            revert PreviousSyncCommitteeMismatch(committee, observation.previousSyncCommitteeHash);
        }
        bytes32 nextCommittee = client.syncCommittees(period + 1);
        if (observation.startNextSyncCommitteeHash != nextCommittee) {
            revert StartNextSyncCommitteeMismatch(nextCommittee, observation.startNextSyncCommitteeHash);
        }
    }
}
