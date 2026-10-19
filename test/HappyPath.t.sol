// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeFixture} from "./utils/BridgeFixture.sol";

/// @notice Baseline. The attacks in the other files only mean something if the honest flow works.
contract HappyPathTest is BridgeFixture {
    /// deposit on the source vault, light client update, withdraw on the paying vault.
    function test_happyPath_depositUpdateWithdraw() public {
        token.mint(alice, 100e18);
        bytes32 nonce = _deposit(vaultA, address(token), alice, bob, 100e18, CHAIN_B);
        assertEq(token.balanceOf(address(vaultA)), 100e18, "source vault locks the deposit");

        bytes32 blockRoot = keccak256("block that contains the deposit");
        _honestUpdate(blockRoot, INITIAL_PERIOD);
        assertTrue(lightClient.isVerifiedBlockRoot(blockRoot));

        _withdraw(vaultB, _inputs(address(token), bob, 100e18, nonce, blockRoot));
        assertEq(token.balanceOf(bob), 100e18, "recipient is paid from pre-seeded liquidity");
        assertEq(token.balanceOf(address(vaultB)), LIQUIDITY - 100e18);
        assertTrue(vaultB.processedNonces(nonce));
    }

    /// Without a verified block root the same proof is refused.
    function test_happyPath_unverifiedBlockRootIsRefused() public {
        token.mint(alice, 100e18);
        bytes32 nonce = _deposit(vaultA, address(token), alice, bob, 100e18, CHAIN_B);
        bytes32 blockRoot = keccak256("unattested block");
        bytes memory publicInputsBytes = abi.encode(_inputs(address(token), bob, 100e18, nonce, blockRoot));
        bytes memory proof = _prove(publicInputsBytes);
        vm.expectRevert("Block root not yet confirmed by consensus layer");
        vaultB.withdraw(proof, publicInputsBytes);
    }

    /// A proof not signed by the prover oracle is refused, and a claim cannot be replayed.
    function test_happyPath_badProofAndReplayAreRefused() public {
        token.mint(alice, 100e18);
        bytes32 nonce = _deposit(vaultA, address(token), alice, bob, 100e18, CHAIN_B);
        bytes32 blockRoot = keccak256("block");
        _honestUpdate(blockRoot, INITIAL_PERIOD);
        bytes memory publicInputsBytes = abi.encode(_inputs(address(token), bob, 100e18, nonce, blockRoot));

        vm.expectRevert("Invalid cryptographic bridge proof");
        vaultB.withdraw(hex"00", publicInputsBytes);

        vaultB.withdraw(_prove(publicInputsBytes), publicInputsBytes);
        bytes memory proof = _prove(publicInputsBytes);
        vm.expectRevert("Bridge transaction already claimed");
        vaultB.withdraw(proof, publicInputsBytes);
    }
}
