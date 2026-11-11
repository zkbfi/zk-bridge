// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {DeliveryRouter} from "../../src/hardened/mediator/DeliveryRouter.sol";
import {ITokenMediator} from "../../src/hardened/mediator/ITokenMediator.sol";
import {IWETH} from "../../src/hardened/mediator/IWETH.sol";
import {MockWrappedNative} from "./mediator/utils/MediatorSupport.sol";
import {WorldSupport} from "./utils/WorldSupport.sol";

/// @notice A send through the delivery router carries its own gate evidence (decision D1, design of 2026-11-10, in
/// `docs/superpowers/specs/2026-11-10-mainnet-readiness.md`, A2). The owner: "keep the contracts simple. just check if
/// the proof has already been provided and then make sure it is provided." The router gives non-empty evidence to the
/// gate of the bridge (`admit`) before it sends; the bridge and the mediator are the real, unchanged contracts, and
/// the gate on chain A is a real `BeaconForkGate` in `Enforcing` mode over the model of the beacon roots contract.
abstract contract RouterGateEvidenceBase is WorldSupport {
    uint256 internal constant VALUE = 1 ether;
    uint256 internal constant ROUTER_CALLBACK_GAS = 300_000;

    BeaconForkGate internal gate;
    DeliveryRouter internal router;
    MockWrappedNative internal wrapped;
    address internal receiver = makeAddr("receiver on B");

    function setUp() public override {
        super.setUp();
        _warpIntoEpoch(EPOCH_E, 3);
        _etchMock();
        gate = _newGate(BeaconForkGate.GateMode.Enforcing);
        _deployWorld(address(gate), address(gateB));
        wrapped = new MockWrappedNative();
        router = new DeliveryRouter(
            ITokenMediator(address(mediatorA)), IWETH(address(wrapped)), makeAddr("reward"), makeAddr("failed delivery")
        );
        vm.deal(alice, 100 ether);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Honest evidence for the epoch of the current block time, from a header two slots into it.
    function _evidenceNow(uint256 epoch) internal returns (bytes memory) {
        return _honestEvidence(block.timestamp, _slotIn(epoch, 2), 6, ELECTRA);
    }

    function _wrapAndRelay(bytes memory evidence) internal {
        vm.chainId(CHAIN_A);
        vm.prank(alice);
        router.wrapAndRelayTokens{value: VALUE}(receiver, evidence);
    }

    function _relayAndCall(bytes memory evidence) internal {
        vm.chainId(CHAIN_A);
        vm.prank(alice);
        router.relayTokensAndCall{value: VALUE}(receiver, hex"7777", ROUTER_CALLBACK_GAS, evidence);
    }

    function _confirmed() internal view returns (uint64 epoch, bool exists) {
        return gate.confirmedEpoch();
    }

    function _countForkConfirmed(Vm.Log[] memory recorded) internal view returns (uint256 count) {
        for (uint256 i; i < recorded.length; i++) {
            if (recorded[i].emitter == address(gate) && recorded[i].topics[0] == BeaconForkGate.ForkConfirmed.selector) {
                count++;
            }
        }
    }

}

/// @notice The behaviour of a send with gate evidence.
contract RouterGateEvidenceTest is RouterGateEvidenceBase {

    /// Claim: in an epoch that is already confirmed, the router passes the evidence to the gate and the gate reads none
    /// of it. Shows: bytes that do not even decode as evidence pass with both entry points, no `ForkConfirmed` is
    /// emitted, and the mediator holds the wrapped coin of both sends. Matters: two senders racing for the first send
    /// of an epoch both attach evidence; the second must not fail or pay for a proof.
    function test_confirmedEpochIgnoresTheEvidence() public {
        gate.confirm(_evidenceNow(EPOCH_E));
        vm.recordLogs();
        _wrapAndRelay(hex"deadbeef");
        _relayAndCall(hex"deadbeef");
        assertEq(_countForkConfirmed(vm.getRecordedLogs()), 0, "no second confirmation");
        assertEq(wrapped.balanceOf(address(mediatorA)), 2 * VALUE, "both sends locked their coin");
    }

    /// Claim: in an unconfirmed epoch, evidence in the send confirms the epoch and the send passes in the same call.
    /// Shows: `ForkConfirmed(E)` is emitted by the gate, the gate records epoch E, and the mediator holds the coin; the
    /// same for `relayTokensAndCall` in the next epoch. Matters: this is the whole point of D1: one transaction, no
    /// race with the epoch border between a confirm and a send.
    function test_unconfirmedEpochEvidenceConfirmsThenSends() public {
        bytes memory evidence = _evidenceNow(EPOCH_E);
        vm.expectEmit(true, false, false, true, address(gate));
        emit BeaconForkGate.ForkConfirmed(EPOCH_E, ELECTRA);
        _wrapAndRelay(evidence);
        (uint64 epoch, bool exists) = _confirmed();
        assertTrue(exists, "an epoch is confirmed");
        assertEq(epoch, EPOCH_E, "epoch E");
        assertEq(wrapped.balanceOf(address(mediatorA)), VALUE, "the send passed");

        _warpIntoEpoch(EPOCH_E + 1, 5);
        bytes memory next = _evidenceNow(EPOCH_E + 1);
        vm.expectEmit(true, false, false, true, address(gate));
        emit BeaconForkGate.ForkConfirmed(EPOCH_E + 1, ELECTRA);
        _relayAndCall(next);
        (epoch,) = _confirmed();
        assertEq(epoch, EPOCH_E + 1, "epoch E + 1");
        assertEq(wrapped.balanceOf(address(mediatorA)), 2 * VALUE, "the second send passed");
    }

    /// Claim: with empty evidence the router does not call the gate, and the bridge's own `admit("")` refuses an
    /// unconfirmed epoch. Shows: all three entry points revert with `ForkNotConfirmed(E)`, and nothing is locked.
    /// Matters: a send never passes unproven; a late empty send fails, it does not slip through.
    function test_unconfirmedEpochEmptyEvidenceReverts() public {
        bytes memory refusal = abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E);
        vm.chainId(CHAIN_A);
        vm.prank(alice);
        vm.expectRevert(refusal);
        router.wrapAndRelayTokens{value: VALUE}();
        vm.expectRevert(refusal);
        _wrapAndRelay("");
        vm.expectRevert(refusal);
        _relayAndCall("");
        assertEq(wrapped.balanceOf(address(mediatorA)), 0, "nothing locked");
    }

    /// Claim: evidence that the gate refuses reverts the whole send. Shows: bytes that do not decode revert; a header
    /// whose root differs from the planted beacon root reverts with `HeaderRootMismatch`; the epoch stays unconfirmed
    /// and nothing is locked. Matters: the router adds no way around the gate's checks.
    function test_badEvidenceReverts() public {
        vm.expectRevert();
        _wrapAndRelay(hex"deadbeef");

        bytes memory evidence = _evidenceNow(EPOCH_E);
        bytes32 planted = keccak256("another root");
        _plant(block.timestamp, planted);
        BeaconForkGate.ForkEvidence memory decoded = abi.decode(evidence, (BeaconForkGate.ForkEvidence));
        vm.expectPartialRevert(BeaconForkGate.HeaderRootMismatch.selector);
        _relayAndCall(abi.encode(decoded));

        (, bool exists) = _confirmed();
        assertFalse(exists, "no epoch confirmed");
        assertEq(wrapped.balanceOf(address(mediatorA)), 0, "nothing locked");
    }

    /// Claim: evidence read in one epoch and sent in the next is refused, never accepted for the wrong epoch. Shows:
    /// evidence of a header in epoch E, sent after the clock moved to E + 1, reverts with `HeaderNotInCurrentEpoch(E,
    /// E + 1)`; an empty send in E + 1 after E was confirmed reverts with `ForkNotConfirmed(E + 1)`; fresh evidence of
    /// E + 1 passes. Matters: the frontend reads the epoch, then the wallet signs; the epoch can roll over in between.
    function test_epochRolloverBetweenReadAndSend() public {
        bytes memory evidenceE = _evidenceNow(EPOCH_E);
        _warpIntoEpoch(EPOCH_E + 1, 0);
        vm.expectRevert(
            abi.encodeWithSelector(BeaconForkGate.HeaderNotInCurrentEpoch.selector, EPOCH_E, EPOCH_E + 1)
        );
        _wrapAndRelay(evidenceE);

        _warpIntoEpoch(EPOCH_E, 31);
        _wrapAndRelay(evidenceE);
        _warpIntoEpoch(EPOCH_E + 1, 0);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E + 1));
        _wrapAndRelay("");

        _wrapAndRelay(_evidenceNow(EPOCH_E + 1));
        assertEq(wrapped.balanceOf(address(mediatorA)), 2 * VALUE, "the two good sends passed");
    }

    /// Claim: evidence of a state shape outside the allowed set does not confirm through the router. Shows: a valid
    /// proof at a disallowed depth reverts with `ShapeNotAllowed(8)`; nothing is confirmed or locked. Matters: the
    /// router cannot be used to admit a send after a fork the bridge cannot follow.
    function test_disallowedForkShapeIsRefused() public {
        bytes memory shape = _sealEvidence(block.timestamp, _slotIn(EPOCH_E, 2), FULU);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ShapeNotAllowed.selector, DISALLOWED_DEPTH));
        _wrapAndRelay(shape);
        (, bool exists) = _confirmed();
        assertFalse(exists, "no epoch confirmed");
        assertEq(wrapped.balanceOf(address(mediatorA)), 0, "nothing locked");
    }

    /// Claim: a sealed gate refuses a send with evidence. Shows: after a seal, an honest evidence send reverts with
    /// `GateSealed`. Matters: evidence in the send does not reopen a sealed route.
    function test_sealedGateRefusesEvidence() public {
        gate.seal(_sealEvidence(block.timestamp, _slotIn(EPOCH_E, 3), FULU));
        bytes memory evidence = _evidenceNow(EPOCH_E);
        vm.expectRevert(BeaconForkGate.GateSealed.selector);
        _wrapAndRelay(evidence);
    }
}

