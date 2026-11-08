// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MerkleTrie} from "./vendor/optimism/trie/MerkleTrie.sol";
import {RLPReader} from "./vendor/optimism/rlp/RLPReader.sol";
import {BeaconProofVerifier} from "./BeaconProofVerifier.sol";

/// @title OpeningProofLib
/// @notice The execution layer part of the opening proof of the message bridge (`openDeposits`): the state root of the
/// proven header, the account of the remote light client, and its `executionBlockHashes` entry. All of it is pure.
/// @dev An external library, linked into `MessageBridge`, so that each contract creation of the bridge stays under the
/// per-transaction gas cap of EIP-7825 (16,777,216). It has no owner and no storage, and its address is fixed in the
/// bytecode of the bridge, so the bridge stays immutable. It reverts with the errors of `BeaconProofVerifier`.
library OpeningProofLib {
    /// @dev The index of `stateRoot` in the execution block header list.
    uint256 internal constant STATE_ROOT_FIELD = 3;
    /// @dev The index of `storageRoot` in an account (nonce, balance, storage root, code hash).
    uint256 internal constant ACCOUNT_STORAGE_ROOT_FIELD = 2;
    /// @dev The storage slot of the mapping `executionBlockHashes` in `BeaconLightClient`.
    uint256 internal constant EXECUTION_BLOCK_HASHES_MAPPING_SLOT = 3;

    /// @notice Links 2 to 4 of the opening proof, after the caller checked that `remoteHeaderRlp` hashes to the stored
    /// block hash: the header holds a state root; under it, the account of `remoteLightClient` holds a storage root;
    /// under that, `executionBlockHashes[storedSlot]` is not zero.
    function requireOpeningEntry(
        bytes calldata remoteHeaderRlp,
        bytes[] calldata accountProof,
        uint64 storedSlot,
        bytes[] calldata storageProof,
        address remoteLightClient
    ) external pure {
        bytes32 stateRoot = headerField(remoteHeaderRlp, STATE_ROOT_FIELD);
        bytes memory account =
            MerkleTrie.get(abi.encodePacked(keccak256(abi.encodePacked(remoteLightClient))), accountProof, stateRoot);
        bytes32 storageRoot = accountStorageRoot(account);
        bytes memory entry = MerkleTrie.get(
            abi.encodePacked(keccak256(abi.encode(executionBlockHashesSlot(storedSlot)))), storageProof, storageRoot
        );
        if (RLPReader.readBytes(entry).length == 0) revert BeaconProofVerifier.OpeningEntryEmpty(storedSlot);
    }

    /// @dev The storage slot of `executionBlockHashes[storedSlot]` in the remote light client: the mapping key and the
    /// declared slot of the mapping, hashed together.
    function executionBlockHashesSlot(uint64 storedSlot) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint256(storedSlot), EXECUTION_BLOCK_HASHES_MAPPING_SLOT));
    }

    /// @dev The 32-byte item at index `field` of an execution block header.
    function headerField(bytes calldata headerRlp, uint256 field) internal pure returns (bytes32) {
        RLPReader.RLPItem[] memory fields = RLPReader.readList(headerRlp);
        if (fields.length <= field) revert BeaconProofVerifier.OpeningProofMalformed();
        bytes memory value = RLPReader.readBytes(fields[field]);
        if (value.length != 32) revert BeaconProofVerifier.OpeningProofMalformed();
        return bytes32(value);
    }

    /// @dev The storage root of an account, from its RLP: nonce, balance, storage root and code hash.
    function accountStorageRoot(bytes memory account) internal pure returns (bytes32) {
        RLPReader.RLPItem[] memory fields = RLPReader.readList(account);
        if (fields.length != 4) revert BeaconProofVerifier.OpeningProofMalformed();
        bytes memory root = RLPReader.readBytes(fields[ACCOUNT_STORAGE_ROOT_FIELD]);
        if (root.length != 32) revert BeaconProofVerifier.OpeningProofMalformed();
        return bytes32(root);
    }
}
