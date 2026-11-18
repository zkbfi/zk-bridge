// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFlowLimiter} from "../IFlowLimiter.sol";
import {IAMB} from "../IAMB.sol";
import {ITokenMediator} from "./ITokenMediator.sol";
import {IBurnableMintableERC677Token} from "./IBurnableMintableERC677Token.sol";
import {IERC20Receiver} from "./IERC20Receiver.sol";
import {TokenFactory} from "./TokenFactory.sol";
import {
    MediatorPayloads,
    IMediatorHandlers,
    COPY_NAME_CONNECTOR,
    COPY_SYMBOL_PREFIX,
    CALLBACK_GAS_MAXIMUM
} from "./MediatorPayloads.sol";
import {ExactGasCall} from "./ExactGasCall.sol";

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
/// the amount that arrived. The balance of the mediator covers `mediatorBalance` for each native token.
///
/// Rebasing tokens are not supported. A token whose balance changes with no transfer (a rebase, an interest bearing
/// token, a token with a negative rebase) can leave the record above the real balance, and then releases fail. The
/// mediator has no function to correct a record, because it has no owner.
///
/// Delivery of a release. The message bridge delivers a message only when the handler succeeds: a handler that
/// reverts leaves the message undelivered, and anyone can deliver it again. The rule at every call that the mediator
/// makes during a release is the same: not enough gas reverts the whole delivery (it can run again with more gas); a
/// callee that says no is recorded and the delivery completes. So a handler does not revert on a token or a limiter
/// that refuses the recipient: it tries the recipient once, and when the recipient cannot take the tokens it emits
/// `ReleaseFailed` and stops. That release is final: there is no claim, no retry and no payee but the recipient. A
/// fallback payee belongs in a router, as an option. A token or a limiter that fails after it used up all the gas that
/// it got is read as a lack of gas, not as a refusal, and the delivery reverts. A token that burns all the gas of
/// every transfer therefore keeps its release undelivered until it stops doing that.
///
/// A failed release and the books. The other chain burned its copies, or locked its native tokens, when it sent the
/// message, so the failed release leaves nothing owed. For a native token, the record falls by the value of every
/// release, paid or failed, and the failed amount stays in the balance of the mediator, owed to nobody. The balance
/// then exceeds the record by the stuck amount, as for a token that arrives by a plain transfer. For a bridged copy, a
/// failed release mints nothing. Only an invalid recipient (the zero address) can make a mint fail, and a sender cannot
/// name it, so the case needs a forged message. Then the native tokens stay locked on the other chain. A transfer
/// attempt gets the gas that is left, less `TRANSFER_GAS_RESERVE`, so a token that burns all its gas still leaves
/// enough gas to tell that case apart and revert.
///
/// Gas. The mediator has no gas rules and no defaults. The message bridge gives a handler all the gas that the executor
/// brings, and an executor that brings too little only loses its own transaction. The one gas number is the gas of the
/// callback: a sender of a relay with a call states `callbackGas`, the message carries it, and the handler on the other
/// chain calls `onTokenBridged` with exactly that gas (see `ExactGasCall`). The gas guarantee is the same for every
/// receiver contract: the mediator knows no router. A send refuses a callback gas above `MAX_CALLBACK_GAS`, the most
/// that one transaction can give with the delivery around it, so every message that it sends can be delivered.
///
/// Divergences from OmniBridge. The handlers also check `messageSourceChainId`. `deploy` takes the native token.
/// Tokens are not registered by an owner. There are no limits, no failed message fix and no claim of stray tokens.
/// The mediator charges no fee. A relay with a call states the gas of the callback, so `relayTokensAndCall` takes a
/// `callbackGas` argument, the three `...AndCall` handlers take it after `data`, and the ERC-677 data of a call carries
/// it after the receiver. The relay with a call and no gas argument of OmniBridge does not exist here.
contract TokenMediator is ITokenMediator, IMediatorHandlers, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The terms at deployment.
    /// @param bridge The message bridge on this chain.
    /// @param remoteMediator The mediator on the other chain. It is the only account whose messages the mediator
    /// accepts. With deployment from the same account and the same nonce on both chains, it has the address of this
    /// mediator.
    /// @param flowLimiter The flow limiter. Zero means no limiter from the start. Nothing can set one later.
    /// @param tokenFactory The factory that deploys the bridged copies, deployed before the mediator with the predicted
    /// address of this mediator as its `mediator`. Its `homeChainName` is the name of the other chain, for example
    /// `Ethereum`, which a bridged copy takes in its name; it cannot be empty and it cannot change.
    struct MediatorTerms {
        address bridge;
        address remoteMediator;
        address flowLimiter;
        address tokenFactory;
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

    /// @dev What a handler delivers. `callbackGas` is the gas of the callback, zero for a plain delivery.
    struct Delivery {
        address recipient;
        uint256 value;
        bytes data;
        CallMode mode;
        uint256 callbackGas;
    }

    /// @notice The gas that a release keeps back when it calls a native token. Each transfer attempt gets the gas
    /// that is left, less this reserve. The reserve pays for what runs after the attempt: the check that tells a lack
    /// of gas from a refusal, and the event of a failed release. The figure comes from the gas report of
    /// `TokenMediatorHostileGas` and has a margin: see `docs/hardened-build-contract.md`.
    uint256 public constant TRANSFER_GAS_RESERVE = 60_000;

    /// @notice The gas that the mediator keeps for itself after the callback: the event of a failed callback and the
    /// return to the bridge. A delivery must have the gas of the callback, its 63/64 share, the gas of the call itself
    /// (`ExactGasCall.CALL_OVERHEAD`, 6,000) and this reserve.
    uint256 public constant CALLBACK_GAS_RESERVE = 10_000;

    /// @notice The largest callback gas that a relay with a call may state: 10,468,731. A send above it reverts with
    /// `CallbackGasTooHigh`, so that every message stays deliverable: a callback gas that no transaction can give would
    /// leave the tokens locked or burned on this chain and the message undeliverable for good.
    /// @dev The figure is the one that the frontends use (`MAX_CALLBACK_GAS` of the explorer core): the 300,000 gas of
    /// a router's own work, a follow-up call of 10,000,000, its 63/64 share (158,731, rounded up) and the router's
    /// reserve of 10,000. It fits one transaction under the cap of EIP-7825 (16,777,216 gas) with a whole delivery
    /// around it. Measured (`BridgeWorld.t.sol`, `test_theLargestCallbackIsDeliveredUnderTheTransactionGasCap`): with a
    /// call that burns its 10,000,000 gas, the delivery through the router and the real bridge needs 11,428,828 gas of
    /// execution; with 21,000 for the transaction, 50,144 for the calldata of the proof and 100,000 of room for the
    /// historical proof path, 11,599,972 gas, which leaves 5,177,244. The delivery adds the 63/64 share of each call
    /// frame (router, bridge, mediator), `ExactGasCall.CALL_OVERHEAD` and `CALLBACK_GAS_RESERVE`, the proof check
    /// (about 323,000 to 353,000 gas) and the release. The first message of a token also deploys its copy. On a chain
    /// that charges the standard 200 gas per byte of code that takes about 1,000,000 gas and fits; on Sepolia, which
    /// charges about 1,600 gas per byte, it takes about 7,000,000, and a first message with a callback gas above about
    /// 8,500,000 does not fit one transaction there. That message waits, and is delivered once the copy exists: any
    /// first message of the same token (a plain relay does) deploys it, and the deploy step of a later message then
    /// only reads the copy.
    uint256 public constant MAX_CALLBACK_GAS = CALLBACK_GAS_MAXIMUM;

    /// @notice The text between the name of a native token and the name of its home chain, in the name of a bridged
    /// copy. The copy of `Wrapped Ether` from Ethereum is `Wrapped Ether from Ethereum`.
    string public constant NAME_CONNECTOR = COPY_NAME_CONNECTOR;
    /// @notice The prefix that a bridged copy adds to the symbol of its native token, with no separator. The copy of
    /// `WETH` is `zWETH`.
    string public constant SYMBOL_PREFIX = COPY_SYMBOL_PREFIX;

    /// @notice The caller of a handler is not the message bridge.
    error NotBridge(address caller);
    /// @notice The message bridge passes a message from an account that is not the mediator on the other chain.
    error WrongRemoteMediator(address expected, address actual);
    /// @notice The message bridge passes a message from a chain that is not the other chain.
    error WrongSourceChain(bytes32 expected, bytes32 actual);
    /// @notice A constructor argument is zero.
    error ZeroValue(string name);
    /// @notice The token factory of the terms names another mediator.
    error FactoryOfAnotherMediator(address mediator);
    /// @notice A relay with a call states no gas for the callback. There is no default.
    error ZeroCallbackGas();
    /// @notice A relay states a callback gas above `MAX_CALLBACK_GAS`, which no delivery can give.
    error CallbackGasTooHigh(uint256 callbackGas, uint256 maximum);
    /// @notice The ERC-677 data is longer than a receiver and shorter than a receiver and the callback gas.
    error MalformedTransferData(uint256 length);
    /// @notice A token, the copy or the flow limiter failed after it used up the gas that it got during a release. The
    /// delivery reverts, so it can run again with more gas.
    error ReleaseOutOfGas(address token);
    /// @notice Only the flow limiter may detach itself. After a detach nobody can.
    error NotFlowLimiter(address caller);
    /// @notice The receiver on the other chain is the zero address, or the mediator on the other chain.
    error InvalidReceiver(address receiver);
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

    /// @notice Emitted when a sender starts a transfer, with the amount that arrived.
    event TokensBridgingInitiated(
        address indexed token, address indexed sender, uint256 value, bytes32 indexed messageId
    );
    /// @notice Emitted when a delivery pays the recipient of the message.
    event TokensBridged(address indexed token, address indexed recipient, uint256 value, bytes32 indexed messageId);
    /// @notice Emitted when the mediator deploys the bridged copy of a native token.
    event NewTokenRegistered(address indexed nativeToken, address indexed bridgedToken);
    /// @notice Emitted when the recipient could not receive a release, or the flow limiter refused it. The release is
    /// final: nothing was paid, and nothing can pay it later.
    event ReleaseFailed(address indexed token, address indexed recipient, uint256 value, bytes32 indexed messageId);
    /// @notice Emitted when the `onTokenBridged` call on a recipient fails with the gas that the message gave it. The
    /// tokens stay with the recipient.
    event CallbackFailed(address indexed token, address indexed recipient, bytes32 indexed messageId);
    /// @notice Emitted when the flow limiter detaches itself. The mediator never calls it again.
    event FlowLimiterDetached(address indexed limiter);

    /// @notice The message bridge on this chain.
    IAMB public immutable bridgeContract;
    /// @notice The mediator on the other chain.
    address public immutable mediatorContractOnOtherSide;
    /// @notice The identifier of the other chain, read from the bridge at deployment.
    uint256 public immutable remoteChainId;
    /// @notice The factory that deploys the bridged copies. It is deployed before the mediator and names it.
    TokenFactory public immutable tokenFactory;
    /// @notice The flow limiter that every relay and release must pass. Zero means none. Only the limiter can detach
    /// itself, and nothing can set it.
    IFlowLimiter public flowLimiter;

    /// @notice The bridged copy of a native token of the other chain, or zero when it is not deployed.
    mapping(address nativeToken => address) public bridgedTokenAddress;
    /// @notice The native token of the other chain that a bridged copy stands for, or zero for any other token.
    mapping(address bridgedToken => address) public nativeTokenAddress;

    /// @dev The record of each native token (`MediatorPayloads.NativeRecord`: balance, registered, deploy acknowledged),
    /// in one storage slot each.
    mapping(address token => MediatorPayloads.NativeRecord) private _native;
    /// @dev True while `_pullAndBridge` pulls tokens. A token that calls `onTokenTransfer` during the pull gets true
    /// and no relay, and a release during the pull is refused (the pull measures a balance difference).
    bool private _pulling;

    /// @param terms The terms at deployment. See `MediatorTerms`. The identifier of the other chain is not a term: the
    /// constructor reads it once from `destinationChainId()` of the bridge, so the two cannot disagree.
    /// The factory is a term: it must have code, name this mediator, and carry a home chain name.
    constructor(MediatorTerms memory terms) {
        if (terms.bridge.code.length == 0) revert ZeroValue("bridge");
        if (terms.remoteMediator == address(0)) revert ZeroValue("remoteMediator");
        if (terms.tokenFactory.code.length == 0) revert ZeroValue("tokenFactory");
        TokenFactory factory = TokenFactory(terms.tokenFactory);
        if (factory.mediator() != address(this)) revert FactoryOfAnotherMediator(factory.mediator());
        if (bytes(factory.homeChainName()).length == 0) revert ZeroValue("remoteChainName");
        uint256 remoteChainId_ = IAMB(terms.bridge).destinationChainId();
        if (remoteChainId_ == 0) revert ZeroValue("remoteChainId");

        bridgeContract = IAMB(terms.bridge);
        mediatorContractOnOtherSide = terms.remoteMediator;
        remoteChainId = remoteChainId_;
        tokenFactory = factory;
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
    /// A release that `receiver` cannot take is final: see `ReleaseFailed`.
    function relayTokens(address token, address receiver, uint256 value) external nonReentrant {
        _pullAndBridge(MediatorPayloads.Relay(token, receiver, "", false, 0), value);
    }

    /// @notice Relays tokens of the caller to the caller on the other chain.
    function relayTokens(address token, uint256 value) external nonReentrant {
        _pullAndBridge(MediatorPayloads.Relay(token, msg.sender, "", false, 0), value);
    }

    /// @notice Relays tokens to `receiver` and calls `onTokenBridged(token, value, data)` on it with exactly
    /// `callbackGas`, even when `data` is empty, as OmniBridge calls. New: the gas of the callback is the sender's, and
    /// there is no default.
    /// @dev On the other chain, a delivery that cannot give the callback `callbackGas` (63/64 rule included) reverts
    /// and can run again with more gas. A callback that fails with that gas emits `CallbackFailed`, and the tokens stay
    /// with `receiver`. A `callbackGas` of zero reverts with `ZeroCallbackGas`, and one above `MAX_CALLBACK_GAS` with
    /// `CallbackGasTooHigh`.
    /// @param callbackGas The gas that `onTokenBridged` gets on the other chain.
    function relayTokensAndCall(
        address token,
        address receiver,
        uint256 value,
        bytes calldata data,
        uint256 callbackGas
    ) external nonReentrant {
        _pullAndBridge(MediatorPayloads.Relay(token, receiver, data, true, callbackGas), value);
    }

    /// @notice The transfer callback of a token with `transferAndCall`. The token has moved `value` to the mediator
    /// already. `data` shorter than 20 bytes means the receiver is `from`, with no callback. `data` of exactly 20 bytes
    /// is the receiver on the other chain, with no callback. Longer `data` is the receiver, then one 32 byte word with
    /// the gas of the callback, then the bytes passed to `onTokenBridged` (they may be empty). `data` between 21 and 51
    /// bytes reverts with `MalformedTransferData`.
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
        _handleNative(token, Delivery(recipient, value, "", CallMode.Plain, 0));
    }

    /// @notice Releases a native token and calls the recipient with `callbackGas`.
    function handleNativeTokensAndCall(
        address token,
        address recipient,
        uint256 value,
        bytes memory data,
        uint256 callbackGas
    ) external onlyRemoteMediator {
        _handleNative(token, Delivery(recipient, value, data, CallMode.WithCall, callbackGas));
    }

    /// @notice Mints the bridged copy of a native token of the other chain. The copy must exist.
    function handleBridgedTokens(address token, address recipient, uint256 value) external onlyRemoteMediator {
        _handleBridged(token, Delivery(recipient, value, "", CallMode.Plain, 0));
    }

    /// @notice Mints the bridged copy and calls the recipient with `callbackGas`.
    function handleBridgedTokensAndCall(
        address token,
        address recipient,
        uint256 value,
        bytes memory data,
        uint256 callbackGas
    ) external onlyRemoteMediator {
        _handleBridged(token, Delivery(recipient, value, data, CallMode.WithCall, callbackGas));
    }

    /// @notice Deploys the bridged copy when it does not exist, then mints it. The first message for a token. It needs
    /// no gas number: the executor brings the gas of the deployment.
    function deployAndHandleBridgedTokens(
        address token,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        address recipient,
        uint256 value
    ) external onlyRemoteMediator {
        address copy = _copyOrDeploy(token, name, symbol, decimals);
        _receive(Side.Bridged, copy, Delivery(recipient, value, "", CallMode.Plain, 0));
    }

    /// @notice Deploys the bridged copy when it does not exist, mints it and calls the recipient with `callbackGas`.
    function deployAndHandleBridgedTokensAndCall(
        address token,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        address recipient,
        uint256 value,
        bytes calldata data,
        uint256 callbackGas
    ) external onlyRemoteMediator {
        address copy = _copyOrDeploy(token, name, symbol, decimals);
        _receive(Side.Bridged, copy, Delivery(recipient, value, data, CallMode.WithCall, callbackGas));
    }

    // ---------------------------------------------------------------------------------------------------------
    // The flow limiter
    // ---------------------------------------------------------------------------------------------------------

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
    function _pullAndBridge(MediatorPayloads.Relay memory relay, uint256 value) private {
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
        uint256 accounted = _native[token].balance;
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance < accounted + value) {
            revert UnbackedTransfer(token, value, balance > accounted ? balance - accounted : 0);
        }
        _bridge(MediatorPayloads.readTransferData(token, from, data), from, value);
    }

    /// @dev Asks the limiter, locks or burns, and sends the message (`MediatorPayloads.send`, in the storage of this
    /// mediator). The message asks the bridge for no gas.
    function _bridge(MediatorPayloads.Relay memory relay, address from, uint256 value) private {
        MediatorPayloads.send(
            _native, nativeTokenAddress, bridgeContract, mediatorContractOnOtherSide, flowLimiter, relay, from, value
        );
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
        MediatorPayloads.NativeRecord memory record = _native[token];
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

    /// @dev The bridged copy of `nativeToken`. It deploys the copy when it does not exist
    /// (`MediatorPayloads.copyOrDeploy`). A copy that exists keeps its name, so a later message with other metadata
    /// changes nothing.
    function _copyOrDeploy(address nativeToken, string calldata name, string calldata symbol, uint8 decimals)
        private
        returns (address)
    {
        return MediatorPayloads.copyOrDeploy(
            bridgedTokenAddress, nativeTokenAddress, tokenFactory, remoteChainId, nativeToken, name, symbol, decimals
        );
    }

    /// @dev Pays a delivery and calls the account that received the tokens, when the message asks for a call.
    function _receive(Side side, address token, Delivery memory delivery) private {
        if (_pulling) revert HandlerDuringTransfer();
        bytes32 messageId = bridgeContract.messageId();
        if (side == Side.Native) {
            uint256 held = _native[token].balance;
            if (held < delivery.value) revert InsufficientMediatorBalance(token, held, delivery.value);
            // The record falls by every release, paid or failed: the other chain burned the copies already.
            _native[token].balance = uint240(held - delivery.value);
        }
        if (!_pay(side, token, delivery, messageId)) return;
        emit TokensBridged(token, delivery.recipient, delivery.value, messageId);
        if (delivery.mode == CallMode.WithCall) _callback(delivery.recipient, token, delivery, messageId);
    }

    /// @dev Tries the recipient once. When the recipient cannot take the release, or the flow limiter refuses it, it
    /// emits `ReleaseFailed` and stops. It never reverts on a refusal, so a refusal cannot hold the message back. It
    /// reverts on a lack of gas, so an executor cannot turn a lack of gas into a refusal. The mediator pays no account
    /// but the recipient.
    /// @return paid Whether the recipient received the tokens.
    function _pay(Side side, address token, Delivery memory delivery, bytes32 messageId) private returns (bool paid) {
        bool allowed = _limiterAllows(token, delivery.recipient, delivery.value, messageId);
        if (allowed && _tryRelease(side, token, delivery.recipient, delivery.value)) return true;
        emit ReleaseFailed(token, delivery.recipient, delivery.value, messageId);
        return false;
    }

    /// @dev Asks the flow limiter about a release. A revert answers false. A failure that used up the gas reverts the
    /// delivery with `ReleaseOutOfGas`.
    function _limiterAllows(address token, address recipient, uint256 value, bytes32 messageId) private returns (bool) {
        IFlowLimiter limiter = flowLimiter;
        if (address(limiter) == address(0)) return true;
        uint256 gasBefore = gasleft();
        try limiter.checkWithdrawal(token, recipient, value, messageId) {
            return true;
        } catch {
            _revertIfOutOfGas(token, gasBefore, 0);
            return false;
        }
    }

    /// @dev Moves a release to `to`. A bridged copy is minted. A native token is transferred, within the reserve. The
    /// record of a native token already fell in `_receive`.
    /// @return Whether `to` received the tokens.
    function _tryRelease(Side side, address token, address to, uint256 value) private returns (bool) {
        if (side == Side.Native) return _transferWithinReserve(IERC20(token), to, value);
        uint256 gasBefore = gasleft();
        try IBurnableMintableERC677Token(token).mint(to, value) returns (bool minted) {
            return minted;
        } catch {
            _revertIfOutOfGas(token, gasBefore, 0);
            return false;
        }
    }

    /// @dev A transfer that cannot take the gas that the handler needs afterwards. The call gets the gas that is left,
    /// less `TRANSFER_GAS_RESERVE`, and fails when the token needs more. It reads the answer as `SafeERC20` does: the
    /// token must return true, or return nothing and have code. It reads 32 bytes of the answer at most, so a token
    /// cannot spend the reserve on a large answer. A gas left that is not above the reserve, and a failed call that
    /// used up its gas, revert the delivery with `ReleaseOutOfGas`.
    function _transferWithinReserve(IERC20 token, address to, uint256 value) private returns (bool success) {
        uint256 available = gasleft();
        if (available <= TRANSFER_GAS_RESERVE) revert ReleaseOutOfGas(address(token));
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
        if (!success) _revertIfOutOfGas(address(token), available, TRANSFER_GAS_RESERVE);
    }

    /// @dev Tells a lack of gas from a refusal, after a call that failed. A call that runs out of gas leaves the caller
    /// one 64th of the gas before the call, or the part that the caller held back (`reserve`), whichever is larger.
    /// A call that refused with gas to spare leaves more. So a gas left at or below `gasBefore / 64 + reserve` reverts
    /// with `ReleaseOutOfGas`: the callee used up what it got, and more gas may change the outcome.
    function _revertIfOutOfGas(address token, uint256 gasBefore, uint256 reserve) private view {
        if (gasleft() <= gasBefore / 64 + reserve) revert ReleaseOutOfGas(token);
    }

    /// @dev Calls `onTokenBridged` on the account that received the tokens, as OmniBridge does: only a contract is
    /// called. The call gets exactly the gas of the message (`ExactGasCall`): not enough gas reverts the delivery, and a
    /// callback that fails with its gas emits `CallbackFailed` and changes nothing else.
    function _callback(address receiver, address token, Delivery memory delivery, bytes32 messageId) private {
        if (receiver.code.length == 0) return;
        bytes memory callData =
            abi.encodeWithSelector(IERC20Receiver.onTokenBridged.selector, token, delivery.value, delivery.data);
        if (!ExactGasCall.callWithExactGas(receiver, delivery.callbackGas, CALLBACK_GAS_RESERVE, callData, 0)) {
            emit CallbackFailed(token, receiver, messageId);
        }
    }
}
