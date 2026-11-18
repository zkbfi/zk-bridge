// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MessageBridge} from "../MessageBridge.sol";
import {ITokenMediator} from "./ITokenMediator.sol";
import {IWETH} from "./IWETH.sol";
import {ExactGasCall} from "./ExactGasCall.sol";

/// @title DeliveryRouter
/// @notice The one router of the bridge, on both chains. On the source chain it wraps the native coin and sends it
/// (`wrapAndRelayTokens`, `relayTokensAndCall`). On the destination chain it delivers a bridged message, pays a tip for
/// it, and unwraps the wrapped native token. It needs no change to the message bridge or the mediator. The sender states the delivery terms in a `FeeDirector`.
/// Layers. The message bridge is neutral and anyone can use it. The mediator is shared by everyone, so it is immutable
/// and trusts no router. This router is the third layer: a frontend chooses which router it points at, and a new
/// router can replace this one with no change to the bridge or the mediator. Neither of them names a router. The
/// mediator gives the callback of the router exactly the gas that the sender stated in the relay (`callbackGas`), and
/// everything in this contract (the fee, the follow-up call and its gas) runs inside that gas.
/// @dev Flow. 1: a sender relays tokens with `relayTokensAndCall` to this router on the destination chain, with an
/// encoded `FeeDirector` as data. 2: anyone calls `executeMessage`. The router stores the starting gas in one slot
/// (`DELIVERY_SLOT`), which marks a router delivery, and executes the message on the bridge. 3: the mediator releases
/// the tokens to the router and calls `onTokenBridged`. 4: the router reads the slot, computes the tip, pays the
/// immutable `rewardAddress`, and pays the rest to the recipient. When the slot is not set, because someone executed
/// the message on the bridge directly, the recipient gets everything and the router takes no tip. A data field of 20
/// bytes is the legacy form: the address that receives the unwrapped native coin, with no tip.
///
/// Source side. `wrapAndRelayTokens` and `relayTokensAndCall` follow `WETHOmnibridgeRouter` of OmniBridge
/// (`contracts/helpers/WETHOmnibridgeRouter.sol`) without its owner, its `claimTokens` and its destination role. They
/// wrap the coin and relay the wrapped token with `relayTokens` or `relayTokensAndCall` of the mediator. The mediator
/// pays the receiver only, and a release that the receiver cannot take is final. This router has no fallback option.
/// A relay with a call passes the gas of the callback on to the mediator. A receiver that is the zero address or this
/// router is refused. The router sends nothing that it holds: the wrap and the relay run in one call. There is no second
/// router for the unwrap: the `UNWRAP` flag and the 20 byte legacy data of `onTokenBridged` do it, so the bridge needs one contract on each chain. The router holds no standing approval: each
/// wrap approves the mediator for exactly the amount that it wraps, and the mediator takes all of it in the same call, so
/// the allowance ends at zero.
///
/// Design choices.
/// - There is no owner, no `claimTokens` and no validator filter. Any account may call `executeMessage`. The tip
///   always goes to the immutable `rewardAddress`, and the caller names nothing, so a copy of a delivery gains the
///   copier nothing: a block builder or a searcher who front-runs a delivery pays the gas and the reward address still
///   gets the tip. The bridge stays permissionless. Anyone may call `MessageBridge.executeMessage` directly. The
///   router then sees no starting gas, takes no tip, and the recipient gets everything, so the user loses nothing.
/// - The tip does not go to the account that calls, and the caller names no one to receive it. The tip goes to
///   `rewardAddress`, which has no setter and no owner.
/// - The reward address is an account that can refuse the tip, so its payment never blocks the payment of the
///   recipient: when it cannot receive its tip, the recipient gets the tip as well. A native coin that the recipient
///   cannot receive is paid as the wrapped token.
/// - The router never reads `tx.origin` or `msg.sender` of `executeMessage`, so a generic Multicall3 contract
///   (`aggregate3` with `allowFailure`) can batch many deliveries, and the block proof, in one transaction. The router
///   knows nothing about batching. A failed call never reverts the others.
/// - The gas based tip is measured in the callback, which reads `startingGas - gasleft()`, where
///   `startingGas` is stored at the entry of `executeMessage`, adds the fixed overhead that covers the rest of the
///   run and, when a call follows, the `callGas` of the terms, caps the tip at the smaller of `limit` and the value,
///   and pays one transfer to the reward address and one to the recipient. The measure is the gas that the delivery
///   used up to the callback: the proof, the bridge and the mediator. A deliverer can choose a costlier proof route
///   (a longer ancestry branch), so a sender must still expect the tip to reach `limit`: `limit` is the price ceiling,
///   and it is the only hard bound on a gas based tip. The tip goes to the fixed reward address, so a stranger gains
///   nothing from it.
/// - `EXCLUDE_PRIORITY` prices gas at `block.basefee`. On a chain that reports a base fee of 0 (BSC) the gas based tip
///   is then zero. The interfaces refuse `EXCLUDE_PRIORITY` for a chain that is configured as having no base fee.
/// - The slot uses regular storage (the compiler target has no transient storage), so it is set and cleared with the
///   value 1, which keeps the slot non-zero after the first use. It holds the starting gas and no address.
/// - There is no `EIP1559_ENABLED` switch. The router reads `block.basefee`.
/// - An unwrap flag on a token that is not the wrapped native token is ignored: the
///   recipient gets the token. The 20 byte legacy form pays the token to the receiver for any token that is not the
///   wrapped native token, and it never reverts for that reason.
/// - Every delivery that pays its recipient emits `Delivered`, with what the router received, the fee, what the
///   recipient received and how. An explorer reads the fee from it, so the router keeps no record of its own.
/// - The sender writes every word of the terms, so the fee is computed with no overflow for any words. A share with a
///   `multiplier` of 1e18 or more is the whole value, and a smaller share is exact for any value. A gas based product
///   that does not fit 256 bits counts as the largest number, so the fee is then the cap: `limit`, and never more than
///   the value. `limit` is the ceiling that the sender signed, so the cap charges nothing the sender did not accept.
///
/// Nothing is owed and nothing is recorded. The mediator calls `onTokenBridged` after it paid the router, and it keeps no
/// hold on a failed call: the tokens stay with the router. So a revert in the callback would strand them, and the router
/// never reverts there. Instead it hands off what it cannot deliver to the immutable `failedDeliveryAddress`, and emits
/// `DeliveryFailed`. The tip still goes to the reward address first, whenever the delivery path takes a tip.
/// - The token refuses the payout to a valid recipient (a blocklist, a revert), the coin and the wrapped token are both
///   refused: the router hands off the amount that it could not deliver.
/// - The terms decode but name the zero address or the router itself as the recipient. The router takes the tip by the
///   terms, as for any delivery, and hands off the rest.
/// - The data has no known shape: shorter than a director, or a recipient word with bits above 160, which `abi.decode`
///   would refuse. No tip can be computed, so the router hands off the whole value.
/// - The terms ask for a call with a `callGas` above `MAX_CALL_GAS`, which no callback can carry. The gas based tip
///   would count that `callGas`, so the router takes no tip, makes no payout and no call, and hands off the whole value
///   as the token (no unwrap), with the reason `InvalidTerms`.
/// - The data is a 20 byte legacy receiver, and the token is not the wrapped native token. The router pays the token to
///   that receiver, with no fee, and hands off the value when the token refuses the receiver.
/// A hand-off that `failedDeliveryAddress` cannot take (a token that blocks it) stays in the router for good, and the
/// router emits `HandOffRefused`. The router keeps no record of it, and it has no `claim`. A plain relay is the one thing
/// that the router cannot see: the mediator pays the router with no callback when a sender names the router as the
/// receiver with `relayTokens`, or when a callback fails. Anyone may call `sweep` to hand the whole balance of a token to
/// `failedDeliveryAddress`.
/// A recipient payout hook can make the bridge deliver another message while a delivery runs, so the mediator calls
/// `onTokenBridged` again. The router detects that with the state of its reentrancy guard and does not revert. It hands
/// the whole value of that nested callback off with the reason `Reentered`, after the tip when the terms decode and a
/// router delivery runs, as the token and with no unwrap. `sweep` keeps the guard and refuses a reentrant call.
///
/// The call after a delivery. The data of `onTokenBridged` is the 160 byte director. Optional bytes may follow it: a 20
/// byte target and then the call data, which fill the rest of the data. A director with no extra bytes, and a director
/// with fewer than 20 extra bytes, mean delivery only. When the router paid the recipient in full (the token, or the
/// native coin, or the wrapped token that replaced a refused coin), it makes one call to the target from itself, with the
/// call data and no native value. The target may differ from the recipient. The call gets exactly `callGas` of the
/// director (`ExactGasCall`), at most `MAX_CALL_GAS`: a larger `callGas` is handed off before any payout (above).
/// When the gas left cannot give it `callGas` under the 63/64 rule plus `CALL_GAS_RESERVE`, which the router keeps to
/// finish, the callback reverts: the mediator gave the callback the gas that the sender
/// stated, so this means the sender's `callbackGas` is too small for its own `callGas`, and the mediator records
/// `CallbackFailed` with the tokens left in the router (anyone may `sweep` them). A call that fails with its `callGas`
/// never reverts the delivery and moves no tokens: the router emits `CallFailed`, and the recipient keeps the tokens.
/// The router skips the call when the tip left nothing to pay the recipient, and when a payment failed and the amount
/// was handed off. The router reads no data that the target returns. The call comes from the router, so it can reach
/// only what the router holds at that moment. After the payments that is stray tokens, which anyone may already sweep.
/// The router holds no allowance for the target to use.
///
/// The gas based tip counts the call. The router takes the tip before the payments and the call, so a measure of the gas
/// that ran so far cannot cover the call. When a call is requested, the router adds `callGas`, the gas that the sender
/// gave the call.
contract DeliveryRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice What the sender of the tokens asks for. The data is five words: the recipient, the settings
    /// flag bits, the limit, the multiplier and the gas of the follow-up call.
    /// @param recipient Who receives the tokens after the tip.
    /// @param settings Flag bits. Bit 0 (`FIXED_FEE`): the tip is `limit`. Bit 1 (`UNWRAP`): unwrap the wrapped native
    /// token to the native coin. Bit 2 (`EXCLUDE_PRIORITY`): price gas at the base fee only, with no priority fee. Bit 3
    /// (`MULTIPLIER_OF_TOTAL`): the tip is `value * multiplier / 1e18`. With bit 0 and bit 3 clear, the tip is the gas
    /// based fee. Bit 0 wins over bit 3.
    /// @param limit The fixed tip, or the price ceiling of the gas based tip. A gas based tip is computed from the gas
    /// that the transaction of the deliverer makes available, which the deliverer chooses, so expect it to reach `limit`.
    /// @param multiplier Scaled by 1e18: the share of the value, or the factor on the gas cost.
    /// @param callGas The gas that the follow-up call gets, exactly, at most `MAX_CALL_GAS`. It is read only when a
    /// call follows the director.
    struct FeeDirector {
        address recipient;
        uint256 settings;
        uint256 limit;
        uint256 multiplier;
        uint256 callGas;
    }

    /// @dev Whether the data asks for a call after the delivery.
    enum CallRequest {
        None,
        Requested
    }

    /// @dev How a payout travels: as the token, or as the native coin after an unwrap.
    enum Payout {
        Token,
        Native
    }

    /// @notice How the recipient received a payout. `None` is never emitted: it means that the payout failed and the
    /// router handed the amount off. `Wrapped`: the unwrap was asked for, the recipient refused the native coin, and
    /// it received the wrapped token instead.
    enum PaidAs {
        None,
        Token,
        Native,
        Wrapped
    }

    /// @dev Which price a gas based fee uses.
    enum GasPrice {
        Transaction,
        BaseFee
    }

    /// @notice The value of `settings` bit 0: the tip is `limit`.
    uint256 public constant FIXED_FEE = 1;
    /// @notice The value of `settings` bit 1: unwrap to the native coin. It applies to the wrapped native token only.
    uint256 public constant UNWRAP = 2;
    /// @notice The value of `settings` bit 2: price gas at the base fee only, with no priority fee.
    uint256 public constant EXCLUDE_PRIORITY = 4;
    /// @notice The value of `settings` bit 3: the tip is `value * multiplier / 1e18`.
    uint256 public constant MULTIPLIER_OF_TOTAL = 8;
    /// @notice Gas added to the measured gas of a token payout, for the transfers after the measure and a margin.
    uint256 public constant TOKEN_GAS_OVERHEAD = 100_000;
    /// @notice Gas added to the measured gas of a native coin payout. It covers two coin sends to new accounts and the
    /// `Delivered` event (about 101,000 gas measured as an upper bound).
    uint256 public constant NATIVE_GAS_OVERHEAD = 105_000;

    /// @notice The gas that the router gives an account that receives the native coin: the recipient or the reward address. It
    /// is enough for the `receive` function of a smart-contract wallet, and it is a bound: a receiver cannot burn more,
    /// so the fallback (wrap again and send the wrapped token) always has gas.
    uint256 public constant NATIVE_SEND_GAS = 50_000;

    /// @notice The gas that the router keeps for itself after the call that follows a delivery: the event of a failed
    /// call and the exit of the callback. The call needs this much gas left on top of `callGas` and its 63/64 share.
    uint256 public constant CALL_GAS_RESERVE = 10_000;

    /// @notice The largest `callGas` that the terms of a call may name. A larger one is terms that cannot be honoured:
    /// the router hands off the whole value with the reason `InvalidTerms`. The figure is the one of the frontends
    /// (`MAX_CALL_GAS` of the explorer core). With the router's own work (300,000), its 63/64 share and
    /// `CALL_GAS_RESERVE`, it makes `TokenMediator.MAX_CALLBACK_GAS` (10,468,731), the largest callback gas that a
    /// relay may state, so a larger call could never run inside a callback.
    uint256 public constant MAX_CALL_GAS = 10_000_000;

    /// @notice The slot that holds the starting gas (low 96 bits) while a message runs through `executeMessage`. It
    /// holds 1 at all other times, which means that no router delivery runs.
    bytes32 public constant DELIVERY_SLOT = keccak256(abi.encode("deliveryrouter.delivery"));

    uint256 private constant NOT_RUNNING = 1;
    /// @dev The length of an encoded `FeeDirector`: five words.
    uint256 private constant DIRECTOR_LENGTH = 160;
    /// @dev The length of the target of the call: one address.
    uint256 private constant TARGET_LENGTH = 20;
    /// @dev Where the call data starts in the data: after the director and the target.
    uint256 private constant CALL_DATA_OFFSET = DIRECTOR_LENGTH + TARGET_LENGTH;

    /// @notice The receiver of a relay is the zero address or this router.
    error InvalidReceiver(address receiver);
    /// @notice A relay with a call needs data, because the mediator calls only when there is data.
    error EmptyData();
    /// @notice The router holds none of the token.
    error NothingToSweep(address token);
    /// @notice The reward address of the constructor is the zero address.
    error ZeroRewardAddress();
    /// @notice The caller of `onTokenBridged` is not the mediator.
    error NotMediator(address caller);
    /// @notice A message is running already through this router.
    error DeliveryInProgress();
    /// @notice The coin came from an account that is not the wrapped token.
    error NotWrappedTokenSender(address sender);
    /// @notice The failed delivery address of the constructor is the zero address.
    error ZeroFailedDeliveryAddress();

    /// @dev Why the router handed off an amount.
    enum Reason {
        PayoutRefused,
        InvalidTerms,
        Reentered
    }

    /// @notice Emitted on every hand-off to `failedDeliveryAddress`. `recipient` is the account that the terms named,
    /// or the zero address when the data has no known shape.
    event DeliveryFailed(address indexed token, address indexed recipient, uint256 amount, Reason reason);
    /// @notice Emitted when `sweep` hands the balance of a token off to `failedDeliveryAddress`.
    event Swept(address indexed token, uint256 amount);
    /// @notice Emitted when the token refuses a push to `failedDeliveryAddress`, for a hand-off or for `sweep`. The
    /// amount stays in the router, with no record.
    event HandOffRefused(address indexed token, uint256 amount);
    /// @notice Emitted when the call after a delivery fails with the gas that the sender gave it. `gasGiven` is that
    /// gas, the `callGas` of the director.
    event CallFailed(address indexed target, address indexed recipient, uint256 gasGiven);
    /// @notice Emitted on every successful delivery: the recipient received its payout. It is emitted after the
    /// payments and before the call that follows, so a failed call adds `CallFailed` after it.
    /// @param token The token that the mediator released to the router (the wrapped native token for an unwrap).
    /// @param recipient The recipient that the terms (or the 20 byte legacy data) named.
    /// @param feeTo The account that received the fee: `rewardAddress`, or the zero address when no fee was paid.
    /// @param amount What the router received for this delivery: `fee + paidOut`.
    /// @param fee What `feeTo` received. Zero when the message ran on the bridge directly, when the terms ask for no
    /// fee, for the legacy data, and when the reward address refused the fee (it then stays with the recipient).
    /// @param paidOut What the recipient received.
    /// @param paidAs As the token, the native coin, or the wrapped token after a refused coin.
    /// @param callTarget The target of the call that follows, or the zero address when no call follows.
    event Delivered(
        address indexed token,
        address indexed recipient,
        address indexed feeTo,
        uint256 amount,
        uint256 fee,
        uint256 paidOut,
        PaidAs paidAs,
        address callTarget
    );

    /// @notice The mediator on this chain.
    ITokenMediator public immutable bridge;
    /// @notice The wrapped native token that `UNWRAP` unwraps.
    IWETH public immutable wNative;
    /// @notice The only address that receives a tip. It has no setter and no owner.
    address public immutable rewardAddress;
    /// @notice Where the router hands off what it cannot deliver. It may equal `rewardAddress`. It has no setter and no
    /// owner.
    address public immutable failedDeliveryAddress;

    /// @param bridge_ The mediator on this chain.
    /// @param wNative_ The wrapped native token of this chain.
    /// @param rewardAddress_ The address that receives the tips. It cannot be the zero address.
    /// @param failedDeliveryAddress_ The address that receives what the router cannot deliver. It cannot be the zero
    /// address. It may equal `rewardAddress_`.
    constructor(ITokenMediator bridge_, IWETH wNative_, address rewardAddress_, address failedDeliveryAddress_) {
        if (rewardAddress_ == address(0)) revert ZeroRewardAddress();
        if (failedDeliveryAddress_ == address(0)) revert ZeroFailedDeliveryAddress();
        bridge = bridge_;
        wNative = wNative_;
        rewardAddress = rewardAddress_;
        failedDeliveryAddress = failedDeliveryAddress_;
    }

    /// @notice Wraps the coin and relays it to the caller on the other chain.
    function wrapAndRelayTokens() external payable {
        _wrapAndRelay(msg.sender, "", 0);
    }

    /// @notice Wraps the coin and relays it to `receiver` on the other chain.
    function wrapAndRelayTokens(address receiver) external payable {
        _wrapAndRelay(receiver, "", 0);
    }

    /// @notice Wraps the coin, relays it to `receiver` and calls `onTokenBridged` on it with `data` and exactly
    /// `callbackGas`. Name a `DeliveryRouter` on the other chain as the receiver, with its terms as data, to pay a tip or
    /// to get the native coin back there.
    /// @param callbackGas The gas of the callback on the other chain. The mediator refuses zero.
    function relayTokensAndCall(address receiver, bytes calldata data, uint256 callbackGas) external payable {
        if (data.length == 0) revert EmptyData();
        _wrapAndRelay(receiver, data, callbackGas);
    }

    /// @notice Executes a message on the message bridge, and takes the tip of any tokens that it delivers to this
    /// router, for `rewardAddress`. Anyone may call it. It reverts when the delivery fails, so the caller sees the
    /// error.
    /// @param proof The evidence that `MessageBridge.executeMessage` verifies. The router forwards it and does not read it.
    function executeMessage(MessageBridge.MessageProof calldata proof) external {
        if (_startingGas() > NOT_RUNNING) revert DeliveryInProgress();

        _storeStartingGas(uint256(uint96(gasleft())));
        MessageBridge(address(bridge.bridgeContract())).executeMessage(proof);
        _storeStartingGas(NOT_RUNNING);
    }

    /// @notice The callback of the mediator. It splits the tokens between the reward address and the recipient, and
    /// hands off to `failedDeliveryAddress` what it cannot deliver. It takes a tip only while `executeMessage` runs.
    /// @param token The token that the mediator released to the router.
    /// @param value The amount that the mediator reports.
    /// @param data An encoded `FeeDirector`, or the 20 byte address of a native coin receiver.
    /// @dev A call that arrives while another callback runs (a recipient payout hook made the bridge deliver another
    /// message) does not revert: the router hands the value off with the reason `Reentered`.
    function onTokenBridged(address token, uint256 value, bytes memory data) external {
        if (msg.sender != address(bridge)) revert NotMediator(msg.sender);
        if (_reentrancyGuardEntered()) {
            _handOffReentered(token, _deliverableAmount(token, value), data);
            return;
        }
        _deliver(token, _deliverableAmount(token, value), data);
    }

    /// @notice Hands the whole balance of a token off to `failedDeliveryAddress`. Anyone may call it. It recovers
    /// tokens that reached the router with no callback: a plain relay to the router, a plain transfer, or a callback that
    /// failed. It reverts when the router holds none. When the token refuses the push, the router emits `HandOffRefused`
    /// and the tokens stay where they are.
    /// @param token The token.
    function sweep(address token) external nonReentrant {
        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) revert NothingToSweep(token);
        if (!_push(token, amount)) return;
        emit Swept(token, amount);
    }

    /// @notice The fee and the amount for the recipient that the router computes.
    /// @param token The token that the mediator released.
    /// @param value The released amount.
    /// @param gasUsed The gas that the whole execution used, for a gas based fee, with the `callGas` of the director
    /// added when a call follows. It is not read for a fixed or percent fee.
    /// @param director The fee terms.
    /// @return fee The fee for the reward address.
    /// @return toRecipient The amount for the recipient.
    function feeInfo(address token, uint256 value, uint256 gasUsed, FeeDirector calldata director)
        external
        view
        returns (uint256 fee, uint256 toRecipient)
    {
        bool toNative = director.settings & UNWRAP != 0 && token == address(wNative);
        fee = _fee(value, gasUsed, director, toNative ? NATIVE_GAS_OVERHEAD : TOKEN_GAS_OVERHEAD);
        toRecipient = value - fee;
    }

    /// @notice The gas price that a gas based tip uses: the base fee when `excludePriority` is set, else the gas price of
    /// the transaction.
    /// @param excludePriority True for the base fee only.
    function baseFee(bool excludePriority) external view returns (uint256) {
        return _gasPrice(excludePriority ? GasPrice.BaseFee : GasPrice.Transaction);
    }

    /// @notice Accepts the native coin from the wrapped token only, when it unwraps.
    receive() external payable {
        if (msg.sender != address(wNative)) revert NotWrappedTokenSender(msg.sender);
    }

    /// @dev Wraps the coin and relays the wrapped token. The approval is for the amount of this call only, and the mediator
    /// takes all of it. Empty data means a plain relay, with no gas number.
    function _wrapAndRelay(address receiver, bytes memory data, uint256 callbackGas) private {
        if (receiver == address(0) || receiver == address(this)) revert InvalidReceiver(receiver);
        wNative.deposit{value: msg.value}();
        wNative.approve(address(bridge), msg.value);
        if (data.length == 0) return bridge.relayTokens(address(wNative), receiver, msg.value);
        bridge.relayTokensAndCall(address(wNative), receiver, msg.value, data, callbackGas);
    }

    /// @dev The delivery of one callback. The guard is held while it runs, so a payout hook or the call after the
    /// delivery that makes the mediator call back takes the hand-off path of `onTokenBridged`.
    function _deliver(address token, uint256 value, bytes memory data) private nonReentrant {
        if (data.length == 20) {
            _payLegacy(token, address(bytes20(data)), value);
            return;
        }
        if (!_hasKnownShape(data)) {
            _handOff(token, address(0), value, Reason.InvalidTerms);
            return;
        }
        FeeDirector memory director = abi.decode(data, (FeeDirector));
        CallRequest request = data.length >= CALL_DATA_OFFSET ? CallRequest.Requested : CallRequest.None;
        if (request == CallRequest.Requested && director.callGas > MAX_CALL_GAS) {
            _handOff(token, director.recipient, value, Reason.InvalidTerms);
            return;
        }
        Payout payout = director.settings & UNWRAP != 0 && token == address(wNative) ? Payout.Native : Payout.Token;
        if (payout == Payout.Native) wNative.withdraw(value);

        uint256 startingGas = _startingGas();
        uint256 toRecipient =
            startingGas > NOT_RUNNING ? _takeFee(token, payout, value, director, startingGas, request) : value;
        if (toRecipient == 0) {
            _emitDelivered(token, director.recipient, value, 0, payout == Payout.Native ? PaidAs.Native : PaidAs.Token, address(0));
            return;
        }
        PaidAs paidAs = _payRecipient(token, payout, director.recipient, toRecipient);
        if (paidAs == PaidAs.None) return;
        address target = request == CallRequest.Requested ? _target(data) : address(0);
        _emitDelivered(token, director.recipient, value, toRecipient, paidAs, target);
        if (request == CallRequest.Requested) _callTarget(target, director.recipient, data, director.callGas);
    }

    /// @dev Emits `Delivered`. The fee is what the recipient did not get: the router pays the reward address first, and
    /// a refused fee stays with the recipient.
    function _emitDelivered(
        address token,
        address recipient,
        uint256 value,
        uint256 paidOut,
        PaidAs paidAs,
        address target
    ) private {
        uint256 fee = value - paidOut;
        emit Delivered(token, recipient, fee == 0 ? address(0) : rewardAddress, value, fee, paidOut, paidAs, target);
    }

    /// @dev The hand-off of a callback that arrives while another callback runs. The router pays nobody then: it takes
    /// the tip when the terms decode and a router delivery runs, and hands the rest off, as the token and with no unwrap.
    function _handOffReentered(address token, uint256 value, bytes memory data) private {
        if (data.length == 20) {
            _handOff(token, address(bytes20(data)), value, Reason.Reentered);
            return;
        }
        if (!_hasKnownShape(data)) {
            _handOff(token, address(0), value, Reason.Reentered);
            return;
        }
        FeeDirector memory director = abi.decode(data, (FeeDirector));
        uint256 startingGas = _startingGas();
        uint256 rest = startingGas > NOT_RUNNING
            ? _takeFee(token, Payout.Token, value, director, startingGas, CallRequest.None)
            : value;
        _handOff(token, director.recipient, rest, Reason.Reentered);
    }

    /// @dev Takes the tip in the callback and pays it to the reward address. A tip that the reward address refuses
    /// stays with the recipient. The measure is the gas that ran since the entry of `executeMessage`. When a call is
    /// requested, the measure adds `callGas`, because the call runs after the tip.
    /// @return toRecipient What the recipient receives.
    function _takeFee(
        address token,
        Payout payout,
        uint256 value,
        FeeDirector memory director,
        uint256 startingGas,
        CallRequest request
    ) private returns (uint256 toRecipient) {
        uint256 overheadGas = payout == Payout.Native ? NATIVE_GAS_OVERHEAD : TOKEN_GAS_OVERHEAD;
        uint256 gasUsed = startingGas - gasleft();
        if (request == CallRequest.Requested) gasUsed += director.callGas;
        uint256 fee = _fee(value, gasUsed, director, overheadGas);
        if (fee == 0 || !_tryPay(token, payout, rewardAddress, fee)) return value;
        return value - fee;
    }

    /// @dev Makes the call after a delivery: from the router, with no native value, to the target at the start of the
    /// bytes after the director, with the call data that follows. It reads no answer, so a target cannot spend gas on a
    /// large one. It gets exactly `callGas` (`ExactGasCall`, with `CALL_GAS_RESERVE` kept for the work after it): too
    /// little gas reverts, and a failure with `callGas` emits `CallFailed` and changes nothing else.
    function _callTarget(address target, address recipient, bytes memory data, uint256 callGas) private {
        if (!ExactGasCall.callWithExactGas(target, callGas, CALL_GAS_RESERVE, data, CALL_DATA_OFFSET)) {
            emit CallFailed(target, recipient, callGas);
        }
    }

    /// @dev The target of the call: the 20 bytes after the director.
    function _target(bytes memory data) private pure returns (address target) {
        uint256 targetOffset = 32 + DIRECTOR_LENGTH;
        assembly ("memory-safe") {
            target := shr(96, mload(add(data, targetOffset)))
        }
    }

    function _startingGas() private view returns (uint256 stored) {
        bytes32 slot = DELIVERY_SLOT;
        assembly {
            stored := sload(slot)
        }
    }

    function _storeStartingGas(uint256 value) private {
        bytes32 slot = DELIVERY_SLOT;
        assembly {
            sstore(slot, value)
        }
    }

    /// @dev True when `abi.decode` reads the data as a `FeeDirector` without a revert: five words, and a recipient word
    /// with no bits above 160.
    function _hasKnownShape(bytes memory data) private pure returns (bool) {
        return data.length >= DIRECTOR_LENGTH && !_hasDirtyRecipientWord(data);
    }

    /// @dev True when the first word of the data has bits above 160. `abi.decode` reverts on such a word, and the callback
    /// must never revert, so the router treats the data as having no known shape.
    function _hasDirtyRecipientWord(bytes memory data) private pure returns (bool) {
        uint256 firstWord;
        assembly {
            firstWord := mload(add(data, 32))
        }
        return firstWord >> 160 != 0;
    }

    /// @dev The fee, never above the value, with no overflow for any terms. Fixed: `limit`. Share:
    /// `value * multiplier / 1e18`, the whole value from a multiplier of 1e18. Otherwise gas based: the gas used, plus
    /// the overhead, times the multiplier and the gas price, with `limit` as the cap; a product that does not fit 256
    /// bits gives the cap.
    function _fee(uint256 value, uint256 gasUsed, FeeDirector memory director, uint256 overheadGas)
        private
        view
        returns (uint256 fee)
    {
        if (director.settings & FIXED_FEE != 0) {
            fee = director.limit;
        } else if (director.settings & MULTIPLIER_OF_TOTAL != 0) {
            fee = director.multiplier >= 1 ether ? value : _share(value, director.multiplier);
        } else {
            GasPrice price = director.settings & EXCLUDE_PRIORITY != 0 ? GasPrice.BaseFee : GasPrice.Transaction;
            uint256 gasUnits = Math.saturatingAdd(gasUsed, overheadGas);
            uint256 product = Math.saturatingMul(Math.saturatingMul(gasUnits, director.multiplier), _gasPrice(price));
            fee = product == type(uint256).max ? product : product / 1 ether;
            if (fee > director.limit) fee = director.limit;
        }
        if (fee > value) fee = value;
    }

    /// @dev `value * multiplier / 1e18`, rounded down, for a multiplier below 1e18, with no product that can overflow:
    /// the whole units of 1e18 in the value times the multiplier, plus the share of the rest. Both terms fit 256 bits,
    /// and their sum is below the value.
    function _share(uint256 value, uint256 multiplier) private pure returns (uint256) {
        return value / 1 ether * multiplier + value % 1 ether * multiplier / 1 ether;
    }

    function _gasPrice(GasPrice price) private view returns (uint256) {
        return price == GasPrice.BaseFee ? block.basefee : tx.gasprice;
    }

    /// @dev Pays without reverting. Tokens and coins both report whether the payee took them.
    function _tryPay(address token, Payout payout, address to, uint256 amount) private returns (bool) {
        if (payout == Payout.Token) return IERC20(token).trySafeTransfer(to, amount);
        (bool sent,) = to.call{value: amount, gas: NATIVE_SEND_GAS}("");
        return sent;
    }

    /// @dev Pays the recipient as the payout says.
    /// @return How the recipient received the amount, or `None` when the router handed it off.
    function _payRecipient(address token, Payout payout, address recipient, uint256 amount) private returns (PaidAs) {
        if (payout == Payout.Native) return _payNative(recipient, amount);
        return _payToken(token, recipient, amount) ? PaidAs.Token : PaidAs.None;
    }

    /// @dev Sends the unwrapped coin. A receiver that refuses it gets the wrapped token. A receiver that refuses both,
    /// and an invalid recipient, cause a hand-off of the wrapped token.
    /// @return How the recipient received the amount (the coin or the wrapped token), or `None` after a hand-off.
    function _payNative(address recipient, uint256 amount) private returns (PaidAs) {
        if (!_canReceive(recipient)) {
            wNative.deposit{value: amount}();
            _handOff(address(wNative), recipient, amount, Reason.InvalidTerms);
            return PaidAs.None;
        }
        PaidAs paidAs = _trySendNative(recipient, amount);
        if (paidAs == PaidAs.None) _handOff(address(wNative), recipient, amount, Reason.PayoutRefused);
        return paidAs;
    }

    /// @dev Sends the coin, and on a refusal wraps it again and sends the wrapped token. When it returns `None` the
    /// router holds the amount as the wrapped token.
    function _trySendNative(address to, uint256 amount) private returns (PaidAs) {
        (bool sent,) = to.call{value: amount, gas: NATIVE_SEND_GAS}("");
        if (sent) return PaidAs.Native;
        wNative.deposit{value: amount}();
        return IERC20(address(wNative)).trySafeTransfer(to, amount) ? PaidAs.Wrapped : PaidAs.None;
    }

    /// @dev Pays a token. An invalid recipient, or a token that refuses the recipient, causes a hand-off.
    /// @return Whether the recipient received the amount.
    function _payToken(address token, address recipient, uint256 amount) private returns (bool) {
        if (!_canReceive(recipient)) {
            _handOff(token, recipient, amount, Reason.InvalidTerms);
            return false;
        }
        if (IERC20(token).trySafeTransfer(recipient, amount)) return true;
        _handOff(token, recipient, amount, Reason.PayoutRefused);
        return false;
    }

    /// @dev The legacy form: the receiver gets the coin for the wrapped native token, and the token itself for any
    /// other token, with no fee in both cases.
    function _payLegacy(address token, address receiver, uint256 value) private {
        PaidAs paidAs;
        if (token != address(wNative)) {
            paidAs = _payToken(token, receiver, value) ? PaidAs.Token : PaidAs.None;
        } else {
            wNative.withdraw(value);
            paidAs = _payNative(receiver, value);
        }
        if (paidAs != PaidAs.None) _emitDelivered(token, receiver, value, value, paidAs, address(0));
    }

    /// @dev An account that can own a payout: not the zero address and not the router, which has no way to pay itself.
    function _canReceive(address account) private view returns (bool) {
        return account != address(0) && account != address(this);
    }

    /// @dev The amount that this delivery may use: the balance of the router, up to `value`. A token that takes a cut on
    /// transfer delivers less than the mediator reports.
    function _deliverableAmount(address token, uint256 value) private view returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        return balance < value ? balance : value;
    }

    /// @dev Hands an amount that the router could not deliver off to `failedDeliveryAddress`.
    function _handOff(address token, address recipient, uint256 amount, Reason reason) private {
        if (amount == 0) return;
        emit DeliveryFailed(token, recipient, amount, reason);
        _push(token, amount);
    }

    /// @dev Pushes an amount to `failedDeliveryAddress`. When the token refuses the push, the amount stays in the router
    /// and the router emits `HandOffRefused`.
    /// @return Whether `failedDeliveryAddress` received the amount.
    function _push(address token, uint256 amount) private returns (bool) {
        if (IERC20(token).trySafeTransfer(failedDeliveryAddress, amount)) return true;
        emit HandOffRefused(token, amount);
        return false;
    }
}
