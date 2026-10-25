// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IBeaconLightClient} from "./IBeaconLightClient.sol";
import {BeaconBlockHeader, SSZ} from "./SSZ.sol";
import {MerkleTrie} from "./vendor/optimism/trie/MerkleTrie.sol";
import {RLPReader} from "./vendor/optimism/rlp/RLPReader.sol";
import {ReceiptLogs} from "./ReceiptLogs.sol";

/// @title BeaconProofVerifier
/// @notice The proof checks that every contract of this bridge shares: it reads a log of the other chain through the
/// light client. It holds the anchor, ancestry and block hash checks, the fork layout table, the receipt and log
/// decoding, and the opening proof of the deposit lock. A contract on top of it adds the check of its own log.
/// @dev Fork layouts. The generalized indices of `state.block_roots`, of `state.historical_summaries` and of the
/// execution block hash depend on the fork of the source chain. The contract holds no fixed table. Anyone may add a
/// layout with `addBlockRootsLayout`, `addHistoricalSummariesLayout` and `addBlockHashLayout`. Two checks guard each
/// call. First, the candidate must be the position of the named field itself in a state or body tree of a known shape
/// (see the position rules below). Second, the chain's own stored data must prove it: the candidate position must map
/// stored header roots (or the stored execution block hash) to the stored state (or body) root.
///
/// The first check is needed because the second is not enough alone. Other fields hold values that a block proposer
/// chooses: the list `eth1_data_votes` has the same tree shape as `block_roots`, and `graffiti` or
/// `eth1_data.block_hash` can hold a copy of the execution block hash. A proposer could place stored header roots or
/// a stored block hash there, get that position accepted, and then forge logs. So only the position of the real field
/// is accepted.
///
/// Ancestry has two paths, chosen from the two slots. A block at most 8192 slots below the anchor is proven through
/// `state.block_roots`. An older block is proven through `state.historical_summaries`, which holds the root of every
/// completed era of 8192 block roots since Capella. So a stored head may be any distance past the one before it.
/// A layout is usable only for the slots between the first and the last slot at which it was validated. A range
/// never covers a slot where another position was validated, and ranges of different positions never overlap. So a
/// position validated, then replaced, then validated again leaves the slots between without a layout, and each
/// lookup has one answer. Layouts move only when a container crosses a power-of-two field count; then a new route
/// (light client and bridge) is deployed beside the old one, and the old route keeps paying what it can still prove.
/// This is the immutability trade-off of hole H-19.
///
/// The layout tables live in the storage of the contract on top, so that it keeps control of its storage layout. This
/// contract reaches them through three hooks.
abstract contract BeaconProofVerifier {
    /// @notice One validated range of a layout table, as the range rule reads it.
    /// @param gindex The validated generalized index.
    /// @param firstSlot The lowest slot of the range.
    /// @param lastSlot The highest slot of the range.
    struct SlotRange {
        uint256 gindex;
        uint64 firstSlot;
        uint64 lastSlot;
    }

    /// @notice A validated `block_roots` position and the state slots at which it was validated.
    /// @param blockRootsGindex The generalized index of `BeaconState.block_roots`.
    /// @param firstSlot The lowest state slot at which the position was validated.
    /// @param lastSlot The highest state slot at which the position was validated.
    struct StateLayout {
        uint256 blockRootsGindex;
        uint64 firstSlot;
        uint64 lastSlot;
    }

    /// @notice A validated block hash position and the header slots at which it was validated.
    /// @param blockHashGindex The generalized index of `BeaconBlockBody.execution_payload.block_hash`.
    /// @param firstSlot The lowest header slot at which the position was validated.
    /// @param lastSlot The highest header slot at which the position was validated.
    struct BodyLayout {
        uint256 blockHashGindex;
        uint64 firstSlot;
        uint64 lastSlot;
    }

    /// @notice Evidence for a `block_roots` position: two stored earlier headers under one stored later state.
    /// @param laterHeader A stored header. Its `stateRoot` holds the block roots.
    /// @param earlierSlotA A stored slot before and within 8192 slots of the later header.
    /// @param earlierSlotB Another such slot.
    /// @param branchA The branch from the stored root at `earlierSlotA` to the later state root.
    /// @param branchB The branch from the stored root at `earlierSlotB` to the later state root.
    struct BlockRootsEvidence {
        BeaconBlockHeader laterHeader;
        uint64 earlierSlotA;
        uint64 earlierSlotB;
        bytes32[] branchA;
        bytes32[] branchB;
    }

    /// @notice A validated `historical_summaries` position and the state slots at which it was validated.
    /// @param historicalSummariesGindex The generalized index of `BeaconState.historical_summaries`.
    /// @param firstSlot The lowest state slot at which the position was validated.
    /// @param lastSlot The highest state slot at which the position was validated.
    struct HistoricalLayout {
        uint256 historicalSummariesGindex;
        uint64 firstSlot;
        uint64 lastSlot;
    }

    /// @notice Evidence for a block hash position: a stored header whose body holds its stored execution block hash.
    /// @param header A stored header.
    /// @param branch The branch from the stored execution block hash to the body root of the header.
    struct BlockHashEvidence {
        BeaconBlockHeader header;
        bytes32[] branch;
    }

    /// @notice Evidence for a `historical_summaries` position: a stored header in a completed era, proven at the claimed
    /// position under a later stored anchor's state root.
    /// @param anchorHeader A stored header. Its `stateRoot` holds `historical_summaries`.
    /// @param earlierSlot A stored slot more than 8192 slots below the anchor, in an era at or after `capellaEra`.
    /// @param branch The branch from the stored root at `earlierSlot` to the anchor state root. Its length is exact.
    struct HistoricalSummariesEvidence {
        BeaconBlockHeader anchorHeader;
        uint64 earlierSlot;
        bytes32[] branch;
    }

    /// @notice The evidence for `openDeposits`: a block of the remote chain whose hash the light client stored, and the
    /// storage of the remote light client under the state root of that block.
    /// @param remoteSlot A slot at which the light client of this vault stored an execution block hash.
    /// @param remoteHeaderRlp The RLP of the execution block header whose hash is stored at `remoteSlot`.
    /// @param accountProof The state trie proof of the account of `remoteLightClient`.
    /// @param storedSlot A slot whose `executionBlockHashes` entry in the remote light client is not zero.
    /// @param storageProof The storage trie proof of that entry.
    struct OpeningProof {
        uint64 remoteSlot;
        bytes remoteHeaderRlp;
        bytes[] accountProof;
        uint64 storedSlot;
        bytes[] storageProof;
    }

    /// @notice The length of `state.block_roots`. A deposit block at most this far below its anchor uses the recent path.
    uint64 public constant SLOTS_PER_HISTORICAL_ROOT = 8192;

    /// @notice `log2(SLOTS_PER_HISTORICAL_ROOT)`: the depth of the `block_roots` vector.
    uint256 public constant BLOCK_ROOTS_VECTOR_DEPTH = 13;

    /// @notice `log2(HISTORICAL_ROOTS_LIMIT)` with `HISTORICAL_ROOTS_LIMIT = 2**24`: the depth of the
    /// `historical_summaries` list below its data node.
    uint256 public constant HISTORICAL_SUMMARIES_LIST_DEPTH = 24;

    /// @dev The deepest accepted `block_roots` or `historical_summaries` position (the state container only).
    uint256 private constant MAX_BLOCK_ROOTS_DEPTH = 8;

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

    /// @dev The index of `receiptsRoot` in the execution block header list.
    uint256 internal constant RECEIPTS_ROOT_FIELD = 5;

    /// @dev The index of `stateRoot` in the execution block header list.
    uint256 private constant STATE_ROOT_FIELD = 3;

    /// @dev The index of `storageRoot` in an account (nonce, balance, storage root, code hash).
    uint256 private constant ACCOUNT_STORAGE_ROOT_FIELD = 2;

    /// @dev The storage slot of the mapping `executionBlockHashes` in `BeaconLightClient`. A test pins it to the contract.
    uint256 private constant EXECUTION_BLOCK_HASHES_MAPPING_SLOT = 3;

    /// @dev The index of `transactionsRoot` in the execution block header list.
    uint256 internal constant TRANSACTIONS_ROOT_FIELD = 4;

    /// @notice A constructor argument is zero.
    error ZeroValue(string name);

    /// @notice The local chain identifier differs from `block.chainid`.
    error LocalChainIdMismatch(uint64 configured, uint256 actual);

    /// @notice The remote chain is the local chain.
    error RemoteChainIsLocalChain();

    /// @notice Deposits are closed until `openDeposits` proves that the other chain can pay them.
    error DepositsNotOpen();

    /// @notice The light client of this vault stored no execution block hash at the slot of the opening proof.
    error OpeningSlotNotStored(uint64 slot);

    /// @notice The header in the opening proof does not hash to the stored execution block hash.
    error OpeningHeaderMismatch(bytes32 expected, bytes32 actual);

    /// @notice The header, the account or the storage entry of the opening proof does not decode to the expected fields.
    error OpeningProofMalformed();

    /// @notice The proven entry of the remote light client is empty.
    error OpeningEntryEmpty(uint64 storedSlot);

    /// @notice The anchor header is not the finalized header stored for its slot.
    error AnchorNotStored(uint64 slot, bytes32 anchorRoot);

    /// @notice The deposit block is not strictly before the anchor.
    error DepositNotBeforeAnchor(uint64 depositSlot, uint64 anchorSlot);

    /// @notice The deposit era is before `capellaEra`, so no historical summary covers it.
    error DepositBeforeCapellaEra(uint64 depositEra, uint64 capellaEra);

    /// @notice The era index does not fit in the summaries list (2**24 entries). It would spill into a neighbour.
    error HistoricalIndexOutOfRange(uint64 index);

    /// @notice A `historical_summaries` evidence slot is not more than 8192 slots below its anchor.
    error EvidenceSlotNotHistorical(uint64 earlierSlot, uint64 anchorSlot);

    /// @notice The slot lies inside the validated range of another position, so a layout cannot be validated there.
    error LayoutRangeConflict(uint64 slot);

    /// @notice No validated layout covers the slot. Anyone can add one with evidence.
    error LayoutNotValidated(uint64 slot);

    /// @notice A candidate position is zero or deeper than the bound.
    error LayoutOutOfBounds(uint256 gindex);

    /// @notice A layout evidence slot holds no stored header.
    error EvidenceSlotNotStored(uint64 slot);

    /// @notice The two earlier slots of the evidence are the same slot.
    error EvidenceSlotsEqual(uint64 slot);

    /// @notice An earlier slot is not before the later header, or lies more than 8192 slots below it.
    error EvidenceSlotOutOfWindow(uint64 earlierSlot, uint64 laterSlot);

    /// @notice The evidence does not prove the candidate position.
    error LayoutEvidenceInvalid();

    /// @notice The ancestry branch does not lead from the deposit header to the anchor state.
    error AncestryBranchInvalid();

    /// @notice The block hash branch does not lead from the execution block hash to the deposit header body.
    error BlockHashBranchInvalid();

    /// @notice The execution header does not decode to a header with a receipts root.
    error MalformedExecutionHeader();

    /// @notice The receipt has an unsupported type byte or does not decode.
    error MalformedReceipt();

    /// @notice The receipt records a failed transaction.
    error ReceiptFailed();

    /// @notice The log index is past the end of the receipt's logs.
    error LogIndexOutOfRange(uint256 logIndex, uint256 logCount);

    /// @notice A candidate position is not the position of the named field in any accepted tree shape.
    error LayoutPositionInvalid(uint256 gindex);

    /// @notice The log was not emitted by the remote vault.
    error WrongEmitter(address expected, address actual);

    /// @notice The log is not a `DepositInitiated` log.
    error WrongEventTopic(bytes32 actual);

    /// @notice The log has the deposit topic but not the deposit layout.
    error MalformedLog();

    /// @notice Emitted when a validated `block_roots` position is added or its validated range grows.
    event BlockRootsLayoutValidated(uint256 indexed blockRootsGindex, uint64 firstSlot, uint64 lastSlot);

    /// @notice Emitted when a validated block hash position is added or its validated range grows.
    event BlockHashLayoutValidated(uint256 indexed blockHashGindex, uint64 firstSlot, uint64 lastSlot);

    /// @notice Emitted when a validated `historical_summaries` position is added or its validated range grows.
    event HistoricalSummariesLayoutValidated(
        uint256 indexed historicalSummariesGindex, uint64 firstSlot, uint64 lastSlot
    );

    /// @notice Emitted once, when `openDeposits` proves the condition. Deposits stay open from then on.
    /// @param remoteSlot The slot at which the light client of this vault stored the proven block of the remote chain.
    /// @param remoteBlockHash The hash of that block.
    /// @param storedSlot The slot whose execution block hash the remote light client had stored in that block.
    event DepositsOpened(uint64 indexed remoteSlot, bytes32 indexed remoteBlockHash, uint64 storedSlot);

    /// @notice The light client that tracks the finalized chain of the remote chain.
    IBeaconLightClient public immutable lightClient;
    /// @notice `floor(capellaForkSlot / 8192)` of the remote chain: the era of the first `historical_summaries` entry.
    /// Ethereum 758 (Capella slot 6209536), PulseChain 0 (Capella epoch 3, slot 96). Zero is valid.
    uint64 public immutable capellaEra;
    /// @notice The light client on the other chain. It tracks the beacon chain of this chain and feeds the remote contract.
    address public immutable remoteLightClient;

    /// @param lightClient_ The light client of the remote chain.
    /// @param capellaEra_ `floor(capellaForkSlot / 8192)` of the remote chain. The deploy script checks it.
    /// @param remoteLightClient_ The light client on the other chain. `openDeposits` reads its storage.
    /// @dev The constructor only stores. The contract on top checks the values, in the order of its own arguments.
    constructor(address lightClient_, uint64 capellaEra_, address remoteLightClient_) {
        lightClient = IBeaconLightClient(lightClient_);
        capellaEra = capellaEra_;
        remoteLightClient = remoteLightClient_;
    }

    // ------------------------------------------------------------------ storage hooks

    /// @dev The validated `block_roots` positions. The contract on top declares the array.
    function _stateLayoutTable() internal view virtual returns (StateLayout[] storage);

    /// @dev The validated block hash positions. The contract on top declares the array.
    function _bodyLayoutTable() internal view virtual returns (BodyLayout[] storage);

    /// @dev The validated `historical_summaries` positions. The contract on top declares the array.
    function _historicalLayoutTable() internal view virtual returns (HistoricalLayout[] storage);

    // ------------------------------------------------------------------ opening proof

    /// @dev Checks the opening proof and returns the block hash that it proved. The contract on top sets its own flag and
    /// emits `DepositsOpened`. The proof walks four links. 1: its light client stored the execution block hash of a
    /// block of the other chain at `remoteSlot`. 2: the header in the proof hashes to that block hash, and it holds a
    /// state root. 3: under that state root, the account of `remoteLightClient` holds a storage root. 4: under that
    /// storage root, `executionBlockHashes[storedSlot]` is not zero. Only `update` writes that entry, so one update was
    /// stored, at a head that the other beacon chain had already finalized. That block is final on the other chain and
    /// final in the light client of this contract, so no reorganization undoes it. A message sent now lies after that
    /// head, because a head is never later than the clock of the chain that stored it.
    function _verifyOpening(OpeningProof calldata proof) internal view returns (bytes32 blockHash) {
        blockHash = lightClient.executionBlockHashes(proof.remoteSlot);
        if (blockHash == bytes32(0)) revert OpeningSlotNotStored(proof.remoteSlot);
        bytes32 actual = keccak256(proof.remoteHeaderRlp);
        if (actual != blockHash) revert OpeningHeaderMismatch(blockHash, actual);

        bytes32 stateRoot = _headerField(proof.remoteHeaderRlp, STATE_ROOT_FIELD);
        bytes memory account = MerkleTrie.get(
            abi.encodePacked(keccak256(abi.encodePacked(remoteLightClient))), proof.accountProof, stateRoot
        );
        bytes32 storageRoot = _accountStorageRoot(account);
        bytes memory entry = MerkleTrie.get(
            abi.encodePacked(keccak256(abi.encode(_executionBlockHashesSlot(proof.storedSlot)))),
            proof.storageProof,
            storageRoot
        );
        if (RLPReader.readBytes(entry).length == 0) revert OpeningEntryEmpty(proof.storedSlot);
    }

    // ------------------------------------------------------------------ proof checks

    /// @dev Checks 2 and 3. The path comes from the distance: up to 8192 slots is the recent path, more is the
    /// historical path. The prover never picks. Both leaf indices are built by pure functions, and the branch length
    /// must be exact (`SSZ.isValidBranch` refuses padding and short branches).
    /// @param anchorHeader A stored header (the caller checked it with `_requireStoredHeader`).
    /// @param sourceHeader The beacon block that carries the proven execution block.
    /// @param branch The branch from the root of `sourceHeader` to the state root of the anchor.
    function _requireAncestryBranch(
        BeaconBlockHeader calldata anchorHeader,
        BeaconBlockHeader calldata sourceHeader,
        bytes32[] calldata branch
    ) internal view {
        uint64 anchorSlot = anchorHeader.slot;
        uint64 depositSlot = sourceHeader.slot;
        if (depositSlot >= anchorSlot) revert DepositNotBeforeAnchor(depositSlot, anchorSlot);
        uint256 leafIndex = anchorSlot - depositSlot <= SLOTS_PER_HISTORICAL_ROOT
            ? _recentLeafGindex(_blockRootsGindexAt(anchorSlot), depositSlot)
            : _historicalLeafGindex(_historicalGindexAt(anchorSlot), _eraIndex(depositSlot), depositSlot);
        bytes32 sourceRoot = SSZ.hashTreeRoot(sourceHeader);
        if (!SSZ.isValidBranch(sourceRoot, branch, leafIndex, anchorHeader.stateRoot)) revert AncestryBranchInvalid();
    }

    /// @dev Check 4. The execution block hash must sit in the body of the source header at the validated position.
    function _requireBlockHashBranch(
        bytes32 blockHash,
        BeaconBlockHeader calldata sourceHeader,
        bytes32[] calldata branch
    ) internal view {
        if (!SSZ.isValidBranch(blockHash, branch, _blockHashGindexAt(sourceHeader.slot), sourceHeader.bodyRoot)) {
            revert BlockHashBranchInvalid();
        }
    }

    /// @dev Check 5. The execution header as a list of its RLP items.
    function _headerItems(bytes calldata executionHeaderRlp) internal pure returns (RLPReader.RLPItem[] memory) {
        return RLPReader.readList(executionHeaderRlp);
    }

    /// @dev A 32-byte root of the execution header: the item at `field`. Reverts on a short header or a wrong width.
    function _headerRoot(RLPReader.RLPItem[] memory fields, uint256 field) internal pure returns (bytes32) {
        if (fields.length <= field) revert MalformedExecutionHeader();
        bytes memory root = RLPReader.readBytes(fields[field]);
        if (root.length != 32) revert MalformedExecutionHeader();
        return bytes32(root);
    }

    /// @dev Checks 6 and 7, up to the log. The receipt is an EIP-2718 envelope. It must record success. Returns the
    /// log at `logIndex`. The receipt may hold more than 32 logs.
    function _receiptLog(bytes memory receipt, uint256 logIndex) internal pure returns (RLPReader.RLPItem memory) {
        RLPReader.RLPItem[] memory fields = RLPReader.readList(_receiptPayload(receipt));
        if (fields.length != 4) revert MalformedReceipt();
        bytes memory status = RLPReader.readBytes(fields[0]);
        if (status.length != 1 || status[0] != 0x01) revert ReceiptFailed();

        (bool logFound, RLPReader.RLPItem memory log, uint256 logCount) = ReceiptLogs.itemAt(fields[3], logIndex);
        if (!logFound) revert LogIndexOutOfRange(logIndex, logCount);
        return log;
    }

    /// @dev The three fields of a log: emitter, topics and data.
    function _logFields(RLPReader.RLPItem memory log) internal pure returns (RLPReader.RLPItem[] memory fields) {
        fields = RLPReader.readList(log);
        if (fields.length != 3) revert MalformedLog();
    }

    /// @dev Requires that the emitter item of a log is `expected`.
    function _requireEmitter(RLPReader.RLPItem memory emitterItem, address expected) internal pure {
        bytes memory emitter = RLPReader.readBytes(emitterItem);
        if (emitter.length != 20) revert MalformedLog();
        address emitterAddress = address(bytes20(emitter));
        if (emitterAddress != expected) revert WrongEmitter(expected, emitterAddress);
    }

    /// @notice Adds a `block_roots` position, or widens its validated range, given evidence from stored data.
    /// @dev Open to anyone. The position must be the `block_roots` field itself: `2**d + 5` with `d` in 5 to 7. Any
    /// other position reverts with `LayoutPositionInvalid`, even when the evidence would match (for example the position
    /// of `eth1_data_votes`, whose entries a proposer writes). The position is accepted only when, under the stored later state root, the leaf at
    /// `blockRootsGindex * 8192 + slot % 8192` equals the light client's stored header root, for two different
    /// stored earlier slots. A wrong position cannot match. The position is then usable for the later header's slot.
    /// @param blockRootsGindex The candidate generalized index of `BeaconState.block_roots`.
    /// @param evidence Two stored earlier headers under one stored later state.
    function addBlockRootsLayout(uint256 blockRootsGindex, BlockRootsEvidence calldata evidence) external {
        if (blockRootsGindex == 0 || SSZ.depthOf(blockRootsGindex) > MAX_BLOCK_ROOTS_DEPTH) {
            revert LayoutOutOfBounds(blockRootsGindex);
        }
        if (!_isStateFieldPosition(blockRootsGindex, BLOCK_ROOTS_FIELD)) {
            revert LayoutPositionInvalid(blockRootsGindex);
        }
        _requireStoredHeader(evidence.laterHeader);
        if (evidence.earlierSlotA == evidence.earlierSlotB) revert EvidenceSlotsEqual(evidence.earlierSlotA);
        _requireEarlierRoot(evidence.laterHeader, evidence.earlierSlotA, blockRootsGindex, evidence.branchA);
        _requireEarlierRoot(evidence.laterHeader, evidence.earlierSlotB, blockRootsGindex, evidence.branchB);

        uint64 slot = evidence.laterHeader.slot;
        SlotRange[] memory ranges = new SlotRange[](_stateLayoutTable().length);
        for (uint256 i = 0; i < ranges.length; i++) {
            StateLayout storage stored = _stateLayoutTable()[i];
            ranges[i] = SlotRange(stored.blockRootsGindex, stored.firstSlot, stored.lastSlot);
        }
        uint256 index = _planRange(blockRootsGindex, slot, ranges);
        if (index == ranges.length) {
            _stateLayoutTable().push(StateLayout({blockRootsGindex: blockRootsGindex, firstSlot: slot, lastSlot: slot}));
            emit BlockRootsLayoutValidated(blockRootsGindex, slot, slot);
            return;
        }
        StateLayout storage layout = _stateLayoutTable()[index];
        if (slot < layout.firstSlot) layout.firstSlot = slot;
        if (slot > layout.lastSlot) layout.lastSlot = slot;
        emit BlockRootsLayoutValidated(blockRootsGindex, layout.firstSlot, layout.lastSlot);
    }

    /// @notice Adds a block hash position, or widens its validated range, given evidence from stored data.
    /// @dev Open to anyone. The position must be the block hash field itself: `(2**db + 9) * 2**dp + 12` with `db` and
    /// `dp` in 4 to 5, which is 412, 668, 812 or 1324. Any other position reverts with `LayoutPositionInvalid`, even when
    /// the evidence would match (for example `graffiti` at 18, or `eth1_data.block_hash` at 70, which a proposer can
    /// fill with a copy of the block hash). The position is accepted only when, under the body root of a stored header, the leaf at
    /// `blockHashGindex` equals the light client's stored execution block hash of that header.
    /// @param blockHashGindex The candidate generalized index of `BeaconBlockBody.execution_payload.block_hash`.
    /// @param evidence A stored header and the branch to its body root.
    function addBlockHashLayout(uint256 blockHashGindex, BlockHashEvidence calldata evidence) external {
        if (blockHashGindex == 0 || SSZ.depthOf(blockHashGindex) > MAX_BLOCK_HASH_DEPTH) {
            revert LayoutOutOfBounds(blockHashGindex);
        }
        if (!_isBlockHashPosition(blockHashGindex)) revert LayoutPositionInvalid(blockHashGindex);
        _requireStoredHeader(evidence.header);
        bytes32 storedBlockHash = lightClient.executionBlockHashes(evidence.header.slot);
        if (storedBlockHash == bytes32(0)) revert EvidenceSlotNotStored(evidence.header.slot);
        if (!SSZ.isValidBranch(storedBlockHash, evidence.branch, blockHashGindex, evidence.header.bodyRoot)) {
            revert LayoutEvidenceInvalid();
        }

        uint64 slot = evidence.header.slot;
        SlotRange[] memory ranges = new SlotRange[](_bodyLayoutTable().length);
        for (uint256 i = 0; i < ranges.length; i++) {
            BodyLayout storage stored = _bodyLayoutTable()[i];
            ranges[i] = SlotRange(stored.blockHashGindex, stored.firstSlot, stored.lastSlot);
        }
        uint256 index = _planRange(blockHashGindex, slot, ranges);
        if (index == ranges.length) {
            _bodyLayoutTable().push(BodyLayout({blockHashGindex: blockHashGindex, firstSlot: slot, lastSlot: slot}));
            emit BlockHashLayoutValidated(blockHashGindex, slot, slot);
            return;
        }
        BodyLayout storage layout = _bodyLayoutTable()[index];
        if (slot < layout.firstSlot) layout.firstSlot = slot;
        if (slot > layout.lastSlot) layout.lastSlot = slot;
        emit BlockHashLayoutValidated(blockHashGindex, layout.firstSlot, layout.lastSlot);
    }

    /// @notice Adds a `historical_summaries` position, or widens its validated range, given evidence from stored data.
    /// @dev Open to anyone. The position is accepted only when, under the stored anchor state root, the leaf at the
    /// historical index of the candidate equals the light client's stored header root at `earlierSlot`. The index is
    /// built as `withdraw` builds it, so the candidate must also fit the era formula. A candidate that is another
    /// state field (`block_roots`, `finalized_checkpoint.root`, `latest_block_header`) or a list of another depth
    /// cannot match. The position is then usable for the anchor's slot.
    /// @param historicalSummariesGindex The candidate generalized index of `BeaconState.historical_summaries`.
    /// @param evidence A stored anchor, a stored earlier slot in a completed era, and the branch between them.
    function addHistoricalSummariesLayout(
        uint256 historicalSummariesGindex,
        HistoricalSummariesEvidence calldata evidence
    ) external {
        if (historicalSummariesGindex == 0 || SSZ.depthOf(historicalSummariesGindex) > MAX_BLOCK_ROOTS_DEPTH) {
            revert LayoutOutOfBounds(historicalSummariesGindex);
        }
        if (!_isStateFieldPosition(historicalSummariesGindex, HISTORICAL_SUMMARIES_FIELD)) {
            revert LayoutPositionInvalid(historicalSummariesGindex);
        }
        _requireStoredHeader(evidence.anchorHeader);
        uint64 anchorSlot = evidence.anchorHeader.slot;
        uint64 earlierSlot = evidence.earlierSlot;
        bytes32 storedRoot = lightClient.headers(earlierSlot);
        if (storedRoot == bytes32(0)) revert EvidenceSlotNotStored(earlierSlot);
        if (earlierSlot >= anchorSlot || anchorSlot - earlierSlot <= SLOTS_PER_HISTORICAL_ROOT) {
            revert EvidenceSlotNotHistorical(earlierSlot, anchorSlot);
        }
        uint256 leafIndex = _historicalLeafGindex(historicalSummariesGindex, _eraIndex(earlierSlot), earlierSlot);
        if (!SSZ.isValidBranch(storedRoot, evidence.branch, leafIndex, evidence.anchorHeader.stateRoot)) {
            revert LayoutEvidenceInvalid();
        }

        SlotRange[] memory ranges = new SlotRange[](_historicalLayoutTable().length);
        for (uint256 i = 0; i < ranges.length; i++) {
            HistoricalLayout storage stored = _historicalLayoutTable()[i];
            ranges[i] = SlotRange(stored.historicalSummariesGindex, stored.firstSlot, stored.lastSlot);
        }
        uint256 index = _planRange(historicalSummariesGindex, anchorSlot, ranges);
        if (index == ranges.length) {
            _historicalLayoutTable()
                .push(
                    HistoricalLayout({
                    historicalSummariesGindex: historicalSummariesGindex, firstSlot: anchorSlot, lastSlot: anchorSlot
                })
                );
            emit HistoricalSummariesLayoutValidated(historicalSummariesGindex, anchorSlot, anchorSlot);
            return;
        }
        HistoricalLayout storage layout = _historicalLayoutTable()[index];
        if (anchorSlot < layout.firstSlot) layout.firstSlot = anchorSlot;
        if (anchorSlot > layout.lastSlot) layout.lastSlot = anchorSlot;
        emit HistoricalSummariesLayoutValidated(historicalSummariesGindex, layout.firstSlot, layout.lastSlot);
    }

    /// @dev The range rule. Returns the index of the range of `gindex` that grows to hold `slot`, or `ranges.length`
    /// when a new range must start. A range grows only when the grown range overlaps no range of another position, so
    /// ranges of different positions never overlap. Reverts when `slot` is already inside the range of another position.
    function _planRange(uint256 gindex, uint64 slot, SlotRange[] memory ranges) internal pure returns (uint256) {
        for (uint256 i = 0; i < ranges.length; i++) {
            if (ranges[i].gindex == gindex) continue;
            if (ranges[i].firstSlot <= slot && slot <= ranges[i].lastSlot) revert LayoutRangeConflict(slot);
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
    function _overlapsOtherPosition(uint256 gindex, uint64 low, uint64 high, SlotRange[] memory ranges)
        private
        pure
        returns (bool)
    {
        for (uint256 i = 0; i < ranges.length; i++) {
            if (ranges[i].gindex == gindex) continue;
            if (ranges[i].firstSlot <= high && low <= ranges[i].lastSlot) return true;
        }
        return false;
    }

    /// @notice The validated `block_roots` positions and their slot ranges.
    function stateLayouts() external view returns (StateLayout[] memory) {
        return _stateLayoutTable();
    }

    /// @notice The validated `historical_summaries` positions and their slot ranges.
    function historicalLayouts() external view returns (HistoricalLayout[] memory) {
        return _historicalLayoutTable();
    }

    /// @notice The validated block hash positions and their slot ranges.
    function bodyLayouts() external view returns (BodyLayout[] memory) {
        return _bodyLayoutTable();
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
    function _requireStoredHeader(BeaconBlockHeader calldata header) internal view {
        bytes32 headerRoot = SSZ.hashTreeRoot(header);
        bytes32 stored = lightClient.headers(header.slot);
        if (stored == bytes32(0) || stored != headerRoot) revert AnchorNotStored(header.slot, headerRoot);
    }

    /// @dev The stored root at `earlierSlot` must be the leaf at the candidate position under the later state root.
    function _requireEarlierRoot(
        BeaconBlockHeader calldata later,
        uint64 earlierSlot,
        uint256 blockRootsGindex,
        bytes32[] calldata branch
    ) private view {
        if (earlierSlot >= later.slot || later.slot - earlierSlot > SLOTS_PER_HISTORICAL_ROOT) {
            revert EvidenceSlotOutOfWindow(earlierSlot, later.slot);
        }
        bytes32 storedRoot = lightClient.headers(earlierSlot);
        if (storedRoot == bytes32(0)) revert EvidenceSlotNotStored(earlierSlot);
        uint256 elementIndex = blockRootsGindex * SLOTS_PER_HISTORICAL_ROOT + (earlierSlot % SLOTS_PER_HISTORICAL_ROOT);
        if (!SSZ.isValidBranch(storedRoot, branch, elementIndex, later.stateRoot)) revert LayoutEvidenceInvalid();
    }

    /// @dev The recent path: `block_roots[depositSlot % 8192]` is at `blockRootsGindex * 8192 + depositSlot % 8192`.
    function _recentLeafGindex(uint256 blockRootsGindex, uint64 depositSlot) private pure returns (uint256) {
        return blockRootsGindex * SLOTS_PER_HISTORICAL_ROOT + (depositSlot % SLOTS_PER_HISTORICAL_ROOT);
    }

    /// @dev The index of the summary of a slot's era: `era - capellaEra`. The era must be at or after `capellaEra`
    /// and the index must fit the list of 2**24 entries.
    function _eraIndex(uint64 slot) private view returns (uint64) {
        uint64 era = slot / SLOTS_PER_HISTORICAL_ROOT;
        if (era < capellaEra) revert DepositBeforeCapellaEra(era, capellaEra);
        uint64 index = era - capellaEra;
        if (uint256(index) >= (uint256(1) << HISTORICAL_SUMMARIES_LIST_DEPTH)) revert HistoricalIndexOutOfRange(index);
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
    function _blockRootsGindexAt(uint64 slot) private view returns (uint256) {
        for (uint256 i = 0; i < _stateLayoutTable().length; i++) {
            StateLayout storage layout = _stateLayoutTable()[i];
            if (layout.firstSlot <= slot && slot <= layout.lastSlot) return layout.blockRootsGindex;
        }
        revert LayoutNotValidated(slot);
    }

    /// @dev The validated `historical_summaries` position whose slot range contains `slot`.
    function _historicalGindexAt(uint64 slot) private view returns (uint256) {
        for (uint256 i = 0; i < _historicalLayoutTable().length; i++) {
            HistoricalLayout storage layout = _historicalLayoutTable()[i];
            if (layout.firstSlot <= slot && slot <= layout.lastSlot) return layout.historicalSummariesGindex;
        }
        revert LayoutNotValidated(slot);
    }

    /// @dev The validated block hash position whose slot range contains `slot`.
    function _blockHashGindexAt(uint64 slot) private view returns (uint256) {
        for (uint256 i = 0; i < _bodyLayoutTable().length; i++) {
            BodyLayout storage layout = _bodyLayoutTable()[i];
            if (layout.firstSlot <= slot && slot <= layout.lastSlot) return layout.blockHashGindex;
        }
        revert LayoutNotValidated(slot);
    }

    /// @dev The storage slot of `executionBlockHashes[storedSlot]` in the remote light client: the mapping key and the
    /// declared slot of the mapping, hashed together.
    function _executionBlockHashesSlot(uint64 storedSlot) private pure returns (bytes32) {
        return keccak256(abi.encode(uint256(storedSlot), EXECUTION_BLOCK_HASHES_MAPPING_SLOT));
    }

    /// @dev The 32-byte item at index `field` of an execution block header.
    function _headerField(bytes calldata headerRlp, uint256 field) private pure returns (bytes32) {
        RLPReader.RLPItem[] memory fields = RLPReader.readList(headerRlp);
        if (fields.length <= field) revert OpeningProofMalformed();
        bytes memory value = RLPReader.readBytes(fields[field]);
        if (value.length != 32) revert OpeningProofMalformed();
        return bytes32(value);
    }

    /// @dev The storage root of an account, from its RLP: nonce, balance, storage root and code hash.
    function _accountStorageRoot(bytes memory account) private pure returns (bytes32) {
        RLPReader.RLPItem[] memory fields = RLPReader.readList(account);
        if (fields.length != 4) revert OpeningProofMalformed();
        bytes memory root = RLPReader.readBytes(fields[ACCOUNT_STORAGE_ROOT_FIELD]);
        if (root.length != 32) revert OpeningProofMalformed();
        return bytes32(root);
    }

    /// @dev Strips the EIP-2718 type byte. Legacy receipts start with a list prefix (at least 0xc0). The result is an
    /// RLP item that points one byte into the receipt, so no byte is copied. A receipt of only a type byte gives an
    /// item of length zero, which the reader refuses.
    function _receiptPayload(bytes memory receipt) internal pure returns (RLPReader.RLPItem memory payload) {
        if (receipt.length == 0) revert MalformedReceipt();
        uint8 first = uint8(receipt[0]);
        payload = RLPReader.toRLPItem(receipt);
        if (first >= 0xc0) return payload;
        if (first < 0x01 || first > 0x04) revert MalformedReceipt();
        payload.length -= 1;
        payload.ptr = RLPReader.MemoryPointer.wrap(RLPReader.MemoryPointer.unwrap(payload.ptr) + 1);
    }

    function _toBytes32(bytes memory value) internal pure returns (bytes32) {
        if (value.length != 32) revert MalformedLog();
        return bytes32(value);
    }

    /// @dev A topic holds an address in its low 20 bytes. The high 12 bytes must be zero.
    function _toAddress(bytes memory topic) internal pure returns (address) {
        uint256 word = uint256(_toBytes32(topic));
        if (word > type(uint160).max) revert MalformedLog();
        return address(uint160(word));
    }

    /// @dev The RLP encoding of an unsigned integer, which is the receipts trie key of a transaction index.
    function _encodeUint(uint256 value) internal pure returns (bytes memory) {
        if (value == 0) return hex"80";
        if (value < 0x80) return abi.encodePacked(uint8(value));
        uint256 length;
        for (uint256 rest = value; rest > 0; rest >>= 8) {
            length++;
        }
        bytes memory encoded = new bytes(length + 1);
        encoded[0] = bytes1(uint8(0x80 + length));
        for (uint256 i = 0; i < length; i++) {
            encoded[length - i] = bytes1(uint8(value >> (8 * i)));
        }
        return encoded;
    }
}
