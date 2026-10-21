// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Revision2Fixture} from "./Revision2Fixture.sol";
import {ZKBridgeVault} from "../../src/revision-2/ZKBridgeVault.sol";

/// @notice R2-10 (bytecode must run on PulseChain, which stopped at Shanghai) and R2-02 (event topic).
contract BytecodeRevision2Test is Revision2Fixture {
    uint8 internal constant TSTORE = 0x5d;
    uint8 internal constant TLOAD = 0x5c;
    uint8 internal constant MCOPY = 0x5e;

    /// @dev Walks the bytecode and skips PUSH data, so a data byte that equals an opcode is not a false hit.
    function _containsOpcode(bytes memory code, uint8 target) internal pure returns (bool) {
        uint256 i = 0;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op == target) return true;
            if (op >= 0x60 && op <= 0x7f) i += uint256(op) - 0x5f;
            i++;
        }
        return false;
    }

    /// Claim (R2-10): the build targets Shanghai, so the bytecode has no MCOPY, TSTORE, or TLOAD.
    /// What the test shows: the fix holds for both revision 2 contracts as compiled in this repository.
    /// Control: the scanner finds each forbidden opcode in a hand-made sample, and ignores the same byte inside PUSH data.
    function test_R2_10_fixConfirmed_revision2BytecodeHasNoCancunOpcodes() public view {
        bytes[3] memory codes = [address(vaultA).code, address(vaultB).code, address(lightClient).code];
        for (uint256 i = 0; i < codes.length; i++) {
            assertFalse(_containsOpcode(codes[i], MCOPY), "no MCOPY");
            assertFalse(_containsOpcode(codes[i], TSTORE), "no TSTORE");
            assertFalse(_containsOpcode(codes[i], TLOAD), "no TLOAD");
        }
        assertTrue(_containsOpcode(hex"5e", MCOPY), "control: finds MCOPY");
        assertTrue(_containsOpcode(hex"5d", TSTORE), "control: finds TSTORE");
        assertTrue(_containsOpcode(hex"600160015d", TSTORE), "control: finds TSTORE after PUSH1 operands");
        assertFalse(_containsOpcode(hex"605e", MCOPY), "control: a PUSH1 operand of 0x5e is data, not MCOPY");
    }

    /// Revision 2 claim: the circuit matches deposit logs by the topic 0 constant `0x2df9...c1ee`.
    /// What the test shows (R2-02): the vault emits `DepositInitiated` with topic 0 equal to the keccak-256 of
    /// its signature, and that value differs from the circuit constant. No log from the vault matches.
    /// Why it matters: no deposit can ever be proven. Control: the emitted topic equals the signature hash.
    function test_R2_02_circuitTopicConstantIsNotTheVaultEventTopic() public {
        bytes32 circuitConstant = 0x2df93605658e38812f86230cb85b0d0c35583b27b9c9769f36b6fbfda3d8c1ee;
        bytes32 signatureHash = keccak256("DepositInitiated(address,address,address,uint256,bytes32,uint64)");
        assertEq(vaultA.currentChainId(), CHAIN_A); // the vault is live
        tokenA.mint(alice, 1e18);
        vm.recordLogs();
        vm.startPrank(alice);
        tokenA.approve(address(vaultA), 1e18);
        vaultA.deposit(address(tokenA), bob, 1e18, CHAIN_B);
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawDeposit;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(vaultA)) continue;
            sawDeposit = true;
            assertEq(logs[i].topics[0], signatureHash, "control: the vault emits the signature hash");
            assertTrue(logs[i].topics[0] != circuitConstant, "the circuit constant never matches");
            assertEq(logs[i].topics.length, 4, "topic 0 plus three indexed parameters");
        }
        assertTrue(sawDeposit);
        assertEq(signatureHash, ZKBridgeVault.DepositInitiated.selector);
        assertTrue(circuitConstant != signatureHash);
    }
}
