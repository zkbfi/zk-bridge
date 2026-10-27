// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeliveryRouter} from "../../../../src/hardened/mediator/DeliveryRouter.sol";
import {MessageBridge} from "../../../../src/hardened/MessageBridge.sol";

/// @notice A target that records the call that it receives: who called, with what coin value, with which bytes, and
/// how much gas it saw at its first instruction.
contract CallRecorder {
    uint256 public calls;
    address public lastCaller;
    uint256 public lastValue;
    bytes public lastData;
    uint256 public gasAtEntry;

    fallback() external payable {
        gasAtEntry = gasleft();
        calls += 1;
        lastCaller = msg.sender;
        lastValue = msg.value;
        lastData = msg.data;
    }
}

/// @notice A target that always reverts with a known error.
contract CallReverter {
    error TargetRefused();

    fallback() external payable {
        revert TargetRefused();
    }
}

/// @notice A target that burns all the gas that it gets, with the invalid opcode.
contract CallBurner {
    fallback() external payable {
        assembly {
            invalid()
        }
    }
}

/// @notice A target that calls back into the router while the router makes the call after a delivery. In the catching
/// mode it records the revert data of each inner call. In the uncaught mode its first inner call reverts the target.
contract ReentryTarget {
    /// @dev What the target does with the failure of an inner call.
    enum Mode {
        Catch,
        Uncaught
    }

    DeliveryRouter public immutable router;
    address public immutable token;
    Mode public immutable mode;

    uint256 public entries;
    bytes public executeMessageFailure;
    bytes public sweepFailure;
    bytes public onTokenBridgedFailure;

    constructor(DeliveryRouter router_, address token_, Mode mode_) {
        router = router_;
        token = token_;
        mode = mode_;
    }

    fallback() external payable {
        entries += 1;
        MessageBridge.MessageProof memory emptyProof;
        if (mode == Mode.Uncaught) {
            router.executeMessage(emptyProof);
            return;
        }
        try router.executeMessage(emptyProof) {}
        catch (bytes memory reason) {
            executeMessageFailure = reason;
        }
        try router.sweep(token) {}
        catch (bytes memory reason) {
            sweepFailure = reason;
        }
        try router.onTokenBridged(token, 1, "") {}
        catch (bytes memory reason) {
            onTokenBridgedFailure = reason;
        }
    }
}

/// @notice A target that tries to take tokens from the router with `transferFrom`, as a spender with no allowance.
contract TokenThief {
    IERC20 public immutable token;
    address public immutable victim;
    address public immutable attacker;
    uint256 public immutable amount;

    uint256 public attempts;
    bool public transferred;
    bytes public failure;

    constructor(IERC20 token_, address victim_, address attacker_, uint256 amount_) {
        token = token_;
        victim = victim_;
        attacker = attacker_;
        amount = amount_;
    }

    fallback() external payable {
        attempts += 1;
        try token.transferFrom(victim, attacker, amount) returns (bool moved) {
            transferred = moved;
        } catch (bytes memory reason) {
            failure = reason;
        }
    }
}

/// @notice A token that records the balance of the sender at each transfer to a watched account. A test uses it to see
/// what the router holds at the moment that a call from the router moves tokens.
contract BalanceProbeToken is ERC20 {
    address public watched;
    uint256 public watchedTransfers;
    uint256 public senderBalanceAtWatchedTransfer;

    constructor() ERC20("Probe", "PRB") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Names the account whose incoming transfers the token watches.
    function watch(address account) external {
        watched = account;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to == watched && from != address(0)) {
            watchedTransfers += 1;
            senderBalanceAtWatchedTransfer = balanceOf(from);
        }
        super._update(from, to, value);
    }
}
