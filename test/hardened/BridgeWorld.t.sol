// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {AmbMessageCodec} from "../../src/hardened/AmbMessageCodec.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {BridgedToken} from "../../src/hardened/mediator/BridgedToken.sol";
import {DeliveryRouter} from "../../src/hardened/mediator/DeliveryRouter.sol";
import {ITokenMediator} from "../../src/hardened/mediator/ITokenMediator.sol";
import {IWETH} from "../../src/hardened/mediator/IWETH.sol";
import {MockWrappedNative} from "./mediator/utils/MediatorSupport.sol";
import {WorldSupport} from "./utils/WorldSupport.sol";

/// @notice An application on chain A. It sends one message through the bridge, so the sender that the bridge records is
/// this contract and not the account that called it.
contract WorldApplication {
    function send(MessageBridge bridge, address target, bytes calldata data, uint256 gas) external returns (bytes32) {
        return bridge.requireToPassMessage(target, data, gas);
    }
}

/// @notice A receiver on chain B. During the call it records what the bridge reports. A test reads the record, and reads
/// the same views of the bridge outside the call.
contract WorldReceiver {
    MessageBridge public immutable bridge;
    uint256 public calls;
    address public seenCaller;
    address public seenSender;
    bytes32 public seenSourceChain;
    bytes32 public seenMessageId;
    bytes32 public seenTransactionHash;

    constructor(MessageBridge bridge_) {
        bridge = bridge_;
    }

    function record() external {
        calls++;
        seenCaller = msg.sender;
        seenSender = bridge.messageSender();
        seenSourceChain = bridge.messageSourceChainId();
        seenMessageId = bridge.messageId();
        seenTransactionHash = bridge.transactionHash();
    }

    function refuse() external pure {
        revert("the receiver refuses");
    }
}

/// @notice A contract that confirms the epoch and sends in one transaction, as a multicall contract does.
contract WorldMulticall {
    function confirmAndSend(
        BeaconForkGate gate,
        bytes calldata evidence,
        MessageBridge bridge,
        address target,
        bytes calldata data
    ) external returns (bytes32) {
        gate.confirm(evidence);
        return bridge.requireToPassMessage(target, data, 300_000);
    }
}

