// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {IFlowLimiter} from "../../../../src/hardened/IFlowLimiter.sol";
import {TokenMediator} from "../../../../src/hardened/mediator/TokenMediator.sol";
import {DenyListToken} from "./MediatorSupport.sol";

/// @notice A token that moves more than it was asked to move: `transferFrom` credits the receiver one unit extra.
/// The mediator must refuse it, because the record would count tokens that nobody sent.
contract MedBonusToken is ERC20 {
    constructor() ERC20("Bonus", "BNS") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        super.transferFrom(from, to, value);
        _mint(to, 1);
        return true;
    }
}

/// @notice A token that calls a chosen target while it sends tokens out (`transfer`), as a token with a hook does.
/// The call runs before the tokens move. It records the result and does not bubble up a failure. After the call, the
/// token either pays or refuses (returns false). It can also refuse every transfer on command.
contract MedHostileToken is ERC20 {
    /// @dev What the transfer does after the hook ran.
    enum Ending {
        Pay,
        Refuse
    }

    address public target;
    bytes public data;
    Ending public ending;
    bool public refusingAll;

    uint256 public hooksRun;
    bool public hookOk;
    bytes public hookReturned;

    constructor() ERC20("Hostile", "HST") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Gives the token itself tokens and an allowance for `spender`, so that the hook can relay as the token.
    function fundSelf(address spender, uint256 amount) external {
        _mint(address(this), amount);
        _approve(address(this), spender, type(uint256).max);
    }

    /// @notice Arms the hook for the next `transfer`.
    function arm(address target_, bytes calldata data_, Ending ending_) external {
        target = target_;
        data = data_;
        ending = ending_;
    }

    /// @notice Makes every `transfer` return false, whether or not a hook is armed.
    function setRefusingAll(bool refusing) external {
        refusingAll = refusing;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        Ending endingNow = Ending.Pay;
        address callee = target;
        if (callee != address(0)) {
            target = address(0);
            endingNow = ending;
            (hookOk, hookReturned) = callee.call(data);
            hooksRun++;
        }
        if (refusingAll || endingNow == Ending.Refuse) return false;
        return super.transfer(to, value);
    }
}

/// @notice A flow limiter that allows everything and tries one hostile move when the mediator calls it. It keeps the
/// revert data of the move. Refusals are separate for deposits and withdrawals, as in `ScriptedMediatorLimiter`.
contract MedHostileLimiter is IFlowLimiter {
    /// @dev What the limiter does to the mediator when the mediator calls it.
    enum Move {
        None,
        ReenterRelay,
        CallHandler,
        PullTokens
    }

    error FlowRefused();

    Move public move;
    bool public refuseDeposits;
    bool public refuseWithdrawals;
    uint256 public depositChecks;
    uint256 public withdrawalChecks;
    uint256 public movesTried;
    bytes public moveError;

    function setMove(Move move_) external {
        move = move_;
    }

    function setRefusals(bool deposits, bool withdrawals) external {
        refuseDeposits = deposits;
        refuseWithdrawals = withdrawals;
    }

    function checkDeposit(address token, address, uint256 amount) external {
        depositChecks++;
        _tryMove(msg.sender, token, amount);
        if (refuseDeposits) revert FlowRefused();
    }

    function checkWithdrawal(address token, address, uint256 amount, bytes32) external {
        withdrawalChecks++;
        _tryMove(msg.sender, token, amount);
        if (refuseWithdrawals) revert FlowRefused();
    }

    function _tryMove(address mediator, address token, uint256 amount) private {
        if (move == Move.None) return;
        movesTried++;
        bytes memory failure;
        if (move == Move.ReenterRelay) {
            try TokenMediator(mediator).relayTokens(token, amount) {}
            catch (bytes memory reason) {
                failure = reason;
            }
        }
        if (move == Move.CallHandler) {
            try TokenMediator(mediator).handleNativeTokens(token, address(this), amount) {}
            catch (bytes memory reason) {
                failure = reason;
            }
        }
        if (move == Move.PullTokens) {
            try IERC20(token).transferFrom(mediator, address(this), amount) {}
            catch (bytes memory reason) {
                failure = reason;
            }
        }
        moveError = failure;
    }
}

