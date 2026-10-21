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
/// fire: `vm.etch` of probe code that succeeds (isolates one canary at a time), and `vm.setEvmVersion` to run the real
/// opcodes (shows that the raw probe bytes really run `TSTORE`, `MCOPY`, `BLOBBASEFEE` and `CLZ` on a chain that has them).
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

    function _probeOf(BeaconForkGate target, uint256 index) internal view returns (address) {
        if (index == 0) return target.tstoreProbe();
        if (index == 1) return target.mcopyProbe();
        if (index == 2) return target.blobBaseFeeProbe();
        return target.clzProbe();
    }

    function _callProbe(address probe) internal returns (bool ok, bytes memory returned) {
        (ok, returned) = probe.call{gas: 300}("");
    }

    /// @dev Honest evidence whose root sits under the timestamp of the PREVIOUS slot only. The detection probe asks for
    /// the root of the current block time and finds nothing, so a canary, not the beacon roots probe, does the
    /// switching in a call that also carries this evidence.
    function _evidenceThatHidesTheBeaconRootsProbe() internal returns (bytes memory) {
        _etchMock();
        return _honestEvidence(block.timestamp - 12, _slotIn(EPOCH_E, 2), 6, ELECTRA);
    }

    // ================================================================ the probes themselves

    /// Claim: the constructor deploys four probes whose runtime code is exactly the documented bytes: one canary
    /// opcode, then `PUSH1 1 PUSH0 MSTORE PUSH1 0x20 PUSH0 RETURN`. Shows: the code of each probe equals the expected
    /// bytes. TSTORE is 0x5d (EIP-1153), MCOPY is 0x5e (EIP-5656), BLOBBASEFEE is 0x4a (EIP-7516), CLZ is 0x1e
    /// (EIP-7939). Matters: a probe that ran another opcode would watch for the wrong fork.
    function test_HB02_canary_probesHoldExactlyTheDocumentedBytes() public view {
        bytes memory tail = hex"60015f5260205ff3";
        assertEq(gate.tstoreProbe().code, abi.encodePacked(hex"60015f5d", tail));
        assertEq(gate.mcopyProbe().code, abi.encodePacked(hex"60205f5f5e", tail));
        assertEq(gate.blobBaseFeeProbe().code, abi.encodePacked(hex"4a50", tail));
        assertEq(gate.clzProbe().code, abi.encodePacked(hex"5f1e50", tail));
    }

    // ================================================================ Shanghai: nothing fires

    /// Claim: on a Shanghai chain every canary fails and the gate admits the deposit. Shows: each probe called with
    /// 300 gas fails; the precompile address returns no data; `admit("")` passes, `enforcing()` stays false, and no
    /// event is emitted. Control: the same gate fires once one probe is replaced by code that succeeds (next tests).
    /// Matters: PulseChain runs Shanghai today. A canary that fired here would stop all deposits for no reason.
    function test_HB02_canary_everyCanaryFailsOnShanghaiAndDepositsAreAdmitted() public {
        for (uint256 i = 0; i < 4; i++) {
            (bool ok,) = _callProbe(_probeOf(gate, i));
            assertFalse(ok, "the opcode is invalid on Shanghai, so the probe fails");
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

    /// Claim: each opcode canary switches the gate on its own. Shows: for each of the four probes in turn, with only
    /// that probe replaced by code that succeeds, `admit("")` emits `ExecutionCanaryFired(canary)` and the deposit
    /// without evidence is refused with `ForkNotConfirmed`. A completed call (`confirm` with evidence) keeps the
    /// switch. Control: before the probe is replaced the same call admits and the gate does not enforce. Matters: any
    /// one new opcode is enough to know that the chain has had an execution fork, and the route cannot follow it.
    function test_HB02_canary_eachOpcodeCanaryFiresAloneAndTheGateEnforces() public {
        for (uint256 i = 0; i < 4; i++) {
            vm.etch(BEACON_ROOTS, "");
            BeaconForkGate fresh = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
            fresh.admit(""); // control: admitted, not enforcing
            assertFalse(fresh.enforcing());

            vm.etch(_probeOf(fresh, i), GateProbeCodes.succeeds());
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

    /// Claim: the switch is for good. Shows: after a canary fires in a call that completes, the probe is replaced by
    /// failing code and the gate still enforces in the next epoch. Matters: a probe that flips back would reopen the
    /// gate.
    function test_HB02_canary_switchIsForGood() public {
        bytes memory evidence = _evidenceThatHidesTheBeaconRootsProbe();
        vm.etch(gate.tstoreProbe(), GateProbeCodes.succeeds());
        gate.confirm(evidence);
        assertTrue(gate.enforcing());
        vm.etch(gate.tstoreProbe(), GateProbeCodes.burnsAllGas());
        vm.warp(block.timestamp + 12 * 32);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E + 1));
        gate.admit("");
    }

    /// Claim: the BLS12-381 canary fires when address 0x0b answers the known input with the known output. Shows: a
    /// stand-in that returns the generator for "generator plus infinity" fires `Bls12381Precompile`. Controls: a
    /// stand-in with the right length and wrong bytes, one with a short answer, one that reverts, and probes that
    /// return the wrong word or nothing do not fire. Matters: the precompile exists only after Prague (EIP-2537),
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

        for (uint256 i = 0; i < 4; i++) {
            vm.etch(_probeOf(gate, i), GateProbeCodes.returnsWrongWord());
        }
        gate.admit("");
        assertFalse(gate.enforcing(), "probes that return the wrong word: no");
        for (uint256 i = 0; i < 4; i++) {
            vm.etch(_probeOf(gate, i), GateProbeCodes.returnsNothing());
        }
        gate.admit("");
        assertFalse(gate.enforcing(), "probes that return nothing: no");

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

    /// Claim: the raw probe bytes run the real opcodes. Shows: under `vm.setEvmVersion("cancun")` a gate built there
    /// has TSTORE, MCOPY and BLOBBASEFEE probes that succeed and return 1, the CLZ probe still fails, and `admit`
    /// emits the TSTORE canary. Under "osaka" the CLZ probe succeeds. Control: the same bytes fail on the default
    /// Shanghai (the first test). Matters: etching code that succeeds proves nothing about the bytes; this proves
    /// that the probes would fire on a chain that has the opcodes.
    function test_HB02_canary_realOpcodesFireOnNewerEvmVersions() public {
        vm.setEvmVersion("cancun");
        BeaconForkGate cancun = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
        for (uint256 i = 0; i < 3; i++) {
            (bool ok, bytes memory returned) = _callProbe(_probeOf(cancun, i));
            assertTrue(ok, "cancun opcode runs");
            assertEq(abi.decode(returned, (uint256)), 1);
        }
        (bool clzOnCancun,) = _callProbe(cancun.clzProbe());
        assertFalse(clzOnCancun, "CLZ is not in Cancun");
        vm.expectEmit(address(cancun));
        emit ExecutionCanaryFired(BeaconForkGate.Canary.TransientStorage);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        cancun.admit("");

        vm.setEvmVersion("osaka");
        (bool clzOnOsaka, bytes memory clzReturned) = _callProbe(cancun.clzProbe());
        assertTrue(clzOnOsaka, "CLZ runs on Osaka");
        assertEq(abi.decode(clzReturned, (uint256)), 1);
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

    /// Claim: the real gate fires its BLS canary on a real precompile. Shows: with the four opcode probes replaced by
    /// failing code, `admit("")` emits `Bls12381Precompile` when the precompile is live (run with
    /// `--evm-version osaka`), and admits without a switch when it is not (default run). Matters: this runs the gate's
    /// own input bytes and output check against the real precompile, not a mock.
    function test_HB02_canary_gateFiresOnTheRealBlsPrecompile() public {
        for (uint256 i = 0; i < 4; i++) {
            vm.etch(_probeOf(gate, i), GateProbeCodes.returnsNothing());
        }
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
        vm.cool(target.tstoreProbe());
        vm.cool(target.mcopyProbe());
        vm.cool(target.blobBaseFeeProbe());
        vm.cool(target.clzProbe());
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
    /// fork. Each probe costs a cold account access (2,600) plus the forwarded 300 that an invalid opcode burns.
    function test_HB02_canary_gasOfAdmitBeforeTheSwitchIsBounded() public {
        uint256 used = _admitGas(gate);
        console2.log("admit before the switch, all accounts cold", used);
        assertLt(used, 24_000);
    }

    /// Claim: a probe that burns every unit of gas it gets cannot cost more than the forwarded cap. Shows: with the four
    /// probes replaced by an endless loop and the precompile address by an endless loop, `admit("")` costs at most the
    /// failing case plus the precompile cap (a failing opcode already burns its 300). Both gates are built in this
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
        for (uint256 i = 0; i < 4; i++) {
            vm.etch(_probeOf(burning, i), GateProbeCodes.burnsAllGas());
        }
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
