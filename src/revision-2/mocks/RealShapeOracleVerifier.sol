// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title RealShapeOracleVerifier
/// @notice Test double with the real SP1 gateway shape: `verifyProof(bytes32,bytes,bytes)`, reverts when
/// invalid, returns nothing. It models a sound proof system: a proof exists only when the oracle signed
/// the raw digest `keccak256(abi.encodePacked(programVKey, sha256(publicValues)))`.
contract RealShapeOracleVerifier {
    error InvalidProof();

    /// @notice The address whose signature stands in for a valid zero-knowledge proof.
    address public immutable oracle;

    constructor(address oracle_) {
        oracle = oracle_;
    }

    /// @notice Reverts with `InvalidProof` unless `proofBytes` is the oracle's signature over the statement.
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view {
        if (proofBytes.length != 65) revert InvalidProof();
        bytes32 digest = keccak256(abi.encodePacked(programVKey, sha256(publicValues)));
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecoverCalldata(digest, proofBytes);
        if (error != ECDSA.RecoverError.NoError || signer != oracle) revert InvalidProof();
    }
}