/// @notice Receipt-level gas of a send with gate evidence against the confirm-then-send pattern it replaces. Each call
/// runs as a transaction of its own (isolation), so the figures include the 21,000 gas of a transaction, its calldata
/// and cold accounts, as in `BridgeWorld.t.sol`. The refund (at most a fifth, EIP-3529) is subtracted.
contract RouterGateEvidenceGasTest is RouterGateEvidenceBase {
    function _receiptGas() internal view returns (uint256) {
        Vm.Gas memory spent = vm.lastCallGas();
        uint256 refund = uint256(int256(spent.gasRefunded));
        if (refund > spent.gasTotalUsed / 5) refund = spent.gasTotalUsed / 5;
        return spent.gasTotalUsed - refund;
    }

    /// @dev One `relayTokensAndCall` of `alice` as a transaction; returns its receipt gas.
    function _sendTx(bytes memory evidence) internal returns (uint256) {
        vm.chainId(CHAIN_A);
        vm.prank(alice, alice);
        router.relayTokensAndCall{value: VALUE}(receiver, hex"7777", ROUTER_CALLBACK_GAS, evidence);
        return _receiptGas();
    }

    /// @dev One `wrapAndRelayTokens(receiver, evidence)` of `alice` as a transaction; returns its receipt gas.
    function _wrapTx(bytes memory evidence) internal returns (uint256) {
        vm.chainId(CHAIN_A);
        vm.prank(alice, alice);
        router.wrapAndRelayTokens{value: VALUE}(receiver, evidence);
        return _receiptGas();
    }

    function _confirmTx(bytes memory evidence) internal returns (uint256) {
        vm.prank(alice, alice);
        gate.confirm(evidence);
        return _receiptGas();
    }

    /// Claim: the first send of an epoch that carries its evidence costs less than a confirm transaction plus a send.
    /// Shows: receipt gas of (a) confirm tx + empty send tx, (b) one send carrying the evidence, (c) an empty send in a
    /// confirmed epoch, for both entry points; logged. (b) is below (a) by about one transaction's base cost.
    /// Matters: the gas the frontends suggest, and the figures in `docs/hardened-build-contract.md`.
    /// forge-config: default.isolate = true
    /// forge-config: deep.isolate = true
    function test_gas_evidenceInTheSendAgainstConfirmThenSend() public {
        // Warm-up: the first relay of the wrapped token registers it on the mediator, which is not the common kind.
        gate.confirm(_evidenceNow(EPOCH_E));
        _sendTx("");

        // Control: isolation is on, each call is a transaction.
        vm.prank(alice, alice);
        wrapped.transfer(alice, 0);
        assertGe(vm.lastCallGas().gasTotalUsed, 21_000, "control: isolation is on");

        _warpIntoEpoch(EPOCH_E + 1, 3);
        uint256 confirmGas = _confirmTx(_evidenceNow(EPOCH_E + 1));
        uint256 callAfterConfirm = _sendTx("");
        uint256 wrapAfterConfirm = _wrapTx("");

        _warpIntoEpoch(EPOCH_E + 2, 3);
        uint256 callWithEvidence = _sendTx(_evidenceNow(EPOCH_E + 2));
        uint256 callConfirmedEmpty = _sendTx("");

        _warpIntoEpoch(EPOCH_E + 3, 3);
        uint256 wrapWithEvidence = _wrapTx(_evidenceNow(EPOCH_E + 3));
        uint256 wrapConfirmedEmpty = _wrapTx("");
        uint256 wrapConfirmedWithEvidence = _wrapTx(_evidenceNow(EPOCH_E + 3));

        emit log_named_uint("confirm tx", confirmGas);
        emit log_named_uint("relayTokensAndCall, empty evidence, confirmed epoch", callAfterConfirm);
        emit log_named_uint("  confirm tx + relayTokensAndCall", confirmGas + callAfterConfirm);
        emit log_named_uint("relayTokensAndCall with evidence, unconfirmed epoch", callWithEvidence);
        emit log_named_uint("relayTokensAndCall, empty evidence, confirmed epoch (again)", callConfirmedEmpty);
        emit log_named_uint("wrapAndRelayTokens, empty evidence, confirmed epoch", wrapAfterConfirm);
        emit log_named_uint("  confirm tx + wrapAndRelayTokens", confirmGas + wrapAfterConfirm);
        emit log_named_uint("wrapAndRelayTokens with evidence, unconfirmed epoch", wrapWithEvidence);
        emit log_named_uint("wrapAndRelayTokens, empty evidence, confirmed epoch (again)", wrapConfirmedEmpty);
        emit log_named_uint("wrapAndRelayTokens with evidence, confirmed epoch", wrapConfirmedWithEvidence);

        assertLt(callWithEvidence, confirmGas + callAfterConfirm, "one transaction is cheaper than two");
        assertLt(wrapWithEvidence, confirmGas + wrapAfterConfirm, "the same for wrapAndRelayTokens");
        assertGt(callWithEvidence, callConfirmedEmpty + 30_000, "control: the evidence send paid for the proof");
    }
}
