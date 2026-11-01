// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {MediatorFixture, MockAMB, RecordingReceiver, TEST_CALLBACK_GAS} from "./utils/MediatorSupport.sol";

/// @notice A target that does nothing. It gives the baseline cost of a delivery through the mock bridge.
contract NoopTarget {
    fallback() external {}
}

/// @notice Measures the gas of the relay and delivery paths, and checks that each message kind stays inside its gas
/// limit constant with a margin. Run with `-vv --isolate` to read the figures: `--isolate` makes each call its own
/// transaction, so storage is cold and writes cost what they cost in a real transaction.
/// @dev The mock bridge stores every message and its context in storage, and that cost is not the cost of the mediator.
/// So each figure is the measured gas less the cost of the same step through the mock: for a relay, the cost of
/// `requireToPassMessage` with the same payload; for a delivery, the cost of a delivery of an empty call. The real
/// message bridge has its own cost for both steps, which is not in these figures. Each correction is accurate to a few
/// thousand gas, because the mock slots are warm in the second measure and may be cold in the first.
contract TokenMediatorGasTest is MediatorFixture {
    /// @dev The share of its budget that a delivery may use. The rest is the margin for cold storage and token variety.
    uint256 internal constant MAXIMUM_SHARE_PERCENT = 70;
    /// @dev Regression budgets of this report. They are the old gas defaults of the mediator, which no message carries
    /// any more: a delivery gets all the gas of the executor. They only make a large change of cost show up.
    uint256 internal constant DEPLOY_BUDGET = 2_000_000;
    uint256 internal constant RELEASE_BUDGET = 250_000;
    uint256 internal constant CALL_BUDGET = 1_000_000;

    NoopTarget internal noop;
    /// @dev A bridge with its own storage, so measuring the cost of a send does not add messages to the real ones.
    MockAMB internal scratch;
    uint256 internal deliveryBaseline;

    function setUp() public override {
        super.setUp();
        noop = new NoopTarget();
        scratch = new MockAMB(CHAIN_A, CHAIN_B);
        scratch.requireToPassMessage(address(noop), hex"00", 1);
        // The first call writes the context slots from zero. Measure the second, as later deliveries see it.
        ambA.execute(address(noop), "", address(mediatorB), bytes32(CHAIN_B), bytes32(uint256(1)), 100_000);
        uint256 gasBefore = gasleft();
        ambA.execute(address(noop), "", address(mediatorB), bytes32(CHAIN_B), bytes32(uint256(1)), 100_000);
        deliveryBaseline = gasBefore - gasleft();
    }

    function test_gasOfRelayAndDelivery() public {
        MockERC20 second = new MockERC20("Second", "SEC");
        second.mint(alice, 1_000 ether);
        vm.prank(alice);
        second.approve(address(mediatorA), type(uint256).max);
        console2.log("mock delivery baseline removed from each delivery:", deliveryBaseline);

        // Relay on the native side: the first relay of a token, then a later relay of the same token.
        console2.log(
            "relayTokens, native, first relay of a token (deploy form):", _gasOfRelay(address(tokenA), 10 ether)
        );
        console2.log(
            "relayTokens, native, later relay of the same token:      ", _gasOfRelay(address(tokenA), 10 ether)
        );
        console2.log(
            "relayTokens, native, a second token, first relay:         ", _gasOfRelay(address(second), 10 ether)
        );

        // Delivery on the other chain: the first message deploys the copy, later messages mint.
        uint256 deployLimit = DEPLOY_BUDGET;
        console2.log("delivery: deployAndHandleBridgedTokens, first:", _gasOfDeliveryAtoB(0, deployLimit));
        console2.log("delivery: deployAndHandleBridgedTokens, later:", _gasOfDeliveryAtoB(1, deployLimit));
        console2.log("delivery: deployAndHandle..., second token (second copy): ", _gasOfDeliveryAtoB(2, deployLimit));

        // Relay of a copy: burn path. Delivery on the native side: unlock.
        address copy = _copyOf(address(tokenA));
        vm.prank(bob);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        vm.prank(bob);
        uint256 gasBefore = gasleft();
        mediatorB.relayTokens(copy, bob, 5 ether);
        uint256 total = gasBefore - gasleft();
        console2.log("relayTokens, bridged copy (burn):                         ", total - _mockSendCost(ambB, 0));
        console2.log(
            "delivery: handleNativeTokens (unlock):                    ",
            _gasOfDeliveryBtoA(0, RELEASE_BUDGET)
        );

        // After the return trip the short form applies.
        console2.log(
            "relayTokens, native, short form after the return trip:    ", _gasOfRelay(address(tokenA), 1 ether)
        );
        console2.log(
            "delivery: handleBridgedTokens (mint, short form):         ",
            _gasOfDeliveryAtoB(3, RELEASE_BUDGET)
        );

        // With a call.
        RecordingReceiver receiver = new RecordingReceiver();
        vm.prank(alice);
        gasBefore = gasleft();
        mediatorA.relayTokensAndCall(address(tokenA), address(receiver), 1 ether, hex"0102", TEST_CALLBACK_GAS);
        total = gasBefore - gasleft();
        console2.log(
            "relayTokensAndCall, native, receiver is a contract:       ", total - _mockSendCost(ambA, _lastIndexA())
        );
        uint256 callLimit = CALL_BUDGET;
        console2.log("delivery: handleBridgedTokensAndCall (mint and callback): ", _gasOfDeliveryAtoB(4, callLimit));
    }

    /// @dev The cost of the mock bridge to record the message at `index`: the same send, made again by the test.
    function _mockSendCost(MockAMB bridge, uint256 index) private returns (uint256) {
        MockAMB.Sent memory message = bridge.messageAt(index);
        uint256 gasBefore = gasleft();
        scratch.requireToPassMessage(message.target, message.data, message.gasLimit);
        return gasBefore - gasleft();
    }

    function _gasOfRelay(address token, uint256 value) private returns (uint256) {
        vm.prank(alice);
        uint256 gasBefore = gasleft();
        mediatorA.relayTokens(token, bob, value);
        uint256 total = gasBefore - gasleft();
        return total - _mockSendCost(ambA, _lastIndexA());
    }

    function _gasOfDeliveryAtoB(uint256 index, uint256 limit) private returns (uint256 used) {
        uint256 gasBefore = gasleft();
        (bool ok,) = _deliverAtoB(index);
        used = gasBefore - gasleft() - deliveryBaseline;
        assertTrue(ok);
        assertLt(used * 100, limit * MAXIMUM_SHARE_PERCENT, "the delivery fits its budget with a margin");
    }

    function _gasOfDeliveryBtoA(uint256 index, uint256 limit) private returns (uint256 used) {
        uint256 gasBefore = gasleft();
        (bool ok,) = _deliverBtoA(index);
        used = gasBefore - gasleft() - deliveryBaseline;
        assertTrue(ok);
        assertLt(used * 100, limit * MAXIMUM_SHARE_PERCENT, "the delivery fits its budget with a margin");
    }
}
