// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

contract LightClientSync {
    using ECDSA for bytes32;

    bytes32 public currentCommitteeRoot;
    uint32 public currentPeriod;

    mapping(bytes32 => bool) public isVerifiedBlockRoot;
    mapping(uint32 => bool) public finalizedPeriods;

    event LightClientUpdate(uint32 indexed period, bytes32 indexed blockRoot);

    constructor(bytes32 _initialCommitteeRoot, uint32 _initialPeriod) {
        currentCommitteeRoot = _initialCommitteeRoot;
        currentPeriod = _initialPeriod;
    }

    /**
     * @notice Permissionlessly update the latest chain state using Sync Committee signatures.
     * @dev Signatures and Merkle proofs MUST be sorted by validator address off-chain to enforce O(N) gas performance.
     */
    function updateSyncState(
        uint32 period,
        bytes32 attestedHeader,
        bytes[] calldata signatures,
        bytes32[][] calldata merkleProofs, // Merkle path proofs proving membership in the active committee
        bytes32 nextCommitteeRoot
    ) external {
        require(period >= currentPeriod, "Cannot submit an ancient consensus period");
        require(!finalizedPeriods[period], "Period state already finalized");
        require(signatures.length == merkleProofs.length, "Mismatched proof/signature array dimensions");

        bytes32 signingRoot = keccak256(abi.encodePacked(attestedHeader, period));
        uint256 validSignaturesCount = 0;
        address lastValidatorAddress = address(0);

        for (uint256 i = 0; i < signatures.length; i++) {
            address validatorAddress = signingRoot.recover(signatures[i]);
            // FIXED (Gas Optimization): Force off-chain sorting to achieve O(N) execution velocity.
            // This strictly forbids duplicate entries or backward out-of-order execution states.
            require(validatorAddress > lastValidatorAddress, "Signatures not strictly ordered or duplicate detected");
            lastValidatorAddress = validatorAddress;

            // FIXED (Security): Cryptographically confirm membership inside the legitimate committee set
            bytes32 leaf = keccak256(abi.encodePacked(validatorAddress));
            bool isMember = MerkleProof.verify(merkleProofs[i], currentCommitteeRoot, leaf);
            
            if (isMember) {
                validSignaturesCount++;
            }
        }

        // Enforce the strict 2/3 supermajority rule
        require(validSignaturesCount >= 342, "Insufficient unique valid sync committee signatures");

        isVerifiedBlockRoot[attestedHeader] = true;
        finalizedPeriods[period] = true;

        if (period > currentPeriod && nextCommitteeRoot != bytes32(0)) {
            currentCommitteeRoot = nextCommitteeRoot;
            currentPeriod = period;
        }

        emit LightClientUpdate(period, attestedHeader);
    }
}