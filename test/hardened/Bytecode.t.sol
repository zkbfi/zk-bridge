// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HardenedFixture} from "./utils/HardenedFixture.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {GateGenuineBeaconRoots} from "./utils/GateMocks.sol";
import {ForkRegistry} from "../../src/hardened/ForkRegistry.sol";

/// @notice PulseChain stopped at Shanghai. It rejects MCOPY (0x5e) and TSTORE (0x5d). These tests scan the deployed
/// runtime bytecode of the hardened contracts, skipping the data bytes that follow PUSH1 to PUSH32.
contract BytecodeTest is HardenedFixture {
    uint8 internal constant TSTORE = 0x5d;
    uint8 internal constant MCOPY = 0x5e;
    uint8 internal constant TLOAD = 0x5c;
    uint8 internal constant BLOBBASEFEE = 0x4a;
    uint8 internal constant CLZ = 0x1e;

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

    /// Claim: no hardened contract contains MCOPY or TSTORE (or TLOAD). Shows: the count is zero for each opcode in
    /// the runtime code of the light client, both vaults and both fork gates (detection mode and enforcing mode), with
    /// the vendored libraries linked in. Matters: R2-10 (the repository compiled for cancun, and PulseChain rejects
    /// those opcodes). The gate is deployed on PulseChain too. The storage reentrancy guard, not the transient one, is
    /// what makes this pass for the vault.
    function test_R2_10_noMcopyOrTstoreInHardenedBytecode() public {
        bytes[5] memory codes = [
            address(lightClientForA).code,
            address(vaultA).code,
            address(vaultB).code,
            address(gateA).code,
            address(_newGate(BeaconForkGate.GateMode.Enforcing)).code
        ];
        for (uint256 i = 0; i < codes.length; i++) {
            assertGt(codes[i].length, 1000, "the contract has code");
            _assertNoNewOpcodes(codes[i]);
        }
    }

    function _assertNoNewOpcodes(bytes memory code) internal pure {
        assertEq(_countOpcode(code, MCOPY), 0, "no MCOPY");
        assertEq(_countOpcode(code, TSTORE), 0, "no TSTORE");
        assertEq(_countOpcode(code, TLOAD), 0, "no TLOAD");
    }

    /// Claim: the fork gate contains none of the three opcodes, checked on its own. Shows: zero counts on the runtime
    /// code of the gate in both modes. Matters: HB-02, the same gate bytecode runs on PulseChain (stopped at
    /// Shanghai).
    function test_HB02_noMcopyOrTstoreInForkGateBytecode() public {
        bytes memory detecting = address(gateB).code;
        bytes memory enforcing = address(_newGate(BeaconForkGate.GateMode.Enforcing)).code;
        assertGt(detecting.length, 1000);
        assertGt(enforcing.length, 1000);
        _assertNoNewOpcodes(detecting);
        _assertNoNewOpcodes(enforcing);
    }

    /// Claim: the genuine EIP-4788 runtime code has none of the opcodes, and a deliberately bad snippet is caught.
    /// Shows: zero counts for the genuine code (a control that the scanner reads real code without false alarms),
    /// and one count each for a snippet of `TLOAD TSTORE MCOPY`. Matters: a scanner that never fails proves nothing.
    function test_HB02_scannerControl_genuineCodeIsCleanAndABadSnippetIsCaught() public pure {
        _assertNoNewOpcodes(GateGenuineBeaconRoots.code());
        bytes memory bad = hex"5c5d5e";
        assertEq(_countOpcode(bad, TLOAD), 1);
        assertEq(_countOpcode(bad, TSTORE), 1);
        assertEq(_countOpcode(bad, MCOPY), 1);
        // a bad opcode after push data is still found, and one inside push data is not
        assertEq(_countOpcode(hex"605d5e", MCOPY), 1);
        assertEq(_countOpcode(hex"605e5d", MCOPY), 0);
    }

    /// Claim: the contracts, the fork gate included, fit the 24576-byte limit. Shows: the sizes. Matters: a
    /// deployable contract on both chains.
    function test_R2_10_hardenedContractsFitTheSizeLimit() public view {
        assertLt(address(lightClientForA).code.length, 24_576);
        assertLt(address(vaultA).code.length, 24_576);
        assertLt(address(gateA).code.length, 24_576);
    }

    /// Claim: the fork gate (in all three modes) and the fork registry contain none of the five canary opcodes, and
    /// each probe contract contains exactly its own opcode and no other. Shows: the scan counts zero of TSTORE, TLOAD,
    /// MCOPY, BLOBBASEFEE and CLZ in the runtime code of the gate and of the registry; then it scans the four probes
    /// the gate deployed and finds exactly one canary opcode in each, the one named in its comment. Matters: the gate
    /// and the registry run on PulseChain, which rejects the new opcodes. The probes are the only code that may
    /// contain them, and the scan excludes exactly those four runtime codes (the addresses that the gate exposes), not
    /// anything else. A probe with a second or a wrong opcode would watch for the wrong fork.
    function test_HB02_canaryOpcodesLiveOnlyInTheProbes() public {
        ForkRegistry registry = new ForkRegistry(address(lightClientForA), address(verifier), keccak256("observation"));
        BeaconForkGate registryGate = new BeaconForkGate(
            BEACON_ROOTS,
            BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry,
            1_606_824_023,
            12,
            32,
            _versions(),
            _sealDepths(),
            address(registry)
        );
        bytes[5] memory scanned = [
            address(gateA).code,
            address(gateB).code,
            address(_newGate(BeaconForkGate.GateMode.Enforcing)).code,
            address(registryGate).code,
            address(registry).code
        ];
        for (uint256 i = 0; i < scanned.length; i++) {
            assertGt(scanned[i].length, 500, "the contract has code");
            _assertNoNewOpcodes(scanned[i]);
            assertEq(_countOpcode(scanned[i], BLOBBASEFEE), 0, "no BLOBBASEFEE");
            assertEq(_countOpcode(scanned[i], CLZ), 0, "no CLZ");
        }

        // The probes: the excluded code, scanned for exactly its own opcode.
        uint8[5] memory canaryOpcodes = [TSTORE, MCOPY, BLOBBASEFEE, CLZ, TLOAD];
        address[4] memory probes =
            [registryGate.tstoreProbe(), registryGate.mcopyProbe(), registryGate.blobBaseFeeProbe(), registryGate.clzProbe()];
        for (uint256 p = 0; p < probes.length; p++) {
            bytes memory code = probes[p].code;
            for (uint256 o = 0; o < canaryOpcodes.length; o++) {
                uint256 expected = o == p ? 1 : 0;
                assertEq(_countOpcode(code, canaryOpcodes[o]), expected, "a probe holds only its own opcode");
            }
        }
    }

    function _versions() internal pure returns (BeaconForkGate.SupportedVersion[] memory versions) {
        versions = new BeaconForkGate.SupportedVersion[](1);
        versions[0] = BeaconForkGate.SupportedVersion(0x05000000, 6);
    }

    function _sealDepths() internal pure returns (uint8[] memory depths) {
        depths = new uint8[](1);
        depths[0] = 6;
    }

    /// Claim: the scanner finds the two new canary opcodes. Shows: BLOBBASEFEE (0x4a) and CLZ (0x1e) count once as
    /// instructions and zero inside push data. Matters: a scanner blind to them would pass a gate that contained them.
    function test_HB02_scannerSeesBlobBaseFeeAndClz() public pure {
        assertEq(_countOpcode(hex"4a1e", BLOBBASEFEE), 1);
        assertEq(_countOpcode(hex"4a1e", CLZ), 1);
        assertEq(_countOpcode(hex"601e604a", CLZ), 0);
        assertEq(_countOpcode(hex"601e604a", BLOBBASEFEE), 0);
    }
}
