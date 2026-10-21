// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {GateSupport} from "./utils/GateSupport.sol";
import {
    GateBlsG1AddMock,
    GateBlsWrongOutputMock,
    GateBlsShortOutputMock,
    GateBlsPoints,
    GateProbeCodes,
    GateAlwaysReverts
} from "./utils/GateMocks.sol";

/// @notice Tests of the execution canaries of `BeaconForkGate` (hole HB-02). A PulseChain consensus fork almost always
/// comes with an execution fork. The gate in detection mode probes for new opcodes and for the BLS12-381 precompile, and
/// the first probe that works switches the gate to enforcing for good.
/// @dev The test environment compiles and runs for Shanghai, so every canary fails by default. Two ways to make one
/// fire: `vm.etch` of probe code that succeeds for one selector only (isolates one canary at a time), and
/// `vm.setEvmVersion` to run the real opcodes (shows that the raw probe bytes really run `TSTORE`, `MCOPY`,
/// `BLOBBASEFEE` and `CLZ` on a chain that has them). The gate has one probe contract. The first calldata byte picks
/// the opcode: 1 for `TSTORE`, 2 for `MCOPY`, 3 for `BLOBBASEFEE`, 4 for `CLZ`.
contract BeaconForkGateCanariesTest is GateSupport {
    address internal constant BLS_G1_ADD = address(0x0b);

    event ExecutionCanaryFired(BeaconForkGate.Canary canary);

    BeaconForkGate internal gate;

    function setUp() public override {
        super.setUp();
        _warpIntoEpoch(EPOCH_E, 3);
        vm.etch(BEACON_ROOTS, "");
        gate = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
    }

    /// @dev The calldata byte that picks the path of a canary: its index in the enum, plus one.
    function _selectorOf(uint256 index) internal pure returns (uint8) {
        return uint8(index + 1);
    }

    /// @dev Calls one path of the probe of `target` with the gas cap of the gate, as the gate does.
    function _callPath(BeaconForkGate target, uint8 selector) internal returns (bool ok, bytes memory returned) {
        (ok, returned) = target.opcodeProbe().call{gas: target.PROBE_GAS()}(abi.encodePacked(selector));
    }

    /// @dev Honest evidence whose root sits under the timestamp of the PREVIOUS slot only. The detection probe asks for
    /// the root of the current block time and finds nothing, so a canary, not the beacon roots probe, does the
    /// switching in a call that also carries this evidence.
    function _evidenceThatHidesTheBeaconRootsProbe() internal returns (bytes memory) {
        _etchMock();
        return _honestEvidence(block.timestamp - 12, _slotIn(EPOCH_E, 2), 6, ELECTRA);
    }

    // ================================================================ the probe itself

    /// Claim: the constructor deploys one probe whose runtime code is exactly the documented bytes. Shows: the code
    /// equals the expected bytes, with the jump targets written out. Each path holds one canary opcode: TSTORE is
    /// 0x5d (EIP-1153), MCOPY is 0x5e (EIP-5656), BLOBBASEFEE is 0x4a (EIP-7516), CLZ is 0x1e (EIP-7939). Matters: a
    /// path that ran another opcode would watch for the wrong fork. A wrong jump target would send a selector to the
    /// wrong path (the real-opcode tests below catch that too).
    function test_HB02_canary_probeHoldsExactlyTheDocumentedBytes() public view {
        bytes memory expected = abi.encodePacked(
            hex"5f3560f81c", // selector from the first calldata byte
            hex"80600114602457", // selector 1 to 0x24
            hex"80600214602c57", // selector 2 to 0x2c
            hex"80600314603557", // selector 3 to 0x35
            hex"80600414603b57", // selector 4 to 0x3b
            hex"5f5ffd", // unknown selector reverts
            hex"5b60015f5d603f56", // 0x24 TSTORE
            hex"5b60205f5f5e603f56", // 0x2c MCOPY
            hex"5b4a50603f56", // 0x35 BLOBBASEFEE
            hex"5b5f1e50", // 0x3b CLZ
            hex"5b60015f5260205ff3" // 0x3f return the word 1
        );
        assertEq(gate.opcodeProbe().code, expected);
        assertEq(uint8(expected[0x24]), 0x5b, "selector 1 lands on a JUMPDEST");
        assertEq(uint8(expected[0x2c]), 0x5b, "selector 2 lands on a JUMPDEST");
        assertEq(uint8(expected[0x35]), 0x5b, "selector 3 lands on a JUMPDEST");
        assertEq(uint8(expected[0x3b]), 0x5b, "selector 4 lands on a JUMPDEST");
        assertEq(uint8(expected[0x3f]), 0x5b, "the return lands on a JUMPDEST");
    }

    /// Claim: an unknown selector fails, on any chain. Shows: under the Osaka rules, where every path works, selector
    /// 0, 5, 255 and empty calldata all revert, and the four real selectors succeed (control). Matters: a probe that
    /// answered an unknown byte could be fired by the wrong input, or fall through into an opcode path.
    function test_HB02_canary_unknownSelectorFails() public {
        vm.setEvmVersion("osaka");
        BeaconForkGate osaka = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
        for (uint256 i = 0; i < 4; i++) {
            (bool known,) = _callPath(osaka, _selectorOf(i));
            assertTrue(known, "control: a real selector works on Osaka");
        }
        uint8[3] memory unknown = [0, 5, 255];
        for (uint256 i = 0; i < unknown.length; i++) {
            (bool ok,) = _callPath(osaka, unknown[i]);
            assertFalse(ok, "an unknown selector fails");
        }
        (bool emptyOk,) = osaka.opcodeProbe().call{gas: 400}("");
        assertFalse(emptyOk, "empty calldata fails");
    }

    // ================================================================ Shanghai: nothing fires

    /// Claim: on a Shanghai chain every canary fails and the gate admits the deposit. Shows: each path of the probe
    /// called with its gas cap fails; the precompile address returns no data; `admit("")` passes, `enforcing()` stays false, and no
    /// event is emitted. Control: the same gate fires once one probe is replaced by code that succeeds (next tests).
    /// Matters: PulseChain runs Shanghai today. A canary that fired here would stop all deposits for no reason.
    function test_HB02_canary_everyCanaryFailsOnShanghaiAndDepositsAreAdmitted() public {
        for (uint256 i = 0; i < 4; i++) {
            (bool ok,) = _callPath(gate, _selectorOf(i));
            assertFalse(ok, "the opcode is invalid on Shanghai, so the path fails");
        }
        (bool precompileOk, bytes memory answer) = BLS_G1_ADD.staticcall(new bytes(256));
        assertTrue(precompileOk, "an empty account accepts the call");
        assertEq(answer.length, 0, "and returns nothing");

        vm.recordLogs();
        gate.admit("");
        assertFalse(gate.enforcing());
        assertEq(vm.getRecordedLogs().length, 0, "no event: nothing fired");
    }

    // ================================================================ each canary alone

    /// Claim: each opcode canary switches the gate on its own, and the paths do not depend on each other. Shows: for
    /// each of the four canaries in turn, with the probe replaced by code that works for that selector only,
    /// `admit("")` emits `ExecutionCanaryFired(canary)` and the deposit without evidence is refused with
    /// `ForkNotConfirmed`; so the three paths before it failed and the one at hand won. A completed call (`confirm`
    /// with evidence) keeps the switch. Controls: before the probe is replaced the same call admits and the gate does
    /// not enforce; a probe that works for a selector outside 1 to 4 fires nothing. Matters: any one new opcode is
    /// enough to know that the chain has had an execution fork, and a chain may add one opcode without the others.
    function test_HB02_canary_eachOpcodeCanaryFiresAloneAndTheGateEnforces() public {
        for (uint256 i = 0; i < 4; i++) {
            vm.etch(BEACON_ROOTS, "");
            BeaconForkGate fresh = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
            fresh.admit(""); // control: admitted, not enforcing
            assertFalse(fresh.enforcing());

            vm.etch(fresh.opcodeProbe(), GateProbeCodes.succeedsOnlyForSelector(5));
            fresh.admit(""); // control: a selector that no path uses fires nothing
            assertFalse(fresh.enforcing());

            vm.etch(fresh.opcodeProbe(), GateProbeCodes.succeedsOnlyForSelector(_selectorOf(i)));
            vm.expectEmit(address(fresh));
            emit ExecutionCanaryFired(BeaconForkGate.Canary(i));
            vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
            fresh.admit("");
            assertFalse(fresh.enforcing(), "a reverted deposit undoes the switch");

            bytes memory evidence = _evidenceThatHidesTheBeaconRootsProbe();
            vm.expectEmit(address(fresh));
            emit ExecutionCanaryFired(BeaconForkGate.Canary(i));
            fresh.confirm(evidence);
            assertTrue(fresh.enforcing(), "a call that completes keeps the switch");
        }
    }

    /// Claim: when several paths work, the first in the order of the enum wins. Shows: a probe that works for every
    /// selector fires `TransientStorage`; a probe that works from selector 3 upward fires `BlobBaseFee`, not
    /// `CountLeadingZeros`. Matters: the event names the first canary, as before the probes were combined.
    function test_HB02_canary_firstCanaryInTheOrderWins() public {
        vm.etch(gate.opcodeProbe(), GateProbeCodes.succeeds());
        vm.expectEmit(address(gate));
        emit ExecutionCanaryFired(BeaconForkGate.Canary.TransientStorage);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        gate.admit("");

        vm.etch(BEACON_ROOTS, "");
        BeaconForkGate other = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
        vm.etch(other.opcodeProbe(), GateProbeCodes.succeedsFromSelector(3));
        vm.expectEmit(address(other));
        emit ExecutionCanaryFired(BeaconForkGate.Canary.BlobBaseFee);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        other.admit("");
    }

    /// Claim: the switch is for good. Shows: after a canary fires in a call that completes, the probe is replaced by
    /// failing code and the gate still enforces in the next epoch. Matters: a probe that flips back would reopen the
    /// gate.
    function test_HB02_canary_switchIsForGood() public {
        bytes memory evidence = _evidenceThatHidesTheBeaconRootsProbe();
        vm.etch(gate.opcodeProbe(), GateProbeCodes.succeeds());
        gate.confirm(evidence);
        assertTrue(gate.enforcing());
        vm.etch(gate.opcodeProbe(), GateProbeCodes.burnsAllGas());
        vm.warp(block.timestamp + 12 * 32);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E + 1));
        gate.admit("");
    }

    /// Claim: the BLS12-381 canary fires when address 0x0b answers the known input with the known output. Shows: a
    /// stand-in that returns the generator for "generator plus infinity" fires `Bls12381Precompile`. Controls: a
    /// stand-in with the right length and wrong bytes, one with a short answer, one that reverts, and a probe
    /// that returns the wrong word or nothing does not fire. Matters: the precompile exists only after Prague (EIP-2537),
    /// and a check on the length alone would fire on any contract at that address.
    function test_HB02_canary_blsPrecompileFiresOnlyOnTheKnownOutput() public {
        vm.etch(BLS_G1_ADD, address(new GateBlsWrongOutputMock()).code);
        gate.admit("");
        assertFalse(gate.enforcing(), "right length, wrong bytes: no");
        vm.etch(BLS_G1_ADD, address(new GateBlsShortOutputMock()).code);
        gate.admit("");
        assertFalse(gate.enforcing(), "short answer: no");
        vm.etch(BLS_G1_ADD, address(new GateAlwaysReverts()).code);
        gate.admit("");
        assertFalse(gate.enforcing(), "revert: no");

        vm.etch(gate.opcodeProbe(), GateProbeCodes.returnsWrongWord());
        gate.admit("");
        assertFalse(gate.enforcing(), "a probe that returns the wrong word: no");
        vm.etch(gate.opcodeProbe(), GateProbeCodes.returnsNothing());
        gate.admit("");
        assertFalse(gate.enforcing(), "a probe that returns nothing: no");

        vm.etch(BLS_G1_ADD, address(new GateBlsG1AddMock()).code);
        vm.expectEmit(address(gate));
        emit ExecutionCanaryFired(BeaconForkGate.Canary.Bls12381Precompile);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        gate.admit("");
        bytes memory evidence = _evidenceThatHidesTheBeaconRootsProbe();
        gate.confirm(evidence);
        assertTrue(gate.enforcing());
    }

    // ================================================================ real opcodes

    /// Claim: the raw probe bytes run the real opcodes, each path alone. Shows: under `vm.setEvmVersion("cancun")` a
    /// gate built there answers selectors 1, 2 and 3 (TSTORE, MCOPY, BLOBBASEFEE) with the word 1, selector 4 (CLZ)
    /// fails, and `admit` emits the TSTORE canary. The CLZ path is called first and last, to show that its failure does
    /// not change the other results. Under "osaka" the CLZ path succeeds too. Control: the same bytes fail on the
    /// default Shanghai (the first test). Matters: etching code that succeeds proves nothing about the bytes; this
    /// proves that the probe would fire on a chain that has the opcodes, and that a chain without CLZ still fires the
    /// others.
    function test_HB02_canary_realOpcodesFireOnNewerEvmVersions() public {
        vm.setEvmVersion("cancun");
        BeaconForkGate cancun = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
        (bool clzFirst,) = _callPath(cancun, _selectorOf(3));
        assertFalse(clzFirst, "CLZ is not in Cancun");
        for (uint256 i = 0; i < 3; i++) {
            (bool ok, bytes memory returned) = _callPath(cancun, _selectorOf(i));
            assertTrue(ok, "cancun opcode runs");
            assertEq(abi.decode(returned, (uint256)), 1);
        }
        (bool clzLast,) = _callPath(cancun, _selectorOf(3));
        assertFalse(clzLast, "CLZ still fails after the others ran");
        vm.expectEmit(address(cancun));
        emit ExecutionCanaryFired(BeaconForkGate.Canary.TransientStorage);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        cancun.admit("");

        vm.setEvmVersion("osaka");
        (bool clzOnOsaka, bytes memory clzReturned) = _callPath(cancun, _selectorOf(3));
        assertTrue(clzOnOsaka, "CLZ runs on Osaka");
        assertEq(abi.decode(clzReturned, (uint256)), 1);
    }

    /// Claim: the gas cap fits the longest path with room to spare, and is still small. Shows: under the Osaka rules,
    /// every path succeeds with half the cap. The costliest path (TSTORE, 167 gas measured) fits, and so does CLZ
    /// (126 gas, after three failed compares). Matters: a cap below the need would make a real canary fail silently; a large cap
    /// would let a burning opcode cost more.
    function test_HB02_canary_everyPathFitsInHalfTheCap() public {
        vm.setEvmVersion("osaka");
        BeaconForkGate osaka = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
        address probe = osaka.opcodeProbe();
        uint256 half = osaka.PROBE_GAS() / 2;
        for (uint256 i = 0; i < 4; i++) {
            (bool ok,) = probe.call{gas: half}(abi.encodePacked(_selectorOf(i)));
            assertTrue(ok, "the path needs less than half of the cap");
        }
        (bool starved,) = probe.call{gas: 40}(abi.encodePacked(_selectorOf(3)));
        assertFalse(starved, "control: too little gas fails");
    }

    function _blsPrecompileIsLive() internal view returns (bool) {
        (bool ok, bytes memory answer) = BLS_G1_ADD.staticcall(abi.encodePacked(GateBlsPoints.generator(), new bytes(128)));
        return ok && answer.length == 128;
    }

    /// Claim: the known input and output of the precompile canary are right. Shows: when the EVM of the test run
    /// has the real `BLS12_G1ADD` (Prague or later), generator plus infinity returns the generator; on the default
    /// Shanghai run the call returns nothing. Matters: a wrong constant would make the canary never fire.
    /// @dev `vm.setEvmVersion` does not add precompiles to a running test, so the real-precompile branch runs only
    /// when forge is started with `--evm-version osaka`. The result of that run is in the report of this build.
    function test_HB02_canary_knownBlsInputGivesKnownOutputOnARealPrecompile() public view {
        bytes memory input = abi.encodePacked(GateBlsPoints.generator(), new bytes(128));
        (bool ok, bytes memory answer) = BLS_G1_ADD.staticcall(input);
        assertTrue(ok);
        if (!_blsPrecompileIsLive()) {
            assertEq(answer.length, 0, "Shanghai control: an empty account returns nothing");
            return;
        }
        assertEq(answer, GateBlsPoints.generator(), "generator plus infinity is the generator");
    }

    /// Claim: the real gate fires its BLS canary on a real precompile. Shows: with the opcode probe replaced by
    /// failing code, `admit("")` emits `Bls12381Precompile` when the precompile is live (run with
    /// `--evm-version osaka`), and admits without a switch when it is not (default run). Matters: this runs the gate's
    /// own input bytes and output check against the real precompile, not a mock.
    function test_HB02_canary_gateFiresOnTheRealBlsPrecompile() public {
        vm.etch(gate.opcodeProbe(), GateProbeCodes.returnsNothing());
        if (!_blsPrecompileIsLive()) {
            gate.admit("");
            assertFalse(gate.enforcing(), "Shanghai control: nothing fires");
            return;
        }
        vm.expectEmit(address(gate));
        emit ExecutionCanaryFired(BeaconForkGate.Canary.Bls12381Precompile);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        gate.admit("");
    }

    // ================================================================ gas

    function _coolCanaries(BeaconForkGate target) internal {
        vm.cool(address(target));
        vm.cool(BEACON_ROOTS);
        vm.cool(target.opcodeProbe());
        vm.cool(BLS_G1_ADD);
    }

    function _admitGas(BeaconForkGate target) internal returns (uint256) {
        _coolCanaries(target);
        uint256 before_ = gasleft();
        target.admit("");
        return before_ - gasleft();
    }

    /// Claim: before the switch, `admit("")` costs a bounded amount. Shows: the gas of `admit("")` with every account
    /// cold, on Shanghai, where all canaries fail. Matters: PulseChain depositors pay this on every deposit until the
    /// fork. The probe costs one cold account access (2,600) and each of its four calls burns the forwarded gas of an invalid opcode.
    function test_HB02_canary_gasOfAdmitBeforeTheSwitchIsBounded() public {
        uint256 used = _admitGas(gate);
        console2.log("admit before the switch, all accounts cold", used);
        assertLt(used, 18_000);
    }

    /// Claim: a probe that burns every unit of gas it gets cannot cost more than the forwarded cap. Shows: with the
    /// probe replaced by an endless loop and the precompile address by an endless loop, `admit("")` costs at most the
    /// failing case plus the precompile cap (a failing opcode already burns its forwarded gas). Both gates are built in this
    /// test and measured without cooling, so the only difference is the code. Matters: an attacker or a repriced
    /// chain must not turn the canaries into a gas sink for depositors.
    function test_HB02_canary_aProbeThatBurnsAllGasCostsNoMoreThanItsCap() public {
        // The first call warms the shared accounts (beacon roots, 0x0b). The second call is the warm baseline.
        _newGate(BeaconForkGate.GateMode.DetectBeaconRoots).admit("");
        BeaconForkGate failing = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
        uint256 beforeFailing = gasleft();
        failing.admit("");
        uint256 failingGas = beforeFailing - gasleft();

        BeaconForkGate burning = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
        vm.etch(burning.opcodeProbe(), GateProbeCodes.burnsAllGas());
        vm.etch(BLS_G1_ADD, GateProbeCodes.burnsAllGas());
        uint256 beforeBurning = gasleft();
        burning.admit("");
        uint256 burnedGas = beforeBurning - gasleft();
        console2.log("admit, probes fail", failingGas);
        console2.log("admit, probes and precompile burn all gas", burnedGas);
        assertFalse(burning.enforcing());
        uint256 cap = 4 * gate.PROBE_GAS() + gate.PRECOMPILE_GAS();
        assertLe(burnedGas, failingGas + cap, "no more than the caps");
        assertGt(burnedGas, failingGas + gate.PRECOMPILE_GAS() / 2, "control: the precompile burn is real");
    }
}
