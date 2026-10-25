// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
// The storage guard, never the transient one: PulseChain has no TSTORE.
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IDepositGate} from "./IDepositGate.sol";
import {IFlowLimiter} from "./IFlowLimiter.sol";
import {BeaconBlockHeader} from "./SSZ.sol";
import {BeaconProofVerifier} from "./BeaconProofVerifier.sol";
import {MerkleTrie} from "./vendor/optimism/trie/MerkleTrie.sol";
import {RLPReader} from "./vendor/optimism/rlp/RLPReader.sol";

/// @title BridgeVault
/// @notice One end of a two-chain bridge. It locks tokens on deposit and pays tokens against a direct proof of
/// a deposit on the other chain. The vault checks the proof itself: no withdrawal zero-knowledge program exists.
/// Only the light client uses a zero-knowledge proof. The vault has no owner, no refund, and no upgrade path.
/// One role exists: the fee authority. It can set a deposit fee within an immutable ceiling, and it can give up that
/// power for good. It cannot touch locked tokens, withdrawals, the light client, the gate or the layout table.
/// @dev The proof checks, the fork layout table and the opening proof live in `BeaconProofVerifier`, which the message
/// bridge shares. Read its notes on fork layouts and ancestry.
///
/// Opening. A deposit is paid only if the light client on the other chain stored a head with an execution block hash at
/// or below the deposit slot, because no block hash row can start earlier (see `openDeposits`). The vault cannot read
/// that light client, so it refuses deposits until `openDeposits` proves, through its own light client, that the other
/// light client has stored one. The opening is permanent.
contract BridgeVault is ReentrancyGuard, BeaconProofVerifier {
    using SafeERC20 for IERC20;

    /// @notice A token on this chain and its counterpart on the remote chain.
    struct TokenPair {
        address localToken;
        address remoteToken;
        uint8 remoteDecimals;
    }

    /// @notice The terms at deployment: the cutoff, the fee switch and the flow limiter.
    /// @dev One struct, because a ninth constructor argument does not compile without the intermediate representation.
    /// @param cutoffTimestamp Deposits revert from this timestamp on. Zero means no cutoff.
    /// @param feeAuthority The fee authority. Zero removes the fee from the start: the fee and the ceiling must be zero.
    /// @param feeRecipient The recipient of collected fees. It must not be zero when the fee is not zero.
    /// @param feeBasisPoints The fee on deposits at the start. It must not exceed the ceiling.
    /// @param feeCeilingBasisPoints The highest fee ever. It must not exceed `MAX_FEE_CEILING_BASIS_POINTS`.
    /// @param flowLimiter The flow limiter. Zero means no limiter from the start. Nothing can set one later.
    /// @param remoteLightClient The light client on the other chain, which tracks the beacon chain of THIS chain and feeds
    /// the remote vault. `openDeposits` reads its storage. It must not be zero.
    struct VaultTerms {
        uint64 cutoffTimestamp;
        address feeAuthority;
        address feeRecipient;
        uint16 feeBasisPoints;
        uint16 feeCeilingBasisPoints;
        address flowLimiter;
        address remoteLightClient;
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




    /// @notice The topic 0 of `DepositInitiated`. Withdrawals match logs against this value.
    /// @dev Solidity 0.8.28 rejects `DepositInitiated.selector` in a constant. A test pins this value to the selector.
    bytes32 public constant DEPOSIT_EVENT_TOPIC =
        keccak256("DepositInitiated(address,address,address,uint256,bytes32,uint64,address,address)");

    /// @notice The highest fee ceiling a vault accepts, in basis points (1%).
    uint16 public constant MAX_FEE_CEILING_BASIS_POINTS = 100;

    /// @notice The number of basis points in the whole amount.
    uint256 public constant BASIS_POINTS_DENOMINATOR = 10_000;




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

    /// @notice Deposits are closed because the cutoff time passed.
    error DepositCutoffReached(uint64 cutoff);
    /// @notice The deposit targets another chain than this chain.
    error WrongTargetChain(uint64 expected, uint64 actual);
    /// @notice The deposit is addressed to another vault than this one.
    error WrongDestinationVault(address expected, address actual);
    /// @notice The deposit names another token than the one this vault pays for the deposited token.
    error WrongDestinationToken(address expected, address actual);
    /// @notice The deposit was already claimed.
    error AlreadyClaimed(bytes32 depositNonce);
    /// @notice Only the flow limiter may detach itself. After a detach nobody can.
    error NotFlowLimiter(address caller);





    /// @notice Emitted when the fee authority sets the fee.
    event FeeChanged(uint16 feeBasisPoints, address feeRecipient);

    /// @notice Emitted when the fee authority gives up its power. The fee is zero from then on, for good.
    event FeeNullified();

    /// @notice Emitted when a deposit is charged a fee. The fee stays in the vault until `collectFees`.
    event FeeCharged(address indexed token, uint256 fee);

    /// @notice Emitted when accrued fees are sent to the fee recipient.
    event FeesCollected(address indexed token, address indexed feeRecipient, uint256 amount);

    /// @notice Emitted when the flow limiter detaches itself. The vault never calls it again.
    event FlowLimiterDetached(address indexed limiter);

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

    /// @notice The identifier of this chain.
    uint64 public immutable localChainId;
    /// @notice The identifier of the other chain.
    uint64 public immutable remoteChainId;
    /// @notice The vault on the other chain.
    address public immutable remoteVault;
    /// @notice Deposits revert at and after this timestamp. Zero disables the cutoff. Set it at deployment only
    /// when a breaking fork of the other chain is already scheduled.
    uint64 public immutable depositCutoffTimestamp;
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
    /// @notice Whether deposits are open. It starts false and `openDeposits` sets it true for good. It shares a storage
    /// slot with the fee authority and the fee, which `deposit` reads anyway, so the check adds almost no gas.
    bool public depositsOpen;
    /// @notice The recipient of collected fees.
    address public feeRecipient;
    /// @notice The fees charged and not yet collected, for each local token.
    mapping(address localToken => uint256) public accruedFees;
    /// @notice The flow limiter that every deposit and withdrawal must pass. Zero means none, from the start or after a
    /// detach. Only the limiter can detach itself, and nothing can set it. Read its code before you use this vault.
    IFlowLimiter public flowLimiter;

    /// @dev The tables of `BeaconProofVerifier` live here, between `claimed` and the fee state, where they always were.
    function _stateLayoutTable() internal view override returns (StateLayout[] storage) {
        return _stateLayouts;
    }

    function _bodyLayoutTable() internal view override returns (BodyLayout[] storage) {
        return _bodyLayouts;
    }

    function _historicalLayoutTable() internal view override returns (HistoricalLayout[] storage) {
        return _historicalLayouts;
    }

    /// @param lightClient_ The light client of the remote chain.
    /// @param localChainId_ The identifier of this chain. It must equal `block.chainid`.
    /// @param remoteChainId_ The identifier of the other chain.
    /// @param remoteVault_ The vault on the other chain.
    /// @param pairs The registered token pairs. The remote decimals are the deployer's claim.
    /// @param vaultTerms The deposit cutoff and the fee switch. See `VaultTerms`.
    /// @param capellaEra_ `floor(capellaForkSlot / 8192)` of the remote chain. The deploy script checks it.
    /// @param depositGate_ The deposit gate. It must not be the zero address.
    constructor(
        address lightClient_,
        uint64 localChainId_,
        uint64 remoteChainId_,
        address remoteVault_,
        TokenPair[] memory pairs,
        VaultTerms memory vaultTerms,
        uint64 capellaEra_,
        address depositGate_
    ) BeaconProofVerifier(lightClient_, capellaEra_, vaultTerms.remoteLightClient) {
        if (lightClient_ == address(0)) revert ZeroValue("lightClient");
        if (remoteChainId_ == 0) revert ZeroValue("remoteChainId");
        if (remoteVault_ == address(0)) revert ZeroValue("remoteVault");
        if (depositGate_ == address(0)) revert ZeroValue("depositGate");
        if (vaultTerms.remoteLightClient == address(0)) revert ZeroValue("remoteLightClient");
        if (localChainId_ != block.chainid) revert LocalChainIdMismatch(localChainId_, block.chainid);
        if (remoteChainId_ == localChainId_) revert RemoteChainIsLocalChain();
        if (pairs.length == 0) revert NoTokenPairs();
        if (vaultTerms.feeCeilingBasisPoints > MAX_FEE_CEILING_BASIS_POINTS) {
            revert FeeCeilingTooHigh(vaultTerms.feeCeilingBasisPoints, MAX_FEE_CEILING_BASIS_POINTS);
        }
        if (
            vaultTerms.feeAuthority == address(0)
                && (vaultTerms.feeBasisPoints != 0 || vaultTerms.feeCeilingBasisPoints != 0)
        ) {
            revert NullifiedFeeMustBeZero(vaultTerms.feeBasisPoints, vaultTerms.feeCeilingBasisPoints);
        }
        _requireFeeTerms(vaultTerms.feeBasisPoints, vaultTerms.feeRecipient, vaultTerms.feeCeilingBasisPoints);

        localChainId = localChainId_;
        remoteChainId = remoteChainId_;
        remoteVault = remoteVault_;
        depositCutoffTimestamp = vaultTerms.cutoffTimestamp;
        depositGate = IDepositGate(depositGate_);
        feeCeilingBasisPoints = vaultTerms.feeCeilingBasisPoints;
        feeAuthority = vaultTerms.feeAuthority;
        feeBasisPoints = vaultTerms.feeBasisPoints;
        feeRecipient = vaultTerms.feeRecipient;
        flowLimiter = IFlowLimiter(vaultTerms.flowLimiter);

        for (uint256 i = 0; i < pairs.length; i++) {
            _registerPair(pairs[i]);
        }
    }

    /// @notice Locks tokens and emits the deposit event. The target is always the remote chain.
    /// @dev The vault refuses every deposit until `openDeposits` ran. The gate runs next. A gate that reverts refuses the deposit, with the tokens still in the wallet of the user.
    /// The vault charges the fee on the amount it received, rounded down, and keeps it in `accruedFees`. The event
    /// carries the amount the vault received less the fee. That amount differs from `amount` for a fee-on-transfer token.
    /// @param token The local token.
    /// @param recipient The recipient on the remote chain.
    /// @param amount The amount to pull from the caller.
    /// @param maxFeeBasisPoints The highest fee the caller accepts. A fee raised just before this call cannot exceed it.
    /// @param gateEvidence The evidence for the deposit gate. Empty when the gate needs none.
    /// @return nonce The unique deposit nonce.
    function deposit(
        address token,
        address recipient,
        uint256 amount,
        uint16 maxFeeBasisPoints,
        bytes calldata gateEvidence
    ) external nonReentrant returns (bytes32 nonce) {
        if (!depositsOpen) revert DepositsNotOpen();
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

    /// @notice Opens deposits for good, given proof that the remote light client has stored a head.
    /// @dev A deposit at slot `s` is paid only if some block hash row covers `s`. A row starts at a stored head that
    /// has an execution block hash, and the constructor of the light client stores none. So a deposit made before the
    /// remote light client stored its first update is lost for ever. The proof is checked by `_verifyOpening`. After the
    /// call, the flag stays true. The call needs no key. A call after the opening returns at once, so two openers do
    /// not fail each other.
    /// @param proof The evidence.
    function openDeposits(OpeningProof calldata proof) external {
        if (depositsOpen) return;
        bytes32 blockHash = _verifyOpening(proof);

        depositsOpen = true;
        emit DepositsOpened(proof.remoteSlot, blockHash, proof.storedSlot);
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

    /// @notice Detaches the flow limiter for good. Only the limiter itself may call it, so its own rules decide when.
    /// Nothing can attach a limiter again.
    function detachFlowLimiter() external {
        IFlowLimiter limiter = flowLimiter;
        if (msg.sender != address(limiter)) revert NotFlowLimiter(msg.sender);
        flowLimiter = IFlowLimiter(address(0));
        emit FlowLimiterDetached(address(limiter));
    }

    /// @notice Pays a deposit that was made on the remote vault, given direct evidence.
    /// @dev The checks run in this order. 1: the anchor is a stored finalized header. 2: the deposit block lies
    /// before the anchor, and the vault picks the ancestry path from the distance. 3: the deposit header is in
    /// `state.block_roots` of the anchor (distance up to 8192) or in a `historical_summaries` era (more).
    /// 4: the execution block hash is in the deposit header body. 5: the execution header hashes to that block hash.
    /// 6: the receipt is in the receipts trie and succeeded. 7: the log is a deposit log of the remote vault for this
    /// chain and this vault, for a registered token that this vault pays under the token the log names, and is unclaimed.
    /// 8: the flow limiter, when one is attached, may refuse; a refusal undoes the call and the nonce stays unclaimed.
    /// 9: state changes, then the transfer.
    /// @param proof The evidence.
    function withdraw(WithdrawalProof calldata proof) external nonReentrant {
        _requireStoredHeader(proof.anchorHeader);
        _requireAncestryBranch(proof.anchorHeader, proof.depositHeader, proof.ancestryBranch);
        bytes32 blockHash = keccak256(proof.executionHeaderRlp);
        _requireBlockHashBranch(blockHash, proof.depositHeader, proof.blockHashBranch);

        bytes32 receiptsRoot = _headerRoot(_headerItems(proof.executionHeaderRlp), RECEIPTS_ROOT_FIELD);
        bytes memory receipt = MerkleTrie.get(_encodeUint(proof.transactionIndex), proof.receiptProof, receiptsRoot);
        Deposit memory found = _decodeLog(_receiptLog(receipt, proof.logIndex));

        if (found.targetChainId != localChainId) revert WrongTargetChain(localChainId, found.targetChainId);
        if (found.destinationVault != address(this)) {
            revert WrongDestinationVault(address(this), found.destinationVault);
        }
        address localToken = localTokenOf[found.token];
        if (localToken == address(0)) revert UnsupportedRemoteToken(found.token);
        if (found.destinationToken != localToken) revert WrongDestinationToken(localToken, found.destinationToken);
        if (claimed[found.nonce]) revert AlreadyClaimed(found.nonce);

        _checkWithdrawalFlow(localToken, found.recipient, found.amount, found.nonce);
        claimed[found.nonce] = true;
        IERC20(localToken).safeTransfer(found.recipient, found.amount);
        emit WithdrawalCompleted(localToken, found.recipient, found.nonce, found.amount, blockHash);
    }









    // ------------------------------------------------------------------ position rules



    // ------------------------------------------------------------------ withdrawal checks

















    /// @dev Checks the emitter and the topics of one log, then decodes its fields.
    function _decodeLog(RLPReader.RLPItem memory log) private view returns (Deposit memory found) {
        RLPReader.RLPItem[] memory logFields = _logFields(log);
        _requireEmitter(logFields[0], remoteVault);

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
        uint256 net = received - fee;
        _checkDepositFlow(token, net);
        nonce = keccak256(abi.encode(block.chainid, address(this), depositCount++));
        emit DepositInitiated(token, msg.sender, recipient, net, nonce, remoteChainId, remoteVault, destinationToken);
    }

    /// @dev Asks the flow limiter about a deposit of the net amount. With no limiter it costs one storage read.
    function _checkDepositFlow(address token, uint256 net) private {
        IFlowLimiter limiter = flowLimiter;
        if (address(limiter) == address(0)) return;
        limiter.checkDeposit(token, msg.sender, net);
    }

    /// @dev Asks the flow limiter about a withdrawal. With no limiter it costs one storage read.
    function _checkWithdrawalFlow(address localToken, address recipient, uint256 amount, bytes32 nonce) private {
        IFlowLimiter limiter = flowLimiter;
        if (address(limiter) == address(0)) return;
        limiter.checkWithdrawal(localToken, recipient, amount, nonce);
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
