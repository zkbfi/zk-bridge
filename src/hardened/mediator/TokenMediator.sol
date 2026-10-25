// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFlowLimiter} from "../IFlowLimiter.sol";
import {IAMB} from "./IAMB.sol";
import {IBurnableMintableERC677Token} from "./IBurnableMintableERC677Token.sol";
import {IERC20Receiver} from "./IERC20Receiver.sol";
import {TokenFactory} from "./TokenFactory.sol";
import {TokenReader} from "./TokenReader.sol";

/// @title TokenMediator
/// @notice Moves tokens across the message bridge, with the interface of the OmniBridge multi-token mediator
/// (`omni/omnibridge`, `BasicOmnibridge`, `HomeOmnibridge`) and without its owner, proxy, limits and registration.
/// @dev The mediator is the target of the message bridge on each chain, and it trusts one account only: the mediator on
/// the other chain, reached through the bridge from the other chain.
///
/// A token is native on the chain where it exists. Relaying a native token locks it here and mints a bridged copy on
/// the other chain. Relaying a bridged copy burns it and unlocks the native token on the other chain. Neither side
/// needs pre-loaded funds. A bridged copy is deployed on first use at a computed address (see `TokenFactory`), so no
/// registration exists. Until the first return trip, every message for a native token carries its name, symbol and
/// decimals, so the messages of one token can execute in any order. A return trip proves the copy exists, and then
/// the mediator sends the short form.
///
/// Accounting. `mediatorBalance(token)` is the amount of a native token that the mediator owes to the other chain:
/// what it locked, less what it released, counted from the amount it received (balance before and after a pull). A
/// token that arrives by a plain transfer is in no record, and nothing pays it out. A fee on transfer token bridges
/// the amount that arrived. The record includes the amounts waiting in `claimable`, so the balance of the mediator
/// covers `mediatorBalance + accruedFees` for each native token.
///
/// Rebasing tokens are not supported. A token whose balance changes with no transfer (a rebase, an interest bearing
/// token, a token with a negative rebase) can leave the record above the real balance, and then releases fail. The
/// mediator has no function to correct a record, because it has no owner.
///
/// Delivery of a release. The message bridge marks a message delivered whether or not the call succeeds, so a handler
/// that reverts loses the tokens for good. So a handler does not revert on a token or a limiter that refuses a
/// payee. It tries the recipient, then the fallback address of the message, and then records the amount in
/// `claimable[token][fallback]` for `claim`. A flow limiter that refuses a release records the amount for the
/// recipient, and `claim` asks the limiter again.
///
/// Divergences from OmniBridge. The handlers also check `messageSourceChainId`. `deploy` takes the native token.
/// Tokens are not registered by an owner. There are no limits, no failed message fix and no claim of stray tokens.
/// The fee is a switch with an immutable ceiling, as in the vault of this repository.
contract TokenMediator is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The terms at deployment.
    /// @param bridge The message bridge on this chain.
    /// @param remoteMediator The mediator on the other chain. It is the only account whose messages the mediator
    /// accepts. With deployment from the same account and the same nonce on both chains, it has the address of this
    /// mediator.
    /// @param remoteChainId The identifier of the other chain. A message must come from this chain.
    /// @param feeAuthority The fee authority. Zero removes the fee from the start: the fee and the ceiling must be zero.
    /// @param feeRecipient The recipient of collected fees. It must not be zero when the fee is not zero.
    /// @param feeBasisPoints The fee on relayed tokens at the start. It must not exceed the ceiling.
    /// @param feeCeilingBasisPoints The highest fee ever. It must not exceed `MAX_FEE_CEILING_BASIS_POINTS`.
    /// @param flowLimiter The flow limiter. Zero means no limiter from the start. Nothing can set one later.
    struct MediatorTerms {
        address bridge;
        address remoteMediator;
        uint256 remoteChainId;
        address feeAuthority;
        address feeRecipient;
        uint16 feeBasisPoints;
        uint16 feeCeilingBasisPoints;
        address flowLimiter;
    }

    /// @dev Whether the delivery calls `onTokenBridged` on the account that received the tokens.
    enum CallMode {
        Plain,
        WithCall
    }

    /// @dev Whether a token is native to this chain or a bridged copy of a token of the other chain.
    enum Side {
        Native,
        Bridged
    }

    /// @dev The four kinds of message. Each has one gas limit constant.
    enum MessageKind {
        Release,
        ReleaseAndCall,
        Deploy,
        DeployAndCall
    }

    /// @dev What the sender asks for in one relay.
    struct Relay {
        address token;
        address receiver;
        address fallbackRecipient;
        bytes data;
        CallMode mode;
        uint16 maxFeeBasisPoints;
    }

    /// @dev What a handler delivers.
    struct Delivery {
        address recipient;
        address fallbackRecipient;
        uint256 value;
        bytes data;
        CallMode mode;
    }

    /// @dev The record of a native token, in one storage slot.
    /// @param balance What the mediator owes to the other chain in this token.
    /// @param registered The token was relayed at least once.
    /// @param deployAcknowledged The other chain proved that the bridged copy exists, by sending tokens back.
    struct NativeRecord {
        uint240 balance;
        bool registered;
        bool deployAcknowledged;
    }

    /// @notice The highest fee ceiling a mediator accepts, in basis points (1%).
    uint16 public constant MAX_FEE_CEILING_BASIS_POINTS = 100;
    /// @notice The divisor of a fee in basis points.
    uint256 public constant BASIS_POINTS_DENOMINATOR = 10_000;
    /// @notice The `maxFeeBasisPoints` that the functions without a limit use: no limit.
    uint16 public constant NO_FEE_LIMIT = type(uint16).max;

    /// @notice The gas that the message bridge gives the call of a release of tokens.
    uint256 public constant RELEASE_GAS_LIMIT = 250_000;
    /// @notice The extra gas for the callback of a release with a call.
    uint256 public constant CALLBACK_GAS_LIMIT = 750_000;
    /// @notice The gas that the message bridge gives the call that deploys a bridged copy and releases tokens.
    uint256 public constant DEPLOY_GAS_LIMIT = 2_000_000;

    /// @notice The suffix that a bridged copy adds to the name of its native token.
    string public constant NAME_SUFFIX = " (zk-bridge)";
    /// @notice The prefix that a bridged copy adds to the symbol of its native token.
    string public constant SYMBOL_PREFIX = "zk";

    /// @notice The caller of a handler is not the message bridge.
    error NotBridge(address caller);
    /// @notice The message bridge passes a message from an account that is not the mediator on the other chain.
    error WrongRemoteMediator(address expected, address actual);
    /// @notice The message bridge passes a message from a chain that is not the other chain.
    error WrongSourceChain(bytes32 expected, bytes32 actual);
    /// @notice A constructor argument is zero.
    error ZeroValue(string name);
    /// @notice The fee ceiling is above `MAX_FEE_CEILING_BASIS_POINTS`.
    error FeeCeilingTooHigh(uint16 ceiling, uint16 maximum);
    /// @notice A mediator with no fee authority must have a zero fee and a zero ceiling.
    error NullifiedFeeMustBeZero(uint16 feeBasisPoints, uint16 feeCeilingBasisPoints);
    /// @notice The fee is above the ceiling.
    error FeeAboveCeiling(uint16 feeBasisPoints, uint16 feeCeilingBasisPoints);
    /// @notice The caller is not the fee authority. After `nullifyFee` nobody is.
    error NotFeeAuthority(address caller);
    /// @notice A fee that is not zero needs a recipient.
    error ZeroFeeRecipient();
    /// @notice The fee is above the limit that the sender accepts.
    error FeeAboveLimit(uint16 feeBasisPoints, uint16 maxFeeBasisPoints);
    /// @notice No fees are waiting for collection in this token.
    error NoFeesAccrued(address token);
    /// @notice Only the flow limiter may detach itself. After a detach nobody can.
    error NotFlowLimiter(address caller);
    /// @notice The receiver on the other chain is the zero address, or the mediator on the other chain.
    error InvalidReceiver(address receiver);
    /// @notice The fallback address is zero.
    error ZeroFallback();
    /// @notice The amount after the fee is zero.
    error ZeroAmount();
    /// @notice The token took more from the mediator than the sender named. The token is not supported.
    error ReceivedMoreThanSent(uint256 received, uint256 sent);
    /// @notice A token reports a transfer that the balance of the mediator does not show.
    error UnbackedTransfer(address token, uint256 value, uint256 unaccounted);
    /// @notice A token has neither a name nor a symbol, so the other chain could not name its copy.
    error NoTokenName(address token);
    /// @notice A release arrived while the mediator pulls tokens from a sender.
    error HandlerDuringTransfer();
    /// @notice The record of a native token holds less than a release asks for.
    error InsufficientMediatorBalance(address token, uint256 balance, uint256 value);
    /// @notice The other chain sent a short form message for a token whose copy does not exist here.
    error UnknownBridgedToken(address nativeToken);
    /// @notice The record of a native token would pass the width of the record.
    error MediatorBalanceOverflow(address token);
    /// @notice The account has nothing to claim in this token.
    error NothingToClaim(address token, address account);
    /// @notice The token refused the payment of a claim.
    error ClaimTransferFailed(address token, address account);

    /// @notice Emitted when a sender starts a transfer, with the amount after the fee.
    event TokensBridgingInitiated(
        address indexed token, address indexed sender, uint256 value, bytes32 indexed messageId
    );
    /// @notice Emitted when a delivery pays an account. `recipient` is the account that received the tokens, which is
    /// the fallback address when the recipient could not receive them.
    event TokensBridged(address indexed token, address indexed recipient, uint256 value, bytes32 indexed messageId);
    /// @notice Emitted when the mediator deploys the bridged copy of a native token.
    event NewTokenRegistered(address indexed nativeToken, address indexed bridgedToken);
    /// @notice Emitted when the recipient could not receive a release and the fallback address received it.
    event FallbackUsed(
        address indexed token, address indexed recipient, address indexed fallbackRecipient, bytes32 messageId
    );
    /// @notice Emitted when a release is held for `claim`: no payee could receive it, or the flow limiter refused it.
    event ClaimableRecorded(address indexed token, address indexed account, uint256 value, bytes32 indexed messageId);
    /// @notice Emitted when `claim` pays an account.
    event Claimed(address indexed token, address indexed account, uint256 value);
    /// @notice Emitted when the `onTokenBridged` call on a recipient fails. The tokens stay with the recipient.
    event CallbackFailed(address indexed token, address indexed recipient, bytes32 indexed messageId);
    /// @notice Emitted when the fee authority sets the fee.
    event FeeChanged(uint16 feeBasisPoints, address feeRecipient);
    /// @notice Emitted when the fee authority gives up its power. The fee is zero from then on, for good.
    event FeeNullified();
    /// @notice Emitted when a relay is charged a fee. The fee stays in the mediator until `collectFees`.
    event FeeCharged(address indexed token, uint256 fee);
    /// @notice Emitted when accrued fees are sent to the fee recipient.
    event FeesCollected(address indexed token, address indexed feeRecipient, uint256 amount);
    /// @notice Emitted when the flow limiter detaches itself. The mediator never calls it again.
    event FlowLimiterDetached(address indexed limiter);

    /// @notice The message bridge on this chain.
    IAMB public immutable bridgeContract;
    /// @notice The mediator on the other chain.
    address public immutable mediatorContractOnOtherSide;
    /// @notice The identifier of the other chain.
    uint256 public immutable remoteChainId;
    /// @notice The factory that deploys the bridged copies. The mediator deploys it in its constructor.
    TokenFactory public immutable tokenFactory;
    /// @notice The highest fee in basis points that the fee authority can ever set. At most 100 (1%).
    uint16 public immutable feeCeilingBasisPoints;

    /// @notice The only role: it sets the fee within the ceiling. Zero means the fee was removed for good.
    address public feeAuthority;
    /// @notice The fee on each new relay, in basis points.
    uint16 public feeBasisPoints;
    /// @notice The recipient of collected fees.
    address public feeRecipient;
    /// @notice The fees charged and not yet collected, for each local token.
    mapping(address token => uint256) public accruedFees;
    /// @notice The flow limiter that every relay and release must pass. Zero means none. Only the limiter can detach
    /// itself, and nothing can set it.
    IFlowLimiter public flowLimiter;

    /// @notice The bridged copy of a native token of the other chain, or zero when it is not deployed.
    mapping(address nativeToken => address) public bridgedTokenAddress;
    /// @notice The native token of the other chain that a bridged copy stands for, or zero for any other token.
    mapping(address bridgedToken => address) public nativeTokenAddress;
    /// @notice The amount that an account can claim, for each token. See `claim`.
    mapping(address token => mapping(address account => uint256)) public claimable;

    mapping(address token => NativeRecord) private _native;
    /// @dev True while `_pullAndBridge` pulls tokens. A token that calls `onTokenTransfer` during the pull gets true
    /// and no relay, and a release during the pull is refused (the pull measures a balance difference).
    bool private _pulling;

    /// @param terms The terms at deployment. See `MediatorTerms`.
    constructor(MediatorTerms memory terms) {
        if (terms.bridge.code.length == 0) revert ZeroValue("bridge");
        if (terms.remoteMediator == address(0)) revert ZeroValue("remoteMediator");
        if (terms.remoteChainId == 0) revert ZeroValue("remoteChainId");
        if (terms.feeCeilingBasisPoints > MAX_FEE_CEILING_BASIS_POINTS) {
            revert FeeCeilingTooHigh(terms.feeCeilingBasisPoints, MAX_FEE_CEILING_BASIS_POINTS);
        }
        if (terms.feeAuthority == address(0) && (terms.feeBasisPoints != 0 || terms.feeCeilingBasisPoints != 0)) {
            revert NullifiedFeeMustBeZero(terms.feeBasisPoints, terms.feeCeilingBasisPoints);
        }
        _requireFeeTerms(terms.feeBasisPoints, terms.feeRecipient, terms.feeCeilingBasisPoints);

        bridgeContract = IAMB(terms.bridge);
        mediatorContractOnOtherSide = terms.remoteMediator;
        remoteChainId = terms.remoteChainId;
        tokenFactory = new TokenFactory(address(this));
        feeCeilingBasisPoints = terms.feeCeilingBasisPoints;
        feeAuthority = terms.feeAuthority;
        feeBasisPoints = terms.feeBasisPoints;
        feeRecipient = terms.feeRecipient;
        flowLimiter = IFlowLimiter(terms.flowLimiter);
    }

    /// @dev The caller must be the message bridge, passing a message from the mediator on the other chain.
    modifier onlyRemoteMediator() {
        _requireRemoteMediator();
        _;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Sending
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Relays tokens of the caller to `receiver` on the other chain. The caller approves the mediator first.
    /// A failed release goes to the caller, at the same address on the other chain.
    function relayTokens(address token, address receiver, uint256 value) external nonReentrant {
        _pullAndBridge(Relay(token, receiver, msg.sender, "", CallMode.Plain, NO_FEE_LIMIT), value);
    }

    /// @notice Relays tokens of the caller to the caller on the other chain.
    function relayTokens(address token, uint256 value) external nonReentrant {
        _pullAndBridge(Relay(token, msg.sender, msg.sender, "", CallMode.Plain, NO_FEE_LIMIT), value);
    }

    /// @notice Relays tokens to `receiver` and calls `onTokenBridged(token, value, data)` on it, even when `data` is
    /// empty, as OmniBridge does. A failed release goes to the caller.
    function relayTokensAndCall(address token, address receiver, uint256 value, bytes calldata data)
        external
        nonReentrant
    {
        _pullAndBridge(Relay(token, receiver, msg.sender, data, CallMode.WithCall, NO_FEE_LIMIT), value);
    }

    /// @notice Relays tokens with an explicit fallback address. New: OmniBridge has no fallback. When the other chain
    /// cannot pay `receiver`, it pays `fallbackRecipient`. A call happens only when `data` is not empty.
    function relayTokensWithFallback(
        address token,
        address receiver,
        uint256 value,
        bytes calldata data,
        address fallbackRecipient
    ) external nonReentrant {
        _pullAndBridge(Relay(token, receiver, fallbackRecipient, data, _modeOf(data), NO_FEE_LIMIT), value);
    }

    /// @notice The same as the five argument form, with a limit on the fee. It reverts with `FeeAboveLimit` when the
    /// current fee is above `maxFeeBasisPoints`, so a fee raised just before this call cannot charge more than the
    /// sender accepted.
    /// @dev Why an overload. The OmniBridge functions keep their signatures, so they cannot carry the limit, and they
    /// accept any fee up to the immutable ceiling of 1%. A sender who wants the guarantee calls this form. The vault
    /// takes the limit as a parameter of `deposit`, which is the one deposit function it has.
    function relayTokensWithFallback(
        address token,
        address receiver,
        uint256 value,
        bytes calldata data,
        address fallbackRecipient,
        uint16 maxFeeBasisPoints
    ) external nonReentrant {
        _pullAndBridge(Relay(token, receiver, fallbackRecipient, data, _modeOf(data), maxFeeBasisPoints), value);
    }

    /// @notice The transfer callback of a token with `transferAndCall`. The token has moved `value` to the mediator
    /// already. `data` of 20 bytes or more starts with the receiver on the other chain, and the rest is passed to
    /// `onTokenBridged`. Shorter data means the receiver is `from`, with no callback.
    /// @dev A token that calls this function while `relayTokens` pulls from a sender gets true and no relay.
    /// The call is refused when the balance of the mediator does not show the transfer, so a token cannot report
    /// tokens that it did not move.
    /// @return Always true.
    function onTokenTransfer(address from, uint256 value, bytes memory data) external returns (bool) {
        if (_pulling) return true;
        _acceptTransfer(msg.sender, from, value, data);
        return true;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Receiving
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Releases a native token of this chain.
    function handleNativeTokens(address token, address recipient, uint256 value) external onlyRemoteMediator {
        _handleNative(token, Delivery(recipient, recipient, value, "", CallMode.Plain));
    }

    /// @notice Releases a native token and calls the recipient.
    function handleNativeTokensAndCall(address token, address recipient, uint256 value, bytes memory data)
        external
        onlyRemoteMediator
    {
        _handleNative(token, Delivery(recipient, recipient, value, data, CallMode.WithCall));
    }

    /// @notice Releases a native token, with a fallback address.
    function handleNativeTokensWithFallback(address token, address recipient, uint256 value, address fallbackRecipient)
        external
        onlyRemoteMediator
    {
        _handleNative(token, Delivery(recipient, fallbackRecipient, value, "", CallMode.Plain));
    }

    /// @notice Releases a native token and calls the recipient, with a fallback address.
    function handleNativeTokensAndCallWithFallback(
        address token,
        address recipient,
        uint256 value,
        bytes memory data,
        address fallbackRecipient
    ) external onlyRemoteMediator {
        _handleNative(token, Delivery(recipient, fallbackRecipient, value, data, CallMode.WithCall));
    }

    /// @notice Mints the bridged copy of a native token of the other chain. The copy must exist.
    function handleBridgedTokens(address token, address recipient, uint256 value) external onlyRemoteMediator {
        _handleBridged(token, Delivery(recipient, recipient, value, "", CallMode.Plain));
    }

    /// @notice Mints the bridged copy and calls the recipient.
    function handleBridgedTokensAndCall(address token, address recipient, uint256 value, bytes memory data)
        external
        onlyRemoteMediator
    {
        _handleBridged(token, Delivery(recipient, recipient, value, data, CallMode.WithCall));
    }

    /// @notice Mints the bridged copy, with a fallback address.
    function handleBridgedTokensWithFallback(address token, address recipient, uint256 value, address fallbackRecipient)
        external
        onlyRemoteMediator
    {
        _handleBridged(token, Delivery(recipient, fallbackRecipient, value, "", CallMode.Plain));
    }

    /// @notice Mints the bridged copy and calls the recipient, with a fallback address.
    function handleBridgedTokensAndCallWithFallback(
        address token,
        address recipient,
        uint256 value,
        bytes memory data,
        address fallbackRecipient
    ) external onlyRemoteMediator {
        _handleBridged(token, Delivery(recipient, fallbackRecipient, value, data, CallMode.WithCall));
    }

    /// @notice Deploys the bridged copy when it does not exist, then mints it. The first message for a token.
    function deployAndHandleBridgedTokens(
        address token,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        address recipient,
        uint256 value
    ) external onlyRemoteMediator {
        address copy = _copyOrDeploy(token, name, symbol, decimals);
        _receive(Side.Bridged, copy, Delivery(recipient, recipient, value, "", CallMode.Plain));
    }

    /// @notice Deploys the bridged copy when it does not exist, mints it and calls the recipient.
    function deployAndHandleBridgedTokensAndCall(
        address token,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        address recipient,
        uint256 value,
        bytes calldata data
    ) external onlyRemoteMediator {
        address copy = _copyOrDeploy(token, name, symbol, decimals);
        _receive(Side.Bridged, copy, Delivery(recipient, recipient, value, data, CallMode.WithCall));
    }

    /// @notice Deploys the bridged copy when it does not exist, then mints it, with a fallback address.
    function deployAndHandleBridgedTokensWithFallback(
        address token,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        address recipient,
        uint256 value,
        address fallbackRecipient
    ) external onlyRemoteMediator {
        address copy = _copyOrDeploy(token, name, symbol, decimals);
        _receive(Side.Bridged, copy, Delivery(recipient, fallbackRecipient, value, "", CallMode.Plain));
    }

    /// @notice Deploys the bridged copy when it does not exist, mints it and calls the recipient, with a fallback
    /// address.
    function deployAndHandleBridgedTokensAndCallWithFallback(
        address token,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        address recipient,
        uint256 value,
        bytes calldata data,
        address fallbackRecipient
    ) external onlyRemoteMediator {
        address copy = _copyOrDeploy(token, name, symbol, decimals);
        _receive(Side.Bridged, copy, Delivery(recipient, fallbackRecipient, value, data, CallMode.WithCall));
    }

    // ---------------------------------------------------------------------------------------------------------
    // Claims, fees and the flow limiter
    // ---------------------------------------------------------------------------------------------------------

    /// @notice Pays what a failed release left for an account. Anyone may call it, and it pays `account` only.
    /// @dev The flow limiter, when one is attached, is asked again, with a zero nonce. A refusal reverts, and the
    /// amount stays claimable. A token that still refuses `account` reverts too.
    /// @param token The token on this chain.
    /// @param account The account that the release was credited to.
    function claim(address token, address account) external nonReentrant {
        uint256 amount = claimable[token][account];
        if (amount == 0) revert NothingToClaim(token, account);
        IFlowLimiter limiter = flowLimiter;
        if (address(limiter) != address(0)) limiter.checkWithdrawal(token, account, amount, bytes32(0));
        claimable[token][account] = 0;
        if (!_tryRelease(_sideOf(token), token, account, amount)) revert ClaimTransferFailed(token, account);
        emit Claimed(token, account, amount);
    }

    /// @notice Sets the fee on new relays and the recipient of collected fees. Only the fee authority may call it.
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
    /// @dev The balance is zeroed before the transfer. A relay never transfers to the recipient, so a recipient that
    /// a token refuses blocks this call only.
    /// @param token The token on this chain.
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

    // ---------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------

    /// @notice The amount of a native token that the mediator owes to the other chain. It is not `balanceOf`.
    function mediatorBalance(address token) external view returns (uint256) {
        return _native[token].balance;
    }

    /// @notice Whether the token was relayed as a native token, or is a bridged copy.
    function isTokenRegistered(address token) public view returns (bool) {
        return _native[token].registered || nativeTokenAddress[token] != address(0);
    }

    /// @notice Whether the token is native to this chain and was relayed at least once.
    function isRegisteredAsNativeToken(address token) external view returns (bool) {
        return _native[token].registered;
    }

    /// @notice Whether the other chain proved that the bridged copy of a native token exists. From then on the
    /// mediator sends the short form message.
    function isBridgedTokenDeployAcknowledged(address token) external view returns (bool) {
        return _native[token].deployAcknowledged;
    }

    /// @notice The interface version of OmniBridge that this interface follows.
    function getBridgeInterfacesVersion() external pure returns (uint64 major, uint64 minor, uint64 patch) {
        return (3, 3, 0);
    }

    /// @notice The bridge mode of the OmniBridge multi-token mediator: `bytes4(keccak256("multi-erc-to-erc-amb"))`.
    function getBridgeMode() external pure returns (bytes4) {
        return 0xb1516c26;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Sending, internal
    // ---------------------------------------------------------------------------------------------------------

    /// @dev Pulls the tokens, measures what arrived, and bridges that amount. The measure makes a fee on transfer
    /// token bridge what the mediator received.
    function _pullAndBridge(Relay memory relay, uint256 value) private {
        IERC20 token = IERC20(relay.token);
        uint256 balanceBefore = token.balanceOf(address(this));
        _pulling = true;
        token.safeTransferFrom(msg.sender, address(this), value);
        _pulling = false;
        uint256 received = token.balanceOf(address(this)) - balanceBefore;
        if (received > value) revert ReceivedMoreThanSent(received, value);
        _bridge(relay, msg.sender, received);
    }

    /// @dev The ERC-677 entry: the tokens are here already. It requires that the balance shows them.
    function _acceptTransfer(address token, address from, uint256 value, bytes memory data) private nonReentrant {
        address receiver = from;
        bytes memory payload = new bytes(0);
        if (data.length >= 20) {
            receiver = address(bytes20(data));
            payload = _dropAddress(data);
        }
        uint256 accounted = accruedFees[token] + _native[token].balance;
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < accounted + value) {
            revert UnbackedTransfer(token, value, balance > accounted ? balance - accounted : 0);
        }
        _bridge(Relay(token, receiver, from, payload, _modeOf(payload), NO_FEE_LIMIT), from, value);
    }

    /// @dev Charges the fee, asks the limiter, locks or burns, and sends the message.
    function _bridge(Relay memory relay, address from, uint256 received) private {
        if (relay.receiver == address(0) || relay.receiver == mediatorContractOnOtherSide) {
            revert InvalidReceiver(relay.receiver);
        }
        if (relay.fallbackRecipient == address(0)) revert ZeroFallback();
        uint256 net = received - _chargeFee(relay.token, received, relay.maxFeeBasisPoints);
        if (net == 0) revert ZeroAmount();
        IFlowLimiter limiter = flowLimiter;
        if (address(limiter) != address(0)) limiter.checkDeposit(relay.token, from, net);

        address nativeToken = nativeTokenAddress[relay.token];
        (bytes memory payload, MessageKind kind) =
            nativeToken == address(0) ? _lockAndEncode(relay, net) : _burnAndEncode(relay, nativeToken, net);
        bytes32 messageId = bridgeContract.requireToPassMessage(mediatorContractOnOtherSide, payload, _gasLimitOf(kind));
        emit TokensBridgingInitiated(relay.token, from, net, messageId);
    }

    /// @dev Takes the fee from the received amount, rounded down, and books it in `accruedFees`.
    function _chargeFee(address token, uint256 received, uint16 maxFeeBasisPoints) private returns (uint256 fee) {
        uint16 basisPoints = feeBasisPoints;
        if (basisPoints > maxFeeBasisPoints) revert FeeAboveLimit(basisPoints, maxFeeBasisPoints);
        fee = received * basisPoints / BASIS_POINTS_DENOMINATOR;
        if (fee == 0) return 0;
        accruedFees[token] += fee;
        emit FeeCharged(token, fee);
    }

    /// @dev A native token: records the lock and builds the message that mints, or unlocks, on the other chain. Until
    /// the other chain proves the copy exists, the message deploys it.
    function _lockAndEncode(Relay memory relay, uint256 net) private returns (bytes memory, MessageKind) {
        NativeRecord memory record = _native[relay.token];
        uint256 newBalance = record.balance + net;
        if (newBalance > type(uint240).max) revert MediatorBalanceOverflow(relay.token);
        _native[relay.token] = NativeRecord(uint240(newBalance), true, record.deployAcknowledged);

        if (record.deployAcknowledged) return _encodeBridged(relay, net);
        return _encodeDeploy(relay, net);
    }

    /// @dev A bridged copy: burns it and builds the message that unlocks the native token on the other chain.
    function _burnAndEncode(Relay memory relay, address nativeToken, uint256 net)
        private
        returns (bytes memory, MessageKind)
    {
        IBurnableMintableERC677Token(relay.token).burn(net);
        bool sameFallback = relay.fallbackRecipient == relay.receiver;
        if (relay.mode == CallMode.WithCall) {
            return sameFallback
                ? (
                    abi.encodeWithSelector(
                        this.handleNativeTokensAndCall.selector, nativeToken, relay.receiver, net, relay.data
                    ),
                    MessageKind.ReleaseAndCall
                )
                : (
                    abi.encodeWithSelector(
                        this.handleNativeTokensAndCallWithFallback.selector,
                        nativeToken,
                        relay.receiver,
                        net,
                        relay.data,
                        relay.fallbackRecipient
                    ),
                    MessageKind.ReleaseAndCall
                );
        }
        return sameFallback
            ? (
                abi.encodeWithSelector(this.handleNativeTokens.selector, nativeToken, relay.receiver, net),
                MessageKind.Release
            )
            : (
                abi.encodeWithSelector(
                    this.handleNativeTokensWithFallback.selector,
                    nativeToken,
                    relay.receiver,
                    net,
                    relay.fallbackRecipient
                ),
                MessageKind.Release
            );
    }

    /// @dev The short form message for a native token whose copy exists. With the recipient as fallback it is the
    /// OmniBridge payload, byte for byte.
    function _encodeBridged(Relay memory relay, uint256 net) private pure returns (bytes memory, MessageKind) {
        bool sameFallback = relay.fallbackRecipient == relay.receiver;
        if (relay.mode == CallMode.WithCall) {
            return sameFallback
                ? (
                    abi.encodeWithSelector(
                        this.handleBridgedTokensAndCall.selector, relay.token, relay.receiver, net, relay.data
                    ),
                    MessageKind.ReleaseAndCall
                )
                : (
                    abi.encodeWithSelector(
                        this.handleBridgedTokensAndCallWithFallback.selector,
                        relay.token,
                        relay.receiver,
                        net,
                        relay.data,
                        relay.fallbackRecipient
                    ),
                    MessageKind.ReleaseAndCall
                );
        }
        return sameFallback
            ? (
                abi.encodeWithSelector(this.handleBridgedTokens.selector, relay.token, relay.receiver, net),
                MessageKind.Release
            )
            : (
                abi.encodeWithSelector(
                    this.handleBridgedTokensWithFallback.selector,
                    relay.token,
                    relay.receiver,
                    net,
                    relay.fallbackRecipient
                ),
                MessageKind.Release
            );
    }

    /// @dev The first message for a native token: it carries the name, the symbol and the decimals.
    function _encodeDeploy(Relay memory relay, uint256 net) private view returns (bytes memory, MessageKind) {
        string memory name = TokenReader.readName(relay.token);
        string memory symbol = TokenReader.readSymbol(relay.token);
        if (bytes(name).length == 0 && bytes(symbol).length == 0) revert NoTokenName(relay.token);
        uint8 decimals = TokenReader.readDecimals(relay.token);
        bool sameFallback = relay.fallbackRecipient == relay.receiver;
        if (relay.mode == CallMode.WithCall) {
            return sameFallback
                ? (
                    abi.encodeWithSelector(
                        this.deployAndHandleBridgedTokensAndCall.selector,
                        relay.token,
                        name,
                        symbol,
                        decimals,
                        relay.receiver,
                        net,
                        relay.data
                    ),
                    MessageKind.DeployAndCall
                )
                : (
                    abi.encodeWithSelector(
                        this.deployAndHandleBridgedTokensAndCallWithFallback.selector,
                        relay.token,
                        name,
                        symbol,
                        decimals,
                        relay.receiver,
                        net,
                        relay.data,
                        relay.fallbackRecipient
                    ),
                    MessageKind.DeployAndCall
                );
        }
        return sameFallback
            ? (
                abi.encodeWithSelector(
                    this.deployAndHandleBridgedTokens.selector, relay.token, name, symbol, decimals, relay.receiver, net
                ),
                MessageKind.Deploy
            )
            : (
                abi.encodeWithSelector(
                    this.deployAndHandleBridgedTokensWithFallback.selector,
                    relay.token,
                    name,
                    symbol,
                    decimals,
                    relay.receiver,
                    net,
                    relay.fallbackRecipient
                ),
                MessageKind.Deploy
            );
    }

    function _gasLimitOf(MessageKind kind) private pure returns (uint256) {
        if (kind == MessageKind.Release) return RELEASE_GAS_LIMIT;
        if (kind == MessageKind.ReleaseAndCall) return RELEASE_GAS_LIMIT + CALLBACK_GAS_LIMIT;
        if (kind == MessageKind.Deploy) return DEPLOY_GAS_LIMIT;
        return DEPLOY_GAS_LIMIT + CALLBACK_GAS_LIMIT;
    }

    function _modeOf(bytes memory data) private pure returns (CallMode) {
        return data.length > 0 ? CallMode.WithCall : CallMode.Plain;
    }

    /// @dev The data of `onTokenTransfer` without its first 20 bytes.
    function _dropAddress(bytes memory data) private pure returns (bytes memory rest) {
        rest = new bytes(data.length - 20);
        for (uint256 i = 0; i < rest.length; i++) {
            rest[i] = data[i + 20];
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Receiving, internal
    // ---------------------------------------------------------------------------------------------------------

    /// @dev The call must come from the message bridge, for a message that the mediator on the other chain sent from
    /// the other chain. OmniBridge checks the first two. The third is new: it keeps a message from another chain that
    /// the same bridge serves from reaching the handlers.
    function _requireRemoteMediator() private view {
        IAMB bridge = bridgeContract;
        if (msg.sender != address(bridge)) revert NotBridge(msg.sender);
        address sender = bridge.messageSender();
        if (sender != mediatorContractOnOtherSide) revert WrongRemoteMediator(mediatorContractOnOtherSide, sender);
        bytes32 sourceChain = bridge.messageSourceChainId();
        if (sourceChain != bytes32(remoteChainId)) revert WrongSourceChain(bytes32(remoteChainId), sourceChain);
    }

    function _handleNative(address token, Delivery memory delivery) private {
        NativeRecord memory record = _native[token];
        if (!record.deployAcknowledged) {
            record.deployAcknowledged = true;
            _native[token] = record;
        }
        _receive(Side.Native, token, delivery);
    }

    function _handleBridged(address nativeToken, Delivery memory delivery) private {
        address copy = bridgedTokenAddress[nativeToken];
        if (copy == address(0)) revert UnknownBridgedToken(nativeToken);
        _receive(Side.Bridged, copy, delivery);
    }

    /// @dev The bridged copy of `nativeToken`. It deploys the copy when it does not exist. A copy that exists keeps
    /// its name, so a later message with other metadata changes nothing.
    function _copyOrDeploy(address nativeToken, string calldata name, string calldata symbol, uint8 decimals)
        private
        returns (address copy)
    {
        copy = bridgedTokenAddress[nativeToken];
        if (copy != address(0)) return copy;
        if (bytes(name).length == 0 && bytes(symbol).length == 0) revert NoTokenName(nativeToken);
        string memory baseName = bytes(name).length == 0 ? symbol : name;
        string memory baseSymbol = bytes(symbol).length == 0 ? name : symbol;
        copy = tokenFactory.deploy(
            string.concat(baseName, NAME_SUFFIX),
            string.concat(SYMBOL_PREFIX, baseSymbol),
            decimals,
            remoteChainId,
            nativeToken
        );
        bridgedTokenAddress[nativeToken] = copy;
        nativeTokenAddress[copy] = nativeToken;
        emit NewTokenRegistered(nativeToken, copy);
    }

    /// @dev Pays a delivery and calls the account that received the tokens, when the message asks for a call.
    function _receive(Side side, address token, Delivery memory delivery) private {
        if (_pulling) revert HandlerDuringTransfer();
        bytes32 messageId = bridgeContract.messageId();
        if (side == Side.Native) {
            uint256 held = _native[token].balance;
            if (held < delivery.value) revert InsufficientMediatorBalance(token, held, delivery.value);
        }
        address paidTo = _pay(side, token, delivery, messageId);
        if (paidTo == address(0)) return;
        emit TokensBridged(token, paidTo, delivery.value, messageId);
        if (delivery.mode == CallMode.WithCall) _callback(paidTo, token, delivery, messageId);
    }

    /// @dev Tries the recipient, then the fallback address, and records a claim when both refuse or when the flow
    /// limiter refuses. It never reverts on a refusal, because a revert would lose the tokens: the bridge marks the
    /// message delivered anyway.
    /// @return paidTo The account that received the tokens, or zero when the amount was recorded for a claim.
    function _pay(Side side, address token, Delivery memory delivery, bytes32 messageId)
        private
        returns (address paidTo)
    {
        if (!_limiterAllows(token, delivery.recipient, delivery.value, messageId)) {
            _recordClaimable(token, delivery.recipient, delivery.value, messageId);
            return address(0);
        }
        if (_tryRelease(side, token, delivery.recipient, delivery.value)) return delivery.recipient;
        bool hasDistinctFallback = delivery.fallbackRecipient != delivery.recipient;
        if (hasDistinctFallback && _tryRelease(side, token, delivery.fallbackRecipient, delivery.value)) {
            emit FallbackUsed(token, delivery.recipient, delivery.fallbackRecipient, messageId);
            return delivery.fallbackRecipient;
        }
        _recordClaimable(token, delivery.fallbackRecipient, delivery.value, messageId);
        return address(0);
    }

    /// @dev Asks the flow limiter about a release. A refusal of any kind, a revert or a lack of gas, answers false.
    function _limiterAllows(address token, address recipient, uint256 value, bytes32 messageId) private returns (bool) {
        IFlowLimiter limiter = flowLimiter;
        if (address(limiter) == address(0)) return true;
        try limiter.checkWithdrawal(token, recipient, value, messageId) {
            return true;
        } catch {
            return false;
        }
    }

    function _recordClaimable(address token, address account, uint256 value, bytes32 messageId) private {
        claimable[token][account] += value;
        emit ClaimableRecorded(token, account, value, messageId);
    }

    /// @dev Moves a release to `to`. A native token leaves the record before the transfer and returns to it when the
    /// token refuses. A bridged copy is minted.
    /// @return Whether `to` received the tokens.
    function _tryRelease(Side side, address token, address to, uint256 value) private returns (bool) {
        if (side == Side.Bridged) {
            try IBurnableMintableERC677Token(token).mint(to, value) returns (bool minted) {
                return minted;
            } catch {
                return false;
            }
        }
        NativeRecord memory record = _native[token];
        uint240 amount = uint240(value);
        record.balance -= amount;
        _native[token] = record;
        if (IERC20(token).trySafeTransfer(to, value)) return true;
        record.balance += amount;
        _native[token] = record;
        return false;
    }

    /// @dev Calls `onTokenBridged` on the account that received the tokens, as OmniBridge does: only a contract is
    /// called, and a failure changes nothing.
    function _callback(address receiver, address token, Delivery memory delivery, bytes32 messageId) private {
        if (receiver.code.length == 0) return;
        (bool ok,) = receiver.call(
            abi.encodeWithSelector(IERC20Receiver.onTokenBridged.selector, token, delivery.value, delivery.data)
        );
        if (!ok) emit CallbackFailed(token, receiver, messageId);
    }

    function _sideOf(address token) private view returns (Side) {
        return nativeTokenAddress[token] == address(0) ? Side.Native : Side.Bridged;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Fee switch, internal
    // ---------------------------------------------------------------------------------------------------------

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
}
