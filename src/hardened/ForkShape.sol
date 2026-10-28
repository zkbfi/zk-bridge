// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SSZ} from "./SSZ.sol";

/// @title ForkShape
/// @notice The one rule that decides which fork versions the bridge accepts, on both chains. It looks at the shape of the
/// `BeaconState` tree, never at the name of a fork version.
/// @dev A shape is a plain tree depth (5, 6 or 7) or the progressive form of Gloas, marked by `PROGRESSIVE`. A shape is
/// allowed when it is in the list that `allowedShapes` returns. That list is the only place where the set is written.
/// Both paths of `BeaconForkGate` read it: the path with EIP-4788 evidence (`judge`) and the path with the registry
/// (`isAllowed`). A new allowed shape added here reaches both paths and `allowedShapes` at once, so they cannot drift.
///
/// The evidence of one shape has two branches under the same state root:
///  - The version branch proves `fork.current_version`. In a plain tree of depth d the leaf sits at
///    `((2**d + 3) * 4) + 1` and the branch has d + 2 entries. In the progressive form it sits at 169 with 7 entries.
///  - The genesis validators root branch proves `genesis_validators_root` (field 1) at its position for that shape: `2**d + 1` with d
///    entries, or node 40 with 5 entries. The leaf is the value that the gate holds as an immutable.
/// A version branch of 7 entries fits both plain depth 5 and the progressive form. `judge` tries each and takes the
/// first for which both branches verify.
///
/// Trade-off: the rule judges the shape, not the meaning of the fields. A future fork that reorders fields at the same
/// depth passes the gate. The light client then fails closed, because its own proofs check fixed positions.
library ForkShape {
    /// @notice The marker of the progressive `BeaconState` (Gloas on).
    uint8 internal constant PROGRESSIVE = 255;
    /// @notice The smallest depth for which a seal proof is looked at. Lower depths land above the fields.
    uint8 internal constant MIN_SEAL_DEPTH = 5;
    /// @notice The largest depth for which a seal proof is looked at.
    uint8 internal constant MAX_SEAL_DEPTH = 31;
    /// @notice The depth of the three field `Fork` container.
    uint256 internal constant FORK_DEPTH = 2;

    /// @dev The generalized index of `fork.current_version` in the progressive state: node 42 times 4, plus 1.
    uint256 private constant PROGRESSIVE_VERSION_GINDEX = 169;
    /// @dev The generalized index of `genesis_validators_root` (chunk 1) in the progressive state.
    uint256 private constant PROGRESSIVE_GENESIS_VALIDATORS_ROOT_GINDEX = 40;
    /// @dev Branch length of the version leaf in the progressive state: 5 state levels and the `Fork` container.
    uint256 private constant PROGRESSIVE_VERSION_LENGTH = 7;
    /// @dev Branch length of the genesis validators root leaf in the progressive state.
    uint256 private constant PROGRESSIVE_GENESIS_VALIDATORS_ROOT_LENGTH = 5;
    /// @dev The position of `fork` among the `BeaconState` fields.
    uint256 private constant FORK_FIELD_INDEX = 3;
    /// @dev The position of `genesis_validators_root` among the `BeaconState` fields.
    uint256 private constant GENESIS_VALIDATORS_ROOT_FIELD_INDEX = 1;

    /// @notice The result of judging evidence.
    enum Verdict {
        /// @dev A shape in the allowed set, with both branches valid.
        Allowed,
        /// @dev No candidate shape has a valid version branch.
        VersionProofInvalid,
        /// @dev The version branch is valid for a candidate shape, but its genesis validators root branch is not.
        GenesisValidatorsRootProofInvalid,
        /// @dev The version branch length fits no allowed shape.
        ShapeNotAllowed
    }

    /// @notice The allowed shapes, in the order in which `judge` tries them.
    function allowedShapes() internal pure returns (uint8[] memory shapes) {
        shapes = new uint8[](4);
        shapes[0] = 5;
        shapes[1] = 6;
        shapes[2] = 7;
        shapes[3] = PROGRESSIVE;
    }

    /// @notice Whether a shape is in the allowed set. The registry path uses this check.
    /// @param shape A plain depth, or `PROGRESSIVE`.
    function isAllowed(uint8 shape) internal pure returns (bool) {
        uint8[] memory shapes = allowedShapes();
        for (uint256 i = 0; i < shapes.length; i++) {
            if (shapes[i] == shape) return true;
        }
        return false;
    }

    /// @notice The generalized index of `fork.current_version` for an allowed shape.
    function versionGindex(uint8 shape) internal pure returns (uint256) {
        if (shape == PROGRESSIVE) return PROGRESSIVE_VERSION_GINDEX;
        return plainVersionGindex(shape);
    }

    /// @notice The generalized index of `fork.current_version` in a plain tree of any depth.
    function plainVersionGindex(uint256 depth) internal pure returns (uint256) {
        return (((uint256(1) << depth) + FORK_FIELD_INDEX) * 4) + 1;
    }

    /// @notice The generalized index of `genesis_validators_root` for an allowed shape.
    function genesisValidatorsRootGindex(uint8 shape) internal pure returns (uint256) {
        if (shape == PROGRESSIVE) return PROGRESSIVE_GENESIS_VALIDATORS_ROOT_GINDEX;
        return (uint256(1) << shape) + GENESIS_VALIDATORS_ROOT_FIELD_INDEX;
    }

    /// @notice The number of entries in the version branch of an allowed shape.
    function versionBranchLength(uint8 shape) internal pure returns (uint256) {
        if (shape == PROGRESSIVE) return PROGRESSIVE_VERSION_LENGTH;
        return uint256(shape) + FORK_DEPTH;
    }

    /// @notice The number of entries in the genesis validators root branch of an allowed shape.
    function genesisValidatorsRootBranchLength(uint8 shape) internal pure returns (uint256) {
        if (shape == PROGRESSIVE) return PROGRESSIVE_GENESIS_VALIDATORS_ROOT_LENGTH;
        return shape;
    }

    /// @notice The tree depth that a version branch length implies, or zero when the length is below the `Fork` depth.
    function depthOfVersionBranch(uint256 length) internal pure returns (uint256) {
        if (length < FORK_DEPTH) return 0;
        return length - FORK_DEPTH;
    }

    /// @notice Judges the evidence of the EIP-4788 path.
    /// @param stateRoot The state root of the header that the beacon roots contract vouches for.
    /// @param version The claimed `fork.current_version`.
    /// @param versionBranch The branch of the version leaf, deepest first.
    /// @param genesisValidatorsRootBranch The branch of `genesis_validators_root`, deepest first.
    /// @param genesisValidatorsRoot The value that the genesis validators root leaf must hold.
    /// @return verdict The result.
    /// @return shape The shape that was proven. Zero unless the verdict is `Allowed`.
    function judge(
        bytes32 stateRoot,
        bytes4 version,
        bytes32[] memory versionBranch,
        bytes32[] memory genesisValidatorsRootBranch,
        bytes32 genesisValidatorsRoot
    ) internal pure returns (Verdict verdict, uint8 shape) {
        uint8[] memory shapes = allowedShapes();
        bool anyCandidate;
        bool versionProven;
        for (uint256 i = 0; i < shapes.length; i++) {
            uint8 candidate = shapes[i];
            if (versionBranch.length != versionBranchLength(candidate)) continue;
            anyCandidate = true;
            if (!SSZ.isValidBranchMemory(bytes32(version), versionBranch, versionGindex(candidate), stateRoot)) continue;
            versionProven = true;
            if (_genesisValidatorsRootHolds(candidate, genesisValidatorsRootBranch, genesisValidatorsRoot, stateRoot)) return (Verdict.Allowed, candidate);
        }
        if (!anyCandidate) return (Verdict.ShapeNotAllowed, 0);
        if (versionProven) return (Verdict.GenesisValidatorsRootProofInvalid, 0);
        return (Verdict.VersionProofInvalid, 0);
    }

    /// @notice Whether a version branch is valid at the plain position of `depth`. A seal uses it for a depth outside
    /// the allowed set. The branch length must equal `depth + 2`.
    /// @param stateRoot The state root.
    /// @param version The claimed version.
    /// @param versionBranch The branch of the version leaf.
    /// @param depth The plain tree depth that the branch length implies.
    function provesPlainVersion(bytes32 stateRoot, bytes4 version, bytes32[] memory versionBranch, uint256 depth)
        internal
        pure
        returns (bool)
    {
        return SSZ.isValidBranchMemory(bytes32(version), versionBranch, plainVersionGindex(depth), stateRoot);
    }

    /// @dev Whether the genesis validators root branch has the length of the shape and proves the genesis validators root.
    function _genesisValidatorsRootHolds(uint8 shape, bytes32[] memory genesisValidatorsRootBranch, bytes32 genesisValidatorsRoot, bytes32 stateRoot)
        private
        pure
        returns (bool)
    {
        if (genesisValidatorsRootBranch.length != genesisValidatorsRootBranchLength(shape)) return false;
        return SSZ.isValidBranchMemory(genesisValidatorsRoot, genesisValidatorsRootBranch, genesisValidatorsRootGindex(shape), stateRoot);
    }
}
