// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BridgeVault} from "../../../src/hardened/BridgeVault.sol";
import {IFlowLimiter} from "../../../src/hardened/IFlowLimiter.sol";

/// @notice A flow limiter for tests. It refuses on command, records what the vault passes, and can try the moves that
/// a hostile limiter would try: a reentry into the vault, and a pull of the vault's tokens.
contract ScriptedFlowLimiter is IFlowLimiter {
    /// @dev What the limiter does with the vault when the vault calls it.
    enum Move {
        None,
        ReenterWithdraw,
        ReenterDeposit,
        PullVaultTokens
    }

    error FlowRefused();

    bool public refuseDeposits;
    bool public refuseWithdrawals;
    Move public move;

    uint256 public depositChecks;
    address public lastDepositToken;
    address public lastDepositor;
    uint256 public lastDepositAmount;

    uint256 public withdrawalChecks;
    address public lastWithdrawalToken;
    address public lastWithdrawalRecipient;
    uint256 public lastWithdrawalAmount;
    bytes32 public lastWithdrawalNonce;

    /// @dev The revert data of the attempted move. Empty when the move did not revert, or when none was tried.
    bytes public moveError;
    bool public moveTried;

    function setRefusals(bool deposits, bool withdrawals) external {
        refuseDeposits = deposits;
        refuseWithdrawals = withdrawals;
    }

    function setMove(Move move_) external {
        move = move_;
    }

    /// @notice Detaches this limiter from `vault`. The vault accepts the call only from the limiter itself.
    function detachFrom(BridgeVault vault) external {
        vault.detachFlowLimiter();
    }

    function checkDeposit(address token, address depositor, uint256 amount) external {
        depositChecks++;
        lastDepositToken = token;
        lastDepositor = depositor;
        lastDepositAmount = amount;
        _tryMove(msg.sender, token, amount);
        if (refuseDeposits) revert FlowRefused();
    }

    function checkWithdrawal(address token, address recipient, uint256 amount, bytes32 nonce) external {
        withdrawalChecks++;
        lastWithdrawalToken = token;
        lastWithdrawalRecipient = recipient;
        lastWithdrawalAmount = amount;
        lastWithdrawalNonce = nonce;
        _tryMove(msg.sender, token, amount);
        if (refuseWithdrawals) revert FlowRefused();
    }

    function _tryMove(address vault, address token, uint256 amount) private {
        if (move == Move.None) return;
        moveTried = true;
        bytes memory failure;
        if (move == Move.ReenterWithdraw) {
            BridgeVault.WithdrawalProof memory emptyProof;
            try BridgeVault(vault).withdraw(emptyProof) {}
            catch (bytes memory reason) {
                failure = reason;
            }
        }
        if (move == Move.ReenterDeposit) {
            try BridgeVault(vault).deposit(token, address(this), amount, 0, "") {}
            catch (bytes memory reason) {
                failure = reason;
            }
        }
        if (move == Move.PullVaultTokens) {
            try IERC20(token).transferFrom(vault, address(this), amount) {}
            catch (bytes memory reason) {
                failure = reason;
            }
        }
        moveError = failure;
    }
}
