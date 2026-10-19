// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {BridgeFixture} from "./utils/BridgeFixture.sol";
import {ZKBridgeVault} from "../src/ZKBridgeVault.sol";
import {FakeDepositEmitter} from "../src/mocks/FakeDepositEmitter.sol";

/// @notice Red-team tests about what a withdrawal claim proves: H-02 and H-16.
/// Every test passes when the attack succeeds.
contract VaultClaimsTest is BridgeFixture {
    // ------------------------------------------------------------------ H-02

    /// Specification claim: a withdrawal needs a proof that a real deposit happened on the source vault.
    /// What the test shows: `BridgeInputs` names no source vault, so a contract that only emits the same
    /// `DepositInitiated` event (and holds no tokens) yields a claim the vault pays. Here the prover
    /// signs the inputs, which models a sound circuit that sees only the event topic. The harness
    /// proves the same attack end to end with a real receipts trie.
    function test_H02_fakeDepositEmitterWithdrawsRealTokens() public {
        FakeDepositEmitter emitter = new FakeDepositEmitter();
        bytes32 fakeNonce = keccak256("fake nonce");
        uint256 stolen = 1_000e18;

        // The attacker emits the vault's event with nothing behind it.
        vm.recordLogs();
        vm.prank(attacker);
        emitter.fakeDeposit(address(token), attacker, stolen, fakeNonce, CHAIN_B);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[0].topics[0], ZKBridgeVault.DepositInitiated.selector, "same event signature as the vault");
        assertEq(token.balanceOf(address(emitter)), 0, "no tokens behind the fake deposit");
        assertEq(token.balanceOf(address(vaultA)), 0, "the real vault received nothing");

        // The committee attests the block that holds the fake event.
        bytes32 blockRoot = keccak256("block that holds the fake deposit event");
        _honestUpdate(blockRoot, INITIAL_PERIOD);

        // Control: a statement the prover did not sign is refused, so the attack needs a valid proof,
        // and the prover cannot tell the fake emitter from the real vault.
        bytes memory publicInputsBytes = abi.encode(_inputs(address(token), attacker, stolen, fakeNonce, blockRoot));
        vm.expectRevert("Invalid cryptographic bridge proof");
        vaultB.withdraw(new bytes(65), publicInputsBytes);

        vaultB.withdraw(_prove(publicInputsBytes), publicInputsBytes);
        assertEq(token.balanceOf(attacker), stolen, "attacker withdraws real tokens");
        assertEq(token.balanceOf(address(vaultB)), LIQUIDITY - stolen);
    }

    // ------------------------------------------------------------------ H-16

    /// Specification claim: a withdrawal proves a deposit on the source chain.
    /// What the test shows: `withdraw` never reads `sourceChainId`. A claim that names chain 999 (no
    /// bridge exists there), or the paying chain itself, is paid. The nonce does not include the source
    /// chain or the source vault either.
    function test_H16_arbitrarySourceChainIdIsAccepted() public {
        bytes32 blockRoot = keccak256("block");
        _honestUpdate(blockRoot, INITIAL_PERIOD);

        ZKBridgeVault.BridgeInputs memory inputs = _inputs(address(token), bob, 10e18, keccak256("n1"), blockRoot);
        inputs.sourceChainId = 999;

        // Control: the target chain id is checked, so a wrong target is refused.
        ZKBridgeVault.BridgeInputs memory wrongTarget = _inputs(address(token), bob, 10e18, keccak256("n1"), blockRoot);
        wrongTarget.sourceChainId = 999;
        wrongTarget.targetChainId = 56;
        bytes memory wrongBytes = abi.encode(wrongTarget);
        bytes memory wrongProof = _prove(wrongBytes);
        vm.expectRevert("Invalid target chain execution");
        vaultB.withdraw(wrongProof, wrongBytes);

        _withdraw(vaultB, inputs);
        assertEq(token.balanceOf(bob), 10e18, "source chain 999 is paid");

        // The paying chain as its own source is paid too.
        inputs.sourceChainId = CHAIN_B;
        inputs.depositNonce = keccak256("n2");
        _withdraw(vaultB, inputs);
        assertEq(token.balanceOf(bob), 20e18, "source chain equal to the paying chain is paid");
    }
}
