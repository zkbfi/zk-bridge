// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IBeaconLightClient} from "./IBeaconLightClient.sol";
import {BeaconBlockHeader, SSZ} from "./SSZ.sol";
import {BeaconProofVerifier} from "./BeaconProofVerifier.sol";

/// @dev The era constants, one copy for this library and the public constants of `BeaconProofVerifier`:
/// `SLOTS_PER_HISTORICAL_ROOT`, its log2, and the log2 of `HISTORICAL_ROOTS_LIMIT` (2**24).
uint64 constant ERA_SLOTS = 8192;
uint256 constant ERA_DEPTH = 13;
uint256 constant HISTORICAL_LIST_DEPTH = 24;

/// @title BeaconLayoutLib
/// @notice The fork layout tables of the message bridge: the position rules and the evidence checks of
/// `addBlockRootsLayout`, `addBlockHashLayout` and `addHistoricalSummariesLayout`, the range rule, and the lookups that
/// turn a slot into the validated position of its fork. The rules are documented on `BeaconProofVerifier`.
/// @dev An external library, linked into `MessageBridge`, so that each contract creation of the bridge stays under the
/// per-transaction gas cap of EIP-7825 (16,777,216). It runs with DELEGATECALL in the storage of the bridge: the tables
/// are `storage` arguments that the bridge passes, so they stay in the storage layout of the bridge. It has no owner and
/// no storage of its own, and its address is fixed in the bytecode of the bridge, so the bridge stays immutable. It reverts
/// with the errors of `BeaconProofVerifier` and emits its events, so the bridge looks the same from outside.
library BeaconLayoutLib {
    /// @dev The deepest accepted `block_roots` or `historical_summaries` position (the state container only), apart from
    /// the fixed Gloas position of `historical_summaries`.
    uint256 private constant MAX_BLOCK_ROOTS_DEPTH = 8;

    /// @dev The position of `BeaconState.block_roots` in the progressive Gloas state: field 5 is chunk 5, the first leaf of
    /// the 16 leaf subtree at node 22, which starts at 352 (`specs/gloas/light-client/sync-protocol.md` fixes the rules,
    /// and `lc-core` derives the number from the field list).
    uint256 private constant GLOAS_BLOCK_ROOTS_GINDEX = 352;

    /// @dev The position of `signed_execution_payload_bid.message.parent_block_hash` in the progressive Gloas
    /// `BeaconBlockBody`: field 10 of the body is node 357, `message` is 714, the bid is progressive and its first chunk
    /// `parent_block_hash` is 714 * 4 = 2856 (`specs/gloas/light-client/sync-protocol.md`, `EXECUTION_BLOCK_HASH_GINDEX_GLOAS`).
    /// The branch has 11 entries. The position is fixed by the progressive layout, so no layout evidence names it.
    ///
    /// The rule for a message source at or after `gloasForkSlot`: the source header is a beacon block B AFTER the block of
    /// the proven execution block X, and `parent_block_hash` of B equals the hash of X. Why it is sound:
    /// `process_execution_payload_bid` asserts `bid.parent_block_hash == state.latest_block_hash`, and `latest_block_hash` is
    /// written only by `apply_parent_execution_payload`, from the bid of a parent whose payload the child confirmed. So the
    /// `parent_block_hash` of a block of the canonical chain names a payload that the chain accepted. A block on an empty
    /// parent names an older accepted payload, which is canonical too. The bid's own `block_hash` is never accepted: that
    /// payload may be withheld. B must be an ancestor of the stored head, which the ancestry branch proves.
    uint256 private constant GLOAS_BID_PARENT_BLOCK_HASH_GINDEX = 2856;

    /// @dev The position of `BeaconState.historical_summaries` in the progressive Gloas state: field 27 is chunk 27, the
    /// seventh leaf of the 64 leaf subtree at node 46, which starts at 2944.
    uint256 private constant GLOAS_HISTORICAL_SUMMARIES_GINDEX = 2950;

    /// @dev The deepest accepted block hash position.
    uint256 private constant MAX_BLOCK_HASH_DEPTH = 16;

    /// @dev The index of `BeaconState.block_roots` among the state fields.
    uint256 private constant BLOCK_ROOTS_FIELD = 5;

    /// @dev The index of `BeaconState.historical_summaries` among the state fields (Capella through Fulu).
    uint256 private constant HISTORICAL_SUMMARIES_FIELD = 27;

    /// @dev The index of `execution_payload` among the `BeaconBlockBody` fields (Capella through Fulu).
    uint256 private constant EXECUTION_PAYLOAD_FIELD = 9;

    /// @dev The index of `block_hash` among the `ExecutionPayload` fields (Capella through Fulu).
    uint256 private constant BLOCK_HASH_FIELD = 12;

    /// @dev The accepted depths of the `BeaconState` tree: 32, 64 or 128 leaves (28 to 128 fields).
    uint256 private constant MIN_STATE_DEPTH = 5;

    uint256 private constant MAX_STATE_DEPTH = 7;

    /// @dev The accepted depths of the `BeaconBlockBody` tree (16 or 32 leaves) and of the `ExecutionPayload` tree
    /// (16 or 32 leaves).
    uint256 private constant MIN_BODY_DEPTH = 4;

    uint256 private constant MAX_BODY_DEPTH = 5;

    uint256 private constant MIN_PAYLOAD_DEPTH = 4;

    uint256 private constant MAX_PAYLOAD_DEPTH = 5;

    uint64 private constant SLOTS_PER_HISTORICAL_ROOT = ERA_SLOTS;
    uint256 private constant BLOCK_ROOTS_VECTOR_DEPTH = ERA_DEPTH;
    uint256 private constant HISTORICAL_SUMMARIES_LIST_DEPTH = HISTORICAL_LIST_DEPTH;

    // ------------------------------------------------------------------ adding layouts

    /// @notice The body of `BeaconProofVerifier.addBlockRootsLayout`.
    function addBlockRootsLayout(
        BeaconProofVerifier.StateLayout[] storage table,
        IBeaconLightClient lightClient,
        uint256 blockRootsGindex,
        BeaconProofVerifier.BlockRootsEvidence calldata evidence
    ) external {
        if (blockRootsGindex == 0 || SSZ.depthOf(blockRootsGindex) > MAX_BLOCK_ROOTS_DEPTH) {
            revert BeaconProofVerifier.LayoutOutOfBounds(blockRootsGindex);
        }
        if (!_isBlockRootsPosition(blockRootsGindex)) {
            revert BeaconProofVerifier.LayoutPositionInvalid(blockRootsGindex);
        }
        _requireStoredHeader(lightClient, evidence.laterHeader);
        if (evidence.earlierSlotA == evidence.earlierSlotB) {
            revert BeaconProofVerifier.EvidenceSlotsEqual(evidence.earlierSlotA);
        }
        _requireEarlierRoot(
            lightClient, evidence.laterHeader, evidence.earlierSlotA, blockRootsGindex, evidence.branchA
        );
        _requireEarlierRoot(
            lightClient, evidence.laterHeader, evidence.earlierSlotB, blockRootsGindex, evidence.branchB
        );

        uint64 slot = evidence.laterHeader.slot;
        BeaconProofVerifier.SlotRange[] memory ranges = new BeaconProofVerifier.SlotRange[](table.length);
        for (uint256 i = 0; i < ranges.length; i++) {
            BeaconProofVerifier.StateLayout storage stored = table[i];
            ranges[i] = BeaconProofVerifier.SlotRange(stored.blockRootsGindex, stored.firstSlot, stored.lastSlot);
        }
        uint256 index = planRange(blockRootsGindex, slot, ranges);
        if (index == ranges.length) {
            table.push(
                BeaconProofVerifier.StateLayout({blockRootsGindex: blockRootsGindex, firstSlot: slot, lastSlot: slot})
            );
            emit BeaconProofVerifier.BlockRootsLayoutValidated(blockRootsGindex, slot, slot);
            return;
        }
        BeaconProofVerifier.StateLayout storage layout = table[index];
        if (slot < layout.firstSlot) layout.firstSlot = slot;
        if (slot > layout.lastSlot) layout.lastSlot = slot;
        emit BeaconProofVerifier.BlockRootsLayoutValidated(blockRootsGindex, layout.firstSlot, layout.lastSlot);
    }

    /// @notice The body of `BeaconProofVerifier.addBlockHashLayout`.
    function addBlockHashLayout(
        BeaconProofVerifier.BodyLayout[] storage table,
        IBeaconLightClient lightClient,
        uint64 gloasForkSlot,
        uint256 blockHashGindex,
        BeaconProofVerifier.BlockHashEvidence calldata evidence
    ) external {
        if (blockHashGindex == 0 || SSZ.depthOf(blockHashGindex) > MAX_BLOCK_HASH_DEPTH) {
            revert BeaconProofVerifier.LayoutOutOfBounds(blockHashGindex);
        }
        if (!_isBlockHashPosition(blockHashGindex)) revert BeaconProofVerifier.LayoutPositionInvalid(blockHashGindex);
        _requireStoredHeader(lightClient, evidence.header);
        if (evidence.header.slot >= gloasForkSlot) {
            revert BeaconProofVerifier.GloasSlotRefused(evidence.header.slot, gloasForkSlot);
        }
        bytes32 storedBlockHash = lightClient.executionBlockHashes(evidence.header.slot);
        if (storedBlockHash == bytes32(0)) revert BeaconProofVerifier.EvidenceSlotNotStored(evidence.header.slot);
        if (!SSZ.isValidBranch(storedBlockHash, evidence.branch, blockHashGindex, evidence.header.bodyRoot)) {
            revert BeaconProofVerifier.LayoutEvidenceInvalid();
        }

        uint64 slot = evidence.header.slot;
        BeaconProofVerifier.SlotRange[] memory ranges = new BeaconProofVerifier.SlotRange[](table.length);
        for (uint256 i = 0; i < ranges.length; i++) {
            BeaconProofVerifier.BodyLayout storage stored = table[i];
            ranges[i] = BeaconProofVerifier.SlotRange(stored.blockHashGindex, stored.firstSlot, stored.lastSlot);
        }
        uint256 index = planRange(blockHashGindex, slot, ranges);
        if (index == ranges.length) {
            table.push(
                BeaconProofVerifier.BodyLayout({blockHashGindex: blockHashGindex, firstSlot: slot, lastSlot: slot})
            );
            emit BeaconProofVerifier.BlockHashLayoutValidated(blockHashGindex, slot, slot);
            return;
        }
        BeaconProofVerifier.BodyLayout storage layout = table[index];
        if (slot < layout.firstSlot) layout.firstSlot = slot;
        if (slot > layout.lastSlot) layout.lastSlot = slot;
        emit BeaconProofVerifier.BlockHashLayoutValidated(blockHashGindex, layout.firstSlot, layout.lastSlot);
    }

    /// @notice The body of `BeaconProofVerifier.addHistoricalSummariesLayout`.
    function addHistoricalSummariesLayout(
        BeaconProofVerifier.HistoricalLayout[] storage table,
        IBeaconLightClient lightClient,
        uint64 capellaEra,
        uint256 historicalSummariesGindex,
        BeaconProofVerifier.HistoricalSummariesEvidence calldata evidence
    ) external {
        if (
            historicalSummariesGindex == 0
                || (SSZ.depthOf(historicalSummariesGindex) > MAX_BLOCK_ROOTS_DEPTH
                    && historicalSummariesGindex != GLOAS_HISTORICAL_SUMMARIES_GINDEX)
        ) {
            revert BeaconProofVerifier.LayoutOutOfBounds(historicalSummariesGindex);
        }
        if (!_isHistoricalSummariesPosition(historicalSummariesGindex)) {
            revert BeaconProofVerifier.LayoutPositionInvalid(historicalSummariesGindex);
        }
        _requireStoredHeader(lightClient, evidence.anchorHeader);
        uint64 anchorSlot = evidence.anchorHeader.slot;
        uint64 earlierSlot = evidence.earlierSlot;
        bytes32 storedRoot = lightClient.headers(earlierSlot);
        if (storedRoot == bytes32(0)) revert BeaconProofVerifier.EvidenceSlotNotStored(earlierSlot);
        if (earlierSlot >= anchorSlot || anchorSlot - earlierSlot <= SLOTS_PER_HISTORICAL_ROOT) {
            revert BeaconProofVerifier.EvidenceSlotNotHistorical(earlierSlot, anchorSlot);
        }
        uint256 leafIndex =
            _historicalLeafGindex(historicalSummariesGindex, _eraIndex(capellaEra, earlierSlot), earlierSlot);
        if (!SSZ.isValidBranch(storedRoot, evidence.branch, leafIndex, evidence.anchorHeader.stateRoot)) {
            revert BeaconProofVerifier.LayoutEvidenceInvalid();
        }

        BeaconProofVerifier.SlotRange[] memory ranges = new BeaconProofVerifier.SlotRange[](table.length);
        for (uint256 i = 0; i < ranges.length; i++) {
            BeaconProofVerifier.HistoricalLayout storage stored = table[i];
            ranges[i] =
                BeaconProofVerifier.SlotRange(stored.historicalSummariesGindex, stored.firstSlot, stored.lastSlot);
        }
        uint256 index = planRange(historicalSummariesGindex, anchorSlot, ranges);
        if (index == ranges.length) {
            table.push(
                BeaconProofVerifier.HistoricalLayout({
                    historicalSummariesGindex: historicalSummariesGindex, firstSlot: anchorSlot, lastSlot: anchorSlot
                })
            );
            emit BeaconProofVerifier.HistoricalSummariesLayoutValidated(
                historicalSummariesGindex, anchorSlot, anchorSlot
            );
            return;
        }
        BeaconProofVerifier.HistoricalLayout storage layout = table[index];
        if (anchorSlot < layout.firstSlot) layout.firstSlot = anchorSlot;
        if (anchorSlot > layout.lastSlot) layout.lastSlot = anchorSlot;
        emit BeaconProofVerifier.HistoricalSummariesLayoutValidated(
            historicalSummariesGindex, layout.firstSlot, layout.lastSlot
        );
    }

    // ------------------------------------------------------------------ checks of a delivery

    /// @notice Checks 1 to 3 of a delivery: the anchor is the header that the light client stored for its slot, and the
    /// source block is its ancestor. The path comes from the distance: up to 8192 slots is the recent path through
    /// `block_roots`, more is the historical path through `historical_summaries`. The prover never picks. Both leaf
    /// indices are built by pure functions, and the branch length must be exact (`SSZ.isValidBranch` refuses padding and
    /// short branches).
    /// @param anchorHeader A header that the light client stored.
    /// @param sourceHeader The beacon block that carries the proven execution block.
    /// @param branch The branch from the root of `sourceHeader` to the state root of the anchor.
    function requireAncestry(
        BeaconProofVerifier.StateLayout[] storage states,
        BeaconProofVerifier.HistoricalLayout[] storage historicals,
        IBeaconLightClient lightClient,
        uint64 capellaEra,
        BeaconBlockHeader calldata anchorHeader,
        BeaconBlockHeader calldata sourceHeader,
        bytes32[] calldata branch
    ) external view {
        _requireStoredHeader(lightClient, anchorHeader);
        uint64 anchorSlot = anchorHeader.slot;
        uint64 depositSlot = sourceHeader.slot;
        if (depositSlot >= anchorSlot) revert BeaconProofVerifier.DepositNotBeforeAnchor(depositSlot, anchorSlot);
        uint256 leafIndex = anchorSlot - depositSlot <= SLOTS_PER_HISTORICAL_ROOT
            ? _blockRootsGindexAt(states, anchorSlot) * SLOTS_PER_HISTORICAL_ROOT
                + (depositSlot % SLOTS_PER_HISTORICAL_ROOT)
            : _historicalLeafGindex(
                _historicalGindexAt(historicals, anchorSlot), _eraIndex(capellaEra, depositSlot), depositSlot
            );
        bytes32 sourceRoot = SSZ.hashTreeRoot(sourceHeader);
        if (!SSZ.isValidBranch(sourceRoot, branch, leafIndex, anchorHeader.stateRoot)) {
            revert BeaconProofVerifier.AncestryBranchInvalid();
        }
    }

    /// @notice Check 4 of a delivery: the execution block hash sits in the body of the source header. Before the Gloas
    /// fork it is at the validated payload block hash position. At or after `gloasForkSlot` it is the bid
    /// `parent_block_hash` at the fixed index 2856 (see `GLOAS_BID_PARENT_BLOCK_HASH_GINDEX`).
    function requireBlockHash(
        BeaconProofVerifier.BodyLayout[] storage bodies,
        uint64 gloasForkSlot,
        bytes32 blockHash,
        BeaconBlockHeader calldata sourceHeader,
        bytes32[] calldata branch
    ) external view {
        uint256 gindex = sourceHeader.slot >= gloasForkSlot
            ? GLOAS_BID_PARENT_BLOCK_HASH_GINDEX
            : _blockHashGindexAt(bodies, sourceHeader.slot);
        if (!SSZ.isValidBranch(blockHash, branch, gindex, sourceHeader.bodyRoot)) {
            revert BeaconProofVerifier.BlockHashBranchInvalid();
        }
    }

    /// @dev The validated block hash position whose slot range contains `slot`.
    function _blockHashGindexAt(BeaconProofVerifier.BodyLayout[] storage bodies, uint64 slot)
        private
        view
        returns (uint256)
    {
        for (uint256 i = 0; i < bodies.length; i++) {
            BeaconProofVerifier.BodyLayout storage layout = bodies[i];
            if (layout.firstSlot <= slot && slot <= layout.lastSlot) return layout.blockHashGindex;
        }
        revert BeaconProofVerifier.LayoutNotValidated(slot);
    }

    // ------------------------------------------------------------------ rules (internal, also used by tests)

    /// @dev The range rule. Returns the index of the range of `gindex` that grows to hold `slot`, or `ranges.length`
    /// when a new range must start. A range grows only when the grown range overlaps no range of another position, so
    /// ranges of different positions never overlap. Reverts when `slot` is already inside the range of another position.
    function planRange(uint256 gindex, uint64 slot, BeaconProofVerifier.SlotRange[] memory ranges)
        internal
        pure
        returns (uint256)
    {
        for (uint256 i = 0; i < ranges.length; i++) {
            if (ranges[i].gindex == gindex) continue;
            if (ranges[i].firstSlot <= slot && slot <= ranges[i].lastSlot) {
                revert BeaconProofVerifier.LayoutRangeConflict(slot);
            }
        }
        for (uint256 i = 0; i < ranges.length; i++) {
            if (ranges[i].gindex != gindex) continue;
            uint64 low = slot < ranges[i].firstSlot ? slot : ranges[i].firstSlot;
            uint64 high = slot > ranges[i].lastSlot ? slot : ranges[i].lastSlot;
            if (_overlapsOtherPosition(gindex, low, high, ranges)) continue;
            return i;
        }
        return ranges.length;
    }

    /// @dev Whether a range of a position other than `gindex` shares a slot with `low` to `high`.
    function _overlapsOtherPosition(
        uint256 gindex,
        uint64 low,
        uint64 high,
        BeaconProofVerifier.SlotRange[] memory ranges
    ) private pure returns (bool) {
        for (uint256 i = 0; i < ranges.length; i++) {
            if (ranges[i].gindex == gindex) continue;
            if (ranges[i].firstSlot <= high && low <= ranges[i].lastSlot) return true;
        }
        return false;
    }

    /// @dev Whether `gindex` is `BeaconState.block_roots`: field 5 of a plain tree of depth 5, 6 or 7, or the fixed Gloas
    /// position.
    function _isBlockRootsPosition(uint256 gindex) private pure returns (bool) {
        return _isStateFieldPosition(gindex, BLOCK_ROOTS_FIELD) || gindex == GLOAS_BLOCK_ROOTS_GINDEX;
    }

    /// @dev Whether `gindex` is `BeaconState.historical_summaries`: field 27 of a plain tree of depth 5, 6 or 7, or the
    /// fixed Gloas position.
    function _isHistoricalSummariesPosition(uint256 gindex) private pure returns (bool) {
        return _isStateFieldPosition(gindex, HISTORICAL_SUMMARIES_FIELD) || gindex == GLOAS_HISTORICAL_SUMMARIES_GINDEX;
    }

    /// @dev Whether `gindex` is field `fieldIndex` of a `BeaconState` tree of depth 5, 6 or 7: `2**depth + fieldIndex`.
    function _isStateFieldPosition(uint256 gindex, uint256 fieldIndex) private pure returns (bool) {
        uint256 depth = SSZ.depthOf(gindex);
        if (depth < MIN_STATE_DEPTH || depth > MAX_STATE_DEPTH) return false;
        return gindex == (uint256(1) << depth) + fieldIndex;
    }

    /// @dev Whether `gindex` is `ExecutionPayload.block_hash` inside `BeaconBlockBody.execution_payload`:
    /// `(2**bodyDepth + 9) * 2**payloadDepth + 12`, with both depths in 4 to 5.
    function _isBlockHashPosition(uint256 gindex) private pure returns (bool) {
        for (uint256 bodyDepth = MIN_BODY_DEPTH; bodyDepth <= MAX_BODY_DEPTH; bodyDepth++) {
            uint256 payloadField = (uint256(1) << bodyDepth) + EXECUTION_PAYLOAD_FIELD;
            for (uint256 payloadDepth = MIN_PAYLOAD_DEPTH; payloadDepth <= MAX_PAYLOAD_DEPTH; payloadDepth++) {
                if (gindex == (payloadField << payloadDepth) + BLOCK_HASH_FIELD) return true;
            }
        }
        return false;
    }

    /// @dev A header must equal the finalized header that the light client stored for its slot.
    function _requireStoredHeader(IBeaconLightClient lightClient, BeaconBlockHeader calldata header) private view {
        bytes32 headerRoot = SSZ.hashTreeRoot(header);
        bytes32 stored = lightClient.headers(header.slot);
        if (stored == bytes32(0) || stored != headerRoot) {
            revert BeaconProofVerifier.AnchorNotStored(header.slot, headerRoot);
        }
    }

    /// @dev The stored root at `earlierSlot` must be the leaf at the candidate position under the later state root.
    function _requireEarlierRoot(
        IBeaconLightClient lightClient,
        BeaconBlockHeader calldata later,
        uint64 earlierSlot,
        uint256 blockRootsGindex,
        bytes32[] calldata branch
    ) private view {
        if (earlierSlot >= later.slot || later.slot - earlierSlot > SLOTS_PER_HISTORICAL_ROOT) {
            revert BeaconProofVerifier.EvidenceSlotOutOfWindow(earlierSlot, later.slot);
        }
        bytes32 storedRoot = lightClient.headers(earlierSlot);
        if (storedRoot == bytes32(0)) revert BeaconProofVerifier.EvidenceSlotNotStored(earlierSlot);
        uint256 elementIndex = blockRootsGindex * SLOTS_PER_HISTORICAL_ROOT + (earlierSlot % SLOTS_PER_HISTORICAL_ROOT);
        if (!SSZ.isValidBranch(storedRoot, branch, elementIndex, later.stateRoot)) {
            revert BeaconProofVerifier.LayoutEvidenceInvalid();
        }
    }

    /// @dev The index of the summary of a slot's era: `era - capellaEra`. The era must be at or after `capellaEra`
    /// and the index must fit the list of 2**24 entries.
    function _eraIndex(uint64 capellaEra, uint64 slot) private pure returns (uint64) {
        uint64 era = slot / SLOTS_PER_HISTORICAL_ROOT;
        if (era < capellaEra) revert BeaconProofVerifier.DepositBeforeCapellaEra(era, capellaEra);
        uint64 index = era - capellaEra;
        if (uint256(index) >= (uint256(1) << HISTORICAL_SUMMARIES_LIST_DEPTH)) {
            revert BeaconProofVerifier.HistoricalIndexOutOfRange(index);
        }
        return index;
    }

    /// @dev The historical path. Built in this order, from the index `g` of `historical_summaries` in `BeaconState`:
    /// 1. `g` is the field. 2. `g = g * 2`: the list data root, past the length mix-in.
    /// 3. `g = g * 2**24 + index`: the list position. 4. `g = g * 2 + 0`: `HistoricalSummary.block_summary_root`.
    /// 5. `g = g * 2**13 + depositSlot % 8192`: the position inside that era's `block_roots`.
    function _historicalLeafGindex(uint256 historicalSummariesGindex, uint64 index, uint64 depositSlot)
        private
        pure
        returns (uint256 gindex)
    {
        gindex = historicalSummariesGindex;
        gindex = gindex * 2;
        gindex = gindex * (uint256(1) << HISTORICAL_SUMMARIES_LIST_DEPTH) + index;
        gindex = gindex * 2 + 0;
        gindex = gindex * (uint256(1) << BLOCK_ROOTS_VECTOR_DEPTH) + (depositSlot % SLOTS_PER_HISTORICAL_ROOT);
    }

    /// @dev The validated `block_roots` position whose slot range contains `slot`.
    function _blockRootsGindexAt(BeaconProofVerifier.StateLayout[] storage states, uint64 slot)
        private
        view
        returns (uint256)
    {
        for (uint256 i = 0; i < states.length; i++) {
            BeaconProofVerifier.StateLayout storage layout = states[i];
            if (layout.firstSlot <= slot && slot <= layout.lastSlot) return layout.blockRootsGindex;
        }
        revert BeaconProofVerifier.LayoutNotValidated(slot);
    }

    /// @dev The validated `historical_summaries` position whose slot range contains `slot`.
    function _historicalGindexAt(BeaconProofVerifier.HistoricalLayout[] storage historicals, uint64 slot)
        private
        view
        returns (uint256)
    {
        for (uint256 i = 0; i < historicals.length; i++) {
            BeaconProofVerifier.HistoricalLayout storage layout = historicals[i];
            if (layout.firstSlot <= slot && slot <= layout.lastSlot) return layout.historicalSummariesGindex;
        }
        revert BeaconProofVerifier.LayoutNotValidated(slot);
    }
}
