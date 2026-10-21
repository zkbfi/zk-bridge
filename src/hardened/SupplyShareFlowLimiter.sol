// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IFlowLimiter} from "./IFlowLimiter.sol";

/// @notice The one function of the vault that the limiter calls.
interface IFlowLimiterVault {
    /// @notice Detaches the limiter from the vault for good. The vault accepts the call only from the limiter.
    function detachFlowLimiter() external;
}

/// @title SupplyShareFlowLimiter
/// @notice A flow limiter for the vault. Each token may leave the vault at a rate of a fixed share of its supply per
/// window. Deposits always pass. The contract has no owner and no setter: every parameter is fixed at construction,
/// and the only way it ends is `sunset()`, after the optional sunset time.
/// @dev Allowance. Each token has a signed allowance. It refills in a straight line, the full cap over one window, and
/// never goes above the cap. A withdrawal passes when it fits in the allowance. A withdrawal that is larger than the
/// cap passes only from a full allowance, and the allowance then goes below zero by the excess (a debt). So every valid
/// withdrawal can complete, and the average outflow stays at one cap per window. A debt refills like any other
/// shortfall, and a withdrawal waits until the allowance can pay for it.
///
/// Storage. The allowance and the time of its last update share one slot. A token that the limiter never saw has an
/// empty slot, which reads as a full allowance. The allowance is an `int192`, so the cap is at most `int192` maximum
/// (about 6e57 base units, far above any real supply: 100 trillion tokens of 18 decimals is about 1e32). A supply above
/// that maximum counts as the maximum, and a debt below the negative maximum counts as the negative maximum.
///
/// Rounding. A refill rounds down, so the limiter never gives more than the straight line. The time of the last update
/// moves only when the refill is at least one unit, so a call every second cannot starve a small cap of its refill.
contract SupplyShareFlowLimiter is IFlowLimiter {
    /// @notice The supply of one token that the constructor fixes. It replaces `totalSupply()` for that token.
    struct FixedSupply {
        address token;
        uint256 supply;
    }

    /// @dev One slot per token. `allowance` is valid from `updatedAt`. A zero `updatedAt` means never used: full.
    struct TokenState {
        int192 allowance;
        uint64 updatedAt;
    }

    /// @notice The caller is not the vault.
    error NotVault(address caller);
    /// @notice The withdrawal does not fit in the allowance of the token now. `available` is zero when the allowance
    /// is in debt.
    error FlowRefused(address token, uint256 amount, uint256 available);
    /// @notice `sunset()` was called while no sunset is set (the time is zero) or before the sunset time.
    error SunsetNotReached(uint256 sunsetTimestamp, uint256 currentTimestamp);
    /// @notice A constructor value is zero.
    error ZeroValue(string name);
    /// @notice The share is above 100 percent.
    error ShareAboveWhole(uint16 shareBasisPoints);
    /// @notice A fixed supply is above the largest supply that the limiter can hold.
    error FixedSupplyTooLarge(address token, uint256 supply);
    /// @notice A token appears twice in the fixed supplies.
    error DuplicateFixedSupply(address token);

    /// @notice The base of the share.
    uint256 public constant BASIS_POINTS = 10_000;
    /// @notice The largest supply that the limiter holds. A larger supply counts as this one.
    uint256 public constant MAXIMUM_SUPPLY = uint256(uint192(type(int192).max));

    /// @notice The only caller of the checks, and the vault that `sunset()` detaches from.
    address public immutable vault;
    /// @notice The share of the supply that may leave per window, in basis points.
    uint16 public immutable shareBasisPoints;
    /// @notice The time in which an empty allowance refills to the cap, in seconds.
    uint64 public immutable windowSeconds;
    /// @notice The time after which anyone may detach the limiter. Zero means never.
    uint64 public immutable sunsetTimestamp;

    /// @notice The supply that the constructor fixed for a token. Zero means that the token uses `totalSupply()`.
    mapping(address token => uint256 supply) public fixedSupplyOf;
    mapping(address token => TokenState state) private _states;

    /// @param vault_ The vault. It may be a predicted address that holds no code yet.
    /// @param shareBasisPoints_ The share of the supply per window, from 1 to 10,000.
    /// @param windowSeconds_ The refill time of a full cap, above zero.
    /// @param sunsetTimestamp_ The time after which `sunset()` works, or zero for never.
    /// @param fixedSupplies The tokens whose supply is not their on-chain `totalSupply()`.
    constructor(
        address vault_,
        uint16 shareBasisPoints_,
        uint64 windowSeconds_,
        uint64 sunsetTimestamp_,
        FixedSupply[] memory fixedSupplies
    ) {
        if (vault_ == address(0)) revert ZeroValue("vault");
        if (shareBasisPoints_ == 0) revert ZeroValue("shareBasisPoints");
        if (shareBasisPoints_ > BASIS_POINTS) revert ShareAboveWhole(shareBasisPoints_);
        if (windowSeconds_ == 0) revert ZeroValue("windowSeconds");
        vault = vault_;
        shareBasisPoints = shareBasisPoints_;
        windowSeconds = windowSeconds_;
        sunsetTimestamp = sunsetTimestamp_;
        for (uint256 i = 0; i < fixedSupplies.length; i++) {
            FixedSupply memory entry = fixedSupplies[i];
            if (entry.token == address(0)) revert ZeroValue("token");
            if (entry.supply == 0) revert ZeroValue("supply");
            if (entry.supply > MAXIMUM_SUPPLY) revert FixedSupplyTooLarge(entry.token, entry.supply);
            if (fixedSupplyOf[entry.token] != 0) revert DuplicateFixedSupply(entry.token);
            fixedSupplyOf[entry.token] = entry.supply;
        }
    }

    /// @notice A deposit always passes. Only the vault may call, so no outsider can use up the allowance.
    function checkDeposit(address, address, uint256) external view {
        _requireVault();
    }

    /// @notice Refuses a withdrawal that the allowance of the token cannot pay, and records one that it can.
    function checkWithdrawal(address token, address, uint256 amount, bytes32) external {
        _requireVault();
        uint256 cap = capOf(token);
        (int256 allowance, uint64 updatedAt) = _refilled(_states[token], cap);
        uint256 available = _positive(allowance);
        // A withdrawal above the cap passes only from a full allowance. Any other withdrawal must fit.
        bool passesIntoDebt = amount > cap && allowance >= int256(cap);
        if (amount > available && !passesIntoDebt) revert FlowRefused(token, amount, available);
        _states[token] = TokenState({allowance: _fitted(allowance - _boundedAmount(amount)), updatedAt: updatedAt});
    }

    /// @notice Detaches the limiter from the vault. It works once, after `sunsetTimestamp`, and never when that is zero.
    /// Anyone may call it. A second call reverts in the vault, which no longer has this limiter.
    function sunset() external {
        if (sunsetTimestamp == 0 || block.timestamp < sunsetTimestamp) {
            revert SunsetNotReached(sunsetTimestamp, block.timestamp);
        }
        IFlowLimiterVault(vault).detachFlowLimiter();
    }

    /// @notice The cap of a token: the share of its supply that may leave per window.
    /// @param token The local token.
    function capOf(address token) public view returns (uint256) {
        uint256 supply = fixedSupplyOf[token];
        if (supply == 0) supply = IERC20(token).totalSupply();
        if (supply > MAXIMUM_SUPPLY) supply = MAXIMUM_SUPPLY;
        return supply * shareBasisPoints / BASIS_POINTS;
    }

    /// @notice What a withdrawal of the token could take now. Zero while the allowance is in debt.
    /// @param token The local token.
    function availableNow(address token) external view returns (uint256) {
        (int256 allowance,) = _refilled(_states[token], capOf(token));
        return _positive(allowance);
    }

    function _requireVault() private view {
        if (msg.sender != vault) revert NotVault(msg.sender);
    }

    /// @dev The allowance now and the time that it is valid from. The allowance is the stored one plus the straight-line
    /// refill, at most the cap. A never-used token is full. The refill is NOT capped at one window: a debt of several caps
    /// needs several windows. The product `cap * elapsed` stays below 2^255 because the cap is below 2^191 and the
    /// elapsed time is below 2^64, so the sum with a stored allowance (below 2^191 in size) still fits in `int256`. The
    /// time moves only when the refill is above zero, so the fraction that rounding drops is not lost on every call.
    function _refilled(TokenState memory state, uint256 cap) private view returns (int256, uint64) {
        if (state.updatedAt == 0) return (int256(cap), uint64(block.timestamp));
        uint256 elapsed = block.timestamp - state.updatedAt;
        uint256 refill = cap * elapsed / windowSeconds;
        if (refill == 0) return (_cappedAt(state.allowance, cap), state.updatedAt);
        return (_cappedAt(state.allowance + int256(refill), cap), uint64(block.timestamp));
    }

    /// @dev An allowance, at most the cap. A stored allowance can lie above a cap that has since shrunk (the supply fell).
    function _cappedAt(int256 allowance, uint256 cap) private pure returns (int256) {
        return allowance > int256(cap) ? int256(cap) : allowance;
    }

    /// @dev The part of a signed allowance that can pay: zero for a debt.
    function _positive(int256 allowance) private pure returns (uint256) {
        return allowance > 0 ? uint256(allowance) : 0;
    }

    /// @dev An amount as a signed number. An amount above the largest supply counts as the largest supply.
    function _boundedAmount(uint256 amount) private pure returns (int256) {
        return amount > MAXIMUM_SUPPLY ? int256(MAXIMUM_SUPPLY) : int256(amount);
    }

    /// @dev Fits a signed allowance in `int192`. A debt below the negative maximum counts as the negative maximum.
    function _fitted(int256 allowance) private pure returns (int192) {
        if (allowance > type(int192).max) return type(int192).max;
        if (allowance < -type(int192).max) return -type(int192).max;
        return int192(allowance);
    }
}
