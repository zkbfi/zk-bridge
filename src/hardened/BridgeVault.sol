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
import {ReceiptLogs} from "./ReceiptLogs.sol";

/// @title BridgeVault
/// @notice One end of a two-chain bridge. It locks tokens on deposit and pays tokens against a direct proof of
/// a deposit on the other chain. The vault checks the proof itself: no withdrawal zero-knowledge program exists.
/// Only the light client uses a zero-knowledge proof. The vault has no owner, no refund, and no upgrade path.
/// One role exists: the fee authority. It can set a deposit fee within an immutable ceiling, and it can give up that
/// power for good. It cannot touch locked tokens, withdrawals, the light client, the gate or the layout table.
/// @dev Fork layouts. The generalized indices of `state.block_roots`, of `state.historical_summaries` and of the
/// execution block hash depend on the fork of the source chain. The vault holds no fixed table. Anyone may add a
/// layout with `addBlockRootsLayout`, `addHistoricalSummariesLayout` and `addBlockHashLayout`. Two checks guard each
/// call. First, the candidate must be the position of the named field itself in a state or body tree of a known shape
/// (see the position rules below). Second, the chain's own stored data must prove it: the candidate position must map
/// stored header roots (or the stored execution block hash) to the stored state (or body) root.
///
/// The first check is needed because the second is not enough alone. Other fields hold values that a block proposer
/// chooses: the list `eth1_data_votes` has the same tree shape as `block_roots`, and `graffiti` or
/// `eth1_data.block_hash` can hold a copy of the execution block hash. A proposer could place stored header roots or
/// a stored block hash there, get that position accepted, and then forge deposits. So the vault accepts only the
/// position of the real field.
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

    /// @notice The deposit terms at deployment: the cutoff and the fee switch.
    /// @dev One struct, because a ninth constructor argument does not compile without the intermediate representation.
    /// @param cutoffTimestamp Deposits revert from this timestamp on. Zero means no cutoff.
    /// @param feeAuthority The fee authority. Zero removes the fee from the start: the fee and the ceiling must be zero.
    /// @param feeRecipient The recipient of collected fees. It must not be zero when the fee is not zero.
    /// @param feeBasisPoints The fee on deposits at the start. It must not exceed the ceiling.
    /// @param feeCeilingBasisPoints The highest fee ever. It must not exceed `MAX_FEE_CEILING_BASIS_POINTS`.
    struct DepositTerms {
        uint64 cutoffTimestamp;
        address feeAuthority;
        address feeRecipient;
        uint16 feeBasisPoints;
        uint16 feeCeilingBasisPoints;
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
        address destinationVault;
        address destinationToken;
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
        keccak256("DepositInitiated(address,address,address,uint256,bytes32,uint64,address,address)");

    /// @notice The highest fee ceiling a vault accepts, in basis points (1%).
    uint16 public constant MAX_FEE_CEILING_BASIS_POINTS = 100;

    /// @notice The number of basis points in the whole amount.
    uint256 public constant BASIS_POINTS_DENOMINATOR = 10_000;

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
    uint256 private constant RECEIPTS_ROOT_FIELD = 5;

    /// @notice A constructor argument is zero.
    error ZeroValue(string name);
    /// @notice The fee ceiling is above `MAX_FEE_CEILING_BASIS_POINTS`.
    error FeeCeilingTooHigh(uint16 ceiling, uint16 maximum);
    /// @notice A vault with no fee authority must have a zero fee and a zero ceiling.
    error NullifiedFeeMustBeZero(uint16 feeBasisPoints, uint16 feeCeilingBasisPoints);
    /// @notice The fee is above the ceiling.
    error FeeAboveCeiling(uint16 feeBasisPoints, uint16 feeCeilingBasisPoints);
    /// @notice The caller is not the fee authority. After `nullifyFee` nobody is.
    error NotFeeAuthority(address caller);
    /// @notice A fee that is not zero needs a recipient.
    error ZeroFeeRecipient();
    /// @notice The fee is above the limit that the depositor accepts.
    error FeeAboveLimit(uint16 feeBasisPoints, uint16 maxFeeBasisPoints);
    /// @notice No fees are waiting for collection in this token.
    error NoFeesAccrued(address token);
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
    /// @notice A candidate position is not the position of the named field in any accepted tree shape.
    error LayoutPositionInvalid(uint256 gindex);
    /// @notice The log was not emitted by the remote vault.
    error WrongEmitter(address expected, address actual);
    /// @notice The log is not a `DepositInitiated` log.
    error WrongEventTopic(bytes32 actual);
    /// @notice The log has the deposit topic but not the deposit layout.
    error MalformedLog();
    /// @notice The deposit targets another chain than this chain.
    error WrongTargetChain(uint64 expected, uint64 actual);
    /// @notice The deposit is addressed to another vault than this one.
    error WrongDestinationVault(address expected, address actual);
    /// @notice The deposit names another token than the one this vault pays for the deposited token.
    error WrongDestinationToken(address expected, address actual);
    /// @notice The deposit was already claimed.
    error AlreadyClaimed(bytes32 depositNonce);

    /// @notice Emitted when a validated `block_roots` position is added or its validated range grows.
    event BlockRootsLayoutValidated(uint256 indexed blockRootsGindex, uint64 firstSlot, uint64 lastSlot);

    /// @notice Emitted when a validated block hash position is added or its validated range grows.
    event BlockHashLayoutValidated(uint256 indexed blockHashGindex, uint64 firstSlot, uint64 lastSlot);

    /// @notice Emitted when a validated `historical_summaries` position is added or its validated range grows.
    event HistoricalSummariesLayoutValidated(uint256 indexed historicalSummariesGindex, uint64 firstSlot, uint64 lastSlot);

    /// @notice Emitted when the fee authority sets the fee.
    event FeeChanged(uint16 feeBasisPoints, address feeRecipient);

    /// @notice Emitted when the fee authority gives up its power. The fee is zero from then on, for good.
    event FeeNullified();

    /// @notice Emitted when a deposit is charged a fee. The fee stays in the vault until `collectFees`.
    event FeeCharged(address indexed token, uint256 fee);

    /// @notice Emitted when accrued fees are sent to the fee recipient.
    event FeesCollected(address indexed token, address indexed feeRecipient, uint256 amount);

    /// @notice Emitted on deposit with the amount the vault received, less the fee. `destinationVault` is the vault
    /// on the other chain that may pay this deposit: the `remoteVault` of the emitting vault. Another vault refuses
    /// the deposit. `destinationToken` is the token that vault must pay: the `remoteTokenOf` entry of `token`. A vault
    /// whose table maps `token` to another local token refuses the deposit.
    event DepositInitiated(
        address indexed token,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        bytes32 nonce,
        uint64 targetChainId,
        address destinationVault,
        address destinationToken
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
    /// @notice The highest fee in basis points that the fee authority can ever set. At most 100 (1%).
    uint16 public immutable feeCeilingBasisPoints;

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


    // The fee state follows the layout tables, so the earlier storage slots keep their place.
    /// @notice The only role: it sets the fee within the ceiling. Zero means the fee was removed for good.
    address public feeAuthority;
    /// @notice The fee on each new deposit, in basis points.
    uint16 public feeBasisPoints;
    /// @notice The recipient of collected fees.
    address public feeRecipient;
    /// @notice The fees charged and not yet collected, for each local token.
    mapping(address localToken => uint256) public accruedFees;

    /// @param lightClient_ The light client of the remote chain.
    /// @param localChainId_ The identifier of this chain. It must equal `block.chainid`.
    /// @param remoteChainId_ The identifier of the other chain.
    /// @param remoteVault_ The vault on the other chain.
    /// @param pairs The registered token pairs. The remote decimals are the deployer's claim.
    /// @param depositTerms The deposit cutoff and the fee switch. See `DepositTerms`.
    /// @param capellaEra_ `floor(capellaForkSlot / 8192)` of the remote chain. The deploy script checks it.
    /// @param depositGate_ The deposit gate. It must not be the zero address.
    constructor(
        address lightClient_,
        uint64 localChainId_,
        uint64 remoteChainId_,
        address remoteVault_,
        TokenPair[] memory pairs,
        DepositTerms memory depositTerms,
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
        if (depositTerms.feeCeilingBasisPoints > MAX_FEE_CEILING_BASIS_POINTS) {
            revert FeeCeilingTooHigh(depositTerms.feeCeilingBasisPoints, MAX_FEE_CEILING_BASIS_POINTS);
        }
        if (depositTerms.feeAuthority == address(0) && (depositTerms.feeBasisPoints != 0 || depositTerms.feeCeilingBasisPoints != 0)) {
            revert NullifiedFeeMustBeZero(depositTerms.feeBasisPoints, depositTerms.feeCeilingBasisPoints);
        }
        _requireFeeTerms(depositTerms.feeBasisPoints, depositTerms.feeRecipient, depositTerms.feeCeilingBasisPoints);

        lightClient = IBeaconLightClient(lightClient_);
        localChainId = localChainId_;
        remoteChainId = remoteChainId_;
        remoteVault = remoteVault_;
        depositCutoffTimestamp = depositTerms.cutoffTimestamp;
        capellaEra = capellaEra_;
        depositGate = IDepositGate(depositGate_);
        feeCeilingBasisPoints = depositTerms.feeCeilingBasisPoints;
        feeAuthority = depositTerms.feeAuthority;
        feeBasisPoints = depositTerms.feeBasisPoints;
        feeRecipient = depositTerms.feeRecipient;

        for (uint256 i = 0; i < pairs.length; i++) {
            _registerPair(pairs[i]);
        }
    }

    /// @notice Locks tokens and emits the deposit event. The target is always the remote chain.
    /// @dev The gate runs first. A gate that reverts refuses the deposit, with the tokens still in the wallet of the user.
    /// The vault charges the fee on the amount it received, rounded down, and keeps it in `accruedFees`. The event
    /// carries the amount the vault received less the fee. That amount differs from `amount` for a fee-on-transfer token.
    /// @param token The local token.
    /// @param recipient The recipient on the remote chain.
    /// @param amount The amount to pull from the caller.
    /// @param maxFeeBasisPoints The highest fee the caller accepts. A fee raised just before this call cannot exceed it.
    /// @param gateEvidence The evidence for the deposit gate. Empty when the gate needs none.
    /// @return nonce The unique deposit nonce.
    function deposit(address token, address recipient, uint256 amount, uint16 maxFeeBasisPoints, bytes calldata gateEvidence)
        external
        nonReentrant
        returns (bytes32 nonce)
    {
        depositGate.admit(gateEvidence);
        if (depositCutoffTimestamp != 0 && block.timestamp >= depositCutoffTimestamp) {
            revert DepositCutoffReached(depositCutoffTimestamp);
        }
        address destinationToken = remoteTokenOf[token];
        if (destinationToken == address(0)) revert UnsupportedToken(token);
        if (feeBasisPoints > maxFeeBasisPoints) revert FeeAboveLimit(feeBasisPoints, maxFeeBasisPoints);
        if (recipient == address(0)) revert ZeroRecipient();
        if (amount == 0) revert ZeroAmount();

        return _recordDeposit(token, recipient, _pull(token, amount), destinationToken);
    }

    /// @notice Sets the fee on new deposits and the recipient of collected fees. Only the fee authority may call it.
    /// @param basisPoints The new fee. It must not exceed `feeCeilingBasisPoints`.
    /// @param recipient The new recipient. It must not be zero when the fee is not zero.
    function setFee(uint16 basisPoints, address recipient) external {
        _requireFeeAuthority();
        _requireFeeTerms(basisPoints, recipient, feeCeilingBasisPoints);
        feeBasisPoints = basisPoints;
        feeRecipient = recipient;
        emit FeeChanged(basisPoints, recipient);
    }

    /// @notice Sets the fee to zero and gives up the fee authority. This cannot be undone. Only the fee authority may
    /// call it. `feeRecipient` stays, so it can still collect the fees already charged.
    function nullifyFee() external {
        _requireFeeAuthority();
        feeBasisPoints = 0;
        feeAuthority = address(0);
        emit FeeNullified();
    }

    /// @notice Sends the accrued fees of a token to the fee recipient. Anyone may call it.
    /// @dev The balance is zeroed before the transfer. A deposit never transfers to the recipient, so a recipient that
    /// a token refuses blocks this call only.
    /// @param token The local token.
    function collectFees(address token) external nonReentrant {
        uint256 amount = accruedFees[token];
        if (amount == 0) revert NoFeesAccrued(token);
        address recipient = feeRecipient;
        if (recipient == address(0)) revert ZeroFeeRecipient();
        accruedFees[token] = 0;
        IERC20(token).safeTransfer(recipient, amount);
        emit FeesCollected(token, recipient, amount);
    }

    /// @notice Pays a deposit that was made on the remote vault, given direct evidence.
    /// @dev The checks run in this order. 1: the anchor is a stored finalized header. 2: the deposit block lies
    /// before the anchor, and the vault picks the ancestry path from the distance. 3: the deposit header is in
    /// `state.block_roots` of the anchor (distance up to 8192) or in a `historical_summaries` era (more).
    /// 4: the execution block hash is in the deposit header body. 5: the execution header hashes to that block hash.
    /// 6: the receipt is in the receipts trie and succeeded. 7: the log is a deposit log of the remote vault for this
    /// chain and this vault, for a registered token that this vault pays under the token the log names, and is unclaimed. 8: state changes, then the transfer.
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
        if (found.destinationVault != address(this)) revert WrongDestinationVault(address(this), found.destinationVault);
        address localToken = localTokenOf[found.token];
        if (localToken == address(0)) revert UnsupportedRemoteToken(found.token);
        if (found.destinationToken != localToken) revert WrongDestinationToken(localToken, found.destinationToken);
        if (claimed[found.nonce]) revert AlreadyClaimed(found.nonce);

        claimed[found.nonce] = true;
        IERC20(localToken).safeTransfer(found.recipient, found.amount);
        emit WithdrawalCompleted(localToken, found.recipient, found.nonce, found.amount, blockHash);
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
        if (!_isStateFieldPosition(blockRootsGindex, BLOCK_ROOTS_FIELD)) revert LayoutPositionInvalid(blockRootsGindex);
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

    // ------------------------------------------------------------------ position rules

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

        (bool logFound, RLPReader.RLPItem memory log, uint256 logCount) = ReceiptLogs.itemAt(fields[3], logIndex);
        if (!logFound) revert LogIndexOutOfRange(logIndex, logCount);
        return _decodeLog(log);
    }

    /// @dev Checks the emitter and the topics of one log, then decodes its fields.
    function _decodeLog(RLPReader.RLPItem memory log) private view returns (Deposit memory found) {
        RLPReader.RLPItem[] memory logFields = RLPReader.readList(log);
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
        if (data.length != 160) revert MalformedLog();
        found.token = _toAddress(RLPReader.readBytes(topics[1]));
        found.recipient = _toAddress(RLPReader.readBytes(topics[3]));
        _decodeData(data, found);
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

    /// @dev Decodes the five data words into `found`: amount, nonce, target chain, destination vault, destination token.
    /// The address and chain words must fit their types.
    function _decodeData(bytes memory data, Deposit memory found) private pure {
        (uint256 amount, bytes32 nonce, uint256 targetWide, uint256 destinationWide, uint256 tokenWide) =
            abi.decode(data, (uint256, bytes32, uint256, uint256, uint256));
        if (targetWide > type(uint64).max) revert MalformedLog();
        if (destinationWide > type(uint160).max) revert MalformedLog();
        if (tokenWide > type(uint160).max) revert MalformedLog();
        found.amount = amount;
        found.nonce = nonce;
        found.targetChainId = uint64(targetWide);
        found.destinationVault = address(uint160(destinationWide));
        found.destinationToken = address(uint160(tokenWide));
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

    /// @dev Pulls `amount` from the caller and returns the amount the vault received.
    function _pull(address token, uint256 amount) private returns (uint256 received) {
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert NothingReceived();
    }

    /// @dev Books the fee on `received`, rounded down, then emits the deposit with the net amount. The fee is at most
    /// 1% of a non-zero amount, so the net amount is never zero.
    function _recordDeposit(address token, address recipient, uint256 received, address destinationToken)
        private
        returns (bytes32 nonce)
    {
        uint256 fee = received * feeBasisPoints / BASIS_POINTS_DENOMINATOR;
        if (fee != 0) {
            accruedFees[token] += fee;
            emit FeeCharged(token, fee);
        }
        nonce = keccak256(abi.encode(block.chainid, address(this), depositCount++));
        emit DepositInitiated(
            token, msg.sender, recipient, received - fee, nonce, remoteChainId, remoteVault, destinationToken
        );
    }

    /// @dev Only the fee authority passes. A zero authority is a nullified fee, and then nobody passes.
    function _requireFeeAuthority() private view {
        address authority = feeAuthority;
        if (authority == address(0) || msg.sender != authority) revert NotFeeAuthority(msg.sender);
    }

    /// @dev A fee must stay within the ceiling and, when it is not zero, have a recipient.
    function _requireFeeTerms(uint16 basisPoints, address recipient, uint16 ceiling) private pure {
        if (basisPoints > ceiling) revert FeeAboveCeiling(basisPoints, ceiling);
        if (basisPoints != 0 && recipient == address(0)) revert ZeroFeeRecipient();
    }

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
