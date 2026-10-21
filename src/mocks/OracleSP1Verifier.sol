// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ISP1Verifier} from "../hardened/ISP1Verifier.sol";

/// @title OracleSP1Verifier
/// @notice Models a sound proof system with the real gateway shape.
/// A proof exists only when the reference prover (the oracle) accepted the statement.
contract OracleSP1Verifier is ISP1Verifier {
    /// @notice The proof is not a 65-byte signature by the oracle over the expected digest.
    error InvalidProof();

    /// @notice The address whose signature stands in for a valid zero-knowledge proof.
    address public immutable oracle;

    /// @param oracle_ The address of the reference prover.
    constructor(address oracle_) {
        oracle = oracle_;
    }

    /// @notice Succeeds only for a 65-byte signature by the oracle.
    /// @dev The signed digest is `keccak256(abi.encodePacked(programVKey, sha256(publicValues)))`, with no message prefix.
    /// @param programVKey The verification key of the program.
    /// @param publicValues The committed public values.
    /// @param proofBytes The signature by the oracle.
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes)
        external
        view
        override
    {
        if (proofBytes.length != 65) revert InvalidProof();
        bytes32 digest = keccak256(abi.encodePacked(programVKey, sha256(publicValues)));
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecoverCalldata(digest, proofBytes);
        if (error != ECDSA.RecoverError.NoError) revert InvalidProof();
        if (signer != oracle) revert InvalidProof();
    }
}
