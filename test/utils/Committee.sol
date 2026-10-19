// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";

/// @title Committee
/// @notice Builds the 512-key committee from the build contract, its sorted-pair Merkle tree,
/// membership proofs, and signature arrays sorted by ascending signer address.
library Committee {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant SIZE = 512;
    uint256 internal constant DEPTH = 9;
    /// @dev The supermajority that `LightClientSync` hard-codes.
    uint256 internal constant THRESHOLD = 342;

    /// @param keys private keys, index i derived from keccak256("committee", label, i)
    /// @param members addresses of the keys
    /// @param layers Merkle layers, layers[0] are leaves, layers[DEPTH][0] is the root
    /// @param sortedIndices key indices ordered by ascending member address
    /// @param root Merkle root of the committee
    struct Set {
        uint256[] keys;
        address[] members;
        bytes32[][] layers;
        uint256[] sortedIndices;
        bytes32 root;
    }

    /// @param signatures 65-byte signatures sorted by ascending signer address
    /// @param proofs Merkle proofs in the same order as the signatures
    struct Signed {
        bytes[] signatures;
        bytes32[][] proofs;
    }

    /// @notice Builds the committee for a chain label such as "chainA".
    function build(string memory label) internal pure returns (Set memory set) {
        set.keys = new uint256[](SIZE);
        set.members = new address[](SIZE);
        set.layers = new bytes32[][](DEPTH + 1);
        set.layers[0] = new bytes32[](SIZE);
        for (uint256 i = 0; i < SIZE; i++) {
            uint256 key = uint256(keccak256(abi.encodePacked("committee", label, i)));
            set.keys[i] = key;
            set.members[i] = vm.addr(key);
            set.layers[0][i] = leafOf(set.members[i]);
        }
        for (uint256 level = 0; level < DEPTH; level++) {
            uint256 width = SIZE >> (level + 1);
            set.layers[level + 1] = new bytes32[](width);
            for (uint256 j = 0; j < width; j++) {
                set.layers[level + 1][j] = hashPair(set.layers[level][2 * j], set.layers[level][2 * j + 1]);
            }
        }
        set.root = set.layers[DEPTH][0];
        set.sortedIndices = _sortedIndices(set.members);
    }

    /// @notice Leaf of a member, as `LightClientSync` computes it.
    function leafOf(address member) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(member));
    }

    /// @notice Sorted-pair hash used by OpenZeppelin `MerkleProof`.
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @notice The digest that the specification's committee signs.
    function attestationDigest(bytes32 attestedHeader, uint32 period) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(attestedHeader, period));
    }

    /// @notice Merkle proof (9 hashes) for the key at `index`.
    function proofOf(Set memory set, uint256 index) internal pure returns (bytes32[] memory proof) {
        proof = new bytes32[](DEPTH);
        for (uint256 level = 0; level < DEPTH; level++) {
            proof[level] = set.layers[level][index ^ 1];
            index >>= 1;
        }
    }

    /// @notice Raw 65-byte signature (r, s, v) over `digest` by key `index`, with no message prefix.
    function signWith(Set memory set, uint256 index, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(set.keys[index], digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Signs `digest` with the first `count` members in ascending address order.
    function sign(Set memory set, bytes32 digest, uint256 count) internal pure returns (Signed memory out) {
        out.signatures = new bytes[](count);
        out.proofs = new bytes32[][](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 index = set.sortedIndices[i];
            out.signatures[i] = signWith(set, index, digest);
            out.proofs[i] = proofOf(set, index);
        }
    }

    /// @notice Signs the specification's attestation digest with `count` members.
    function attest(Set memory set, bytes32 attestedHeader, uint32 period, uint256 count)
        internal
        pure
        returns (Signed memory)
    {
        return sign(set, attestationDigest(attestedHeader, period), count);
    }

    function _sortedIndices(address[] memory members) private pure returns (uint256[] memory order) {
        order = new uint256[](members.length);
        for (uint256 i = 0; i < members.length; i++) {
            uint256 j = i;
            while (j > 0 && members[order[j - 1]] > members[i]) {
                order[j] = order[j - 1];
                j--;
            }
            order[j] = i;
        }
    }
}
