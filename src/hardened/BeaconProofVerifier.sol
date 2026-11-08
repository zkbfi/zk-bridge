// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IBeaconLightClient} from "./IBeaconLightClient.sol";
import {BeaconBlockHeader, SSZ} from "./SSZ.sol";
import {OpeningProofLib} from "./OpeningProofLib.sol";
import {BeaconLayoutLib, ERA_SLOTS, ERA_DEPTH, HISTORICAL_LIST_DEPTH} from "./BeaconLayoutLib.sol";

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
/// Gloas. From Gloas on, `BeaconState` is a progressive container (EIP-7495, EIP-7916), so a field no longer sits at
/// `2**depth + index`. Its position is one fixed number, which later forks keep. `block_roots` sits at 352 and
/// `historical_summaries` at 2950. The position rules take those two numbers next to the depth rule, and no other
/// number of a deeper tree: the rule for an older fork is not looser. The body of a Gloas block holds a bid and no payload,
/// so no layout position of the block hash exists for a Gloas slot. A message source at or after `gloasForkSlot` is a beacon
/// block B after the execution block X, and the fixed index 2856 (the bid `parent_block_hash` of B) must equal the hash of X.
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
///
/// Split for the gas cap. The execution layer checks of a delivery (receipt, transaction, log) are in the external
/// library `ReceiptProofLib`, the account and storage proofs of the opening in `OpeningProofLib`, and the anchor, the
/// ancestry, the block hash branch and the layout rules in `BeaconLayoutLib`, so that the creation of the contract on top and of each library stays under the per-transaction
/// gas cap of EIP-7825 (16,777,216). Both are linked: no owner, no storage of their own, their addresses fixed in the
/// bytecode. The layout library runs in the storage of the contract on top, with the tables passed as `storage`
/// arguments. The errors and the events stay declared here, and the libraries use them, so nothing changes outside.
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

    /// @notice The value of `gloasForkSlot` for a route whose remote chain has no Gloas fork.
    uint64 public constant NO_GLOAS_FORK = type(uint64).max;

    /// @notice The length of `state.block_roots`. A deposit block at most this far below its anchor uses the recent path.
    uint64 public constant SLOTS_PER_HISTORICAL_ROOT = ERA_SLOTS;

    /// @notice `log2(SLOTS_PER_HISTORICAL_ROOT)`: the depth of the `block_roots` vector.
    uint256 public constant BLOCK_ROOTS_VECTOR_DEPTH = ERA_DEPTH;

    /// @notice `log2(HISTORICAL_ROOTS_LIMIT)` with `HISTORICAL_ROOTS_LIMIT = 2**24`: the depth of the
    /// `historical_summaries` list below its data node.
    uint256 public constant HISTORICAL_SUMMARIES_LIST_DEPTH = HISTORICAL_LIST_DEPTH;

    // The position rules, the fork positions and the depths are constants of `BeaconLayoutLib`; the execution header and
    // account field indices are constants of `ReceiptProofLib` and `OpeningProofLib`. One copy of each, in the code that
    // reads it.

    /// @notice A constructor argument is zero.
    error ZeroValue(string name);

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

    /// @notice `addBlockHashLayout` was asked about a slot at or after the Gloas fork. The stored hash of such a slot is
    /// `latest_block_hash`, not the payload of the block of that slot, and the body holds only a bid. A message source
    /// at or after the fork takes no layout: it reads the fixed bid index.
    error GloasSlotRefused(uint64 slot, uint64 gloasForkSlot);

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
    /// @notice The first slot of the Gloas fork on the remote chain, or `NO_GLOAS_FORK` when the route has none.
    /// @dev From this slot on, `lightClient.executionBlockHashes(slot)` holds `state.latest_block_hash` of the finalized
    /// state: the newest payload that a block confirmed BEFORE the slot, not the payload of the slot. The body of a Gloas
    /// block holds a bid and no payload. So `addBlockHashLayout` never reads a stored hash at or after this slot as the
    /// payload of the beacon block of that slot, and refuses it. A message source at or after this slot reads the bid
    /// `parent_block_hash` of a LATER block (`BeaconLayoutLib.GLOAS_BID_PARENT_BLOCK_HASH_GINDEX`). A Gloas head is used through the
    /// opening proof, which checks an execution header RLP against the stored hash.
    uint64 public immutable gloasForkSlot;

    /// @param lightClient_ The light client of the remote chain.
    /// @param capellaEra_ `floor(capellaForkSlot / 8192)` of the remote chain. The deploy script checks it.
    /// @param remoteLightClient_ The light client on the other chain. `openDeposits` reads its storage.
    /// @param gloasForkSlot_ The first slot of Gloas on the remote chain, or `NO_GLOAS_FORK`. The deploy script checks it.
    /// @dev The constructor only stores. The contract on top checks the values, in the order of its own arguments.
    constructor(address lightClient_, uint64 capellaEra_, address remoteLightClient_, uint64 gloasForkSlot_) {
        lightClient = IBeaconLightClient(lightClient_);
        capellaEra = capellaEra_;
        remoteLightClient = remoteLightClient_;
        gloasForkSlot = gloasForkSlot_;
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
    /// head, because a head is never later than the clock of the chain that stored it. Links 2 to 4 are in
    /// `OpeningProofLib.requireOpeningEntry`.
    function _verifyOpening(OpeningProof calldata proof) internal view returns (bytes32 blockHash) {
        blockHash = lightClient.executionBlockHashes(proof.remoteSlot);
        if (blockHash == bytes32(0)) revert OpeningSlotNotStored(proof.remoteSlot);
        bytes32 actual = keccak256(proof.remoteHeaderRlp);
        if (actual != blockHash) revert OpeningHeaderMismatch(blockHash, actual);
        OpeningProofLib.requireOpeningEntry(
            proof.remoteHeaderRlp, proof.accountProof, proof.storedSlot, proof.storageProof, remoteLightClient
        );
    }

    // ------------------------------------------------------------------ proof checks

    /// @dev Checks 1 to 3: the anchor is a stored header and the source block is its ancestor. The rules run in
    /// `BeaconLayoutLib.requireAncestry`, over the layout tables of this contract.
    /// @param anchorHeader A header that the light client stored.
    /// @param sourceHeader The beacon block that carries the proven execution block.
    /// @param branch The branch from the root of `sourceHeader` to the state root of the anchor.
    function _requireAncestry(
        BeaconBlockHeader calldata anchorHeader,
        BeaconBlockHeader calldata sourceHeader,
        bytes32[] calldata branch
    ) internal view {
        BeaconLayoutLib.requireAncestry(
            _stateLayoutTable(), _historicalLayoutTable(), lightClient, capellaEra, anchorHeader, sourceHeader, branch
        );
    }

    /// @dev Check 4. The execution block hash must sit in the body of the source header. Before the Gloas fork it is at the
    /// validated payload block hash position. At or after `gloasForkSlot` it is the bid `parent_block_hash` at the fixed
    /// index 2856 (see `BeaconLayoutLib.GLOAS_BID_PARENT_BLOCK_HASH_GINDEX`). The rule runs in `BeaconLayoutLib.requireBlockHash`.
    function _requireBlockHashBranch(
        bytes32 blockHash,
        BeaconBlockHeader calldata sourceHeader,
        bytes32[] calldata branch
    ) internal view {
        BeaconLayoutLib.requireBlockHash(_bodyLayoutTable(), gloasForkSlot, blockHash, sourceHeader, branch);
    }

    /// @notice Adds a `block_roots` position, or widens its validated range, given evidence from stored data.
    /// @dev Open to anyone. The position must be the `block_roots` field itself: `2**d + 5` with `d` in 5 to 7, or 352
    /// (Gloas). Any other position reverts with `LayoutPositionInvalid`, even when the evidence would match (for example the position
    /// of `eth1_data_votes`, whose entries a proposer writes). The position is accepted only when, under the stored later state root, the leaf at
    /// `blockRootsGindex * 8192 + slot % 8192` equals the light client's stored header root, for two different
    /// stored earlier slots. A wrong position cannot match. The position is then usable for the later header's slot.
    /// The rules run in `BeaconLayoutLib.addBlockRootsLayout`.
    /// @param blockRootsGindex The candidate generalized index of `BeaconState.block_roots`.
    /// @param evidence Two stored earlier headers under one stored later state.
    function addBlockRootsLayout(uint256 blockRootsGindex, BlockRootsEvidence calldata evidence) external {
        BeaconLayoutLib.addBlockRootsLayout(_stateLayoutTable(), lightClient, blockRootsGindex, evidence);
    }

    /// @notice Adds a block hash position, or widens its validated range, given evidence from stored data.
    /// @dev Open to anyone. The position must be the block hash field itself: `(2**db + 9) * 2**dp + 12` with `db` and
    /// `dp` in 4 to 5, which is 412, 668, 812 or 1324. Any other position reverts with `LayoutPositionInvalid`, even when
    /// the evidence would match (for example `graffiti` at 18, or `eth1_data.block_hash` at 70, which a proposer can
    /// fill with a copy of the block hash). The position is accepted only when, under the body root of a stored header, the leaf at
    /// `blockHashGindex` equals the light client's stored execution block hash of that header. A slot at or after
    /// `gloasForkSlot` is refused. The rules run in `BeaconLayoutLib.addBlockHashLayout`.
    /// @param blockHashGindex The candidate generalized index of `BeaconBlockBody.execution_payload.block_hash`.
    /// @param evidence A stored header and the branch to its body root.
    function addBlockHashLayout(uint256 blockHashGindex, BlockHashEvidence calldata evidence) external {
        BeaconLayoutLib.addBlockHashLayout(_bodyLayoutTable(), lightClient, gloasForkSlot, blockHashGindex, evidence);
    }

    /// @notice Adds a `historical_summaries` position, or widens its validated range, given evidence from stored data.
    /// @dev Open to anyone. The position is accepted only when, under the stored anchor state root, the leaf at the
    /// historical index of the candidate equals the light client's stored header root at `earlierSlot`. The index is
    /// built as `withdraw` builds it, so the candidate must also fit the era formula. A candidate that is another
    /// state field (`block_roots`, `finalized_checkpoint.root`, `latest_block_header`) or a list of another depth
    /// cannot match. The position is then usable for the anchor's slot. The rules run in
    /// `BeaconLayoutLib.addHistoricalSummariesLayout`.
    /// @param historicalSummariesGindex The candidate generalized index of `BeaconState.historical_summaries`.
    /// @param evidence A stored anchor, a stored earlier slot in a completed era, and the branch between them.
    function addHistoricalSummariesLayout(
        uint256 historicalSummariesGindex,
        HistoricalSummariesEvidence calldata evidence
    ) external {
        BeaconLayoutLib.addHistoricalSummariesLayout(
            _historicalLayoutTable(), lightClient, capellaEra, historicalSummariesGindex, evidence
        );
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
}