/// @notice The whole stack: two chains in one test, the real `MessageBridge` and the real `TokenMediator` on each, and
/// real proofs of the logs that the real contracts emit. No mock stands between a send and its delivery. The proofs
/// carry a synthetic beacon part (see `DynamicProofs`), and the tries are real.
contract BridgeWorldTest is WorldSupport {
    uint256 internal constant AMOUNT = 400 ether;

    MockERC20 internal nativeToken;
    address internal receiverOnA = makeAddr("receiver on A");
    address internal receiverOnB = makeAddr("receiver on B");

    function setUp() public override {
        super.setUp();
        nativeToken = new MockERC20("Token A", "TKA");
        nativeToken.mint(alice, 10_000 ether);
        vm.prank(alice);
        nativeToken.approve(address(mediatorA), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Records the logs of one relay on chain A, and measures the gas of the send.
    function _relayFromA(address sender, address recipient, uint256 value)
        internal
        returns (Vm.Log[] memory recorded, uint256 gasUsed)
    {
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        vm.prank(sender);
        uint256 before = gasleft();
        mediatorA.relayTokens(address(nativeToken), recipient, value);
        gasUsed = before - gasleft();
        recorded = vm.getRecordedLogs();
    }

    /// @dev Records the logs of one relay of the bridged copy on chain B, and measures the gas of the send.
    function _relayBackFromB(address sender, address recipient, uint256 value)
        internal
        returns (Vm.Log[] memory recorded, uint256 gasUsed)
    {
        address copy = mediatorB.bridgedTokenAddress(address(nativeToken));
        vm.chainId(CHAIN_B);
        vm.prank(sender);
        BridgedToken(copy).approve(address(mediatorB), type(uint256).max);
        vm.recordLogs();
        vm.prank(sender);
        uint256 before = gasleft();
        mediatorB.relayTokens(copy, recipient, value);
        gasUsed = before - gasleft();
        recorded = vm.getRecordedLogs();
    }

    /// @dev Records the logs of a relay with a call on chain A.
    function _relayAndCallFromA(address sender, address receiver, uint256 value, bytes memory data)
        internal
        returns (Vm.Log[] memory)
    {
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        vm.prank(sender);
        mediatorA.relayTokensAndCall(address(nativeToken), receiver, value, data);
        return vm.getRecordedLogs();
    }

    /// @dev The address where `TokenFactory` must put the copy of `nativeToken`, from the salt rule of the factory and
    /// the creation code of the token, not from the mediator.
    function _independentCopyAddress(address token) internal view returns (address) {
        bytes32 salt = keccak256(abi.encode(uint256(CHAIN_A), token));
        return
            vm.computeCreate2Address(
                salt, keccak256(type(BridgedToken).creationCode), address(mediatorB.tokenFactory())
            );
    }

    function _selectorOfData(bytes memory data) internal pure returns (bytes4 selector) {
        assembly {
            selector := mload(add(data, 0x20))
        }
    }

    // ---------------------------------------------------------------- tests

    /// Claim: a native token that a sender relays on chain A reaches chain B as a bridged copy at the computed address,
    /// and the copy returns to chain A and unlocks the native token. Each step is a real send, a real proof of the
    /// logs of that send, and a real `executeMessage`. Shows: the copy sits at the address that an independent CREATE2
    /// computation gives and has the name, symbol and decimals of the mediator code; the receiver holds the amount; the
    /// record of the mediator equals the tokens that it holds. After the return the copy has no supply, the receiver on
    /// chain A holds the tokens, and the record is zero. The first message is the deploy form and the first message
    /// after the return is the short form. A replay is refused, and the proof does not run on the sending bridge.
    /// Matters: this is the whole product. Each unit passes alone against mocks. Only this test proves that the
    /// encoding of the mediator, the log of the bridge, the proof, the context of the bridge and the handlers agree.
    function test_tokenRelayRoundTrip() public {
        // Step 1 and 2: send on A, execute on B (the first message, so it deploys the copy).
        (Vm.Log[] memory sentOnA, uint256 sendGasOnA) = _relayFromA(alice, receiverOnB, AMOUNT);
        (, bytes memory firstData) = _messageOf(sentOnA, bridgeA);
        assertEq(
            _selectorOfData(firstData), mediatorB.deployAndHandleBridgedTokens.selector, "the first message deploys"
        );
        assertFalse(mediatorA.isBridgedTokenDeployAcknowledged(address(nativeToken)), "no return trip yet");

        Transit memory toB = _deliverToB(sentOnA);
        assertTrue(bridgeB.messageCallStatus(toB.messageId), "the message executed on chain B");

        address copy = mediatorB.bridgedTokenAddress(address(nativeToken));
        assertEq(copy, _independentCopyAddress(address(nativeToken)), "the copy is at the address of the factory rule");
        assertGt(copy.code.length, 0, "the copy has code");
        assertEq(BridgedToken(copy).name(), "Token A from Chain A", "the name");
        assertEq(BridgedToken(copy).symbol(), "zTKA", "the symbol");
        assertEq(BridgedToken(copy).decimals(), 18, "the decimals");
        assertEq(BridgedToken(copy).balanceOf(receiverOnB), AMOUNT, "the receiver holds the amount, with no fee");
        assertEq(BridgedToken(copy).totalSupply(), AMOUNT, "the copy supply is the amount");
        assertEq(mediatorA.mediatorBalance(address(nativeToken)), AMOUNT, "the record on chain A");
        assertEq(nativeToken.balanceOf(address(mediatorA)), AMOUNT, "the record equals the tokens locked");

        _refuseReplayAndWrongBridge(toB);

        // Step 3 and 4: the receiver relays the copy back, and chain A unlocks the native token.
        (Vm.Log[] memory sentOnB, uint256 sendGasOnB) = _relayBackFromB(receiverOnB, receiverOnA, AMOUNT);
        Transit memory toA = _deliverToA(sentOnB);
        assertTrue(bridgeA.messageCallStatus(toA.messageId), "the message executed on chain A");

        assertEq(BridgedToken(copy).totalSupply(), 0, "the copy is burned");
        assertEq(BridgedToken(copy).balanceOf(receiverOnB), 0, "the receiver on chain B holds nothing");
        assertEq(nativeToken.balanceOf(receiverOnA), AMOUNT, "the native token is unlocked to the receiver");
        assertEq(mediatorA.mediatorBalance(address(nativeToken)), 0, "the record is zero again");
        assertEq(nativeToken.balanceOf(address(mediatorA)), 0, "the mediator holds nothing");
        assertEq(nativeToken.balanceOf(alice) + nativeToken.balanceOf(receiverOnA), 10_000 ether, "balances add up");
        assertTrue(mediatorA.isBridgedTokenDeployAcknowledged(address(nativeToken)), "the return trip proves the copy");

        // A second relay after the return trip is the short form, and it costs less to execute.
        (Vm.Log[] memory secondOnA,) = _relayFromA(alice, receiverOnB, AMOUNT);
        (, bytes memory secondData) = _messageOf(secondOnA, bridgeA);
        assertEq(_selectorOfData(secondData), mediatorB.handleBridgedTokens.selector, "the short form");
        Transit memory second = _deliverToB(secondOnA);
        assertEq(BridgedToken(copy).balanceOf(receiverOnB), AMOUNT, "the short form mints to the receiver");
        assertLt(second.gasUsed, toB.gasUsed, "the short form is cheaper than the deploy form");

        uint256 total = sendGasOnA + toB.gasUsed + sendGasOnB + toA.gasUsed;
        emit log_named_uint("gas: send on A (relayTokens, native token, first time)", sendGasOnA);
        emit log_named_uint("gas: execute on B (with the deployment of the copy)", toB.gasUsed);
        emit log_named_uint("gas: send on B (relayTokens, burn of the copy)", sendGasOnB);
        emit log_named_uint("gas: execute on A (unlock)", toA.gasUsed);
        emit log_named_uint("gas: sum of the four steps", total);
        emit log_named_uint("gas: execute on B, short form (second relay)", second.gasUsed);
    }

    /// @dev The refusals of the round trip test: a replay on the destination, and a run on the sending bridge. The
    /// second one has two forms, because the anchor check comes before the emitter check.
    function _refuseReplayAndWrongBridge(Transit memory toB) internal {
        vm.chainId(CHAIN_B);
        vm.expectRevert(abi.encodeWithSelector(MessageBridge.AlreadyDelivered.selector, toB.messageId));
        bridgeB.executeMessage(toB.proof);

        // The proof of the message of A on the bridge of A: the light client of A does not hold its anchor.
        vm.chainId(CHAIN_A);
        vm.expectPartialRevert(BeaconProofVerifier.AnchorNotStored.selector);
        bridgeA.executeMessage(toB.proof);

        // The same log with a beacon part that the bridge of A accepts: the emitter is bridge A, but bridge A expects
        // the messages of bridge B, so the log is refused before its destination is read.
        (MessageBridge.MessageProof memory forA,) =
            _proveMessage(bridgeA, lightClientForA, GENESIS_ROOT_B, toB.source, toB.logIndex);
        vm.expectRevert(
            abi.encodeWithSelector(BeaconProofVerifier.WrongEmitter.selector, address(bridgeB), address(bridgeA))
        );
        bridgeA.executeMessage(forA);
    }

    /// Claim: an application on chain A sends an arbitrary message, and the receiver on chain B sees the real context of
    /// the bridge. Shows: during the call the sender is the application, the source chain is 1, the identifier equals
    /// the one that the send returned, the transaction hash is the hash of the transaction that holds the log, and the
    /// caller is bridge B. Outside the call all four views are zero. A receiver that reverts leaves a final failure.
    /// Matters: every application trusts these views. A wrong view makes a receiver accept a forged sender, or lose the
    /// link from a message to its source transaction.
    function test_arbitraryMessage() public {
        WorldApplication application = new WorldApplication();
        WorldReceiver receiver = new WorldReceiver(bridgeB);
        bytes memory data = abi.encodeCall(WorldReceiver.record, ());

        vm.chainId(CHAIN_A);
        vm.recordLogs();
        uint256 before = gasleft();
        bytes32 id = application.send(bridgeA, address(receiver), data, 300_000);
        uint256 sendGas = before - gasleft();
        Vm.Log[] memory recorded = vm.getRecordedLogs();

        Transit memory transit = _deliverToB(recorded);

        assertEq(transit.messageId, id, "the log carries the identifier that the send returned");
        assertTrue(bridgeB.messageCallStatus(id), "the message executed");
        assertEq(receiver.calls(), 1, "one call");
        assertEq(receiver.seenSender(), address(application), "the sender is the application, not the account");
        assertEq(receiver.seenSourceChain(), bytes32(uint256(CHAIN_A)), "the source chain is 1");
        assertEq(receiver.seenMessageId(), id, "the identifier");
        assertEq(
            receiver.seenTransactionHash(), _transactionHashOf(transit.source), "the hash of the source transaction"
        );
        assertEq(receiver.seenCaller(), address(bridgeB), "the caller is bridge B");

        assertEq(bridgeB.messageSender(), address(0), "outside the call: no sender");
        assertEq(bridgeB.messageSourceChainId(), bytes32(0), "outside the call: no source chain");
        assertEq(bridgeB.messageId(), bytes32(0), "outside the call: no identifier");
        assertEq(bridgeB.transactionHash(), bytes32(0), "outside the call: no transaction hash");

        emit log_named_uint("gas: send (application to bridge A, arbitrary message)", sendGas);
        emit log_named_uint("gas: execute (bridge B to receiver)", transit.gasUsed);
        emit log_named_uint("gas: sum", sendGas + transit.gasUsed);

        _failingReceiverIsFinal(application, receiver);
    }

    /// @dev A message to a receiver that reverts. The bridge marks it final: failed, never repeated, with the data that
    /// OmniBridge keeps.
    function _failingReceiverIsFinal(WorldApplication application, WorldReceiver receiver) internal {
        bytes memory data = abi.encodeCall(WorldReceiver.refuse, ());
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        bytes32 id = application.send(bridgeA, address(receiver), data, 300_000);
        Vm.Log[] memory recorded = vm.getRecordedLogs();

        Transit memory transit = _deliverToB(recorded);

        assertFalse(bridgeB.messageCallStatus(id), "the call failed");
        assertEq(bridgeB.failedMessageDataHash(id), keccak256(data), "the data hash of the failure");
        assertEq(bridgeB.failedMessageReceiver(id), address(receiver), "the receiver of the failure");
        assertEq(bridgeB.failedMessageSender(id), address(application), "the sender of the failure");
        vm.expectRevert(abi.encodeWithSelector(MessageBridge.AlreadyDelivered.selector, id));
        bridgeB.executeMessage(transit.proof);
        assertEq(receiver.calls(), 1, "the failed message did not change the receiver");
    }

    /// Claim: a delivery through the delivery router pays a tip to the reward address, and plain execution pays none. All
    /// of it runs through the real bridge and the real mediator. Shows: with a fixed fee the reward address holds the tip
    /// in the bridged copy and the recipient holds the rest. With a gas based fee the reward address is paid from the measured gas:
    /// positive, below the cap, and bounded by the fee of the gas that the caller supplied (4,000,000, set with an explicit gas amount). A small cap binds. Plain
    /// `executeMessage` of the same kind of message pays no fee. Matters: the router relies on the callback order and on
    /// the gas rule of the bridge. Only the real bridge forwards exactly the gas of the message.
    function test_deliveryRouterPaysTheRewardAddressThroughTheRealBridge() public {
        MockWrappedNative wrapped = new MockWrappedNative();
        DeliveryRouter router = new DeliveryRouter(
            ITokenMediator(address(mediatorB)),
            IWETH(address(wrapped)),
            makeAddr("fee reward address"),
            makeAddr("fee failed delivery address")
        );
        // The first message of a token deploys its copy and costs more. Do it plainly, so the fee tests measure a
        // delivery of the common kind.
        (Vm.Log[] memory first,) = _relayFromA(alice, receiverOnB, 100 ether);
        _deliverToB(first);
        address copy = mediatorB.bridgedTokenAddress(address(nativeToken));
        assertGt(copy.code.length, 0, "the copy exists");

        _fixedFee(router, copy);
        _gasBasedFee(router, copy);
        _directDeliveryNoFee(router, copy);
        _defaultTipOnBothPaths(router, copy);
    }

    /// Claim: the call path through the router pays the default tip, and a direct delivery pays none. The sender
    /// relays through the mediator of chain A to the router on chain B, with a tip of 0.1% (the multiplier of total
    /// mode with the multiplier 1e15). Path one: an account calls `DeliveryRouter.executeMessage`, which calls
    /// `MessageBridge.executeMessage`, and the mediator delivers the tokens to the router. The router sees the starting
    /// gas, takes the tip, and pays the recipient. Path two: anyone calls `MessageBridge.executeMessage` directly. The
    /// mediator still delivers to the router, but no starting gas is recorded, so the router pays the recipient everything.
    /// Matters: this is the money path of the explorer, and both paths must pay exact amounts.
    function _defaultTipOnBothPaths(DeliveryRouter router, address copy) internal {
        uint256 value = 100 ether;
        uint256 tip = 0.1 ether;
        address viaRouter = makeAddr("recipient, tip through the router");
        address viaDirect = makeAddr("recipient, direct delivery");
        uint256 rewardBefore = BridgedToken(copy).balanceOf(router.rewardAddress());

        Vm.Log[] memory recorded = _relayAndCallFromA(
            alice, address(router), value, _directorData(viaRouter, router.MULTIPLIER_OF_TOTAL(), 0, 1e15)
        );
        Transit memory transit = _proveForB(recorded);
        vm.chainId(CHAIN_B);
        _gasOfRouterRun(router, transit);
        assertTrue(bridgeB.messageCallStatus(transit.messageId), "the message executed through the router");
        assertEq(
            BridgedToken(copy).balanceOf(router.rewardAddress()) - rewardBefore,
            tip,
            "the reward address holds exactly 0.1%"
        );
        assertEq(BridgedToken(copy).balanceOf(viaRouter), value - tip, "the recipient holds the rest");
        assertEq(BridgedToken(copy).balanceOf(address(router)), 0, "the router keeps nothing");

        recorded = _relayAndCallFromA(
            alice, address(router), value, _directorData(viaDirect, router.MULTIPLIER_OF_TOTAL(), 0, 1e15)
        );
        transit = _deliverToB(recorded);
        assertTrue(bridgeB.messageCallStatus(transit.messageId), "the message executed on the bridge directly");
        assertEq(BridgedToken(copy).balanceOf(viaDirect), value, "a direct delivery pays no tip");
        assertEq(
            BridgedToken(copy).balanceOf(router.rewardAddress()) - rewardBefore,
            tip,
            "the reward address earned nothing more"
        );
        assertEq(BridgedToken(copy).balanceOf(address(router)), 0, "the router keeps nothing");
    }

    function _directorData(address recipient, uint256 settings, uint256 limit, uint256 multiplier)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(DeliveryRouter.FeeDirector(recipient, settings, limit, multiplier));
    }

    function _fixedFee(DeliveryRouter router, address copy) internal {
        address recipient = makeAddr("recipient, fixed fee");
        uint256 value = 100 ether;
        uint256 fee = 3 ether;
        Vm.Log[] memory recorded =
            _relayAndCallFromA(alice, address(router), value, _directorData(recipient, router.FIXED_FEE(), fee, 0));
        Transit memory transit = _proveForB(recorded);

        vm.chainId(CHAIN_B);
        vm.prank(bob, bob);
        router.executeMessage(transit.proof);

        assertTrue(bridgeB.messageCallStatus(transit.messageId), "the message executed");
        assertEq(BridgedToken(copy).balanceOf(router.rewardAddress()), fee, "the reward address holds the fixed tip");
        assertEq(BridgedToken(copy).balanceOf(recipient), value - fee, "the recipient holds the rest");
        assertEq(BridgedToken(copy).balanceOf(address(router)), 0, "the router keeps nothing");
    }

    /// @dev The gas of one call through the router, made by an account with no role.
    function _gasOfRouterRun(DeliveryRouter router, Transit memory transit) internal returns (uint256) {
        vm.prank(bob, bob);
        uint256 before = gasleft();
        router.executeMessage(transit.proof);
        return before - gasleft();
    }

    function _gasBasedFee(DeliveryRouter router, address copy) internal {
        vm.txGasPrice(1 gwei);
        address recipient = makeAddr("recipient, gas based fee");
        uint256 value = 100 ether;
        uint256 cap = 1 ether;
        DeliveryRouter.FeeDirector memory director = DeliveryRouter.FeeDirector(recipient, 0, cap, 1 ether);
        Vm.Log[] memory recorded = _relayAndCallFromA(alice, address(router), value, abi.encode(director));
        Transit memory transit = _proveForB(recorded);

        vm.chainId(CHAIN_B);
        uint256 heldBefore = BridgedToken(copy).balanceOf(router.rewardAddress());
        // The caller supplies an exact amount. The real bridge forwards only the gas limit of the message, so the router
        // measures the supplied gas less what the bridge held back, plus the work in between.
        uint256 supplied = 4_000_000;
        vm.prank(bob, bob);
        router.executeMessage{gas: supplied}(transit.proof);

        uint256 paid = BridgedToken(copy).balanceOf(router.rewardAddress()) - heldBefore;
        assertGt(paid, 0, "the reward address is paid");
        assertLt(paid, cap, "the fee is measured, not the cap");
        assertEq(
            paid + BridgedToken(copy).balanceOf(recipient), value, "the recipient and the reward address hold the value"
        );
        // The measure is at most the supplied gas, and at least the supplied gas less the gas limit of the message and
        // a margin for the entry. The tip is the fee of that measure, in whole gas prices.
        uint256 gasLimitOfTheMessage = mediatorA.DEPLOY_GAS_LIMIT() + mediatorA.CALLBACK_GAS_LIMIT();
        (uint256 upper,) = router.feeInfo(copy, value, supplied, director);
        (uint256 lower,) = router.feeInfo(copy, value, supplied - gasLimitOfTheMessage - 30_000, director);
        assertEq(paid % 1 gwei, 0, "the unit is the gas price");
        assertLe(paid, upper, "the tip does not exceed the fee of the supplied gas");
        assertGe(paid, lower, "the tip follows the gas that the call measured");

        _cappedFee(router, copy);
    }

    /// @dev A cap below the measured fee binds: the reward address gets the cap.
    function _cappedFee(DeliveryRouter router, address copy) internal {
        uint256 value = 100 ether;
        address cappedRecipient = makeAddr("recipient, capped fee");
        Vm.Log[] memory recorded =
            _relayAndCallFromA(alice, address(router), value, _directorData(cappedRecipient, 0, 1000, 1 ether));
        Transit memory transit = _proveForB(recorded);
        vm.chainId(CHAIN_B);
        uint256 heldBefore = BridgedToken(copy).balanceOf(router.rewardAddress());
        vm.prank(bob, bob);
        router.executeMessage(transit.proof);
        assertEq(BridgedToken(copy).balanceOf(router.rewardAddress()) - heldBefore, 1000, "the cap binds");
        assertEq(BridgedToken(copy).balanceOf(cappedRecipient), value - 1000, "the recipient holds the rest");
    }

    function _directDeliveryNoFee(DeliveryRouter router, address copy) internal {
        address recipient = makeAddr("recipient, direct delivery of a fixed tip");
        uint256 value = 100 ether;
        Vm.Log[] memory recorded =
            _relayAndCallFromA(alice, address(router), value, _directorData(recipient, router.FIXED_FEE(), 3 ether, 0));
        Transit memory transit = _deliverToB(recorded);

        assertTrue(bridgeB.messageCallStatus(transit.messageId), "the message executed");
        assertEq(BridgedToken(copy).balanceOf(recipient), value, "plain execution pays no fee");
    }

    /// Claim: with an enforcing gate on chain A, the first poster of an epoch confirms the fork with `gate.confirm` and
    /// then sends, and later senders just send. Nothing passes evidence through a send. Shows: a send in an unconfirmed
    /// epoch reverts with `ForkNotConfirmed` and emits no log; the first poster confirms (`ForkConfirmed`) and sends; a
    /// second sender sends with no confirm; in the next epoch a send is refused again, the evidence of the old epoch is
    /// refused, and a confirm by a third account lets a later send pass; the message of the second sender is delivered
    /// on chain B with a real proof. Matters: this is the pattern that the user decided for the gate. A send that took
    /// evidence, or an epoch that stayed confirmed, would break a user flow or the safety of the route.
    function test_gatePatternOnAnEnforcingGate() public {
        _warpIntoEpoch(EPOCH_E, 3);
        _etchMock();
        BeaconForkGate gate = _newGate(BeaconForkGate.GateMode.Enforcing);
        _deployWorld(address(gate), address(gateB));
        WorldReceiver receiver = new WorldReceiver(bridgeB);
        bytes memory data = abi.encodeCall(WorldReceiver.record, ());
        address first = makeAddr("first poster");
        address second = makeAddr("second poster");
        address third = makeAddr("third account");
        bytes memory evidenceE = _honestEvidence(block.timestamp, _slotIn(EPOCH_E, 2), 6, ELECTRA);

        // (i) An unconfirmed epoch refuses the send. Nothing is emitted. The nonce is not spent: the first message that
        // passes later carries nonce zero.
        vm.recordLogs();
        vm.prank(first);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E));
        bridgeA.requireToPassMessage(address(receiver), data, 300_000);
        assertEq(vm.getRecordedLogs().length, 0, "no log");

        // (ii) The first poster confirms, then sends.
        vm.expectEmit(true, false, false, true, address(gate));
        emit BeaconForkGate.ForkConfirmed(EPOCH_E, ELECTRA);
        vm.prank(first);
        gate.confirm(evidenceE);
        vm.prank(first);
        bytes32 firstId = bridgeA.requireToPassMessage(address(receiver), data, 300_000);
        assertEq(
            firstId, AmbMessageCodec.messageIdPrefix(CHAIN_A, address(bridgeA)), "the nonce was not spent: it is zero"
        );

        // (iii) A second sender in the same epoch sends with no confirm.
        vm.recordLogs();
        vm.prank(second);
        bytes32 secondId = bridgeA.requireToPassMessage(address(receiver), data, 300_000);
        Vm.Log[] memory recordedSecond = vm.getRecordedLogs();
        assertEq(
            secondId, AmbMessageCodec.messageIdPrefix(CHAIN_A, address(bridgeA)) | bytes32(uint256(1)), "nonce one"
        );

        // (iv) The next epoch refuses a send, and the evidence of the old epoch does not help.
        _warpIntoEpoch(EPOCH_E + 1, 3);
        vm.prank(second);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E + 1));
        bridgeA.requireToPassMessage(address(receiver), data, 300_000);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.HeaderNotInCurrentEpoch.selector, EPOCH_E, EPOCH_E + 1));
        gate.confirm(evidenceE);

        bytes memory evidenceNext = _honestEvidence(block.timestamp, _slotIn(EPOCH_E + 1, 2), 6, ELECTRA);
        vm.prank(third);
        gate.confirm(evidenceNext);
        (uint64 confirmed,) = gate.confirmedEpoch();
        assertEq(confirmed, EPOCH_E + 1, "the third account confirmed the new epoch");
        vm.prank(first);
        bridgeA.requireToPassMessage(address(receiver), data, 300_000);

        // (v) The message of step (iii) is delivered on chain B with a real proof.
        Transit memory transit = _deliverToB(recordedSecond);
        assertEq(transit.messageId, secondId, "the proof names the message of the second sender");
        assertTrue(bridgeB.messageCallStatus(secondId), "delivered");
        assertEq(receiver.seenSender(), second, "the sender is the second poster");
        assertEq(receiver.seenMessageId(), secondId, "the identifier");
        assertEq(receiver.seenSourceChain(), bytes32(uint256(CHAIN_A)), "the source chain");
    }

    /// Claim: a contract that calls `gate.confirm(evidence)` and then `bridgeA.requireToPassMessage(...)` in one
    /// transaction sends a valid message, and the receiver on chain B sees the MULTICALL CONTRACT as the sender, not the
    /// user who called the multicall. Shows: the message is delivered, and `messageSender()` is the multicall contract.
    /// Matters: the bridge records `msg.sender`. For the same reason, a multicall that relays tokens through
    /// `TokenMediator` must itself hold the tokens: the mediator pulls tokens from `msg.sender`, which is the multicall.
    function test_multicallConfirmsAndSendsAsTheMulticall() public {
        _warpIntoEpoch(EPOCH_E, 3);
        _etchMock();
        BeaconForkGate gate = _newGate(BeaconForkGate.GateMode.Enforcing);
        _deployWorld(address(gate), address(gateB));
        WorldReceiver receiver = new WorldReceiver(bridgeB);
        WorldMulticall multicall = new WorldMulticall();
        bytes memory evidence = _honestEvidence(block.timestamp, _slotIn(EPOCH_E, 2), 6, ELECTRA);

        vm.chainId(CHAIN_A);
        vm.recordLogs();
        vm.prank(alice);
        bytes32 id = multicall.confirmAndSend(
            gate, evidence, bridgeA, address(receiver), abi.encodeCall(WorldReceiver.record, ())
        );
        Vm.Log[] memory recorded = vm.getRecordedLogs();

        Transit memory transit = _deliverToB(recorded);

        assertEq(transit.messageId, id, "the identifier");
        assertTrue(bridgeB.messageCallStatus(id), "delivered");
        assertEq(receiver.seenSender(), address(multicall), "the sender is the multicall contract");
        assertTrue(receiver.seenSender() != alice, "the sender is not the user who called the multicall");
    }
}
