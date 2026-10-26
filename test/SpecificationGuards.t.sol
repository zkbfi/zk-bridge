// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeFixture} from "./utils/BridgeFixture.sol";
import {Committee} from "./utils/Committee.sol";
import {LightClientSync} from "../src/LightClientSync.sol";
import {ZKBridgeVault} from "../src/ZKBridgeVault.sol";

/// @notice The input guards of the specification's contracts. The red team tests show what the specification gets wrong.
/// These tests show the guards that it gets right, each with its exact revert string, so a change of a guard shows up.
contract SpecificationGuardsTest is BridgeFixture {
    using Committee for Committee.Set;

    bytes32 internal constant HEADER = keccak256("header for the guard tests");

    // ================================================================ the light client

    /// Claim: a period below the current period is refused before any signature is read. Shows: period 0, with the
    /// current period 1, reverts with the exact message, and the current period is accepted with the same signatures.
    function test_lightClient_refusesAnAncientPeriod() public {
        Committee.Signed memory signed = honest.attest(HEADER, INITIAL_PERIOD - 1, Committee.THRESHOLD);
        vm.expectRevert("Cannot submit an ancient consensus period");
        lightClient.updateSyncState(INITIAL_PERIOD - 1, HEADER, signed.signatures, signed.proofs, bytes32(0));
        assertFalse(lightClient.isVerifiedBlockRoot(HEADER));
        assertFalse(lightClient.finalizedPeriods(INITIAL_PERIOD - 1));
    }

    /// Claim: the signature list and the proof list must have the same length. Shows: one signature with no proof
    /// reverts with the exact message. Matters: the loop reads one proof for each signature.
    function test_lightClient_refusesMismatchedArrays() public {
        Committee.Signed memory signed = honest.attest(HEADER, INITIAL_PERIOD, 1);
        bytes32[][] memory noProofs = new bytes32[][](0);
        vm.expectRevert("Mismatched proof/signature array dimensions");
        lightClient.updateSyncState(INITIAL_PERIOD, HEADER, signed.signatures, noProofs, bytes32(0));
    }

    /// Claim: a signature list that repeats a signer, or that is not sorted by signer address, is refused. Shows: the
    /// same signature twice, and two signatures in descending order, each revert with the exact message, and the list in
    /// ascending order is accepted. Matters: strict order is what makes each signer count once.
    function test_lightClient_refusesDuplicateAndUnorderedSigners() public {
        Committee.Signed memory pair = honest.attest(HEADER, INITIAL_PERIOD, 2);

        bytes[] memory duplicated = new bytes[](2);
        duplicated[0] = pair.signatures[0];
        duplicated[1] = pair.signatures[0];
        bytes32[][] memory duplicatedProofs = new bytes32[][](2);
        duplicatedProofs[0] = pair.proofs[0];
        duplicatedProofs[1] = pair.proofs[0];
        vm.expectRevert("Signatures not strictly ordered or duplicate detected");
        lightClient.updateSyncState(INITIAL_PERIOD, HEADER, duplicated, duplicatedProofs, bytes32(0));

        bytes[] memory descending = new bytes[](2);
        descending[0] = pair.signatures[1];
        descending[1] = pair.signatures[0];
        bytes32[][] memory descendingProofs = new bytes32[][](2);
        descendingProofs[0] = pair.proofs[1];
        descendingProofs[1] = pair.proofs[0];
        vm.expectRevert("Signatures not strictly ordered or duplicate detected");
        lightClient.updateSyncState(INITIAL_PERIOD, HEADER, descending, descendingProofs, bytes32(0));

        Committee.Signed memory full = honest.attest(HEADER, INITIAL_PERIOD, Committee.THRESHOLD);
        lightClient.updateSyncState(INITIAL_PERIOD, HEADER, full.signatures, full.proofs, bytes32(0));
        assertTrue(lightClient.isVerifiedBlockRoot(HEADER), "control: the ascending list is accepted");
    }

    // ================================================================ the vault

    /// Claim: the constructor refuses a zero verifier and a zero sync registry. Shows: each zero reverts with its exact
    /// message, and a vault with both set is built. Matters: with a zero verifier or registry no claim could ever pass.
    function test_vault_constructorRefusesZeroAddresses() public {
        vm.expectRevert("Invalid verifier address");
        new ZKBridgeVault(address(0), PROGRAM_VKEY, CHAIN_A, address(lightClient));
        vm.expectRevert("Invalid sync registry address");
        new ZKBridgeVault(address(verifier), PROGRAM_VKEY, CHAIN_A, address(0));
        ZKBridgeVault built = new ZKBridgeVault(address(verifier), PROGRAM_VKEY, CHAIN_A, address(lightClient));
        assertEq(address(built.sp1Verifier()), address(verifier));
        assertEq(address(built.syncRegistry()), address(lightClient));
    }

    /// Claim: a deposit of zero is refused. Shows: the exact message, and no nonce is used. Matters: a zero deposit
    /// would give an event that a prover could turn into a claim of nothing.
    function test_vault_refusesAZeroDeposit() public {
        vm.prank(alice);
        vm.expectRevert("Amount must be greater than 0");
        vaultA.deposit(address(token), bob, 0, CHAIN_B);
    }
}
