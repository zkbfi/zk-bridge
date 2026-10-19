// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {BridgeFixture} from "./utils/BridgeFixture.sol";
import {ZKBridgeVault} from "../src/ZKBridgeVault.sol";
import {RealShapeSP1Verifier} from "../src/mocks/RealShapeSP1Verifier.sol";

/// @notice Red-team tests about funds that lock or claims that fail: H-09, H-10, H-11, H-12.
/// Every test passes when the attack succeeds.
contract VaultLivenessTest is BridgeFixture {
    // ------------------------------------------------------------------ H-09

    /// Specification claim: "100% immutable", "adminless", users can always bridge and claim.
    /// What the test shows: the paying vault has no liquidity of its own. With zero balance, the claim
    /// reverts. The source vault has no refund function, so the deposit stays locked.
    function test_H09_emptyDestinationVaultLocksDepositForever() public {
        ZKBridgeVault emptyVault = new ZKBridgeVault(address(verifier), PROGRAM_VKEY, CHAIN_B, address(lightClient));

        token.mint(alice, 100e18);
        bytes32 nonce = _deposit(vaultA, address(token), alice, alice, 100e18, CHAIN_B);
        bytes32 blockRoot = keccak256("block with the deposit");
        _honestUpdate(blockRoot, INITIAL_PERIOD);

        ZKBridgeVault.BridgeInputs memory inputs = _inputs(address(token), alice, 100e18, nonce, blockRoot);
        bytes memory publicInputsBytes = abi.encode(inputs);
        bytes memory proof = _prove(publicInputsBytes);

        // The claim reverts: the paying vault holds nothing.
        vm.expectRevert(
            abi.encodeWithSignature("ERC20InsufficientBalance(address,uint256,uint256)", address(emptyVault), 0, 100e18)
        );
        emptyVault.withdraw(proof, publicInputsBytes);

        // The source vault will not release it: its only exit is `withdraw`, which needs targetChainId == 1.
        vm.expectRevert("Invalid target chain execution");
        vaultA.withdraw(proof, publicInputsBytes);

        // No refund path exists under any plausible name.
        string[5] memory signatures = [
            "refund(bytes32)",
            "refund(address,uint256)",
            "emergencyWithdraw(address)",
            "rescue(address,uint256)",
            "cancelDeposit(bytes32)"
        ];
        for (uint256 i = 0; i < signatures.length; i++) {
            (bool ok,) = address(vaultA).call(abi.encodeWithSignature(signatures[i], nonce));
            assertFalse(ok, "unknown selector must revert");
        }
        (bool received,) = address(vaultA).call{value: 0}("");
        assertFalse(received, "no fallback function");
        assertEq(token.balanceOf(address(vaultA)), 100e18, "tokens stay locked");
        assertEq(token.balanceOf(alice), 0);

        // Control: the only missing piece is liquidity. Once someone funds the paying vault, the same
        // claim is paid.
        token.mint(address(emptyVault), 100e18);
        emptyVault.withdraw(proof, publicInputsBytes);
        assertEq(token.balanceOf(alice), 100e18);
    }

    // ------------------------------------------------------------------ H-10

    /// Specification claim: `deposit` guards the target ("Cannot bridge to the same chain").
    /// What the test shows: any other target id, such as 56 or 0, is accepted and locks the tokens.
    /// No vault exists on that chain, and no refund exists here.
    function test_H10_depositToUnsupportedChainLocksTokens() public {
        token.mint(alice, 300e18);

        // Control: the only guard is the same-chain check.
        vm.startPrank(alice);
        token.approve(address(vaultA), type(uint256).max);
        vm.expectRevert("Cannot bridge to the same chain");
        vaultA.deposit(address(token), alice, 100e18, CHAIN_A);
        vm.stopPrank();

        _deposit(vaultA, address(token), alice, alice, 100e18, 56);
        _deposit(vaultA, address(token), alice, alice, 100e18, 0);
        assertEq(token.balanceOf(address(vaultA)), 200e18, "tokens locked for chain 56 and chain 0");
        assertEq(token.balanceOf(alice), 100e18);
    }

    // ------------------------------------------------------------------ H-11

    /// Specification claim: the vault works with "production verifiers" for SP1.
    /// What the test shows: the real SP1 gateway has `verifyProof(bytes32,bytes,bytes)`, not
    /// `verify(bytes32,bytes32,bytes)`. A vault wired to a verifier of the real shape reverts on every
    /// withdrawal, even with a proof that this verifier accepts.
    function test_H11_realShapeVerifierBreaksEveryWithdrawal() public {
        RealShapeSP1Verifier realVerifier = new RealShapeSP1Verifier();
        ZKBridgeVault realVault = new ZKBridgeVault(address(realVerifier), PROGRAM_VKEY, CHAIN_B, address(lightClient));
        token.mint(address(realVault), 100e18);

        bytes32 blockRoot = keccak256("block");
        _honestUpdate(blockRoot, INITIAL_PERIOD);
        bytes memory publicInputsBytes =
            abi.encode(_inputs(address(token), bob, 100e18, keccak256("nonce"), blockRoot));
        bytes memory validForRealVerifier = hex"01";

        // Control 1: this proof is valid for the real-shaped verifier, and an invalid one reverts there.
        realVerifier.verifyProof(PROGRAM_VKEY, publicInputsBytes, validForRealVerifier);
        vm.expectRevert(RealShapeSP1Verifier.InvalidProof.selector);
        realVerifier.verifyProof(PROGRAM_VKEY, publicInputsBytes, hex"02");

        // The vault calls a selector the verifier lacks, so it reverts with no data.
        vm.expectRevert();
        realVault.withdraw(validForRealVerifier, publicInputsBytes);
        assertEq(token.balanceOf(bob), 0);

        // Control 2: the same claim works through the specification-shaped mock verifier.
        _withdraw(vaultB, _inputs(address(token), bob, 100e18, keccak256("nonce"), blockRoot));
        assertEq(token.balanceOf(bob), 100e18);
    }

    // ------------------------------------------------------------------ H-12

    /// Specification claim: "a mathematically deterministic unique nonce".
    /// What the test shows: the nonce hashes sender, recipient, amount, timestamp and prevrandao. Two
    /// equal deposits from one sender in one block share a nonce. Only one can ever be claimed, and the
    /// tokens of the second stay locked.
    function test_H12_identicalDepositsInOneBlockShareOneNonce() public {
        token.mint(alice, 200e18);
        bytes32 first = _deposit(vaultA, address(token), alice, bob, 100e18, CHAIN_B);
        bytes32 second = _deposit(vaultA, address(token), alice, bob, 100e18, CHAIN_B);
        assertEq(first, second, "same nonce");
        assertEq(token.balanceOf(address(vaultA)), 200e18, "both deposits locked tokens");

        bytes32 blockRoot = keccak256("block with both deposits");
        _honestUpdate(blockRoot, INITIAL_PERIOD);
        ZKBridgeVault.BridgeInputs memory inputs = _inputs(address(token), bob, 100e18, first, blockRoot);
        _withdraw(vaultB, inputs);
        assertEq(token.balanceOf(bob), 100e18);

        bytes memory publicInputsBytes = abi.encode(inputs);
        bytes memory proof = _prove(publicInputsBytes);
        vm.expectRevert("Bridge transaction already claimed");
        vaultB.withdraw(proof, publicInputsBytes);
        assertEq(token.balanceOf(address(vaultA)), 200e18, "second deposit is lost to the sender");

        // Control: the same deposit in a later block (new timestamp) gets a different nonce.
        vm.warp(block.timestamp + 12);
        token.mint(alice, 100e18);
        bytes32 later = _deposit(vaultA, address(token), alice, bob, 100e18, CHAIN_B);
        assertTrue(later != first, "different block, different nonce");
    }
}
