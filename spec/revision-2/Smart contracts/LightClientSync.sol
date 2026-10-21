// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

contract LightClientSync {
    using ECDSA for bytes32;

    bytes32 public currentCommitteeRoot;
    uint32 public currentPeriod;

    // FIXED (H-07): Tracks cumulative distinct block roots linearly to prevent 27-hour user lockout vectors
    mapping(bytes32 => bool) public isVerifiedBlockRoot;
    mapping(uint32 => bytes32) public historicalCommitteeRoots;
    mapping(uint32 => bool) public finalizedPeriods;

    event LightClientUpdate(uint32 indexed period, bytes32 indexed blockRoot);

    constructor(bytes32 _initialCommitteeRoot, uint32 _initialPeriod) {
        currentCommitteeRoot = _initialCommitteeRoot;
        currentPeriod = _initialPeriod;
        historicalCommitteeRoots[_initialPeriod] = _initialCommitteeRoot;
    }

    /**
     * @notice Permissionlessly update the latest chain state using Sync Committee signatures.
     * @dev Signatures and Merkle proofs MUST be sorted by validator address off-chain to enforce O(N) performance.
     */
    function updateSyncState(
        uint32 period,
        bytes32 attestedHeader,
        bytes[] calldata signatures,
        bytes32[][] calldata merkleProofs,
        bytes32 nextCommitteeRoot
    ) external {
        require(period >= currentPeriod, "Ancient period profile");
        require(signatures.length == merkleProofs.length, "Mismatched array dimensions");

        // FIXED (H-01): nextCommitteeRoot is hashed into the signing message to prevent front-running mempool hijacking
        bytes32 signingRoot = keccak256(abi.encodePacked(attestedHeader, period, nextCommitteeRoot));
        uint256 validSignaturesCount = 0;
        address lastValidatorAddress = address(0);

        for (uint256 i = 0; i < signatures.length; i++) {
            // FIXED (H-14): Using tryRecover safely traps malformed signature execution states without reverting the transaction
            (address validatorAddress, ECDSA.RecoverError err, ) = signingRoot.tryRecover(signatures[i]);
            if (err != ECDSA.RecoverError.NoError || validatorAddress == address(0)) continue;

            // Enforce strict ascending order to guarantee uniqueness in a single O(N) pass (H-15 Gas Hardened)
            require(validatorAddress > lastValidatorAddress, "Signatures not strictly ordered or duplicate detected");
            lastValidatorAddress = validatorAddress;

            bytes32 leaf = keccak256(abi.encodePacked(validatorAddress));
            if (MerkleProof.verify(merkleProofs[i], currentCommitteeRoot, leaf)) {
                validSignaturesCount++;
            }
        }

        // Enforce the strict 2/3 supermajority rule (>= 342 out of 512 validators)
        require(validSignaturesCount >= 342, "Insufficient unique valid sync committee signatures");

        isVerifiedBlockRoot[attestedHeader] = true;

        if (period > currentPeriod && nextCommitteeRoot != bytes32(0)) {
            finalizedPeriods[currentPeriod] = true;
            currentCommitteeRoot = nextCommitteeRoot;
            currentPeriod = period;
            historicalCommitteeRoots[period] = nextCommitteeRoot;
        }

        emit LightClientUpdate(period, attestedHeader);
    }
}