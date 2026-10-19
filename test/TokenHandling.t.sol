// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeFixture} from "./utils/BridgeFixture.sol";
import {ZKBridgeVault} from "../src/ZKBridgeVault.sol";
import {FeeOnTransferToken} from "../src/mocks/FeeOnTransferToken.sol";
import {ReturnsFalseToken} from "../src/mocks/ReturnsFalseToken.sol";
import {NoReturnToken} from "../src/mocks/NoReturnToken.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Red-team tests about ERC-20 handling (H-13). Every test passes when the attack succeeds.
contract TokenHandlingTest is BridgeFixture {
    // ------------------------------------------------------------------ H-13a

    /// Specification claim: the vault locks `amount` and releases `amount`.
    /// What the test shows: a fee-on-transfer token delivers less than `amount` to the vault, but the
    /// event and the claim use the full `amount`. Two depositors fund 198; two claims of 100 need 200,
    /// so the last claimant cannot be paid.
    function test_H13_feeOnTransferTokenMakesVaultInsolvent() public {
        FeeOnTransferToken feeToken = new FeeOnTransferToken("Fee", "FEE");
        assertFalse(_secondClaimPaid(address(feeToken)), "last withdrawer is not paid");
        assertEq(feeToken.balanceOf(address(vaultB)), 98e18, "vault is short by the burned fees");

        // Control: a plain ERC-20 in the same scenario pays both claims.
        MockERC20 plainToken = new MockERC20("Plain", "PLN");
        assertTrue(_secondClaimPaid(address(plainToken)), "plain token pays both claims");
    }

    // ------------------------------------------------------------------ H-13b

    /// Specification claim: step 6 clears the nullifier before moving funds, so a claim is paid once.
    /// What the test shows: a token whose `transfer` returns false moves nothing, yet the vault ignores
    /// the return value. The nonce is marked processed, the recipient gets nothing, and the claim
    /// cannot be retried.
    function test_H13_returnsFalseTokenBurnsTheClaim() public {
        ReturnsFalseToken falseToken = new ReturnsFalseToken("False", "FLS");
        falseToken.mint(address(vaultB), 100e18);
        bytes32 blockRoot = keccak256("block");
        _honestUpdate(blockRoot, INITIAL_PERIOD);

        ZKBridgeVault.BridgeInputs memory inputs =
            _inputs(address(falseToken), bob, 100e18, keccak256("claim"), blockRoot);
        _withdraw(vaultB, inputs);
        assertTrue(vaultB.processedNonces(inputs.depositNonce), "nonce is spent");
        assertEq(falseToken.balanceOf(bob), 0, "nothing was paid");
        assertEq(falseToken.balanceOf(address(vaultB)), 100e18);

        bytes memory publicInputsBytes = abi.encode(inputs);
        bytes memory proof = _prove(publicInputsBytes);
        vm.expectRevert("Bridge transaction already claimed");
        vaultB.withdraw(proof, publicInputsBytes);

        // Control: the plain token pays the same claim.
        inputs.tokenAddress = address(token);
        inputs.depositNonce = keccak256("claim with plain token");
        _withdraw(vaultB, inputs);
        assertEq(token.balanceOf(bob), 100e18);
    }

    // ------------------------------------------------------------------ H-13c

    /// Specification claim: the vault bridges ERC-20 tokens.
    /// What the test shows: a USDT-shaped token returns nothing from `transferFrom` and `transfer`.
    /// The vault's interface expects a `bool`, so the call reverts on decoding. USDT cannot be
    /// deposited, and any balance of it in a vault cannot be withdrawn.
    function test_H13_noReturnTokenCannotBeBridged() public {
        NoReturnToken usdtLike = new NoReturnToken();
        usdtLike.mint(alice, 100e18);
        vm.startPrank(alice);
        usdtLike.approve(address(vaultA), 100e18);
        vm.expectRevert();
        vaultA.deposit(address(usdtLike), bob, 100e18, CHAIN_B);
        vm.stopPrank();

        usdtLike.mint(address(vaultB), 100e18);
        bytes32 blockRoot = keccak256("block");
        _honestUpdate(blockRoot, INITIAL_PERIOD);
        bytes memory publicInputsBytes =
            abi.encode(_inputs(address(usdtLike), bob, 100e18, keccak256("usdt claim"), blockRoot));
        bytes memory proof = _prove(publicInputsBytes);
        vm.expectRevert();
        vaultB.withdraw(proof, publicInputsBytes);

        // Control: a standard token deposits without trouble.
        token.mint(alice, 100e18);
        _deposit(vaultA, address(token), alice, bob, 100e18, CHAIN_B);
        assertEq(token.balanceOf(address(vaultA)), 100e18);
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Two users deposit 100 of `tokenAddress` into `vaultB`, then two claims of 100 are made
    /// against it. Returns whether the second claim was paid.
    function _secondClaimPaid(address tokenAddress) internal returns (bool) {
        IMintable(tokenAddress).mint(alice, 100e18);
        IMintable(tokenAddress).mint(bob, 100e18);
        _deposit(vaultB, tokenAddress, alice, alice, 100e18, CHAIN_A);
        _deposit(vaultB, tokenAddress, bob, bob, 100e18, CHAIN_A);

        bytes32 blockRoot = keccak256(abi.encodePacked("block", tokenAddress));
        _honestUpdate(blockRoot, lightClient.currentPeriod() + 1);

        _withdraw(vaultB, _inputs(tokenAddress, attacker, 100e18, keccak256(abi.encodePacked("first claim", tokenAddress)), blockRoot));
        ZKBridgeVault.BridgeInputs memory second =
            _inputs(tokenAddress, makeAddr("second claimant"), 100e18, keccak256(abi.encodePacked("second claim", tokenAddress)), blockRoot);
        bytes memory publicInputsBytes = abi.encode(second);
        bytes memory proof = _prove(publicInputsBytes);
        try vaultB.withdraw(proof, publicInputsBytes) {
            return true;
        } catch {
            return false;
        }
    }
}
