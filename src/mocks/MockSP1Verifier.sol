// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title MockSP1Verifier
/// @notice Models a sound proof system using the specification's `verify` interface.
/// A proof exists only when the reference prover (the oracle) signed the statement.
contract MockSP1Verifier {
    /// @notice The address whose signature stands in for a valid zero-knowledge proof.
    address public immutable proverOracle;

    constructor(address _proverOracle) {
        proverOracle = _proverOracle;
    }

    /// @notice Returns true only for a 65-byte signature by the oracle over the raw digest.
    /// @dev Never reverts. The digest has no Ethereum message prefix.
    function verify(bytes32 programVKey, bytes32 publicInputsHash, bytes calldata proof)
        external
        view
        returns (bool)
    {
        if (proof.length != 65) return false;
        bytes32 digest = keccak256(abi.encodePacked(programVKey, publicInputsHash));
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecoverCalldata(digest, proof);
        if (error != ECDSA.RecoverError.NoError) return false;
        return signer == proverOracle;
    }
}
