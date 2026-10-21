// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice A beacon block header, as in the consensus specification.
struct BeaconBlockHeader {
    uint64 slot;
    uint64 proposerIndex;
    bytes32 parentRoot;
    bytes32 stateRoot;
    bytes32 bodyRoot;
}

/// @title SSZ
/// @notice The small part of SimpleSerialize that the bridge needs: the hash tree root of a
/// `BeaconBlockHeader`, and the check of a Merkle branch by generalized index.
/// @dev Every hash is SHA-256 through the precompile at address 0x02, which exists on Ethereum and PulseChain.
/// The compiler emits a call to that precompile for `sha256`.
library SSZ {
    /// @notice The branch length differs from the depth of the generalized index.
    error BranchLengthMismatch(uint256 expected, uint256 actual);
    /// @notice The generalized index is zero.
    error ZeroGeneralizedIndex();

    /// @notice The hash tree root of a beacon block header: five leaves padded to eight.
    /// @param header The header.
    function hashTreeRoot(BeaconBlockHeader calldata header) internal pure returns (bytes32) {
        bytes32 left = _hashPair(
            _hashPair(_uint64Leaf(header.slot), _uint64Leaf(header.proposerIndex)),
            _hashPair(header.parentRoot, header.stateRoot)
        );
        bytes32 right = _hashPair(_hashPair(header.bodyRoot, bytes32(0)), _hashPair(bytes32(0), bytes32(0)));
        return _hashPair(left, right);
    }

    /// @notice The hash tree root of a header held in memory.
    /// @param header The header.
    function hashTreeRootMemory(BeaconBlockHeader memory header) internal pure returns (bytes32) {
        bytes32 left = _hashPair(
            _hashPair(_uint64Leaf(header.slot), _uint64Leaf(header.proposerIndex)),
            _hashPair(header.parentRoot, header.stateRoot)
        );
        bytes32 right = _hashPair(_hashPair(header.bodyRoot, bytes32(0)), _hashPair(bytes32(0), bytes32(0)));
        return _hashPair(left, right);
    }

    /// @notice Checks that `leaf` sits at `generalizedIndex` under `root`, given the sibling hashes from leaf to root.
    /// @dev The branch length must equal the depth of the index, which fixes the tree shape. A branch of another
    /// length is an error, not a failed check, so a wrong fork row shows up as a clear revert.
    /// @param leaf The leaf value.
    /// @param branch The siblings, deepest first.
    /// @param generalizedIndex The generalized index of the leaf.
    /// @param root The expected root.
    function isValidBranch(bytes32 leaf, bytes32[] calldata branch, uint256 generalizedIndex, bytes32 root)
        internal
        pure
        returns (bool)
    {
        uint256 depth = depthOf(generalizedIndex);
        if (branch.length != depth) revert BranchLengthMismatch(depth, branch.length);
        bytes32 value = leaf;
        for (uint256 level = 0; level < depth; level++) {
            bool nodeIsRight = (generalizedIndex >> level) & 1 == 1;
            value = nodeIsRight ? _hashPair(branch[level], value) : _hashPair(value, branch[level]);
        }
        return value == root;
    }

    /// @notice The same check for a branch held in memory, for evidence that the caller decoded from `bytes`.
    /// @param leaf The leaf value.
    /// @param branch The siblings, deepest first.
    /// @param generalizedIndex The generalized index of the leaf.
    /// @param root The expected root.
    function isValidBranchMemory(bytes32 leaf, bytes32[] memory branch, uint256 generalizedIndex, bytes32 root)
        internal
        pure
        returns (bool)
    {
        uint256 depth = depthOf(generalizedIndex);
        if (branch.length != depth) revert BranchLengthMismatch(depth, branch.length);
        bytes32 value = leaf;
        for (uint256 level = 0; level < depth; level++) {
            bool nodeIsRight = (generalizedIndex >> level) & 1 == 1;
            value = nodeIsRight ? _hashPair(branch[level], value) : _hashPair(value, branch[level]);
        }
        return value == root;
    }

    /// @notice The depth of a generalized index: the number of bits below the leading one.
    /// @param generalizedIndex The index. It must not be zero.
    function depthOf(uint256 generalizedIndex) internal pure returns (uint256 depth) {
        if (generalizedIndex == 0) revert ZeroGeneralizedIndex();
        while (generalizedIndex > 1) {
            generalizedIndex >>= 1;
            depth++;
        }
    }

    /// @dev A uint64 leaf is the little-endian bytes of the value, padded on the right with zeros.
    function _uint64Leaf(uint64 value) private pure returns (bytes32) {
        uint64 swapped = ((value & 0xFF00FF00FF00FF00) >> 8) | ((value & 0x00FF00FF00FF00FF) << 8);
        swapped = ((swapped & 0xFFFF0000FFFF0000) >> 16) | ((swapped & 0x0000FFFF0000FFFF) << 16);
        swapped = (swapped >> 32) | (swapped << 32);
        return bytes32(uint256(swapped) << 192);
    }

    function _hashPair(bytes32 left, bytes32 right) private pure returns (bytes32) {
        return sha256(abi.encodePacked(left, right));
    }
}
