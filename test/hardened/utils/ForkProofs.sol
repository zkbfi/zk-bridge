// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconProofVerifier} from "../../../src/hardened/BeaconProofVerifier.sol";
import {SSZ} from "../../../src/hardened/SSZ.sol";

/// @title ForkProofs
/// @notice Builds beacon states as real sparse Merkle trees that hold `genesis_validators_root` and `fork.current_version`
/// at the positions of one shape, and the `ForkProof` that the bridge reads from them. A state may hold more leaves (an
/// anchor holds `block_roots` entries). The positions are written here by hand, not taken from `ForkShape`, so a test
/// that uses them checks the library against an independent copy.
/// @dev The sparse tree holds the given leaves, zero under every node with no leaf below, and the hash of the children
/// elsewhere. The leaves may lie at different depths, but none may lie below another.
library ForkProofs {
    /// @notice The marker of the progressive state (Gloas on), the value of `ForkShape.PROGRESSIVE`.
    uint8 internal constant PROGRESSIVE = 255;
    /// @notice A plain depth outside the allowed shapes: a valid proof of it is refused.
    uint8 internal constant DISALLOWED_DEPTH = 8;
    /// @notice The version that the plain states of the tests hold. The bridge does not judge it by name.
    bytes4 internal constant PLAIN_VERSION = 0x06000000;
    /// @notice The version that the progressive states of the tests hold.
    bytes4 internal constant PROGRESSIVE_VERSION = 0x07000000;

    /// @notice One state and the proofs that the tests need from it.
    /// @param root The state root.
    /// @param fork The fork proof of the state.
    /// @param extraBranches The branches of the extra leaves, in the order given.
    struct ForkedState {
        bytes32 root;
        BeaconProofVerifier.ForkProof fork;
        bytes32[][] extraBranches;
    }

    /// @notice A state of `shape` (a plain depth, or `PROGRESSIVE`) that holds `genesisRoot` and the version of the shape.
    function state(uint8 shape, bytes32 genesisRoot) internal pure returns (ForkedState memory) {
        return stateWith(shape, genesisRoot, versionOf(shape), new uint256[](0), new bytes32[](0));
    }

    /// @notice A state of `shape` that holds `genesisRoot`, `version` and the extra leaves.
    function stateWith(
        uint8 shape,
        bytes32 genesisRoot,
        bytes4 version,
        uint256[] memory extraGindices,
        bytes32[] memory extraLeaves
    ) internal pure returns (ForkedState memory result) {
        uint256 count = extraGindices.length + 4;
        uint256[] memory gindices = new uint256[](count);
        bytes32[] memory leaves = new bytes32[](count);
        uint256 versionGindex = versionGindexOf(shape);
        // `Fork` is (previous_version, current_version, epoch, empty): the version leaf is the second of four.
        gindices[0] = versionGindex;
        leaves[0] = bytes32(version);
        gindices[1] = versionGindex - 1;
        leaves[1] = bytes32(bytes4(0x05000000));
        gindices[2] = versionGindex + 1;
        leaves[2] = keccak256("the fork.epoch leaf");
        gindices[3] = genesisGindexOf(shape);
        leaves[3] = genesisRoot;
        for (uint256 i = 0; i < extraGindices.length; i++) {
            gindices[i + 4] = extraGindices[i];
            leaves[i + 4] = extraLeaves[i];
        }
        bytes32[][] memory branches;
        (result.root, branches) = sparseTree(gindices, leaves);
        result.fork = BeaconProofVerifier.ForkProof(version, branches[0], branches[3]);
        result.extraBranches = new bytes32[][](extraGindices.length);
        for (uint256 i = 0; i < extraGindices.length; i++) {
            result.extraBranches[i] = branches[i + 4];
        }
    }

    /// @notice The shape whose `block_roots` position is `blockRootsGindex`: the plain depth, or `PROGRESSIVE` for 352.
    function shapeOfBlockRoots(uint256 blockRootsGindex) internal pure returns (uint8) {
        if (blockRootsGindex == 352) return PROGRESSIVE;
        return uint8(SSZ.depthOf(blockRootsGindex));
    }

    /// @notice The version that the states of the tests hold for a shape.
    function versionOf(uint8 shape) internal pure returns (bytes4) {
        return shape == PROGRESSIVE ? PROGRESSIVE_VERSION : PLAIN_VERSION;
    }

    /// @notice `fork.current_version`: 169 in the progressive state, `(2**d + 3) * 4 + 1` in a plain one.
    function versionGindexOf(uint8 shape) internal pure returns (uint256) {
        if (shape == PROGRESSIVE) return 169;
        return ((uint256(1) << shape) + 3) * 4 + 1;
    }

    /// @notice `genesis_validators_root`: 40 in the progressive state, `2**d + 1` in a plain one.
    function genesisGindexOf(uint8 shape) internal pure returns (uint256) {
        if (shape == PROGRESSIVE) return 40;
        return (uint256(1) << shape) + 1;
    }

    /// @notice The root and the branches of a sparse tree with the given leaves. Built bottom up, level by level (the
    /// algorithm of `HistoricalScenes._mixedTree`), so leaves 45 levels deep cost little. An empty node is zero; no check
    /// of the tests reads below one.
    function sparseTree(uint256[] memory gindices, bytes32[] memory leaves)
        internal
        pure
        returns (bytes32 root, bytes32[][] memory branches)
    {
        uint256 count = gindices.length;
        uint256 maxDepth;
        for (uint256 k = 0; k < count; k++) {
            uint256 depth = SSZ.depthOf(gindices[k]);
            if (depth > maxDepth) maxDepth = depth;
        }
        Nodes memory nodes = Nodes(
            new uint256[](count * (maxDepth + 1)),
            new uint256[](count * (maxDepth + 1)),
            new bytes32[](count * (maxDepth + 1)),
            0
        );
        for (uint256 k = 0; k < count; k++) {
            _add(nodes, gindices[k], SSZ.depthOf(gindices[k]), leaves[k]);
        }
        for (uint256 level = maxDepth; level > 0; level--) {
            uint256 limit = nodes.known;
            for (uint256 j = 0; j < limit; j++) {
                if (nodes.depth[j] != level) continue;
                uint256 parent = nodes.index[j] >> 1;
                if (_find(nodes, parent) != type(uint256).max) continue;
                bytes32 left = _valueOf(nodes, parent * 2);
                bytes32 right = _valueOf(nodes, parent * 2 + 1);
                _add(nodes, parent, level - 1, sha256(abi.encodePacked(left, right)));
            }
        }
        root = _valueOf(nodes, 1);
        branches = new bytes32[][](count);
        for (uint256 k = 0; k < count; k++) {
            uint256 g = gindices[k];
            branches[k] = new bytes32[](SSZ.depthOf(g));
            for (uint256 i = 0; i < branches[k].length; i++) {
                branches[k][i] = _valueOf(nodes, g ^ 1);
                g >>= 1;
            }
        }
    }

    /// @dev The known nodes of a tree under construction.
    struct Nodes {
        uint256[] index;
        uint256[] depth;
        bytes32[] value;
        uint256 known;
    }

    function _add(Nodes memory nodes, uint256 index, uint256 depth, bytes32 value) private pure {
        nodes.index[nodes.known] = index;
        nodes.depth[nodes.known] = depth;
        nodes.value[nodes.known] = value;
        nodes.known++;
    }

    function _find(Nodes memory nodes, uint256 index) private pure returns (uint256) {
        for (uint256 i = 0; i < nodes.known; i++) {
            if (nodes.index[i] == index) return i;
        }
        return type(uint256).max;
    }

    function _valueOf(Nodes memory nodes, uint256 index) private pure returns (bytes32) {
        uint256 at = _find(nodes, index);
        return at == type(uint256).max ? bytes32(0) : nodes.value[at];
    }
}
