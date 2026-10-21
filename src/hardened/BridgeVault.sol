// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
// The storage guard, never the transient one: PulseChain has no TSTORE.
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBeaconLightClient} from "./IBeaconLightClient.sol";
import {IDepositGate} from "./IDepositGate.sol";
import {BeaconBlockHeader, SSZ} from "./SSZ.sol";
import {MerkleTrie} from "./vendor/optimism/trie/MerkleTrie.sol";
import {RLPReader} from "./vendor/optimism/rlp/RLPReader.sol";

/// @title BridgeVault
/// @notice One end of a two-chain bridge. It locks tokens on deposit and pays tokens against a direct proof of
/// a deposit on the other chain. The vault checks the proof itself: no withdrawal zero-knowledge program exists.
/// Only the light client uses a zero-knowledge proof. The vault has no owner, no refund, and no upgrade path.
/// @dev Fork layouts. The generalized indices of `state.block_roots`, of `state.historical_summaries` and of the
/// execution block hash depend on the fork of the source chain. The vault holds no fixed table. Anyone may add a
/// layout with `addBlockRootsLayout`, `addHistoricalSummariesLayout` and `addBlockHashLayout`, and the chain's own stored
/// data must prove it: the candidate position must map stored header roots (or the stored execution block hash) to the
/// stored state (or body) root. A wrong position cannot match.
///
/// Ancestry has two paths, chosen by the vault from the two slots. A deposit at most 8192 slots below the anchor is
/// proven through `state.block_roots`. An older deposit is proven through `state.historical_summaries`, which holds the
/// root of every completed era of 8192 block roots since Capella. So a stored head may be any distance past the one
/// before it.
/// A layout is usable only for the slots between the first and the last slot at which it was validated. Layouts move
/// only when a container crosses a power-of-two field count; then a new route (light client and vault) is deployed
/// beside the old one, and the old route keeps paying what it can still prove. This is the immutability trade-off of
/// hole H-19.
contract BridgeVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice A token on this chain and its counterpart on the remote chain.
    struct TokenPair {
        address localToken;
        address remoteToken;
        uint8 remoteDecimals;
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

    /// @notice The evidence for one withdrawal. Nothing in it is secret.
    struct WithdrawalProof {
        BeaconBlockHeader anchorHeader;
        BeaconBlockHeader depositHeader;
        bytes32[] ancestryBranch;
        bytes32[] blockHashBranch;
        bytes executionHeaderRlp;
        bytes[] receiptProof;
        uint256 transactionIndex;
        uint256 logIndex;
    }

    /// @dev The fields of a deposit log.
    struct Deposit {
        address token;
        address recipient;
        uint256 amount;
        bytes32 nonce;
        uint64 targetChainId;
    }

    /// @notice The length of `state.block_roots`. A deposit block at most this far below its anchor uses the recent path.
    uint64 public constant SLOTS_PER_HISTORICAL_ROOT = 8192;

    /// @notice `log2(SLOTS_PER_HISTORICAL_ROOT)`: the depth of the `block_roots` vector.
    uint256 public constant BLOCK_ROOTS_VECTOR_DEPTH = 13;

    /// @notice `log2(HISTORICAL_ROOTS_LIMIT)` with `HISTORICAL_ROOTS_LIMIT = 2**24`: the depth of the
    /// `historical_summaries` list below its data node.
    uint256 public constant HISTORICAL_SUMMARIES_LIST_DEPTH = 24;

    /// @notice The topic 0 of `DepositInitiated`. Withdrawals match logs against this value.
    /// @dev Solidity 0.8.28 rejects `DepositInitiated.selector` in a constant. A test pins this value to the selector.
    bytes32 public constant DEPOSIT_EVENT_TOPIC =
        keccak256("DepositInitiated(address,address,address,uint256,bytes32,uint64)");

    /// @dev The deepest accepted `block_roots` or `historical_summaries` position (the state container only).
    uint256 private constant MAX_BLOCK_ROOTS_DEPTH = 8;
    /// @dev The deepest accepted block hash position.
    uint256 private constant MAX_BLOCK_HASH_DEPTH = 16;

    /// @dev The index of `receiptsRoot` in the execution block header list.
    uint256 private constant RECEIPTS_ROOT_FIELD = 5;

    /// @notice A constructor argument is zero.
    error ZeroValue(string name);
    /// @notice The local chain identifier differs from `block.chainid`.
    error LocalChainIdMismatch(uint64 configured, uint256 actual);
    /// @notice The remote chain is the local chain.
    error RemoteChainIsLocalChain();
    /// @notice The constructor got no token pairs.
    error NoTokenPairs();
    /// @notice A token address holds no code.
    error TokenHasNoCode(address token);
    /// @notice The local token reports other decimals than the pair claims.
    error DecimalsMismatch(address localToken, uint8 localDecimals, uint8 remoteDecimals);
    /// @notice A local token appears twice.
    error DuplicateLocalToken(address token);
    /// @notice A remote token appears twice.
    error DuplicateRemoteToken(address token);
    /// @notice The local token is not registered.
    error UnsupportedToken(address token);
    /// @notice The remote token is not registered.
    error UnsupportedRemoteToken(address token);
    /// @notice The recipient is the zero address.
    error ZeroRecipient();
    /// @notice The amount is zero.
    error ZeroAmount();
    /// @notice The vault received no tokens from the transfer.
    error NothingReceived();

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
    /// @notice Deposits are closed because the cutoff time passed.
    error DepositCutoffReached(uint64 cutoff);
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
    /// @notice The log was not emitted by the remote vault.
    error WrongEmitter(address expected, address actual);
    /// @notice The log is not a `DepositInitiated` log.
    error WrongEventTopic(bytes32 actual);
    /// @notice The log has the deposit topic but not the deposit layout.
    error MalformedLog();
    /// @notice The deposit targets another chain than this chain.
    error WrongTargetChain(uint64 expected, uint64 actual);
    /// @notice The deposit was already claimed.
    error AlreadyClaimed(bytes32 depositNonce);

    /// @notice Emitted when a validated `block_roots` position is added or its validated range grows.
    event BlockRootsLayoutValidated(uint256 indexed blockRootsGindex, uint64 firstSlot, uint64 lastSlot);

    /// @notice Emitted when a validated block hash position is added or its validated range grows.
    event BlockHashLayoutValidated(uint256 indexed blockHashGindex, uint64 firstSlot, uint64 lastSlot);

    /// @notice Emitted when a validated `historical_summaries` position is added or its validated range grows.
    event HistoricalSummariesLayoutValidated(uint256 indexed historicalSummariesGindex, uint64 firstSlot, uint64 lastSlot);

    /// @notice Emitted on deposit with the amount the vault received.
    event DepositInitiated(
        address indexed token,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        bytes32 nonce,
        uint64 targetChainId
    );

    /// @notice Emitted when a withdrawal pays out. `depositBlockHash` is the execution block that holds the deposit.
    event WithdrawalCompleted(
        address indexed token,
        address indexed recipient,
        bytes32 indexed depositNonce,
        uint256 amount,
        bytes32 depositBlockHash
    );

    /// @notice The light client that tracks the finalized chain of the remote chain.
    IBeaconLightClient public immutable lightClient;
    /// @notice The identifier of this chain.
    uint64 public immutable localChainId;
    /// @notice The identifier of the other chain.
    uint64 public immutable remoteChainId;
    /// @notice The vault on the other chain.
    address public immutable remoteVault;
    /// @notice Deposits revert at and after this timestamp. Zero disables the cutoff. Set it at deployment only
    /// when a breaking fork of the other chain is already scheduled.
    uint64 public immutable depositCutoffTimestamp;
    /// @notice `floor(capellaForkSlot / 8192)` of the remote chain: the era of the first `historical_summaries` entry.
    /// Ethereum 758 (Capella slot 6209536), PulseChain 0 (Capella epoch 3, slot 96). Zero is valid.
    uint64 public immutable capellaEra;
    /// @notice The gate that `deposit` calls first. It refuses a deposit the route cannot deliver.
    IDepositGate public immutable depositGate;

    /// @notice The number of deposits so far. It feeds the nonce.
    uint256 public depositCount;
    /// @notice The remote token for each registered local token.
    mapping(address localToken => address remoteToken) public remoteTokenOf;
    /// @notice The local token for each registered remote token.
    mapping(address remoteToken => address localToken) public localTokenOf;
    /// @notice Whether a deposit nonce from the remote chain was paid.
    mapping(bytes32 depositNonce => bool) public claimed;

    StateLayout[] private _stateLayouts;
    BodyLayout[] private _bodyLayouts;
    HistoricalLayout[] private _historicalLayouts;

    /// @param lightClient_ The light client of the remote chain.
    /// @param localChainId_ The identifier of this chain. It must equal `block.chainid`.
    /// @param remoteChainId_ The identifier of the other chain.
    /// @param remoteVault_ The vault on the other chain.
    /// @param pairs The registered token pairs. The remote decimals are the deployer's claim.
    /// @param depositCutoffTimestamp_ Deposits revert from this timestamp on. Zero means no cutoff.
    /// @param capellaEra_ `floor(capellaForkSlot / 8192)` of the remote chain. The deploy script checks it.
    /// @param depositGate_ The deposit gate. It must not be the zero address.
    constructor(
        address lightClient_,
        uint64 localChainId_,
        uint64 remoteChainId_,
        address remoteVault_,
        TokenPair[] memory pairs,
        uint64 depositCutoffTimestamp_,
        uint64 capellaEra_,
        address depositGate_
    ) {
        if (lightClient_ == address(0)) revert ZeroValue("lightClient");
        if (remoteChainId_ == 0) revert ZeroValue("remoteChainId");
        if (remoteVault_ == address(0)) revert ZeroValue("remoteVault");
        if (depositGate_ == address(0)) revert ZeroValue("depositGate");
        if (localChainId_ != block.chainid) revert LocalChainIdMismatch(localChainId_, block.chainid);
        if (remoteChainId_ == localChainId_) revert RemoteChainIsLocalChain();
        if (pairs.length == 0) revert NoTokenPairs();

        lightClient = IBeaconLightClient(lightClient_);
        localChainId = localChainId_;
        remoteChainId = remoteChainId_;
        remoteVault = remoteVault_;
        depositCutoffTimestamp = depositCutoffTimestamp_;
        capellaEra = capellaEra_;
        depositGate = IDepositGate(depositGate_);

        for (uint256 i = 0; i < pairs.length; i++) {
            _registerPair(pairs[i]);
        }
    }

    /// @notice Locks tokens and emits the deposit event. The target is always the remote chain.
    /// @dev The gate runs first. A gate that reverts refuses the deposit, with the tokens still in the wallet of the user.
    /// The event carries the amount the vault received, which differs from `amount` for a fee-on-transfer token.
    /// @param token The local token.
    /// @param recipient The recipient on the remote chain.
    /// @param amount The amount to pull from the caller.
    /// @param gateEvidence The evidence for the deposit gate. Empty when the gate needs none.
    /// @return nonce The unique deposit nonce.
    function deposit(address token, address recipient, uint256 amount, bytes calldata gateEvidence)
        external
        nonReentrant
        returns (bytes32 nonce)
    {
        depositGate.admit(gateEvidence);
        if (depositCutoffTimestamp != 0 && block.timestamp >= depositCutoffTimestamp) {
            revert DepositCutoffReached(depositCutoffTimestamp);
        }
        if (remoteTokenOf[token] == address(0)) revert UnsupportedToken(token);
        if (recipient == address(0)) revert ZeroRecipient();
        if (amount == 0) revert ZeroAmount();

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert NothingReceived();

        nonce = keccak256(abi.encode(block.chainid, address(this), depositCount++));
        emit DepositInitiated(token, msg.sender, recipient, received, nonce, remoteChainId);
    }

    /// @notice Pays a deposit that was made on the remote vault, given direct evidence.
    /// @dev The checks run in this order. 1: the anchor is a stored finalized header. 2: the deposit block lies
    /// before the anchor, and the vault picks the ancestry path from the distance. 3: the deposit header is in
    /// `state.block_roots` of the anchor (distance up to 8192) or in a `historical_summaries` era (more).
    /// 4: the execution block hash is in the deposit header body. 5: the execution header hashes to that block hash.
    /// 6: the receipt is in the receipts trie and succeeded. 7: the log is a deposit log of the remote vault for this
    /// chain and a registered token, and is unclaimed. 8: state changes, then the transfer.
    /// @param proof The evidence.
    function withdraw(WithdrawalProof calldata proof) external nonReentrant {
        _requireStoredAnchor(proof.anchorHeader);
        _requireAncestryBranch(proof);
        bytes32 blockHash = keccak256(proof.executionHeaderRlp);
        _requireBlockHashBranch(proof, blockHash);

        bytes32 receiptsRoot = _receiptsRoot(proof.executionHeaderRlp);
        bytes memory receipt = MerkleTrie.get(_encodeUint(proof.transactionIndex), proof.receiptProof, receiptsRoot);
        Deposit memory found = _depositLog(receipt, proof.logIndex);

        if (found.targetChainId != localChainId) revert WrongTargetChain(localChainId, found.targetChainId);
        address localToken = localTokenOf[found.token];
        if (localToken == address(0)) revert UnsupportedRemoteToken(found.token);
        if (claimed[found.nonce]) revert AlreadyClaimed(found.nonce);

        claimed[found.nonce] = true;
        IERC20(localToken).safeTransfer(found.recipient, found.amount);
        emit WithdrawalCompleted(localToken, found.recipient, found.nonce, found.amount, blockHash);
    }

    /// @notice Adds a `block_roots` position, or widens its validated range, given evidence from stored data.
    /// @dev Open to anyone. The position is accepted only when, under the stored later state root, the leaf at
    /// `blockRootsGindex * 8192 + slot % 8192` equals the light client's stored header root, for two different
    /// stored earlier slots. A wrong position cannot match. The position is then usable for the later header's slot.
    /// @param blockRootsGindex The candidate generalized index of `BeaconState.block_roots`.
    /// @param evidence Two stored earlier headers under one stored later state.
    function addBlockRootsLayout(uint256 blockRootsGindex, BlockRootsEvidence calldata evidence) external {
        if (blockRootsGindex == 0 || SSZ.depthOf(blockRootsGindex) > MAX_BLOCK_ROOTS_DEPTH) {
            revert LayoutOutOfBounds(blockRootsGindex);
        }
        _requireStoredHeader(evidence.laterHeader);
        if (evidence.earlierSlotA == evidence.earlierSlotB) revert EvidenceSlotsEqual(evidence.earlierSlotA);
        _requireEarlierRoot(evidence.laterHeader, evidence.earlierSlotA, blockRootsGindex, evidence.branchA);
        _requireEarlierRoot(evidence.laterHeader, evidence.earlierSlotB, blockRootsGindex, evidence.branchB);

        uint64 slot = evidence.laterHeader.slot;
        for (uint256 i = 0; i < _stateLayouts.length; i++) {
            StateLayout storage layout = _stateLayouts[i];
            if (layout.blockRootsGindex != blockRootsGindex) continue;
            if (slot < layout.firstSlot) layout.firstSlot = slot;
            if (slot > layout.lastSlot) layout.lastSlot = slot;
            emit BlockRootsLayoutValidated(blockRootsGindex, layout.firstSlot, layout.lastSlot);
            return;
        }
        _stateLayouts.push(StateLayout({blockRootsGindex: blockRootsGindex, firstSlot: slot, lastSlot: slot}));
        emit BlockRootsLayoutValidated(blockRootsGindex, slot, slot);
    }

    /// @notice Adds a block hash position, or widens its validated range, given evidence from stored data.
    /// @dev Open to anyone. The position is accepted only when, under the body root of a stored header, the leaf at
    /// `blockHashGindex` equals the light client's stored execution block hash of that header.
    /// @param blockHashGindex The candidate generalized index of `BeaconBlockBody.execution_payload.block_hash`.
    /// @param evidence A stored header and the branch to its body root.
    function addBlockHashLayout(uint256 blockHashGindex, BlockHashEvidence calldata evidence) external {
        if (blockHashGindex == 0 || SSZ.depthOf(blockHashGindex) > MAX_BLOCK_HASH_DEPTH) {
            revert LayoutOutOfBounds(blockHashGindex);
        }
        _requireStoredHeader(evidence.header);
        bytes32 storedBlockHash = lightClient.executionBlockHashes(evidence.header.slot);
        if (storedBlockHash == bytes32(0)) revert EvidenceSlotNotStored(evidence.header.slot);
        if (!SSZ.isValidBranch(storedBlockHash, evidence.branch, blockHashGindex, evidence.header.bodyRoot)) {
            revert LayoutEvidenceInvalid();
        }

        uint64 slot = evidence.header.slot;
        for (uint256 i = 0; i < _bodyLayouts.length; i++) {
            BodyLayout storage layout = _bodyLayouts[i];
            if (layout.blockHashGindex != blockHashGindex) continue;
            if (slot < layout.firstSlot) layout.firstSlot = slot;
            if (slot > layout.lastSlot) layout.lastSlot = slot;
            emit BlockHashLayoutValidated(blockHashGindex, layout.firstSlot, layout.lastSlot);
            return;
        }
        _bodyLayouts.push(BodyLayout({blockHashGindex: blockHashGindex, firstSlot: slot, lastSlot: slot}));
        emit BlockHashLayoutValidated(blockHashGindex, slot, slot);
    }

    /// @notice Adds a `historical_summaries` position, or widens its validated range, given evidence from stored data.
    /// @dev Open to anyone. The position is accepted only when, under the stored anchor state root, the leaf at the
    /// historical index of the candidate equals the light client's stored header root at `earlierSlot`. The index is
    /// built as `withdraw` builds it, so the candidate must also fit the era formula. A candidate that is another
    /// state field (`block_roots`, `finalized_checkpoint.root`, `latest_block_header`) or a list of another depth
    /// cannot match. The position is then usable for the anchor's slot.
    /// @param historicalSummariesGindex The candidate generalized index of `BeaconState.historical_summaries`.
    /// @param evidence A stored anchor, a stored earlier slot in a completed era, and the branch between them.
    function addHistoricalSummariesLayout(uint256 historicalSummariesGindex, HistoricalSummariesEvidence calldata evidence)
        external
    {
        if (historicalSummariesGindex == 0 || SSZ.depthOf(historicalSummariesGindex) > MAX_BLOCK_ROOTS_DEPTH) {
            revert LayoutOutOfBounds(historicalSummariesGindex);
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

        for (uint256 i = 0; i < _historicalLayouts.length; i++) {
            HistoricalLayout storage layout = _historicalLayouts[i];
            if (layout.historicalSummariesGindex != historicalSummariesGindex) continue;
            if (anchorSlot < layout.firstSlot) layout.firstSlot = anchorSlot;
            if (anchorSlot > layout.lastSlot) layout.lastSlot = anchorSlot;
            emit HistoricalSummariesLayoutValidated(historicalSummariesGindex, layout.firstSlot, layout.lastSlot);
            return;
        }
        _historicalLayouts.push(
            HistoricalLayout({historicalSummariesGindex: historicalSummariesGindex, firstSlot: anchorSlot, lastSlot: anchorSlot})
        );
        emit HistoricalSummariesLayoutValidated(historicalSummariesGindex, anchorSlot, anchorSlot);
    }

    /// @notice The validated `block_roots` positions and their slot ranges.
    function stateLayouts() external view returns (StateLayout[] memory) {
        return _stateLayouts;
    }

    /// @notice The validated `historical_summaries` positions and their slot ranges.
    function historicalLayouts() external view returns (HistoricalLayout[] memory) {
        return _historicalLayouts;
    }

    /// @notice The validated block hash positions and their slot ranges.
    function bodyLayouts() external view returns (BodyLayout[] memory) {
        return _bodyLayouts;
    }

    // ------------------------------------------------------------------ withdrawal checks

    /// @dev Check 1.
    function _requireStoredAnchor(BeaconBlockHeader calldata anchor) private view {
        _requireStoredHeader(anchor);
    }

    /// @dev A header must equal the finalized header that the light client stored for its slot.
    function _requireStoredHeader(BeaconBlockHeader calldata header) private view {
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

    /// @dev Checks 2 and 3. The vault picks the path from the distance: up to 8192 slots is the recent path, more is the
    /// historical path. The prover never picks. Both leaf indices are built by pure functions, and the branch length
    /// must be exact (`SSZ.isValidBranch` refuses padding and short branches).
    function _requireAncestryBranch(WithdrawalProof calldata proof) private view {
        uint64 anchorSlot = proof.anchorHeader.slot;
        uint64 depositSlot = proof.depositHeader.slot;
        if (depositSlot >= anchorSlot) revert DepositNotBeforeAnchor(depositSlot, anchorSlot);
        uint256 leafIndex = anchorSlot - depositSlot <= SLOTS_PER_HISTORICAL_ROOT
            ? _recentLeafGindex(_blockRootsGindexAt(anchorSlot), depositSlot)
            : _historicalLeafGindex(_historicalGindexAt(anchorSlot), _eraIndex(depositSlot), depositSlot);
        bytes32 depositRoot = SSZ.hashTreeRoot(proof.depositHeader);
        if (!SSZ.isValidBranch(depositRoot, proof.ancestryBranch, leafIndex, proof.anchorHeader.stateRoot)) {
            revert AncestryBranchInvalid();
        }
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

    /// @dev Check 4.
    function _requireBlockHashBranch(WithdrawalProof calldata proof, bytes32 blockHash) private view {
        if (!SSZ.isValidBranch(
                blockHash, proof.blockHashBranch, _blockHashGindexAt(proof.depositHeader.slot), proof.depositHeader.bodyRoot
            )) {
            revert BlockHashBranchInvalid();
        }
    }

    /// @dev The validated `block_roots` position whose slot range contains `slot`.
    function _blockRootsGindexAt(uint64 slot) private view returns (uint256) {
        for (uint256 i = 0; i < _stateLayouts.length; i++) {
            StateLayout storage layout = _stateLayouts[i];
            if (layout.firstSlot <= slot && slot <= layout.lastSlot) return layout.blockRootsGindex;
        }
        revert LayoutNotValidated(slot);
    }

    /// @dev The validated `historical_summaries` position whose slot range contains `slot`.
    function _historicalGindexAt(uint64 slot) private view returns (uint256) {
        for (uint256 i = 0; i < _historicalLayouts.length; i++) {
            HistoricalLayout storage layout = _historicalLayouts[i];
            if (layout.firstSlot <= slot && slot <= layout.lastSlot) return layout.historicalSummariesGindex;
        }
        revert LayoutNotValidated(slot);
    }

    /// @dev The validated block hash position whose slot range contains `slot`.
    function _blockHashGindexAt(uint64 slot) private view returns (uint256) {
        for (uint256 i = 0; i < _bodyLayouts.length; i++) {
            BodyLayout storage layout = _bodyLayouts[i];
            if (layout.firstSlot <= slot && slot <= layout.lastSlot) return layout.blockHashGindex;
        }
        revert LayoutNotValidated(slot);
    }

    /// @dev Check 5. The execution header is an RLP list. Its sixth item is the receipts root.
    function _receiptsRoot(bytes calldata executionHeaderRlp) private pure returns (bytes32) {
        RLPReader.RLPItem[] memory fields = RLPReader.readList(executionHeaderRlp);
        if (fields.length <= RECEIPTS_ROOT_FIELD) revert MalformedExecutionHeader();
        bytes memory root = RLPReader.readBytes(fields[RECEIPTS_ROOT_FIELD]);
        if (root.length != 32) revert MalformedExecutionHeader();
        return bytes32(root);
    }

    /// @dev Checks 6 and 7, up to the decoding. The receipt is an EIP-2718 envelope: a bare RLP list (legacy) or a
    /// type byte 1 to 4 followed by an RLP list.
    function _depositLog(bytes memory receipt, uint256 logIndex) private view returns (Deposit memory found) {
        RLPReader.RLPItem[] memory fields = RLPReader.readList(_receiptPayload(receipt));
        if (fields.length != 4) revert MalformedReceipt();
        bytes memory status = RLPReader.readBytes(fields[0]);
        if (status.length != 1 || status[0] != 0x01) revert ReceiptFailed();

        RLPReader.RLPItem[] memory logs = RLPReader.readList(fields[3]);
        if (logIndex >= logs.length) revert LogIndexOutOfRange(logIndex, logs.length);
        RLPReader.RLPItem[] memory logFields = RLPReader.readList(logs[logIndex]);
        if (logFields.length != 3) revert MalformedLog();

        bytes memory emitter = RLPReader.readBytes(logFields[0]);
        if (emitter.length != 20) revert MalformedLog();
        address emitterAddress = address(bytes20(emitter));
        if (emitterAddress != remoteVault) revert WrongEmitter(remoteVault, emitterAddress);

        RLPReader.RLPItem[] memory topics = RLPReader.readList(logFields[1]);
        if (topics.length == 0) revert WrongEventTopic(bytes32(0));
        bytes32 topic0 = _toBytes32(RLPReader.readBytes(topics[0]));
        if (topic0 != DEPOSIT_EVENT_TOPIC) revert WrongEventTopic(topic0);
        if (topics.length != 4) revert MalformedLog();

        bytes memory data = RLPReader.readBytes(logFields[2]);
        if (data.length != 96) revert MalformedLog();
        found.token = _toAddress(RLPReader.readBytes(topics[1]));
        found.recipient = _toAddress(RLPReader.readBytes(topics[3]));
        (found.amount, found.nonce, found.targetChainId) = _decodeData(data);
    }

    /// @dev Strips the EIP-2718 type byte. Legacy receipts start with a list prefix (at least 0xc0).
    function _receiptPayload(bytes memory receipt) private pure returns (bytes memory) {
        if (receipt.length == 0) revert MalformedReceipt();
        uint8 first = uint8(receipt[0]);
        if (first >= 0xc0) return receipt;
        if (first < 0x01 || first > 0x04) revert MalformedReceipt();
        bytes memory payload = new bytes(receipt.length - 1);
        for (uint256 i = 0; i < payload.length; i++) {
            payload[i] = receipt[i + 1];
        }
        return payload;
    }

    function _decodeData(bytes memory data) private pure returns (uint256 amount, bytes32 nonce, uint64 target) {
        uint256 targetWide;
        (amount, nonce, targetWide) = abi.decode(data, (uint256, bytes32, uint256));
        if (targetWide > type(uint64).max) revert MalformedLog();
        target = uint64(targetWide);
    }

    function _toBytes32(bytes memory value) private pure returns (bytes32) {
        if (value.length != 32) revert MalformedLog();
        return bytes32(value);
    }

    /// @dev A topic holds an address in its low 20 bytes. The high 12 bytes must be zero.
    function _toAddress(bytes memory topic) private pure returns (address) {
        uint256 word = uint256(_toBytes32(topic));
        if (word > type(uint160).max) revert MalformedLog();
        return address(uint160(word));
    }

    /// @dev The RLP encoding of an unsigned integer, which is the receipts trie key of a transaction index.
    function _encodeUint(uint256 value) private pure returns (bytes memory) {
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

    // ------------------------------------------------------------------ constructor helpers

    /// @dev Registers one pair after it checks the code, the decimals, and the uniqueness.
    function _registerPair(TokenPair memory pair) private {
        if (pair.localToken == address(0)) revert ZeroValue("localToken");
        if (pair.remoteToken == address(0)) revert ZeroValue("remoteToken");
        if (pair.localToken.code.length == 0) revert TokenHasNoCode(pair.localToken);
        if (remoteTokenOf[pair.localToken] != address(0)) revert DuplicateLocalToken(pair.localToken);
        if (localTokenOf[pair.remoteToken] != address(0)) revert DuplicateRemoteToken(pair.remoteToken);
        uint8 localDecimals = IERC20Metadata(pair.localToken).decimals();
        if (localDecimals != pair.remoteDecimals) {
            revert DecimalsMismatch(pair.localToken, localDecimals, pair.remoteDecimals);
        }
        remoteTokenOf[pair.localToken] = pair.remoteToken;
        localTokenOf[pair.remoteToken] = pair.localToken;
    }
}
