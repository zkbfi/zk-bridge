// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HardenedFixture} from "./utils/HardenedFixture.sol";

/// @notice PulseChain stopped at Shanghai. It rejects MCOPY (0x5e) and TSTORE (0x5d). These tests scan the deployed
/// runtime bytecode of the hardened contracts, skipping the data bytes that follow PUSH1 to PUSH32.
contract BytecodeTest is HardenedFixture {
    uint8 internal constant TSTORE = 0x5d;
    uint8 internal constant MCOPY = 0x5e;
    uint8 internal constant TLOAD = 0x5c;

    /// @notice Counts how many times `opcode` appears as an instruction (not as push data).
    function _countOpcode(bytes memory code, uint8 opcode) internal pure returns (uint256 count) {
        uint256 i = 0;
        while (i < code.length) {
            uint8 current = uint8(code[i]);
            if (current == opcode) count++;
            if (current >= 0x60 && current <= 0x7f) i += uint256(current) - 0x5f; // skip the push data
            i++;
        }
    }

    // ---------------------------------------------------------------- the scanner itself

    /// Claim: the scanner finds an opcode that is an instruction. Shows: 0x5e alone and 0x5d after a push count once.
    /// Matters: a scanner that finds nothing would pass a bad contract (control for the tests below).
    function test_R2_10_scannerFindsRealInstructions() public pure {
        assertEq(_countOpcode(hex"5e", MCOPY), 1);
        assertEq(_countOpcode(hex"6001" hex"5d", TSTORE), 1);
        assertEq(_countOpcode(hex"5e5e5d", MCOPY), 2);
    }

    /// Claim: the scanner skips push data. Shows: 0x5e and 0x5d inside PUSH1, PUSH2 and PUSH32 data do not count, and
    /// the instruction after the data is still seen. Matters: constants such as `0x5e` appear in real code.
    function test_R2_10_scannerSkipsPushData() public pure {
        assertEq(_countOpcode(hex"605e", MCOPY), 0);
        assertEq(_countOpcode(hex"615d5e", TSTORE), 0);
        assertEq(_countOpcode(abi.encodePacked(hex"7f", bytes32(uint256(0x5e5e5e5e)), hex"5e"), MCOPY), 1);
    }

    // ---------------------------------------------------------------- the contracts

    /// Claim: neither hardened contract contains MCOPY or TSTORE (or TLOAD). Shows: the count is zero for each opcode in
    /// the runtime code of the light client and of both vaults, with the vendored libraries linked in. Matters: R2-10
    /// (the repository compiled for cancun, and PulseChain rejects those opcodes). The storage reentrancy guard, not the
    /// transient one, is what makes this pass for the vault.
    function test_R2_10_noMcopyOrTstoreInHardenedBytecode() public view {
        bytes[3] memory codes = [address(lightClientForA).code, address(vaultA).code, address(vaultB).code];
        for (uint256 i = 0; i < codes.length; i++) {
            assertGt(codes[i].length, 1000, "the contract has code");
            assertEq(_countOpcode(codes[i], MCOPY), 0, "no MCOPY");
            assertEq(_countOpcode(codes[i], TSTORE), 0, "no TSTORE");
            assertEq(_countOpcode(codes[i], TLOAD), 0, "no TLOAD");
        }
    }

    /// Claim: the contracts fit the 24576-byte limit. Shows: the sizes. Matters: a deployable contract on both chains.
    function test_R2_10_hardenedContractsFitTheSizeLimit() public view {
        assertLt(address(lightClientForA).code.length, 24_576);
        assertLt(address(vaultA).code.length, 24_576);
    }
}
