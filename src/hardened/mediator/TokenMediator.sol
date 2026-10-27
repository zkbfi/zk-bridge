// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFlowLimiter} from "../IFlowLimiter.sol";
import {IAMB} from "../IAMB.sol";
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
/// covers `mediatorBalance` for each native token.
///
/// Rebasing tokens are not supported. A token whose balance changes with no transfer (a rebase, an interest bearing
/// token, a token with a negative rebase) can leave the record above the real balance, and then releases fail. The
/// mediator has no function to correct a record, because it has no owner.
///
/// Delivery of a release. The message bridge marks a message delivered whether or not the call succeeds, so a handler
/// that reverts loses the tokens for good. So a handler does not revert on a token or a limiter that refuses a
/// payee. It tries the recipient, then the fallback address of the message, and then records the amount in
/// `claimable[token][fallback]` for `claim`. A flow limiter that refuses a release records the amount for the
/// recipient, and `claim` asks the limiter again. A transfer attempt gets the gas that is left, less
/// `TRANSFER_GAS_RESERVE`, so a token that burns all its gas still leaves enough for the claim record.
///
/// Gas. The sender chooses the gas limit of a message: the larger of the request and the default of the message kind.
/// The default of a first message grows with the length of the name and the symbol of the token.
///
/// Divergences from OmniBridge. The handlers also check `messageSourceChainId`. `deploy` takes the native token.
/// Tokens are not registered by an owner. There are no limits, no failed message fix and no claim of stray tokens.
/// The mediator charges no fee.
contract TokenMediator is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The terms at deployment.
    /// @param bridge The message bridge on this chain.
    /// @param remoteMediator The mediator on the other chain. It is the only account whose messages the mediator
    /// accepts. With deployment from the same account and the same nonce on both chains, it has the address of this
    /// mediator.
    /// @param remoteChainId The identifier of the other chain. A message must come from this chain.
    /// @param flowLimiter The flow limiter. Zero means no limiter from the start. Nothing can set one later.
    /// @param remoteChainName The name of the other chain, for example `Ethereum`. A bridged copy takes it in its name.
    /// It cannot be empty and it cannot change.
    struct MediatorTerms {
        address bridge;
        address remoteMediator;
        uint256 remoteChainId;
        address flowLimiter;
        string remoteChainName;
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

    /// @notice What a sender chooses for one relay, in `relayTokensWithOptions`.
    /// @param receiver The account that receives the tokens on the other chain.
    /// @param data The data of the call to `onTokenBridged` on the receiver. Empty data means no call. The mediator
    /// never reads the data: a router that reads a fee schedule from it owns its meaning.
    /// @param fallbackRecipient The account that receives the tokens when the receiver cannot. It cannot be zero.
    /// @param gasLimit The gas that the call on the other chain gets, or zero for the default of the message. The
    /// mediator uses the larger of this value and the default, and refuses a value above the maximum of the message
    /// bridge.
    struct RelayOptions {
        address receiver;
        bytes data;
        address fallbackRecipient;
        uint256 gasLimit;
    }

    /// @dev What the sender asks for in one relay. `requestedGasLimit` is zero when the sender asks for the default.
    struct Relay {
        address token;
        address receiver;
        address fallbackRecipient;
        bytes data;
        CallMode mode;
        uint256 requestedGasLimit;
    }

    /// @dev What the first message of a native token carries for the name of its copy.
    struct Metadata {
        string name;
        string symbol;
        uint8 decimals;
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

    /// @notice The gas that the message bridge gives the call of a release of tokens.
    uint256 public constant RELEASE_GAS_LIMIT = 250_000;
    /// @notice The extra gas for the callback of a release with a call.
    uint256 public constant CALLBACK_GAS_LIMIT = 750_000;
    /// @notice The gas that the message bridge gives the call that deploys a bridged copy and releases tokens.
    uint256 public constant DEPLOY_GAS_LIMIT = 2_000_000;

    /// @notice The base of the gas rule for the first message of a token. Measured with `forge test`: the
    /// deployment of a copy with a short name costs 1,058,000 gas when each call is its own transaction
    /// (`--isolate`) and 1,153,000 gas when the whole test is one transaction. The base adds a margin for the name of
    /// the home chain and for a compiler change.
    uint256 public constant DEPLOY_GAS_BASE = 1_300_000;
    /// @notice The gas for each byte of name and symbol together in the first message of a token. The copy stores both
    /// texts, and the factory holds them while it deploys: four writes to a new storage slot for each 32 bytes. The
    /// measured cost is 1,142 gas for each byte with `--isolate` and 1,419 in one transaction. The rule uses 1,600.
    /// With the base it is above `DEPLOY_GAS_LIMIT` from 437 bytes, and it reaches the maximum of the bridge at 5,437
    /// bytes.
    uint256 public constant DEPLOY_GAS_PER_BYTE = 1_600;

    /// @notice The gas that a release keeps back when it calls a native token. Each transfer attempt gets the gas
    /// that is left, less this reserve. The reserve pays for what runs after the last attempt: the return of the
    /// amount to the record, the claim record (a write to a new storage slot) and its event. Without it a token that
    /// burns all its gas leaves only 1/64 of the gas, the handler cannot write the claim and it reverts. The bridge
    /// marks the message as delivered even then, so the tokens would be lost. The figure comes from the gas report of
    /// `TokenMediatorHostileGas` and has a margin: see `docs/hardened-build-contract.md`.
    uint256 public constant TRANSFER_GAS_RESERVE = 60_000;

    /// @notice The text between the name of a native token and the name of its home chain, in the name of a bridged
    /// copy. The copy of `Wrapped Ether` from Ethereum is `Wrapped Ether from Ethereum`.
    string public constant NAME_CONNECTOR = " from ";
    /// @notice The prefix that a bridged copy adds to the symbol of its native token, with no separator. The copy of
    /// `WETH` is `zkbWETH`.
    string public constant SYMBOL_PREFIX = "zkb";

    /// @notice The caller of a handler is not the message bridge.
    error NotBridge(address caller);
    /// @notice The message bridge passes a message from an account that is not the mediator on the other chain.
    error WrongRemoteMediator(address expected, address actual);
    /// @notice The message bridge passes a message from a chain that is not the other chain.
    error WrongSourceChain(bytes32 expected, bytes32 actual);
    /// @notice A constructor argument is zero.
    error ZeroValue(string name);
    /// @notice The largest message of the mediator asks for more gas than the message bridge allows in one call.
    error GasLimitAboveBridgeMaximum(uint256 gasLimit, uint256 maximum);
    /// @notice Only the flow limiter may detach itself. After a detach nobody can.
    error NotFlowLimiter(address caller);
    /// @notice The receiver on the other chain is the zero address, or the mediator on the other chain.
    error InvalidReceiver(address receiver);
    /// @notice The fallback address is zero.
    error ZeroFallback();
    /// @notice The amount to bridge is zero.
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

    /// @notice Emitted when a sender starts a transfer, with the amount that arrived.
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
        // A message that asks for more than `maxGasPerTx` is refused at the send, so no relay would ever work.
        uint256 largestGasLimit = DEPLOY_GAS_LIMIT + CALLBACK_GAS_LIMIT;
        uint256 bridgeMaximum = IAMB(terms.bridge).maxGasPerTx();
        if (largestGasLimit > bridgeMaximum) revert GasLimitAboveBridgeMaximum(largestGasLimit, bridgeMaximum);
        if (terms.remoteMediator == address(0)) revert ZeroValue("remoteMediator");
        if (terms.remoteChainId == 0) revert ZeroValue("remoteChainId");
        if (bytes(terms.remoteChainName).length == 0) revert ZeroValue("remoteChainName");

        bridgeContract = IAMB(terms.bridge);
        mediatorContractOnOtherSide = terms.remoteMediator;
        remoteChainId = terms.remoteChainId;
        tokenFactory = _createFactory(terms.remoteChainName);
        flowLimiter = IFlowLimiter(terms.flowLimiter);
    }

    /// @dev A function of its own, so the constructor keeps its stack small.
    function _createFactory(string memory remoteChainName) private returns (TokenFactory) {
        return new TokenFactory(address(this), remoteChainName);
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
        _pullAndBridge(Relay(token, receiver, msg.sender, "", CallMode.Plain, 0), value);
    }

    /// @notice Relays tokens of the caller to the caller on the other chain.
    function relayTokens(address token, uint256 value) external nonReentrant {
        _pullAndBridge(Relay(token, msg.sender, msg.sender, "", CallMode.Plain, 0), value);
    }

    /// @notice Relays tokens to `receiver` and calls `onTokenBridged(token, value, data)` on it, even when `data` is
    /// empty, as OmniBridge does. A failed release goes to the caller.
    function relayTokensAndCall(address token, address receiver, uint256 value, bytes calldata data)
        external
        nonReentrant
    {
        _pullAndBridge(Relay(token, receiver, msg.sender, data, CallMode.WithCall, 0), value);
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
        _pullAndBridge(Relay(token, receiver, fallbackRecipient, data, _modeOf(data), 0), value);
    }

    /// @notice Relays tokens of the caller with every choice of the sender in one struct. The caller approves the
    /// mediator first. New: OmniBridge has no such function, because its owner sets the gas limits.
    /// @dev The gas limit of the message is the larger of `options.gasLimit` and the default of the message. The
    /// default of the first message of a token also grows with the length of its name and symbol. A value above the
    /// maximum of the message bridge reverts with `GasLimitAboveBridgeMaximum`.
    /// @param token The token to relay.
    /// @param value The amount to pull from the caller.
    /// @param options The receiver, the data, the fallback address and the gas limit. See `RelayOptions`.
    function relayTokensWithOptions(address token, uint256 value, RelayOptions calldata options) external nonReentrant {
        _pullAndBridge(
            Relay(
                token,
                options.receiver,
                options.fallbackRecipient,
                options.data,
                _modeOf(options.data),
                options.gasLimit
            ),
            value
        );
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
    // Claims and the flow limiter
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
        uint256 accounted = _native[token].balance;
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < accounted + value) {
            revert UnbackedTransfer(token, value, balance > accounted ? balance - accounted : 0);
        }
        _bridge(Relay(token, receiver, from, payload, _modeOf(payload), 0), from, value);
    }

    /// @dev Asks the limiter, locks or burns, and sends the message.
    function _bridge(Relay memory relay, address from, uint256 value) private {
        if (relay.receiver == address(0) || relay.receiver == mediatorContractOnOtherSide) {
            revert InvalidReceiver(relay.receiver);
        }
        if (relay.fallbackRecipient == address(0)) revert ZeroFallback();
        if (value == 0) revert ZeroAmount();
        IFlowLimiter limiter = flowLimiter;
        if (address(limiter) != address(0)) limiter.checkDeposit(relay.token, from, value);

        address nativeToken = nativeTokenAddress[relay.token];
        (bytes memory payload, uint256 defaultGasLimit) =
            nativeToken == address(0) ? _lockAndEncode(relay, value) : _burnAndEncode(relay, nativeToken, value);
        uint256 gasLimit = _chooseGasLimit(relay.requestedGasLimit, defaultGasLimit);
        bytes32 messageId = bridgeContract.requireToPassMessage(mediatorContractOnOtherSide, payload, gasLimit);
        emit TokensBridgingInitiated(relay.token, from, value, messageId);
    }

    /// @dev A native token: records the lock and builds the message that mints, or unlocks, on the other chain. Until
    /// the other chain proves the copy exists, the message deploys it.
    function _lockAndEncode(Relay memory relay, uint256 value) private returns (bytes memory, uint256) {
        NativeRecord memory record = _native[relay.token];
        uint256 newBalance = record.balance + value;
        if (newBalance > type(uint240).max) revert MediatorBalanceOverflow(relay.token);
        _native[relay.token] = NativeRecord(uint240(newBalance), true, record.deployAcknowledged);

        if (record.deployAcknowledged) return _encodeBridged(relay, value);
        return _encodeDeploy(relay, value);
    }

    /// @dev A bridged copy: burns it and builds the message that unlocks the native token on the other chain.
    function _burnAndEncode(Relay memory relay, address nativeToken, uint256 value)
        private
        returns (bytes memory, uint256)
    {
        IBurnableMintableERC677Token(relay.token).burn(value);
        bool sameFallback = relay.fallbackRecipient == relay.receiver;
        if (relay.mode == CallMode.WithCall) {
            return sameFallback
                ? (
                    abi.encodeWithSelector(
                        this.handleNativeTokensAndCall.selector, nativeToken, relay.receiver, value, relay.data
                    ),
                    RELEASE_GAS_LIMIT + CALLBACK_GAS_LIMIT
                )
                : (
                    abi.encodeWithSelector(
                        this.handleNativeTokensAndCallWithFallback.selector,
                        nativeToken,
                        relay.receiver,
                        value,
                        relay.data,
                        relay.fallbackRecipient
                    ),
                    RELEASE_GAS_LIMIT + CALLBACK_GAS_LIMIT
                );
        }
        return sameFallback
            ? (
                abi.encodeWithSelector(this.handleNativeTokens.selector, nativeToken, relay.receiver, value),
                RELEASE_GAS_LIMIT
            )
            : (
                abi.encodeWithSelector(
                    this.handleNativeTokensWithFallback.selector,
                    nativeToken,
                    relay.receiver,
                    value,
                    relay.fallbackRecipient
                ),
                RELEASE_GAS_LIMIT
            );
    }

    /// @dev The short form message for a native token whose copy exists. With the recipient as fallback it is the
    /// OmniBridge payload, byte for byte.
    function _encodeBridged(Relay memory relay, uint256 value) private pure returns (bytes memory, uint256) {
        bool sameFallback = relay.fallbackRecipient == relay.receiver;
        if (relay.mode == CallMode.WithCall) {
            return sameFallback
                ? (
                    abi.encodeWithSelector(
                        this.handleBridgedTokensAndCall.selector, relay.token, relay.receiver, value, relay.data
                    ),
                    RELEASE_GAS_LIMIT + CALLBACK_GAS_LIMIT
                )
                : (
                    abi.encodeWithSelector(
                        this.handleBridgedTokensAndCallWithFallback.selector,
                        relay.token,
                        relay.receiver,
                        value,
                        relay.data,
                        relay.fallbackRecipient
                    ),
                    RELEASE_GAS_LIMIT + CALLBACK_GAS_LIMIT
                );
        }
        return sameFallback
            ? (
                abi.encodeWithSelector(this.handleBridgedTokens.selector, relay.token, relay.receiver, value),
                RELEASE_GAS_LIMIT
            )
            : (
                abi.encodeWithSelector(
                    this.handleBridgedTokensWithFallback.selector,
                    relay.token,
                    relay.receiver,
                    value,
                    relay.fallbackRecipient
                ),
                RELEASE_GAS_LIMIT
            );
    }

    /// @dev The first message for a native token: it carries the name, the symbol and the decimals. The default gas
    /// limit grows with the length of the name and the symbol, because the copy stores both.
    function _encodeDeploy(Relay memory relay, uint256 value) private view returns (bytes memory, uint256) {
        Metadata memory metadata = _readMetadata(relay.token);
        uint256 gasLimit = _deployGasLimitOf(metadata, relay.mode);
        bool sameFallback = relay.fallbackRecipient == relay.receiver;
        if (relay.mode == CallMode.WithCall) {
            return sameFallback
                ? (
                    abi.encodeWithSelector(
                        this.deployAndHandleBridgedTokensAndCall.selector,
                        relay.token,
                        metadata.name,
                        metadata.symbol,
                        metadata.decimals,
                        relay.receiver,
                        value,
                        relay.data
                    ),
                    gasLimit
                )
                : (
                    abi.encodeWithSelector(
                        this.deployAndHandleBridgedTokensAndCallWithFallback.selector,
                        relay.token,
                        metadata.name,
                        metadata.symbol,
                        metadata.decimals,
                        relay.receiver,
                        value,
                        relay.data,
                        relay.fallbackRecipient
                    ),
                    gasLimit
                );
        }
        return sameFallback
            ? (
                abi.encodeWithSelector(
                    this.deployAndHandleBridgedTokens.selector,
                    relay.token,
                    metadata.name,
                    metadata.symbol,
                    metadata.decimals,
                    relay.receiver,
                    value
                ),
                gasLimit
            )
            : (
                abi.encodeWithSelector(
                    this.deployAndHandleBridgedTokensWithFallback.selector,
                    relay.token,
                    metadata.name,
                    metadata.symbol,
                    metadata.decimals,
                    relay.receiver,
                    value,
                    relay.fallbackRecipient
                ),
                gasLimit
            );
    }

    /// @dev Reads the name, the symbol and the decimals of a native token for its first message.
    function _readMetadata(address token) private view returns (Metadata memory metadata) {
        metadata.name = TokenReader.readName(token);
        metadata.symbol = TokenReader.readSymbol(token);
        if (bytes(metadata.name).length == 0 && bytes(metadata.symbol).length == 0) revert NoTokenName(token);
        metadata.decimals = TokenReader.readDecimals(token);
    }

    /// @dev The default gas limit of a deploy message: the larger of `DEPLOY_GAS_LIMIT` and the rule of
    /// `DEPLOY_GAS_BASE` plus `DEPLOY_GAS_PER_BYTE` for each byte of name and symbol. The callback limit comes on top
    /// when the message calls the receiver.
    function _deployGasLimitOf(Metadata memory metadata, CallMode mode) private pure returns (uint256 gasLimit) {
        gasLimit = DEPLOY_GAS_LIMIT;
        uint256 textLength = bytes(metadata.name).length + bytes(metadata.symbol).length;
        uint256 needed = DEPLOY_GAS_BASE + DEPLOY_GAS_PER_BYTE * textLength;
        if (needed > gasLimit) gasLimit = needed;
        if (mode == CallMode.WithCall) gasLimit += CALLBACK_GAS_LIMIT;
    }

    /// @dev The gas limit of a message: the larger of the request of the sender and the default of the message. A
    /// value above the maximum of the message bridge reverts with the mediator error, and not with the error of the
    /// bridge that does not name the rule.
    function _chooseGasLimit(uint256 requested, uint256 defaultGasLimit) private view returns (uint256 gasLimit) {
        gasLimit = requested > defaultGasLimit ? requested : defaultGasLimit;
        uint256 bridgeMaximum = bridgeContract.maxGasPerTx();
        if (gasLimit > bridgeMaximum) revert GasLimitAboveBridgeMaximum(gasLimit, bridgeMaximum);
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
            string.concat(baseName, NAME_CONNECTOR, tokenFactory.homeChainName()),
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
        uint240 amount = uint240(value);
        _native[token].balance -= amount;
        if (_transferWithinReserve(IERC20(token), to, value)) return true;
        // Read the record again: a token that calls back during the transfer can lock more tokens before it refuses.
        _native[token].balance += amount;
        return false;
    }

    /// @dev A transfer that cannot take the gas that the handler needs afterwards. The call gets the gas that is left,
    /// less `TRANSFER_GAS_RESERVE`, and fails when the token needs more. It reads the answer as `SafeERC20` does: the
    /// token must return true, or return nothing and have code. It reads 32 bytes of the answer at most, so a token
    /// cannot spend the reserve on a large answer. It returns false, with no call, when the gas left is not above the
    /// reserve.
    function _transferWithinReserve(IERC20 token, address to, uint256 value) private returns (bool success) {
        uint256 available = gasleft();
        if (available <= TRANSFER_GAS_RESERVE) return false;
        uint256 gasCap = available - TRANSFER_GAS_RESERVE;
        bytes4 selector = IERC20.transfer.selector;
        assembly ("memory-safe") {
            let freePointer := mload(0x40)
            mstore(0x00, selector)
            mstore(0x04, and(to, shr(96, not(0))))
            mstore(0x24, value)
            success := call(gasCap, token, 0, 0x00, 0x44, 0x00, 0x20)
            if iszero(and(success, eq(mload(0x00), 1))) {
                success := and(success, and(iszero(returndatasize()), gt(extcodesize(token), 0)))
            }
            mstore(0x40, freePointer)
        }
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
}
