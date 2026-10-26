// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MessageBridge} from "../MessageBridge.sol";
import {ITokenMediator} from "./ITokenMediator.sol";
import {IWETH} from "./IWETH.sol";

/// @title DeliveryRouter
/// @notice An optional helper that lets one fixed executor earn a fee for the execution of a message, with no change to
/// the message bridge or the mediator. It is the router pattern of `gibsfinance/omnibridge`
/// (`contracts/helpers/TokenOmnibridgeBase.sol`), and it reads the same `FeeDirector`.
/// @dev Flow. 1: a sender relays tokens with `relayTokensAndCall` to this router on the destination chain, with an
/// encoded `FeeDirector` as data. 2: the runner calls `executeMessageWithRunner` and names the reward
/// address. The router stores the reward address and the
/// starting gas in one slot (`RUNNER_SLOT`) and executes the message on the bridge. 3: the mediator releases the tokens
/// to the router and calls `onTokenBridged`. 4: the router reads the slot, computes the fee, pays the reward address,
/// and pays the rest to the recipient. When no reward address is stored, because someone executed the message on the
/// bridge directly, the recipient gets everything and the router takes no fee. A data field of 20 bytes is the legacy
/// form: the address that receives the unwrapped native coin, with no fee.
///
/// Divergences from `gibsfinance/omnibridge`.
/// - There is no owner, no `claimTokens` and no validator filter. One account, the immutable `runner`, may call
///   `executeMessageWithRunner`. This stops front-running by block builders and searchers: without it, any account
///   could copy the call of the runner and take the fee. The bridge stays permissionless. Anyone may call
///   `MessageBridge.executeMessage` directly. The router then sees no reward address, takes no fee, and the recipient
///   gets everything, so the user loses nothing.
/// - The tip does not go to the runner. The runner is the hot account that signs the transactions. It names a reward
///   address with each call, and the call reverts unless that address equals the immutable `rewardAddress`. So a
///   stolen runner key can run deliveries but cannot redirect the tips.
/// - The reward address is an account that can refuse the fee, so its payment never blocks the payment of the
///   recipient: when it cannot receive its fee, the recipient gets the fee as well. A native coin that the recipient
///   cannot receive is paid as the wrapped token.
/// - The runner check reads `tx.origin`, so the runner can batch many deliveries, and the block proof, in one
///   transaction through a generic Multicall3 contract (`aggregate3` with `allowFailure`). The router knows nothing about
///   batching. A failed call never reverts the others.
/// - The gas based fee is settled after the bridge call returns. In `gibsfinance/omnibridge` the callback measures
///   `startGas - gasleft()` itself. That works there because the bridge forwards all its gas. This bridge forwards
///   exactly the gas limit of the message, so the callback runs in a frame that started with less gas than the
///   router, and the difference would include the gas that the executor supplied and the bridge held back. An executor
///   could then raise its own fee to the cap at no cost. So for a gas based fee the router pays the recipient the value
///   less the cap, keeps the cap (`Settlement`), and `executeMessageWithRunner` computes the fee from the gas used by
///   the whole call, pays the reward address, and sends the rest of the cap to the recipient. Fixed and share fees need no gas
///   and are paid in the callback.
/// - The slot uses regular storage (the compiler target has no transient storage), so it is set and cleared with the
///   value 1, which keeps the slot non-zero after the first use.
/// - There is no `EIP1559_ENABLED` switch. The router reads `block.basefee`.
///
/// Nothing stays in the router. The mediator calls `onTokenBridged` after it paid the router, and it keeps no hold on a
/// failed call: the tokens stay with the router. So a revert in the callback would strand them, and the router never
/// reverts there. Instead it hands off what it cannot deliver to the immutable `failedDeliveryAddress`, and emits
/// `DeliveryFailed`. The tip still goes to the reward address first, whenever the delivery path takes a tip.
/// - The token refuses the payout to a valid recipient (a blocklist, a revert), the coin and the wrapped token are both
///   refused, or the refund of a gas based fee fails: the router hands off the amount that it could not deliver.
/// - The terms decode but name the zero address or the router itself as the recipient. The router takes the tip by the
///   terms, as for any delivery, and hands off the rest.
/// - The data has no known shape. No tip can be computed, so the router hands off the whole value.
/// - The data is a 20 byte legacy receiver, and the token is not the wrapped native token. The router pays the token to
///   that receiver, with no fee, and hands off the value when the token refuses the receiver.
/// The router never burns. When the push to `failedDeliveryAddress` fails too (a token that blocks it), the router keeps
/// a record in `claimable` for that address, and anyone may call `claim` to pay it. `totalClaimable(token)` is the sum
/// of the records of a token, and the router never pays a delivery from that part of its balance. So the balance of the
/// router in each token equals its records, and it holds no coin at rest.
contract DeliveryRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice What the sender of the tokens asks for.
    /// @param recipient Who receives the tokens after the fee.
    /// @param settings Flag bits. Bit 0: the fee is `limit`. Bit 1: unwrap to the native coin. Bit 2: price gas at the
    /// base fee only, with no priority fee. Bit 3: the fee is `value * multiplier / 1e18`. With bit 0 and bit 3 clear,
    /// the fee is the gas based fee.
    /// @param limit The fixed fee, or the cap on the gas based fee.
    /// @param multiplier Scaled by 1e18: the share of the value, or the factor on the gas price.
    struct FeeDirector {
        address recipient;
        uint256 settings;
        uint256 limit;
        uint256 multiplier;
    }

    /// @dev How a payout travels: as the token, or as the native coin after an unwrap.
    enum Payout {
        Token,
        Native
    }

    /// @dev Which price a gas based fee uses.
    enum GasPrice {
        Transaction,
        BaseFee
    }

    /// @dev A gas based fee that waits for the end of the call. `held` is the cap, which is the most that the fee can
    /// be. Zero means nothing waits.
    struct Settlement {
        address token;
        Payout payout;
        GasPrice gasPrice;
        address recipient;
        uint96 multiplier;
        uint256 held;
    }

    /// @notice The value of `settings` bit 0: the fee is `limit`.
    uint256 public constant FIXED_FEE = 1;
    /// @notice The value of `settings` bit 1: unwrap to the native coin.
    uint256 public constant UNWRAP = 2;
    /// @notice The value of `settings` bit 2: price gas at the base fee only.
    uint256 public constant BASE_FEE_ONLY = 4;
    /// @notice The value of `settings` bit 3: the fee is a share of the value.
    uint256 public constant SHARE_OF_VALUE = 8;
    /// @notice Gas added to the measured gas of a token payout, for the transfers after the measure and a margin.
    uint256 public constant TOKEN_GAS_OVERHEAD = 100_000;
    /// @notice Gas added to the measured gas of a native coin payout.
    uint256 public constant NATIVE_GAS_OVERHEAD = 50_000;

    /// @notice The gas that the router gives an account that receives the native coin: the recipient or the reward address. It
    /// is enough for the `receive` function of a smart-contract wallet, and it is a bound: a receiver cannot burn more,
    /// so the fallback (wrap again and send the wrapped token) always has gas.
    uint256 public constant NATIVE_SEND_GAS = 50_000;

    /// @notice The slot that holds the reward address (high 160 bits) and the starting gas (low 96 bits) while a
    /// message runs.
    bytes32 public constant RUNNER_SLOT = keccak256(abi.encode("omnibridgerouter.runner"));

    uint256 private constant NOT_RUNNING = 1;
    /// @dev The length of an encoded `FeeDirector`: four words.
    uint256 private constant DIRECTOR_LENGTH = 128;

    /// @notice The origin of the transaction is not the runner of this router.
    error NotRunner(address caller);
    /// @notice The reward address of a call is not the one that this router whitelists.
    error WrongRewardAddress(address reward);
    /// @notice The runner of the constructor is the zero address.
    error ZeroRunner();
    /// @notice The reward address of the constructor is the zero address.
    error ZeroRewardAddress();
    /// @notice The caller of `onTokenBridged` is not the mediator.
    error NotMediator(address caller);
    /// @notice A message is running already through this router.
    error RunnerSlotInUse();
    /// @notice Never raised. A stored run value holds the reward address in its upper 160 bits, and the constructor
    /// refuses a zero reward address, so the value is always above `NOT_RUNNING`. The declaration stays so that the
    /// interface of the contract does not change.
    error InvalidRunnerValue();
    /// @notice The coin came from an account that is not the wrapped token.
    error NotWrappedTokenSender(address sender);
    /// @notice The failed delivery address of the constructor is the zero address.
    error ZeroFailedDeliveryAddress();
    /// @notice The failed delivery address has nothing recorded in this token.
    error NothingToClaim(address token);

    /// @dev Why the router handed off an amount.
    enum Reason {
        PayoutRefused,
        InvalidTerms
    }

    /// @notice Emitted on every hand-off to `failedDeliveryAddress`. `recipient` is the account that the terms named,
    /// or the zero address when the data has no known shape. When the push fails, the amount is recorded as well.
    event DeliveryFailed(address indexed token, address indexed recipient, uint256 amount, Reason reason);
    /// @notice Emitted when `claim` pays the record of the failed delivery address.
    event Claimed(address indexed token, uint256 amount);

    /// @notice The mediator on this chain.
    ITokenMediator public immutable bridge;
    /// @notice The wrapped native token that `UNWRAP` unwraps.
    IWETH public immutable wNative;
    /// @notice The only account that may call `executeMessageWithRunner`. It does not receive the fee. It has no setter and
    /// no owner.
    address public immutable runner;
    /// @notice The only address that a call may name as the reward address, and so the only address that receives a
    /// fee. It has no setter and no owner.
    address public immutable rewardAddress;
    /// @notice Where the router hands off what it cannot deliver. It may equal `rewardAddress`. It has no setter and no
    /// owner.
    address public immutable failedDeliveryAddress;

    /// @notice What the router owes to `failedDeliveryAddress` in a token, after a hand-off that the token refused.
    mapping(address token => mapping(address account => uint256)) public claimable;
    /// @notice The sum of `claimable` over the accounts, for each token.
    mapping(address token => uint256) public totalClaimable;

    Settlement private _settlement;

    /// @param bridge_ The mediator on this chain.
    /// @param wNative_ The wrapped native token of this chain.
    /// @param runner_ The externally owned account that runs the deliveries. It cannot be the zero address.
    /// @param rewardAddress_ The address that receives the fees. It cannot be the zero address.
    /// @param failedDeliveryAddress_ The address that receives what the router cannot deliver. It cannot be the zero
    /// address. It may equal `rewardAddress_`.
    constructor(
        ITokenMediator bridge_,
        IWETH wNative_,
        address runner_,
        address rewardAddress_,
        address failedDeliveryAddress_
    ) {
        if (runner_ == address(0)) revert ZeroRunner();
        if (rewardAddress_ == address(0)) revert ZeroRewardAddress();
        if (failedDeliveryAddress_ == address(0)) revert ZeroFailedDeliveryAddress();
        bridge = bridge_;
        wNative = wNative_;
        runner = runner_;
        rewardAddress = rewardAddress_;
        failedDeliveryAddress = failedDeliveryAddress_;
    }

    /// @notice Executes a message on the message bridge and attributes the fee of any tokens that it delivers to this
    /// router to the reward address. Only the runner may call it. It reverts when the delivery fails, so the runner
    /// sees the error.
    /// @param proof The evidence that `MessageBridge.executeMessage` verifies. The router forwards it and does not read it.
    /// @param reward The reward address. It must equal `rewardAddress`.
    function executeMessageWithRunner(MessageBridge.MessageProof calldata proof, address reward) external {
        _requireRunnerAndReward(reward);
        if (_storedRunner() > NOT_RUNNING) revert RunnerSlotInUse();

        uint256 value = _begin(reward);
        MessageBridge(address(bridge.bridgeContract())).executeMessage(proof);
        _finish(value, reward);
    }

    /// @notice The callback of the mediator. It splits the tokens between the reward address and the recipient, and
    /// hands off to `failedDeliveryAddress` what it cannot deliver.
    /// @param token The token that the mediator released to the router.
    /// @param value The amount that the mediator reports.
    /// @param data An encoded `FeeDirector`, or the 20 byte address of a native coin receiver.
    function onTokenBridged(address token, uint256 value, bytes memory data) external nonReentrant {
        if (msg.sender != address(bridge)) revert NotMediator(msg.sender);
        value = _freeBalance(token, value);

        if (data.length == 20) {
            _payLegacy(token, address(bytes20(data)), value);
            return;
        }
        if (data.length < DIRECTOR_LENGTH) {
            _handOff(token, address(0), value, Reason.InvalidTerms);
            return;
        }
        FeeDirector memory director = abi.decode(data, (FeeDirector));
        Payout payout = director.settings & UNWRAP != 0 && token == address(wNative) ? Payout.Native : Payout.Token;
        if (payout == Payout.Native) wNative.withdraw(value);

        uint256 stored = _storedRunner();
        uint256 toRecipient = stored > NOT_RUNNING ? _takeFee(token, payout, value, director, _rewardOf(stored)) : value;
        if (toRecipient == 0) return;
        if (payout == Payout.Native) {
            _payNative(director.recipient, toRecipient);
            return;
        }
        _payToken(token, director.recipient, toRecipient);
    }

    /// @notice Pays the record of `failedDeliveryAddress` in a token. Anyone may call it, and it pays that address only.
    /// A token that still refuses the address reverts, and the record stays.
    /// @param token The token.
    function claim(address token) external nonReentrant {
        address account = failedDeliveryAddress;
        uint256 amount = claimable[token][account];
        if (amount == 0) revert NothingToClaim(token);
        claimable[token][account] = 0;
        totalClaimable[token] -= amount;
        IERC20(token).safeTransfer(account, amount);
        emit Claimed(token, amount);
    }

    /// @notice The fee and the amount for the recipient that the router computes.
    /// @param token The token that the mediator released.
    /// @param value The released amount.
    /// @param gasUsed The gas that the whole execution used, for a gas based fee. It is not read for a fixed or share
    /// fee.
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

    /// @notice Accepts the native coin from the wrapped token only, when it unwraps.
    receive() external payable {
        if (msg.sender != address(wNative)) revert NotWrappedTokenSender(msg.sender);
    }

    /// @dev Takes the fee in the callback when it needs no gas figure. For a gas based fee it sets the cap aside and
    /// leaves the settlement to the end of `executeMessageWithRunner`.
    /// @return toRecipient What the recipient receives now.
    function _takeFee(address token, Payout payout, uint256 value, FeeDirector memory director, address reward)
        private
        returns (uint256 toRecipient)
    {
        if (!_isGasBased(director.settings)) {
            uint256 fee = _fee(value, 0, director, 0);
            if (fee == 0 || !_tryPay(token, payout, reward, fee)) return value;
            return value - fee;
        }
        uint256 held = director.limit > value ? value : director.limit;
        // One settlement waits at a time. A second message in the same run pays no fee.
        if (held == 0 || _settlement.held != 0) return value;
        _settlement = Settlement({
            token: token,
            payout: payout,
            gasPrice: director.settings & BASE_FEE_ONLY != 0 ? GasPrice.BaseFee : GasPrice.Transaction,
            recipient: director.recipient,
            multiplier: director.multiplier > type(uint96).max ? type(uint96).max : uint96(director.multiplier),
            held: held
        });
        return value - held;
    }

    /// @dev Pays the reward address the gas based fee, and sends the rest of the held cap to the recipient.
    function _settle(Settlement memory waiting, uint256 gasUsed, address reward) private {
        uint256 overhead = waiting.payout == Payout.Native ? NATIVE_GAS_OVERHEAD : TOKEN_GAS_OVERHEAD;
        uint256 fee = (gasUsed + overhead) * waiting.multiplier * _gasPrice(waiting.gasPrice) / 1 ether;
        if (fee > waiting.held) fee = waiting.held;
        if (fee > 0 && !_tryPay(waiting.token, waiting.payout, reward, fee)) fee = 0;
        uint256 refund = waiting.held - fee;
        if (refund == 0) return;
        if (waiting.payout == Payout.Native) {
            _payNative(waiting.recipient, refund);
            return;
        }
        _payToken(waiting.token, waiting.recipient, refund);
    }

    /// @dev The two checks that every execute function makes first.
    function _requireRunnerAndReward(address reward) private view {
        // `tx.origin`, not `msg.sender`: the runner may reach the router through a generic multicall contract, which then
        // is `msg.sender`. The runner signs the transaction, so a copier of the call cannot pass. The reward address is
        // immutable, so a contract that tricks the runner into a call still cannot redirect a tip.
        // forge-lint: disable-next-line(tx-origin)
        if (tx.origin != runner) revert NotRunner(tx.origin);
        if (reward != rewardAddress) revert WrongRewardAddress(reward);
    }

    /// @dev Stores the reward address and the starting gas, which marks a run. Returns the stored value.
    function _begin(address reward) private returns (uint256 value) {
        value = uint256(uint96(gasleft())) | (uint256(uint160(reward)) << 96);
        _storeRunner(value);
    }

    /// @dev Settles a gas based fee that waits, and clears the slot. `value` is the value that `_begin` returned.
    function _finish(uint256 value, address reward) private {
        Settlement memory waiting = _settlement;
        if (waiting.held != 0) {
            delete _settlement;
            _settle(waiting, uint256(uint96(value)) - gasleft(), reward);
        }
        _storeRunner(NOT_RUNNING);
    }


    function _rewardOf(uint256 stored) private pure returns (address) {
        return address(uint160(stored >> 96));
    }

    function _storedRunner() private view returns (uint256 stored) {
        bytes32 slot = RUNNER_SLOT;
        assembly {
            stored := sload(slot)
        }
    }

    function _storeRunner(uint256 value) private {
        bytes32 slot = RUNNER_SLOT;
        assembly {
            sstore(slot, value)
        }
    }

    function _isGasBased(uint256 settings) private pure returns (bool) {
        return settings & (FIXED_FEE | SHARE_OF_VALUE) == 0;
    }

    /// @dev The fee, never above the value. Fixed: `limit`. Share: `value * multiplier / 1e18`. Otherwise gas based:
    /// the gas used, plus the overhead, times the multiplier and the gas price, with `limit` as the cap.
    function _fee(uint256 value, uint256 gasUsed, FeeDirector memory director, uint256 overheadGas)
        private
        view
        returns (uint256 fee)
    {
        if (director.settings & FIXED_FEE != 0) {
            fee = director.limit;
        } else if (director.settings & SHARE_OF_VALUE != 0) {
            fee = value * director.multiplier / 1 ether;
        } else {
            GasPrice price = director.settings & BASE_FEE_ONLY != 0 ? GasPrice.BaseFee : GasPrice.Transaction;
            fee = (gasUsed + overheadGas) * director.multiplier * _gasPrice(price) / 1 ether;
            if (fee > director.limit) fee = director.limit;
        }
        if (fee > value) fee = value;
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

    /// @dev Sends the unwrapped coin. A receiver that refuses it gets the wrapped token. A receiver that refuses both,
    /// and an invalid recipient, cause a hand-off of the wrapped token.
    function _payNative(address recipient, uint256 amount) private {
        if (!_canReceive(recipient)) {
            wNative.deposit{value: amount}();
            _handOff(address(wNative), recipient, amount, Reason.InvalidTerms);
            return;
        }
        if (_trySendNative(recipient, amount)) return;
        _handOff(address(wNative), recipient, amount, Reason.PayoutRefused);
    }

    /// @dev Sends the coin, and on a refusal wraps it again and sends the wrapped token. When it returns false the
    /// router holds the amount as the wrapped token.
    function _trySendNative(address to, uint256 amount) private returns (bool) {
        (bool sent,) = to.call{value: amount, gas: NATIVE_SEND_GAS}("");
        if (sent) return true;
        wNative.deposit{value: amount}();
        return IERC20(address(wNative)).trySafeTransfer(to, amount);
    }

    /// @dev Pays a token. An invalid recipient, or a token that refuses the recipient, causes a hand-off.
    function _payToken(address token, address recipient, uint256 amount) private {
        if (!_canReceive(recipient)) {
            _handOff(token, recipient, amount, Reason.InvalidTerms);
            return;
        }
        if (IERC20(token).trySafeTransfer(recipient, amount)) return;
        _handOff(token, recipient, amount, Reason.PayoutRefused);
    }

    /// @dev The legacy form: the receiver gets the coin for the wrapped native token, and the token itself for any
    /// other token, with no fee in both cases.
    function _payLegacy(address token, address receiver, uint256 value) private {
        if (token != address(wNative)) {
            _payToken(token, receiver, value);
            return;
        }
        wNative.withdraw(value);
        _payNative(receiver, value);
    }

    /// @dev An account that can own a payout: not the zero address and not the router, which has no way to pay itself.
    function _canReceive(address account) private view returns (bool) {
        return account != address(0) && account != address(this);
    }

    /// @dev The part of the balance that no record owns, up to `value`. A token that takes a cut on transfer delivers
    /// less than the mediator reports, and the records of other accounts are not for this delivery.
    function _freeBalance(address token, uint256 value) private view returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 owed = totalClaimable[token];
        uint256 free = balance > owed ? balance - owed : 0;
        return free < value ? free : value;
    }

    /// @dev Pushes an amount that the router could not deliver to `failedDeliveryAddress`. When the token refuses that
    /// push, the router records the amount for the address, so the tokens stay owed and never burn.
    function _handOff(address token, address recipient, uint256 amount, Reason reason) private {
        if (amount == 0) return;
        emit DeliveryFailed(token, recipient, amount, reason);
        if (IERC20(token).trySafeTransfer(failedDeliveryAddress, amount)) return;
        claimable[token][failedDeliveryAddress] += amount;
        totalClaimable[token] += amount;
    }
}
