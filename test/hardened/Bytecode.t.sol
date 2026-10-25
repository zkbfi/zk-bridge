// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessageScenes} from "./utils/MessageScenes.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {GateGenuineBeaconRoots} from "./utils/GateMocks.sol";
import {ForkRegistry} from "../../src/hardened/ForkRegistry.sol";
import {TokenMediator} from "../../src/hardened/mediator/TokenMediator.sol";
import {TokenFactory} from "../../src/hardened/mediator/TokenFactory.sol";
import {WETHOmnibridgeRouter} from "../../src/hardened/mediator/WETHOmnibridgeRouter.sol";
import {FeeRouter} from "../../src/hardened/mediator/FeeRouter.sol";
import {ITokenMediator} from "../../src/hardened/mediator/ITokenMediator.sol";
import {IWETH} from "../../src/hardened/mediator/IWETH.sol";
import {MockWrappedNative} from "./mediator/utils/MediatorSupport.sol";

/// @notice PulseChain stopped at Shanghai. It rejects MCOPY (0x5e) and TSTORE (0x5d). These tests scan the deployed
/// runtime bytecode of the hardened contracts, skipping the data bytes that follow PUSH1 to PUSH32.
contract BytecodeTest is MessageScenes {
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

    /// @dev A mediator, its factory, one bridged copy, and the two routers, built on the destination bridge. The
    /// factory deploys the copy when its mediator asks, so the copy is real runtime code of the factory.
    function _mediatorContracts()
        internal
        returns (
            TokenMediator mediator,
            TokenFactory factory,
            address copy,
            WETHOmnibridgeRouter wethRouter,
            FeeRouter feeRouter
        )
    {
        mediator = new TokenMediator(
            TokenMediator.MediatorTerms({
                bridge: address(bridge),
                remoteMediator: makeAddr("remote mediator"),
                remoteChainId: CHAIN_A,
                feeAuthority: address(0),
                feeRecipient: address(0),
                feeBasisPoints: 0,
                feeCeilingBasisPoints: 0,
                flowLimiter: address(0)
            })
        );
        factory = mediator.tokenFactory();
        vm.prank(address(mediator));
        copy = factory.deploy("Copy", "CPY", 18, CHAIN_A, makeAddr("native token"));
        IWETH wrapped = IWETH(address(new MockWrappedNative()));
        wethRouter = new WETHOmnibridgeRouter(ITokenMediator(address(mediator)), wrapped);
        feeRouter = new FeeRouter(ITokenMediator(address(mediator)), wrapped);
    }

    /// @dev The runtime code of every contract that runs on both chains, with the names that the logs print. The fork
    /// gate in enforcing mode and the fork registry are scanned in other tests, with the probe.
    function _deployedContracts() internal returns (string[9] memory names, bytes[9] memory codes) {
        (TokenMediator mediator, TokenFactory factory, address copy, WETHOmnibridgeRouter wethRouter, FeeRouter feeRouter) =
            _mediatorContracts();
        names = [
            "BeaconLightClient",
            "MessageBridge (source)",
            "MessageBridge (destination)",
            "BeaconForkGate",
            "TokenMediator",
            "TokenFactory",
            "BridgedToken",
            "WETHOmnibridgeRouter",
            "FeeRouter"
        ];
        codes = [
            address(lightClientForA).code,
            address(sourceBridge).code,
            address(bridge).code,
            address(gateA).code,
            address(mediator).code,
            address(factory).code,
            copy.code,
            address(wethRouter).code,
            address(feeRouter).code
        ];
    }

    /// Claim: no hardened contract contains MCOPY or TSTORE (or TLOAD). Shows: the count is zero for each opcode in
    /// the runtime code of the light client, both message bridges, the fork gate (detection mode and enforcing mode),
    /// the token mediator, its factory, a bridged token, the wrapped coin router and the fee router, with the vendored
    /// libraries linked in. Matters: R2-10 (the repository compiled for cancun, and PulseChain rejects those
    /// opcodes). Every contract that runs on both chains must pass. The storage reentrancy guard, not the transient
    /// one, is what makes this pass for the bridge and the mediator.
    function test_R2_10_noMcopyOrTstoreInHardenedBytecode() public {
        (string[9] memory names, bytes[9] memory codes) = _deployedContracts();
        for (uint256 i = 0; i < codes.length; i++) {
            assertGt(codes[i].length, 500, string.concat(names[i], " has code"));
            _assertNoNewOpcodes(codes[i]);
        }
        bytes memory enforcing = address(_newGate(BeaconForkGate.GateMode.Enforcing)).code;
        assertGt(enforcing.length, 1000, "the enforcing gate has code");
        _assertNoNewOpcodes(enforcing);
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

    /// Claim: every hardened contract fits the 24576-byte limit. Shows: the runtime size of each contract is printed and
    /// is below the limit, for the light client, both message bridges, the fork gate, the token mediator, its factory,
    /// a bridged token, the wrapped coin router and the fee router. Matters: each contract is deployable on both chains.
    function test_R2_10_hardenedContractsFitTheSizeLimit() public {
        (string[9] memory names, bytes[9] memory codes) = _deployedContracts();
        for (uint256 i = 0; i < codes.length; i++) {
            emit log_named_uint(names[i], codes[i].length);
            assertLt(codes[i].length, 24_576, names[i]);
        }
    }

    /// Claim: the fork gate (in all three modes) and the fork registry contain none of the five canary opcodes, and
    /// the one probe contract holds exactly the four
    /// intended opcodes once each. Shows: the scan counts zero of TSTORE, TLOAD, MCOPY, BLOBBASEFEE and CLZ in the
    /// runtime code of the gate and of the registry; then it scans the probe the gate deployed and finds one TSTORE,
    /// one MCOPY, one BLOBBASEFEE, one CLZ and no TLOAD. Matters: the gate and the registry run on PulseChain, which
    /// rejects the new opcodes. The probe is the only code that may contain them, and the scan excludes exactly that
    /// runtime code (the address that the gate exposes), not anything else. A second or a wrong opcode in the probe
    /// would watch for the wrong fork.
    function test_HB02_canaryOpcodesLiveOnlyInTheProbe() public {
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

        // The probe: the one excluded code, scanned for exactly the four intended opcodes and nothing else new.
        bytes memory probeCode = registryGate.opcodeProbe().code;
        assertEq(_countOpcode(probeCode, TSTORE), 1, "the probe holds one TSTORE");
        assertEq(_countOpcode(probeCode, MCOPY), 1, "the probe holds one MCOPY");
        assertEq(_countOpcode(probeCode, BLOBBASEFEE), 1, "the probe holds one BLOBBASEFEE");
        assertEq(_countOpcode(probeCode, CLZ), 1, "the probe holds one CLZ");
        assertEq(_countOpcode(probeCode, TLOAD), 0, "the probe holds no TLOAD");
        // Control: the probe differs from the gate only by what it holds. The scan helper sees a second opcode.
        assertEq(_countOpcode(abi.encodePacked(probeCode, hex"5d"), TSTORE), 2, "control: an extra opcode is counted");
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
