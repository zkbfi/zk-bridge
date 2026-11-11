// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {DeliveryRouter} from "../../src/hardened/mediator/DeliveryRouter.sol";
import {ITokenMediator} from "../../src/hardened/mediator/ITokenMediator.sol";
import {IWETH} from "../../src/hardened/mediator/IWETH.sol";
import {MockERC20, MockWrappedNative} from "./mediator/utils/MediatorSupport.sol";
import {WorldSupport} from "./utils/WorldSupport.sol";

/// @notice Receipt gas of a send through the router and through the mediator, over the real bridge and mediator, with an
/// `Enforcing` gate (a confirmed epoch, and the confirm transaction of the first sender of an epoch) against a
/// `SealOnly` gate; and the receipt gas of `seal`. Each call runs as its own transaction (isolation), so the figures
/// include the 21,000 of a transaction and its calldata; the refund is capped at a fifth. The figures go to
/// `docs/hardened-build-contract.md`, "Seal-only gate".
contract SendGateGasTest is WorldSupport {
    uint256 internal constant VALUE = 1 ether;
    uint256 internal constant CALLBACK_GAS = 300_000;

    DeliveryRouter internal router;
    MockWrappedNative internal wrapped;
    MockERC20 internal token;
    address internal receiver = makeAddr("receiver on B");

    function _receiptGas() internal view returns (uint256) {
        Vm.Gas memory spent = vm.lastCallGas();
        uint256 refund = uint256(int256(spent.gasRefunded));
        if (refund > spent.gasTotalUsed / 5) refund = spent.gasTotalUsed / 5;
        return spent.gasTotalUsed - refund;
    }

    function _world(BeaconForkGate gate) internal {
        _deployWorld(address(gate), address(gateB));
        wrapped = new MockWrappedNative();
        router = new DeliveryRouter(
            ITokenMediator(address(mediatorA)), IWETH(address(wrapped)), makeAddr("reward"), makeAddr("failed delivery")
        );
        token = new MockERC20("Token A", "TKA");
        token.mint(alice, 1_000 ether);
        vm.prank(alice, alice);
        token.approve(address(mediatorA), type(uint256).max);
        vm.deal(alice, 100 ether);
    }

    function _wrapTx() internal returns (uint256) {
        vm.chainId(CHAIN_A);
        vm.prank(alice, alice);
        router.wrapAndRelayTokens{value: VALUE}(receiver);
        return _receiptGas();
    }

    function _callTx() internal returns (uint256) {
        vm.chainId(CHAIN_A);
        vm.prank(alice, alice);
        router.relayTokensAndCall{value: VALUE}(receiver, hex"7777", CALLBACK_GAS);
        return _receiptGas();
    }

    function _mediatorTx() internal returns (uint256) {
        vm.chainId(CHAIN_A);
        vm.prank(alice, alice);
        mediatorA.relayTokens(address(token), receiver, VALUE);
        return _receiptGas();
    }

    /// @dev The first relay of each token registers it on the mediator, which is not the common kind of send.
    function _warmUp() internal {
        _wrapTx();
        _mediatorTx();
    }

    /// Claim: with an `Enforcing` gate, a send in a confirmed epoch and the confirm of the first sender cost what is
    /// logged. Shows: the receipt gas of the confirm transaction and of the three sends in the confirmed epoch.
    /// Matters: the "before" column of the comparison.
    /// forge-config: default.isolate = true
    /// forge-config: deep.isolate = true
    function test_gas_sendsThroughAnEnforcingGate() public {
        _warpIntoEpoch(EPOCH_E, 3);
        _etchMock();
        BeaconForkGate gate = _newGate(BeaconForkGate.GateMode.Enforcing);
        _world(gate);
        gate.confirm(_honestEvidence(block.timestamp, _slotIn(EPOCH_E, 2), 6, ELECTRA));
        _warmUp();

        _warpIntoEpoch(EPOCH_E + 1, 3);
        bytes memory evidence = _honestEvidence(block.timestamp, _slotIn(EPOCH_E + 1, 2), 6, ELECTRA);
        vm.prank(alice, alice);
        gate.confirm(evidence);
        uint256 confirmGas = _receiptGas();
        assertGe(confirmGas, 21_000, "control: isolation is on");
        uint256 wrapGas = _wrapTx();
        uint256 callGas = _callTx();
        uint256 mediatorGas = _mediatorTx();
        emit log_named_uint("enforcing: confirm tx (first sender of an epoch)", confirmGas);
        emit log_named_uint("enforcing: router wrapAndRelayTokens(receiver), confirmed epoch", wrapGas);
        emit log_named_uint("enforcing: router relayTokensAndCall, confirmed epoch", callGas);
        emit log_named_uint("enforcing: mediator relayTokens, confirmed epoch", mediatorGas);
    }

    /// Claim: with a `SealOnly` gate, every send costs the same in every epoch with no confirm, and `seal` costs what is
    /// logged. Shows: the receipt gas of the three sends in two epochs is equal; `seal` with a depth 8 proof; logged.
    /// Matters: the "after" column, and the cost of the seal that the watcher posts.
    /// forge-config: default.isolate = true
    /// forge-config: deep.isolate = true
    function test_gas_sendsThroughASealOnlyGateAndTheSeal() public {
        _warpIntoEpoch(EPOCH_E, 3);
        _etchMock();
        BeaconForkGate gate = _newGate(BeaconForkGate.GateMode.SealOnly);
        _world(gate);
        _warmUp();

        _warpIntoEpoch(EPOCH_E + 1, 3);
        uint256 wrapGas = _wrapTx();
        uint256 callGas = _callTx();
        uint256 mediatorGas = _mediatorTx();
        assertGe(wrapGas, 21_000, "control: isolation is on");
        _warpIntoEpoch(EPOCH_E + 2, 20);
        assertEq(_wrapTx(), wrapGas, "the same in the next epoch: router wrap");
        assertEq(_callTx(), callGas, "the same in the next epoch: router call");
        assertEq(_mediatorTx(), mediatorGas, "the same in the next epoch: mediator");

        bytes memory evidence = _sealEvidence(block.timestamp, _slotIn(EPOCH_E + 2, 20), UNKNOWN_FORK);
        vm.prank(alice, alice);
        gate.seal(evidence);
        uint256 sealGas = _receiptGas();
        assertTrue(gate.isSealed());
        emit log_named_uint("seal-only: router wrapAndRelayTokens(receiver)", wrapGas);
        emit log_named_uint("seal-only: router relayTokensAndCall", callGas);
        emit log_named_uint("seal-only: mediator relayTokens", mediatorGas);
        emit log_named_uint("seal(evidence), depth 8 proof (synthetic tree)", sealGas);
    }
}
