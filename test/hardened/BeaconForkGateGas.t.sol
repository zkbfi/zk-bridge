// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {GateSupport} from "./utils/GateSupport.sol";
import {GateAlwaysAdmits} from "./utils/GateMocks.sol";

/// @notice Gas of a message bridge send with the fork gate. Each number is measured with `gasleft()` around the call, with
/// the touched accounts cooled first (`vm.cool`) so storage and account reads are cold, as in a fresh transaction.
/// The bounds are about 20 percent above the measurement, rounded up. The plain baseline is a send through a gate
/// that does nothing, so it already pays the cold external call into a gate (about 2,600 gas); the extra numbers are what
/// the real gate adds on top of that call. Since the execution canaries, a send before the switch also makes four
/// calls to one probe contract (one cold account, three warm calls) and one call to the BLS12-381 address; the numbers
/// below cool those accounts too.
///
/// Toolchain: the numbers are from forge 1.9.0. Up to forge 1.8.5, `vm.cool` cooled the account but left its storage
/// slots warm, and it left a contract created in the same test warm altogether. The detection-mode numbers measured then
/// (9,827 over the plain send for a cold-canary send on 2026-10-22, 11,914 on 2026-11-10) missed the cold reads of the
/// gate's storage, so they were below what a sender pays in a fresh transaction. Forge 1.9.0 cools both, and the same
/// gate code measures 14,414. The gate itself did not get costlier: its `admit` frame is 14,715 gas at the canary
/// commit and 14,764 now (the 49 gas are the seal-only mode check of 2026-11-10).
contract BeaconForkGateGasTest is GateSupport {
    function setUp() public override {
        super.setUp();
        _warpIntoEpoch(EPOCH_E, 3);
    }

    /// @dev Cost of one send as `alice`, from a fresh (cold) state of the touched accounts. The bridge gives the gate
    /// empty evidence, so the epoch must be confirmed before this call when the gate enforces.
    function _measuredSend(MessageBridge sender, address gateAddress) internal returns (uint256 used) {
        address target = makeAddr("target");
        vm.chainId(CHAIN_A);
        vm.cool(address(sender));
        vm.cool(gateAddress);
        vm.cool(BEACON_ROOTS);
        vm.prank(alice);
        uint256 before_ = gasleft();
        sender.requireToPassMessage(target, hex"c0ffee", 100_000);
        used = before_ - gasleft();
    }

    /// @dev Cost of one `confirm` call from a cold gate and a cold beacon roots contract.
    function _measuredConfirm(BeaconForkGate target, bytes memory evidence) internal returns (uint256 used) {
        vm.cool(address(target));
        vm.cool(BEACON_ROOTS);
        uint256 before_ = gasleft();
        target.confirm(evidence);
        used = before_ - gasleft();
    }

    /// @dev Cools the opcode probe contract and the BLS address, which the detection modes call on every send.
    function _coolCanaries(BeaconForkGate target) internal {
        vm.cool(target.opcodeProbe());
        vm.cool(address(0x0b));
    }

    function _plainSendGas() internal returns (uint256) {
        address plainGate = address(new GateAlwaysAdmits());
        return _measuredSend(_bridgeWithGate(plainGate), plainGate);
    }

    /// Claim: a send in detection mode before detection (no beacon roots contract) costs the plain send plus the
    /// probe, about 2,600 gas by the design estimate. Shows: the numbers for plain, for the gate with no code at the
    /// address, and for the gate with the genuine code at the address and empty storage (which reverts inside the
    /// probe, so it costs more). Matters: PulseChain senders pay this on every send until EIP-4788 arrives.
    function test_HB02_gas_sendInDetectionModeBeforeDetection() public {
        uint256 plain = _plainSendGas();
        vm.etch(BEACON_ROOTS, "");
        BeaconForkGate detecting = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
        _coolCanaries(detecting);
        uint256 withGate = _measuredSend(_bridgeWithGate(address(detecting)), address(detecting));
        _etchGenuine();
        BeaconForkGate detectingGenuine = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
        _coolCanaries(detectingGenuine);
        uint256 withGenuine = _measuredSend(_bridgeWithGate(address(detectingGenuine)), address(detectingGenuine));
        emit log_named_uint("plain send (always admit gate)", plain);
        emit log_named_uint("send in detection mode, no code at the address", withGate);
        emit log_named_uint("  extra over plain (probe plus the gate call)", withGate - plain);
        emit log_named_uint("send in detection mode, genuine code with empty storage", withGenuine);
        emit log_named_uint("  extra over plain", withGenuine - plain);
        // Before the canaries the probe cost under 1,000 gas. The opcode probe adds one cold account access (2,600 gas), the BLS12-381
        // address adds another, and each of the four probe calls burns the forwarded gas of an invalid opcode: about
        // 10,000 gas more, bounded by the caps of the gate. With the gate's storage cold as well (forge 1.9.0, see the
        // contract comment) the measurement is 14,414 with no code at the address and 16,607 with the reverting genuine
        // code. The bounds are those numbers plus about 20 percent, rounded up to the next thousand. They were 12,000
        // when forge left the gate's storage warm.
        assertLt(withGate - plain, 18_000, "the probes and canaries stay bounded");
        assertLt(withGenuine - plain, 20_000, "the same with a reverting beacon roots contract");
    }

    /// Claim: a send in detection mode, with every canary account cold as in a fresh transaction, costs a bounded
    /// amount over the plain send. Shows: the gas through the gate of the fixture (`gateB`, built in `setUp`, so
    /// that `vm.cool` takes effect on its probes even with forge 1.8.5, where a contract created inside the test stayed
    /// warm). Measured 14,414 with forge 1.9.0; the bound is that plus about 20 percent. Matters: this is the
    /// real price a PulseChain sender pays on every send until a canary fires: the beacon roots probe, the
    /// opcode probe contract (one cold access, then warm calls) and the BLS12-381 address (a cold access).
    function test_HB02_gas_sendInDetectionModeWithColdCanaries() public {
        vm.etch(BEACON_ROOTS, "");
        uint256 plain = _plainSendGas();
        _coolCanaries(gateB);
        uint256 withGate = _measuredSend(_bridgeWithGate(address(gateB)), address(gateB));
        emit log_named_uint("send in detection mode, cold canaries", withGate);
        emit log_named_uint("  extra over plain", withGate - plain);
        assertGt(withGate - plain, 7_000, "control: the cold accesses are real");
        assertLt(withGate - plain, 18_000, "bound");
    }

    /// Claim: the admit call alone, before detection, costs a small fixed amount. Shows: the gas of
    /// `gate.admit("")` as an external call with a cold gate. Matters: it separates the gate from the bridge work.
    function test_HB02_gas_admitOnlyBeforeDetection() public {
        vm.etch(BEACON_ROOTS, "");
        BeaconForkGate detecting = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
        vm.cool(address(detecting));
        vm.cool(BEACON_ROOTS);
        _coolCanaries(detecting);
        uint256 before_ = gasleft();
        detecting.admit("");
        uint256 used = before_ - gasleft();
        emit log_named_uint("admit only, before detection", used);
        assertLt(used, 18_000);
    }

    /// Claim: a send in a confirmed epoch costs the plain send plus about 3,000 gas (one cold read of the packed state
    /// slot, plus the dispatch and the checks). Shows: the numbers. Matters: this is the common path on Ethereum, because only the first
    /// sender of an epoch confirms.
    function test_HB02_gas_sendInAConfirmedEpoch() public {
        _etchMock();
        BeaconForkGate gate = _newGate(BeaconForkGate.GateMode.Enforcing);
        MessageBridge sender = _bridgeWithGate(address(gate));
        gate.confirm(_honestEvidence(block.timestamp, _slotIn(EPOCH_E, 2), 6, ELECTRA));
        uint256 plain = _plainSendGas();
        uint256 used = _measuredSend(sender, address(gate));
        emit log_named_uint("send in a confirmed epoch", used);
        emit log_named_uint("  extra over plain", used - plain);
        assertGt(used - plain, 2_100, "control: the cold read of the state slot is real");
        assertLt(used - plain, 3_700);
    }

    /// Claim: the `confirm` call of the first sender of an epoch costs 40,000 to 47,000 gas. Shows: the numbers for a
    /// depth 6 state and a depth 5 state. Each includes the second branch, the one of `genesis_validators_root`, which
    /// adds about 8,000 gas (five or six more SHA-256 steps and the longer calldata) to the 34,700 gas of the version
    /// branch alone. Matters: this is what the first sender of each epoch pays on top of the send. The send after it
    /// costs the confirmed epoch number.
    function test_HB02_gas_confirmWithProof() public {
        _etchMock();
        BeaconForkGate gateSix = _newGate(BeaconForkGate.GateMode.Enforcing);
        bytes memory six = _honestEvidence(block.timestamp, _slotIn(EPOCH_E, 2), 6, ELECTRA);
        uint256 usedSix = _measuredConfirm(gateSix, six);
        BeaconForkGate gateFive = _newGate(BeaconForkGate.GateMode.Enforcing);
        bytes memory five = _honestEvidence(block.timestamp + 12, _slotIn(EPOCH_E, 2), 5, DENEB);
        uint256 usedFive = _measuredConfirm(gateFive, five);
        emit log_named_uint("confirm with proof, depth 6", usedSix);
        emit log_named_uint("confirm with proof, depth 5", usedFive);
        assertLt(usedSix, 47_000);
        assertLt(usedFive, 45_000);
        assertGt(usedFive, 20_000, "a proof costs far more than a read");
    }
}
