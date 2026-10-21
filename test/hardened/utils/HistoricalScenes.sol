// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconLightClient} from "../../../src/hardened/BeaconLightClient.sol";
import {BridgeVault} from "../../../src/hardened/BridgeVault.sol";
import {BeaconBlockHeader, SSZ} from "../../../src/hardened/SSZ.sol";
import {WithdrawalScenes} from "./WithdrawalScenes.sol";
import {ReceiptFixtures} from "./ReceiptFixtures.sol";

/// @notice Builds withdrawal evidence for the historical path. The anchor state is a sparse Merkle tree. It holds the
/// header root of each deposit at the historical position, which this file computes BY HAND (no call into the vault).
/// Optionally the same state also holds the recent `block_roots` leaves, so one anchor can serve both paths.
///
/// A scene stores these headers in the light client, in slot order: a low body evidence header (40 slots below the
/// lowest deposit), the historical evidence header, extra headers that a test asks for, two recent filler headers
/// (only when the state holds recent leaves), and the anchor.
abstract contract HistoricalScenes is WithdrawalScenes {
    /// @param anchorSlot The slot of the anchor header.
    /// @param capellaEra `floor(capellaForkSlot / 8192)` of the simulated chain.
    /// @param historicalSummariesGindex The position of `historical_summaries` in the state (59 or 91).
    /// @param blockRootsGindex The position of `block_roots` in the state (37 or 69), or zero for a state without recent leaves.
    /// @param evidenceSlot A stored slot in a completed era at or after `capellaEra`, more than 8192 below the anchor.
    /// @param depositSlots The slots of the deposit headers. Each one gets a leaf at the historical position.
    /// @param extraStoredSlots More slots to store. Each one below the anchor, at or after `capellaEra`, gets a leaf too.
    struct HistoricalParams {
        uint64 anchorSlot;
        uint64 capellaEra;
        uint256 historicalSummariesGindex;
        uint256 blockRootsGindex;
        uint64 evidenceSlot;
        uint64[] depositSlots;
        uint64[] extraStoredSlots;
    }

    /// @notice The result of building a historical scene.
    struct HistoricalScene {
        BeaconBlockHeader anchorHeader;
        bytes32 anchorRoot;
        bytes32 blockHash;
        BeaconBlockHeader[] depositHeaders;
        bytes32[][] historicalBranches;
        bytes32[][] recentBranches;
        bytes32[][] blockHashBranches;
        bytes32[][] extraBranches;
        BeaconBlockHeader evidenceHeader;
        BridgeVault.HistoricalSummariesEvidence historicalEvidence;
        BridgeVault.BlockRootsEvidence rootsEvidence;
        BridgeVault.BlockHashEvidence anchorBodyEvidence;
        BridgeVault.BlockHashEvidence lowBodyEvidence;
    }

    /// @dev A header that the scene stores in the light client.
    struct StoredHeader {
        uint64 slot;
        bytes32 root;
    }

    /// @dev The leaves of a sparse tree under construction.
    struct LeafSet {
        uint256[] gindices;
        bytes32[] roots;
        uint256 count;
    }

    /// @dev Where each leaf sits in the `LeafSet`.
    struct LeafPositions {
        uint256[] deposit;
        uint256[] recent;
        uint256[] extra;
        uint256 evidence;
        uint256 fillerA;
        uint256 fillerB;
    }

    uint256 internal constant BODY_GINDEX = 812;
    uint256 internal constant NO_LEAF = type(uint256).max;
    /// @dev The depth of the state container in an Electra-like fork (37 or 38 fields, padded to 64 leaves).
    uint256 internal constant ELECTRA_STATE_DEPTH = 6;

    // ---------------------------------------------------------------- worlds and parameters

    /// @notice A light client that starts at `initialSlot`, and a vault on chain B with `capellaEra`, funded with tokens.
    /// The fixture's `lightClientForB` is replaced, so every later scene stores its headers in the new client.
    function _historicalWorld(uint64 initialSlot, uint64 capellaEra) internal returns (BridgeVault vault_) {
        lightClientForB = new BeaconLightClient(
            address(verifier),
            LIGHT_CLIENT_VKEY,
            GENESIS_ROOT_A,
            SLOTS_PER_PERIOD,
            initialSlot,
            INITIAL_HEADER_ROOT,
            COMMITTEE_100,
            COMMITTEE_101
        );
        vault_ = _newWithdrawalVault(0, capellaEra);
        tokenOnB.mint(address(vault_), 1_000_000e18);
    }

    /// @notice Parameters for a state without recent leaves and without extra headers.
    function _historicalParams(
        uint64 anchorSlot,
        uint64 capellaEra,
        uint256 historicalSummariesGindex,
        uint64 evidenceSlot,
        uint64[] memory depositSlots
    ) internal pure returns (HistoricalParams memory params) {
        params.anchorSlot = anchorSlot;
        params.capellaEra = capellaEra;
        params.historicalSummariesGindex = historicalSummariesGindex;
        params.evidenceSlot = evidenceSlot;
        params.depositSlots = depositSlots;
        params.extraStoredSlots = new uint64[](0);
    }

    function _noSlots() internal pure returns (uint64[] memory out) {
        out = new uint64[](0);
    }

    function _slots(uint64 a) internal pure returns (uint64[] memory out) {
        out = new uint64[](1);
        out[0] = a;
    }

    function _slots(uint64 a, uint64 b) internal pure returns (uint64[] memory out) {
        out = new uint64[](2);
        out[0] = a;
        out[1] = b;
    }

    function _slots(uint64 a, uint64 b, uint64 c) internal pure returns (uint64[] memory out) {
        out = new uint64[](3);
        out[0] = a;
        out[1] = b;
        out[2] = c;
    }

    function _slots(uint64 a, uint64 b, uint64 c, uint64 d) internal pure returns (uint64[] memory out) {
        out = new uint64[](4);
        out[0] = a;
        out[1] = b;
        out[2] = c;
        out[3] = d;
    }

    // ---------------------------------------------------------------- the positions, written out by hand

    /// @notice The generalized index of the summary leaf of a deposit, with a list depth that the caller names.
    /// @dev Written out here, step by step, and independent of the vault. The honest list depth is 24
    /// (`HISTORICAL_ROOTS_LIMIT = 2**24`). Other depths model a state built with another limit.
    function _historicalLeafWithListDepth(uint256 field, uint64 capellaEra, uint64 slot, uint256 listDepth)
        internal
        pure
        returns (uint256 g)
    {
        uint256 index = uint256(slot / 8192) - uint256(capellaEra);
        g = field;
        g = g * 2; // the data root of the list, past the length mix-in
        g = g * (2 ** listDepth) + index; // the position in the list
        g = g * 2; // `block_summary_root`, the first field of the summary
        g = g * 8192 + (slot % 8192); // the position inside the block roots of that era
    }

    /// @notice The honest historical leaf position (list depth 24).
    function _historicalLeaf(uint256 field, uint64 capellaEra, uint64 slot) internal pure returns (uint256) {
        return _historicalLeafWithListDepth(field, capellaEra, slot, 24);
    }

    /// @notice The recent leaf position of `block_roots[slot % 8192]`.
    function _recentLeaf(uint256 blockRootsField, uint64 slot) internal pure returns (uint256) {
        return blockRootsField * 8192 + (slot % 8192);
    }

    // ---------------------------------------------------------------- building

    function _defaultHeaderRlp() internal pure returns (bytes memory) {
        return _executionHeaderRlp(ReceiptFixtures.RECEIPTS_ROOT, 17);
    }

    /// @notice Builds a scene and stores its headers in the light client. It adds no layout to any vault.
    function _historicalScene(HistoricalParams memory params) internal returns (HistoricalScene memory scene) {
        scene = _buildHistorical(params, _defaultHeaderRlp());
        _storeHistorical(params, scene);
    }

    /// @notice Builds a scene. Nothing is stored.
    function _buildHistorical(HistoricalParams memory params, bytes memory headerRlp)
        internal
        pure
        returns (HistoricalScene memory scene)
    {
        scene.blockHash = keccak256(headerRlp);
        uint256 depositCount = params.depositSlots.length;
        scene.depositHeaders = new BeaconBlockHeader[](depositCount);
        scene.blockHashBranches = new bytes32[][](depositCount);
        for (uint256 i = 0; i < depositCount; i++) {
            (scene.depositHeaders[i], scene.blockHashBranches[i]) =
                _depositHeaderAt(params.depositSlots[i], scene.blockHash);
        }
        (scene.evidenceHeader,) = _bodyEvidenceHeader(params.evidenceSlot, BODY_GINDEX);

        LeafSet memory set = _newLeafSet(params);
        LeafPositions memory at = _addLeaves(set, params, scene);
        (uint256[] memory gindices, bytes32[] memory roots) = _trimmed(set);
        (bytes32 stateRoot, bytes32[][] memory branches) = _mixedTree(gindices, roots);

        bytes32[] memory anchorBodyBranch = _siblings(SSZ.depthOf(BODY_GINDEX), "anchor body", params.anchorSlot);
        scene.anchorHeader = BeaconBlockHeader({
            slot: params.anchorSlot,
            proposerIndex: 9,
            parentRoot: keccak256(abi.encode("anchor parent", params.anchorSlot)),
            stateRoot: stateRoot,
            bodyRoot: _rootFromBranch(_execHash(params.anchorSlot), anchorBodyBranch, BODY_GINDEX)
        });
        scene.anchorRoot = SSZ.hashTreeRootMemory(scene.anchorHeader);
        scene.anchorBodyEvidence = BridgeVault.BlockHashEvidence(scene.anchorHeader, anchorBodyBranch);
        _fillEvidence(params, scene, at, branches);
    }

    function _fillEvidence(
        HistoricalParams memory params,
        HistoricalScene memory scene,
        LeafPositions memory at,
        bytes32[][] memory branches
    ) private pure {
        uint256 depositCount = params.depositSlots.length;
        scene.historicalBranches = new bytes32[][](depositCount);
        scene.recentBranches = new bytes32[][](depositCount);
        for (uint256 i = 0; i < depositCount; i++) {
            scene.historicalBranches[i] = branches[at.deposit[i]];
            if (params.blockRootsGindex != 0) scene.recentBranches[i] = branches[at.recent[i]];
        }
        scene.extraBranches = new bytes32[][](params.extraStoredSlots.length);
        for (uint256 i = 0; i < params.extraStoredSlots.length; i++) {
            if (at.extra[i] != NO_LEAF) scene.extraBranches[i] = branches[at.extra[i]];
        }
        scene.historicalEvidence = BridgeVault.HistoricalSummariesEvidence({
            anchorHeader: scene.anchorHeader,
            earlierSlot: params.evidenceSlot,
            branch: branches[at.evidence]
        });
        if (params.blockRootsGindex != 0) {
            scene.rootsEvidence = BridgeVault.BlockRootsEvidence({
                laterHeader: scene.anchorHeader,
                earlierSlotA: params.anchorSlot - 80,
                earlierSlotB: params.anchorSlot - 40,
                branchA: branches[at.fillerA],
                branchB: branches[at.fillerB]
            });
        }
        // The lowest body evidence is the header 40 slots below the lowest deposit; with no deposit it is the evidence header.
        if (depositCount == 0) {
            (BeaconBlockHeader memory header, bytes32[] memory branch) = _bodyEvidenceHeader(params.evidenceSlot, BODY_GINDEX);
            scene.lowBodyEvidence = BridgeVault.BlockHashEvidence(header, branch);
            return;
        }
        (BeaconBlockHeader memory low, bytes32[] memory lowBranch) =
            _bodyEvidenceHeader(_lowestDeposit(params) - 40, BODY_GINDEX);
        scene.lowBodyEvidence = BridgeVault.BlockHashEvidence(low, lowBranch);
    }

    function _lowestDeposit(HistoricalParams memory params) internal pure returns (uint64 lowest) {
        lowest = params.depositSlots[0];
        for (uint256 i = 1; i < params.depositSlots.length; i++) {
            if (params.depositSlots[i] < lowest) lowest = params.depositSlots[i];
        }
    }

    function _depositHeaderAt(uint64 slot, bytes32 blockHash)
        private
        pure
        returns (BeaconBlockHeader memory header, bytes32[] memory hashBranch)
    {
        hashBranch = _siblings(SSZ.depthOf(BODY_GINDEX), "hash", slot);
        header = BeaconBlockHeader({
            slot: slot,
            proposerIndex: 7,
            parentRoot: keccak256(abi.encode("deposit parent", slot)),
            stateRoot: keccak256(abi.encode("deposit state", slot)),
            bodyRoot: _rootFromBranch(blockHash, hashBranch, BODY_GINDEX)
        });
    }

    /// @dev Whether the state holds a historical leaf for `slot`: it is below the anchor, and its era index fits.
    function _hasHistoricalLeaf(HistoricalParams memory params, uint64 slot) private pure returns (bool) {
        if (slot >= params.anchorSlot) return false;
        if (slot / 8192 < params.capellaEra) return false;
        return uint256(slot / 8192) - uint256(params.capellaEra) < 2 ** 24;
    }

    function _newLeafSet(HistoricalParams memory params) private pure returns (LeafSet memory set) {
        uint256 capacity = params.depositSlots.length * 2 + params.extraStoredSlots.length + 3;
        set.gindices = new uint256[](capacity);
        set.roots = new bytes32[](capacity);
    }

    function _addLeaves(LeafSet memory set, HistoricalParams memory params, HistoricalScene memory scene)
        private
        pure
        returns (LeafPositions memory at)
    {
        uint256 field = params.historicalSummariesGindex;
        at.deposit = new uint256[](params.depositSlots.length);
        at.recent = new uint256[](params.depositSlots.length);
        at.extra = new uint256[](params.extraStoredSlots.length);
        for (uint256 i = 0; i < params.depositSlots.length; i++) {
            uint64 slot = params.depositSlots[i];
            at.deposit[i] = _push(
                set, _historicalLeaf(field, params.capellaEra, slot), SSZ.hashTreeRootMemory(scene.depositHeaders[i])
            );
            if (params.blockRootsGindex == 0) continue;
            at.recent[i] =
                _push(set, _recentLeaf(params.blockRootsGindex, slot), SSZ.hashTreeRootMemory(scene.depositHeaders[i]));
        }
        at.evidence = _push(
            set,
            _historicalLeaf(field, params.capellaEra, params.evidenceSlot),
            SSZ.hashTreeRootMemory(scene.evidenceHeader)
        );
        for (uint256 i = 0; i < params.extraStoredSlots.length; i++) {
            uint64 slot = params.extraStoredSlots[i];
            at.extra[i] = NO_LEAF;
            if (!_hasHistoricalLeaf(params, slot)) continue;
            at.extra[i] = _push(set, _historicalLeaf(field, params.capellaEra, slot), _fillerRoot(slot));
        }
        if (params.blockRootsGindex == 0) return at;
        at.fillerA = _push(
            set, _recentLeaf(params.blockRootsGindex, params.anchorSlot - 80), _fillerRoot(params.anchorSlot - 80)
        );
        at.fillerB = _push(
            set, _recentLeaf(params.blockRootsGindex, params.anchorSlot - 40), _fillerRoot(params.anchorSlot - 40)
        );
    }

    function _push(LeafSet memory set, uint256 gindex, bytes32 root) private pure returns (uint256 at) {
        at = set.count;
        set.gindices[at] = gindex;
        set.roots[at] = root;
        set.count = at + 1;
    }

    function _trimmed(LeafSet memory set) private pure returns (uint256[] memory gindices, bytes32[] memory roots) {
        gindices = new uint256[](set.count);
        roots = new bytes32[](set.count);
        for (uint256 i = 0; i < set.count; i++) {
            gindices[i] = set.gindices[i];
            roots[i] = set.roots[i];
        }
    }

    // ---------------------------------------------------------------- storing and layouts

    /// @notice Stores the headers of a scene in the light client in slot order. A repeated slot is a test bug.
    function _storeHistorical(HistoricalParams memory params, HistoricalScene memory scene) internal {
        uint256 capacity = params.extraStoredSlots.length + 5;
        StoredHeader[] memory list = new StoredHeader[](capacity);
        uint256 count;
        if (params.depositSlots.length > 0) {
            list[count++] = StoredHeader(
                scene.lowBodyEvidence.header.slot, SSZ.hashTreeRootMemory(scene.lowBodyEvidence.header)
            );
        }
        list[count++] = StoredHeader(params.evidenceSlot, SSZ.hashTreeRootMemory(scene.evidenceHeader));
        for (uint256 i = 0; i < params.extraStoredSlots.length; i++) {
            list[count++] = StoredHeader(params.extraStoredSlots[i], _fillerRoot(params.extraStoredSlots[i]));
        }
        if (params.blockRootsGindex != 0) {
            list[count++] = StoredHeader(params.anchorSlot - 80, _fillerRoot(params.anchorSlot - 80));
            list[count++] = StoredHeader(params.anchorSlot - 40, _fillerRoot(params.anchorSlot - 40));
        }
        list[count++] = StoredHeader(params.anchorSlot, scene.anchorRoot);
        _sortBySlot(list, count);
        for (uint256 i = 0; i < count; i++) {
            require(i == 0 || list[i].slot != list[i - 1].slot, "scene: two headers at one slot");
            require(list[i].slot > lightClientForB.head(), "scene: slot not above the head");
            _storeAnchor(list[i].slot, list[i].root);
        }
    }

    function _sortBySlot(StoredHeader[] memory list, uint256 count) private pure {
        for (uint256 i = 1; i < count; i++) {
            for (uint256 j = i; j > 0 && list[j - 1].slot > list[j].slot; j--) {
                StoredHeader memory held = list[j];
                list[j] = list[j - 1];
                list[j - 1] = held;
            }
        }
    }

    /// @notice Adds the two block hash layouts that cover every deposit slot up to the anchor.
    function _addBodyRows(BridgeVault vault_, HistoricalScene memory scene) internal {
        vault_.addBlockHashLayout(BODY_GINDEX, scene.lowBodyEvidence);
        vault_.addBlockHashLayout(BODY_GINDEX, scene.anchorBodyEvidence);
    }

    function _addHistoricalRow(BridgeVault vault_, HistoricalParams memory params, HistoricalScene memory scene) internal {
        vault_.addHistoricalSummariesLayout(params.historicalSummariesGindex, scene.historicalEvidence);
    }

    function _addRecentRow(BridgeVault vault_, HistoricalParams memory params, HistoricalScene memory scene) internal {
        vault_.addBlockRootsLayout(params.blockRootsGindex, scene.rootsEvidence);
    }

    // ---------------------------------------------------------------- proofs

    /// @notice A withdrawal proof for deposit `i` with a chosen ancestry branch.
    function _proofWithBranch(
        HistoricalScene memory scene,
        uint256 i,
        ReceiptFixtures.Named memory named,
        bytes32[] memory ancestryBranch
    ) internal pure returns (BridgeVault.WithdrawalProof memory) {
        // A deep copy, so a test that edits the proof never edits the scene (memory structs are references).
        return _clone(
            BridgeVault.WithdrawalProof({
                anchorHeader: scene.anchorHeader,
                depositHeader: scene.depositHeaders[i],
                ancestryBranch: ancestryBranch,
                blockHashBranch: scene.blockHashBranches[i],
                executionHeaderRlp: _defaultHeaderRlp(),
                receiptProof: ReceiptFixtures.proofFor(named.transactionIndex),
                transactionIndex: named.transactionIndex,
                logIndex: named.logIndex
            })
        );
    }

    /// @notice The honest historical proof of deposit `i`.
    function _historicalProof(HistoricalScene memory scene, uint256 i, ReceiptFixtures.Named memory named)
        internal
        pure
        returns (BridgeVault.WithdrawalProof memory)
    {
        return _proofWithBranch(scene, i, named, scene.historicalBranches[i]);
    }

    /// @notice The recent proof of deposit `i` (only for a scene whose state holds recent leaves).
    function _recentProof(HistoricalScene memory scene, uint256 i, ReceiptFixtures.Named memory named)
        internal
        pure
        returns (BridgeVault.WithdrawalProof memory)
    {
        return _proofWithBranch(scene, i, named, scene.recentBranches[i]);
    }

    // ---------------------------------------------------------------- sparse trees of mixed depth

    /// @notice A state of the Electra-like depth that holds `leaf` at `gindex` and a stand-in value in every other
    /// field. The field that contains `gindex` gets no stand-in. Returns the root and the branch of the leaf.
    function _stateWithLeaf(uint256 gindex, bytes32 leaf) internal pure returns (bytes32 root, bytes32[] memory branch) {
        uint256 depth = SSZ.depthOf(gindex);
        uint256 containing = gindex >> (depth - ELECTRA_STATE_DEPTH);
        uint256[] memory gindices = new uint256[](38);
        bytes32[] memory leaves = new bytes32[](38);
        uint256 count;
        gindices[count] = gindex;
        leaves[count++] = leaf;
        for (uint256 field = 64; field < 101; field++) {
            if (field == containing) continue;
            gindices[count] = field;
            leaves[count++] = keccak256(abi.encode("state field", field));
        }
        uint256[] memory usedIndices = new uint256[](count);
        bytes32[] memory usedLeaves = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            usedIndices[i] = gindices[i];
            usedLeaves[i] = leaves[i];
        }
        bytes32[][] memory branches;
        (root, branches) = _mixedTree(usedIndices, usedLeaves);
        branch = branches[0];
    }

    /// @notice The root and the branches of a Merkle tree that holds the given leaves at the given generalized indices.
    /// The depths may differ. Every node that holds no leaf below it is zero.
    function _mixedTree(uint256[] memory gindices, bytes32[] memory leaves)
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
        uint256 capacity = count * (maxDepth + 1);
        uint256[] memory nodeIndex = new uint256[](capacity);
        uint256[] memory nodeDepth = new uint256[](capacity);
        bytes32[] memory nodeValue = new bytes32[](capacity);
        uint256 known;
        for (uint256 k = 0; k < count; k++) {
            nodeIndex[known] = gindices[k];
            nodeDepth[known] = SSZ.depthOf(gindices[k]);
            nodeValue[known] = leaves[k];
            known++;
        }
        for (uint256 level = maxDepth; level > 0; level--) {
            uint256 limit = known;
            for (uint256 j = 0; j < limit; j++) {
                if (nodeDepth[j] != level) continue;
                uint256 parent = nodeIndex[j] >> 1;
                if (_isKnown(nodeIndex, known, parent)) continue;
                bytes32 left = _valueOf(nodeIndex, nodeValue, known, parent * 2);
                bytes32 right = _valueOf(nodeIndex, nodeValue, known, parent * 2 + 1);
                nodeIndex[known] = parent;
                nodeDepth[known] = level - 1;
                nodeValue[known] = sha256(abi.encodePacked(left, right));
                known++;
            }
        }
        root = _valueOf(nodeIndex, nodeValue, known, 1);
        branches = new bytes32[][](count);
        for (uint256 k = 0; k < count; k++) {
            uint256 g = gindices[k];
            branches[k] = new bytes32[](SSZ.depthOf(g));
            for (uint256 i = 0; i < branches[k].length; i++) {
                branches[k][i] = _valueOf(nodeIndex, nodeValue, known, g ^ 1);
                g >>= 1;
            }
        }
    }

    function _isKnown(uint256[] memory nodeIndex, uint256 known, uint256 gindex) private pure returns (bool) {
        for (uint256 i = 0; i < known; i++) {
            if (nodeIndex[i] == gindex) return true;
        }
        return false;
    }

    function _valueOf(uint256[] memory nodeIndex, bytes32[] memory nodeValue, uint256 known, uint256 gindex)
        private
        pure
        returns (bytes32)
    {
        for (uint256 i = 0; i < known; i++) {
            if (nodeIndex[i] == gindex) return nodeValue[i];
        }
        return bytes32(0);
    }

    // ---------------------------------------------------------------- branch editing

    function _concat(bytes32[] memory first, bytes32[] memory second) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](first.length + second.length);
        for (uint256 i = 0; i < first.length; i++) {
            out[i] = first[i];
        }
        for (uint256 i = 0; i < second.length; i++) {
            out[first.length + i] = second[i];
        }
    }

    function _repeat(bytes32 value, uint256 times) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](times);
        for (uint256 i = 0; i < times; i++) {
            out[i] = value;
        }
    }

    function _slice(bytes32[] memory branch, uint256 from, uint256 to) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](to - from);
        for (uint256 i = from; i < to; i++) {
            out[i - from] = branch[i];
        }
    }

    /// @notice The branch with one entry added at `position`.
    function _inserting(bytes32[] memory branch, uint256 position, bytes32 value)
        internal
        pure
        returns (bytes32[] memory)
    {
        return _concat(_concat(_slice(branch, 0, position), _repeat(value, 1)), _slice(branch, position, branch.length));
    }

    /// @notice The branch with the entry at `position` removed.
    function _without(bytes32[] memory branch, uint256 position) internal pure returns (bytes32[] memory) {
        return _concat(_slice(branch, 0, position), _slice(branch, position + 1, branch.length));
    }
}