/// @notice A token that takes a cut of every transfer that leaves one chosen sender, as a token with a transfer tax
/// does. The cut is zero until a test sets it, so the token can enter a mediator whole and leave it short.
contract MedCutToken is ERC20 {
    uint256 internal constant DENOMINATOR = 10_000;

    address public cutSender;
    uint256 public cutBasisPoints;

    constructor() ERC20("Cut", "CUT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice From now on, a transfer from `sender` burns `basisPoints` of its value on the way.
    function setCut(address sender, uint256 basisPoints) external {
        cutSender = sender;
        cutBasisPoints = basisPoints;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != cutSender || from == address(0) || to == address(0)) return super._update(from, to, value);
        uint256 cut = value * cutBasisPoints / DENOMINATOR;
        super._update(from, address(0), cut);
        super._update(from, to, value - cut);
    }
}

/// @notice A wrapped native token that refuses every transfer to the accounts on its deny list, as a wrapped token with
/// a blocklist would. The coin that it pays on `withdraw` is not a transfer of the token, so a denied account can still
/// receive the coin.
contract MedDenyListWrappedNative is ERC20 {
    error TransferRefused(address to);
    error NativeTransferFailed();

    mapping(address account => bool) public denied;

    constructor() ERC20("Wrapped Deny", "WDENY") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool sent,) = msg.sender.call{value: amount}("");
        if (!sent) revert NativeTransferFailed();
    }

    function setDenied(address account, bool isDenied) external {
        denied[account] = isDenied;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (denied[to]) revert TransferRefused(to);
        super._update(from, to, value);
    }
}

/// @notice A receiver of the native coin that refuses it on command.
contract MedToggleReceiver {
    bool public refuse = true;

    function setRefuse(bool refuse_) external {
        refuse = refuse_;
    }

    receive() external payable {
        require(!refuse, "refused");
    }
}

/// @notice A token that records the storage slot of a router at the moment that the router pays out. The slot is read
/// with the `load` cheat code, so the test sees what the router holds in the middle of a delivery.
contract SlotProbeToken is ERC20 {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address public immutable watchedRouter;
    bytes32 public immutable watchedSlot;
    /// @notice The slot value at the last payout from the router, or zero when there was none since the last reset.
    uint256 public slotSeenAtPayout;

    /// @param router_ The router whose slot the token reads.
    /// @param slot_ The slot to read.
    constructor(address router_, bytes32 slot_) ERC20("Probe", "PRB") {
        watchedRouter = router_;
        watchedSlot = slot_;
    }

    /// @notice Mints tokens.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Forgets the last reading.
    function resetSeen() external {
        slotSeenAtPayout = 0;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == watchedRouter) slotSeenAtPayout = uint256(VM.load(watchedRouter, watchedSlot));
        super._update(from, to, value);
    }
}

/// @notice A token that calls a chosen target once, right after it pays a chosen account, as a token with a receive hook
/// does (ERC-777 `tokensReceived`). The call runs after the tokens moved. It records the result and does not bubble up a
/// failure.
contract MedReentryToken is ERC20 {
    address public hookedAccount;
    address public target;
    bytes public data;

    uint256 public hooksRun;
    bool public hookOk;
    bytes public hookReturned;

    constructor() ERC20("Reentry", "RNT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Arms the hook for the next payment to `hookedAccount`.
    function arm(address hookedAccount_, address target_, bytes calldata data_) external {
        hookedAccount = hookedAccount_;
        target = target_;
        data = data_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        address callee = target;
        if (callee == address(0) || to != hookedAccount) return;
        target = address(0);
        (hookOk, hookReturned) = callee.call(data);
        hooksRun++;
    }
}

/// @notice A deny list token with a receive hook: right after it pays a chosen account, it calls a chosen target once, as
/// a token with a receive hook does. The call runs after the tokens moved. It records nothing about a failure.
contract MedHookedDenyListToken is DenyListToken {
    address public hookedAccount;
    address public target;
    bytes public data;
    uint256 public hooksRun;

    /// @notice Arms the hook for the next payment to `hookedAccount_`. A zero target disarms it.
    function arm(address hookedAccount_, address target_, bytes calldata data_) external {
        hookedAccount = hookedAccount_;
        target = target_;
        data = data_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        address callee = target;
        if (callee == address(0) || to != hookedAccount) return;
        target = address(0);
        hooksRun++;
        callee.call(data);
    }
}
