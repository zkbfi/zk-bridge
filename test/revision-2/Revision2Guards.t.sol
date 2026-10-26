// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Revision2Fixture} from "./Revision2Fixture.sol";
import {Committee} from "../utils/Committee.sol";
import {ZKBridgeVault} from "../../src/revision-2/ZKBridgeVault.sol";
import {BurnAllToken} from "../hardened/utils/HardenedMocks.sol";

/// @notice Guards and the refund path of revision 2. The refund tests pin the behaviour that the red team report
/// describes: a refund needs no proof from the other chain, so a deposit that was paid out can also be refunded.
contract Revision2GuardsTest is Revision2Fixture {
    bytes32 internal constant ROOT = keccak256("block that holds the deposit");

    // ================================================================ light client

    /// Claim: a period below the current period, and unequal signature and proof lists, are refused with exact text.
    function test_lightClient_refusesAnAncientPeriodAndMismatchedArrays() public {
        Committee.Signed memory signed = _sign(honest, ROOT, INITIAL_PERIOD - 1, bytes32(0), Committee.THRESHOLD);
        vm.expectRevert("Ancient period profile");
        lightClient.updateSyncState(INITIAL_PERIOD - 1, ROOT, signed.signatures, signed.proofs, bytes32(0));

        Committee.Signed memory one = _sign(honest, ROOT, INITIAL_PERIOD, bytes32(0), 1);
        bytes32[][] memory noProofs = new bytes32[][](0);
        vm.expectRevert("Mismatched array dimensions");
        lightClient.updateSyncState(INITIAL_PERIOD, ROOT, one.signatures, noProofs, bytes32(0));
        assertFalse(lightClient.isVerifiedBlockRoot(ROOT));
    }

    // ================================================================ vault guards

    /// Claim: the constructor refuses token lists of unequal length. Shows: the exact text; equal lists build.
    function test_vault_constructorRefusesUnequalTokenRegistry() public {
        address[] memory two = new address[](2);
        vm.expectRevert("Token registry bounds mismatch");
        new ZKBridgeVault(
            address(verifier), PROGRAM_VKEY, CHAIN_A, address(lightClient), _chains(CHAIN_B), _addresses(address(tokenA)),
            two, _addresses(address(tokenA)), CHAIN_B, address(0xBEEF)
        );
    }

    /// Claim: a deposit of zero is refused, and a token that reports success but moves nothing is refused. Shows: the
    /// exact text of each. Matters: a record of zero would never be refundable or claimable.
    function test_vault_refusesZeroAndZeroNetDeposits() public {
        vm.prank(alice);
        vm.expectRevert("Amount must be greater than 0");
        vaultA.deposit(address(tokenA), bob, 0, CHAIN_B);

        BurnAllToken burn = new BurnAllToken();
        (ZKBridgeVault burnVault,) = _deployPair(address(burn), address(tokenB));
        burn.mint(alice, 10e18);
        vm.startPrank(alice);
        burn.approve(address(burnVault), 10e18);
        vm.expectRevert("Zero net transfer volume");
        burnVault.deposit(address(burn), bob, 10e18, CHAIN_B);
        vm.stopPrank();
    }

    // ================================================================ refund

    function _depositOnA(uint256 amount) internal returns (bytes32 nonce) {
        tokenA.mint(alice, amount);
        (nonce,) = _deposit(vaultA, address(tokenA), alice, bob, amount, CHAIN_B);
    }

    /// Claim: the sender gets the deposit back after the delay, once. Shows: unknown nonce, early call, the payout with
    /// its event, and a second call each revert or pay with exact effect.
    function test_refund_paysTheSenderAfterTheDelayOnce() public {
        bytes32 nonce = _depositOnA(100e18);
        vm.expectRevert("Deposit record target tracking profile absent");
        vaultA.requestRefund(keccak256("unknown"));

        vm.warp(block.timestamp + vaultA.REFUND_DELAY() - 1);
        vm.expectRevert("Refund lock safety window active");
        vaultA.requestRefund(nonce);

        vm.warp(block.timestamp + 1);
        vm.expectEmit(true, true, true, true, address(vaultA));
        emit ZKBridgeVault.DepositRefunded(nonce, address(tokenA), alice, 100e18);
        vm.prank(bob);
        vaultA.requestRefund(nonce);
        assertEq(tokenA.balanceOf(alice), 100e18, "the sender is paid, whoever calls");
        assertEq(tokenA.balanceOf(address(vaultA)), 0);

        vm.expectRevert("Refund allocation profile already processed");
        vaultA.requestRefund(nonce);
    }

    /// Claim (red team, passes when the defect is real): a deposit that was paid on the other chain can still be
    /// refunded, because the refund needs no proof. Shows: bob withdraws on chain B, then alice refunds on chain A.
    function test_refund_paidDepositCanAlsoBeRefunded() public {
        bytes32 nonce = _depositOnA(100e18);
        _attest(ROOT);
        bytes memory values = _publicValues(address(vaultA), address(tokenA), bob, 100e18, nonce, ROOT);
        _claim(vaultB, values);
        assertEq(tokenB.balanceOf(bob), 100e18, "paid on chain B");

        vm.warp(block.timestamp + vaultA.REFUND_DELAY());
        vaultA.requestRefund(nonce);
        assertEq(tokenA.balanceOf(alice), 100e18, "and refunded on chain A: one deposit, two payouts");
    }
}
