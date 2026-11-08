// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {BeaconLightClient} from "../../../src/hardened/BeaconLightClient.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";
import {Multicall3} from "../../../src/hardened/vendor/multicall3/Multicall3.sol";
import {BridgedToken} from "../../../src/hardened/mediator/BridgedToken.sol";
import {DeliveryRouter} from "../../../src/hardened/mediator/DeliveryRouter.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {MockWrappedNative, TEST_CALLBACK_GAS} from "./utils/MediatorSupport.sol";
import {MessageReverter, MessageNoop} from "../utils/MessageTargets.sol";
import {WorldSupport} from "../utils/WorldSupport.sol";

/// @notice The batching of deliveries through Multicall3 (`aggregate3`, `allowFailure`) and the delivery router, through the real bridge, the real mediator and real proofs. The mock
/// bridge of `DeliveryRouter.t.sol` reads no proof, so only this world shows the refusals of the bridge, the update of the
/// light client and the gas of a whole run.
contract DeliveryRouterBatchingTest is WorldSupport {
    uint256 internal constant VALUE = 100 ether;
    /// @dev A share fee of 1%.
    uint256 internal constant ONE_PERCENT = 0.01 ether;
    uint256 internal constant TIP = 1 ether;

    MockERC20 internal nativeToken;
    DeliveryRouter internal router;
    address internal batcher = makeAddr("batch caller");
    address internal reward = makeAddr("batch reward address");
    address internal recipient = makeAddr("batch recipient");
    address internal copy;
    MessageReverter internal revertingTarget;
    MessageNoop internal quietTarget;
    Multicall3 internal multicall = new Multicall3();

    function setUp() public override {
        super.setUp();
        nativeToken = new MockERC20("Token A", "TKA");
        nativeToken.mint(alice, 10_000 ether);
        vm.prank(alice);
        nativeToken.approve(address(mediatorA), type(uint256).max);
        revertingTarget = new MessageReverter();
        quietTarget = new MessageNoop();
        router = new DeliveryRouter(
            ITokenMediator(address(mediatorB)), IWETH(address(new MockWrappedNative())), reward, reward
        );
        // The first message of a token deploys its copy and costs more. Deliver it plainly, so the runs below are of the
        // common kind.
        _deliverToB(_relay(alice, 1 ether));
        copy = mediatorB.bridgedTokenAddress(address(nativeToken));
        assertGt(copy.code.length, 0, "the copy exists");
    }

    // ---------------------------------------------------------------- helpers

    function _relay(address receiver, uint256 value) internal returns (Vm.Log[] memory) {
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        vm.prank(alice);
        mediatorA.relayTokens(address(nativeToken), receiver, value);
        return vm.getRecordedLogs();
    }

    /// @dev A transfer to the router that asks for a tip of 1% of 100 tokens, with `to` as the recipient.
    function _tipMessage(address to) internal returns (Transit memory) {
        bytes memory data = abi.encode(DeliveryRouter.FeeDirector(to, router.MULTIPLIER_OF_TOTAL(), 0, ONE_PERCENT, 0));
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        vm.prank(alice);
        mediatorA.relayTokensAndCall(address(nativeToken), address(router), VALUE, data, TEST_CALLBACK_GAS);
        return _proveForB(vm.getRecordedLogs());
    }

    /// @dev A plain message of the application kind: `gas` for `target`.
    function _applicationMessage(address target, uint256 gas) internal returns (Transit memory) {
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        vm.prank(alice);
        bridgeA.requireToPassMessage(target, hex"deadbeef", gas);
        return _proveForB(vm.getRecordedLogs());
    }


    /// @dev Takes the anchor of `transit` out of the light client of the bridge, as if the block proof had not been
    /// posted yet, and returns the output that puts it back. The mappings `headers` (slot 1) and `executionBlockHashes`
    /// (slot 3) and the head (slot 0) are the first storage variables of the light client.
    function _withheldAnchor(Transit memory transit) internal returns (BeaconLightClient.LightClientOutput memory output) {
        uint64 anchorSlot = transit.proof.anchorHeader.slot;
        bytes32 anchorRoot = lightClientForB.headers(anchorSlot);
        assertEq(vm.load(address(lightClientForB), keccak256(abi.encode(uint256(anchorSlot), uint256(1)))), anchorRoot, "slot of headers");
        assertEq(uint256(vm.load(address(lightClientForB), bytes32(0))), uint256(anchorSlot), "slot of head");
        vm.store(address(lightClientForB), keccak256(abi.encode(uint256(anchorSlot), uint256(1))), bytes32(0));
        vm.store(address(lightClientForB), keccak256(abi.encode(uint256(anchorSlot), uint256(3))), bytes32(0));
        vm.store(address(lightClientForB), bytes32(0), bytes32(uint256(anchorSlot - 40)));
        assertEq(lightClientForB.headers(anchorSlot), bytes32(0), "the anchor is withheld");

        output = _outputAt(lightClientForB, GENESIS_ROOT_A, anchorSlot, _execHash(anchorSlot));
        output.newHeaderRoot = anchorRoot;
    }

    /// @dev The `executeMessage` call of the router for one message. Failure is allowed.
    function _deliverCall(Transit memory transit) internal view returns (Multicall3.Call3 memory) {
        return Multicall3.Call3(address(router), true, abi.encodeCall(DeliveryRouter.executeMessage, (transit.proof)));
    }

    /// @dev The call of the block proof, straight to the light client. Failure is allowed.
    function _updateCall(BeaconLightClient.LightClientOutput memory output) internal view returns (Multicall3.Call3 memory) {
        return Multicall3.Call3(
            address(lightClientForB), true, abi.encodeCall(BeaconLightClient.update, (_lightClientProof(output), abi.encode(output)))
        );
    }

    /// @dev Sends the list as a transaction of `origin`: the origin and the caller of Multicall3 are the same account.
    function _aggregateAs(address origin, Multicall3.Call3[] memory calls) internal returns (Multicall3.Result[] memory) {
        vm.chainId(CHAIN_B);
        vm.prank(origin, origin);
        return multicall.aggregate3(calls);
    }

    function _two(Multicall3.Call3 memory first, Multicall3.Call3 memory second) internal pure returns (Multicall3.Call3[] memory calls) {
        calls = new Multicall3.Call3[](2);
        calls[0] = first;
        calls[1] = second;
    }

    function _balance(address account) internal view returns (uint256) {
        return BridgedToken(copy).balanceOf(account);
    }

    function _assertIdle() internal view {
        assertEq(uint256(vm.load(address(router), router.DELIVERY_SLOT())), 1, "the delivery slot is idle again");
        assertEq(_balance(address(router)), 0, "the router keeps nothing");
    }

    // ---------------------------------------------------------------- the multicall

    /// Claim: one failed call does not stop the others. Shows: a list of an update, a good message, a message whose
    /// proof the bridge refuses, and a second good message. The refused call records the exact revert data of the
    /// bridge; the other three succeed; the events match the results. Matters: the calls are discrete, so a bad proof
    /// must not strand the good deliveries of the same transaction, and the reward address holds exactly the tips of
    /// the messages that were delivered.
    function test_batch_oneFailedCallLeavesTheOthersWorking() public {
        Transit memory first = _tipMessage(recipient);
        Transit memory broken = _tipMessage(makeAddr("recipient of the broken message"));
        Transit memory second = _tipMessage(makeAddr("recipient of the second message"));
        broken.proof.transactionIndex = broken.proof.receiptIndex + 1;
        BeaconLightClient.LightClientOutput memory output = _withheldAnchor(second);

        Multicall3.Call3[] memory calls = new Multicall3.Call3[](4);
        calls[0] = _updateCall(output);
        calls[1] = _deliverCall(first);
        calls[2] = _deliverCall(broken);
        calls[3] = _deliverCall(second);
        bytes memory refusal = abi.encodeWithSelector(
            MessageBridge.IndexMismatch.selector, broken.proof.receiptIndex, broken.proof.transactionIndex
        );
        Multicall3.Result[] memory results = _aggregateAs(batcher, calls);

        assertEq(results.length, 4);
        assertTrue(results[0].success, "the update");
        assertTrue(results[1].success, "the first message");
        assertFalse(results[2].success, "the refused message");
        assertEq(results[2].returnData, refusal, "the revert data of the bridge");
        assertTrue(results[3].success, "the second message");
        assertEq(lightClientForB.head(), second.proof.anchorHeader.slot, "the update moved the head");
        assertTrue(bridgeB.messageCallStatus(first.messageId));
        assertFalse(bridgeB.messageCallStatus(broken.messageId), "the refused message stays open");
        assertTrue(bridgeB.messageCallStatus(second.messageId));
        assertEq(_balance(reward), 2 * TIP, "the reward address holds exactly the two tips");
        assertEq(_balance(batcher), 0, "the caller holds no tip");
        assertEq(_balance(recipient), VALUE - TIP);
        assertEq(_balance(makeAddr("recipient of the second message")), VALUE - TIP);
        assertEq(_balance(makeAddr("recipient of the broken message")), 0);
        _assertIdle();
    }

    /// Claim: a message that is delivered already fails alone. Shows: the second call of the list carries
    /// `AlreadyDelivered` with the message identifier; the calls around it deliver; the delivered message got no
    /// second tip. Matters: another account may win the race for a message, and that must not cost the caller the rest.
    function test_batch_aMessageDeliveredAlreadyFailsAlone() public {
        Transit memory early = _tipMessage(makeAddr("recipient of the early message"));
        Transit memory taken = _tipMessage(makeAddr("recipient of the taken message"));
        Transit memory late = _tipMessage(makeAddr("recipient of the late message"));
        _execute(bridgeB, taken);
        uint256 rewardBefore = _balance(reward);

        Multicall3.Call3[] memory calls = new Multicall3.Call3[](3);
        calls[0] = _deliverCall(early);
        calls[1] = _deliverCall(taken);
        calls[2] = _deliverCall(late);
        Multicall3.Result[] memory results = _aggregateAs(batcher, calls);

        assertTrue(results[0].success);
        assertFalse(results[1].success);
        assertEq(results[1].returnData, abi.encodeWithSelector(MessageBridge.AlreadyDelivered.selector, taken.messageId));
        assertTrue(results[2].success);
        assertEq(_balance(reward) - rewardBefore, 2 * TIP, "two tips, none for the delivered message");
        assertEq(_balance(makeAddr("recipient of the taken message")), VALUE, "delivered once, with no tip");
        _assertIdle();
    }

    /// Claim: a call whose target reverts fails alone in a batch, and the message waits; the next call of the batch
    /// still delivers. Matters: a failed delivery reverts, so a batch must not let one target stop the others.
    function test_batch_aFailingTargetFailsItsCallAndTheMessageWaits() public {
        Transit memory failing = _applicationMessage(address(revertingTarget), 300_000);
        Transit memory good = _tipMessage(makeAddr("recipient next to a failing target"));
        Multicall3.Call3[] memory calls = new Multicall3.Call3[](2);
        calls[0] = _deliverCall(failing);
        calls[1] = _deliverCall(good);
        Multicall3.Result[] memory results = _aggregateAs(batcher, calls);
        assertFalse(results[0].success, "the delivery of the failing target reverts");
        assertFalse(bridgeB.messageCallStatus(failing.messageId), "the message waits");
        assertTrue(results[1].success, "the other call of the batch delivers");
        assertTrue(bridgeB.messageCallStatus(good.messageId));
    }

    /// Claim: the router asks nothing of the caller of a batch. Shows: four different accounts, among them the reward
    /// address itself and a contract with no origin of its own, each batch one delivery through Multicall3 with the
    /// origin set to that account; each call succeeds, the reward address holds one tip per message, and the caller
    /// holds nothing. Matters: no whitelist and no origin check, so any account may batch deliveries, and the tip never
    /// follows the caller.
    function test_batch_anyAccountMayBatchAndTheTipIgnoresIt() public {
        address[4] memory callers = [bob, reward, makeAddr("third caller"), address(this)];
        for (uint256 i = 0; i < callers.length; i++) {
            Transit memory first = _tipMessage(makeAddr(string.concat("recipient of caller ", vm.toString(i))));
            Multicall3.Call3[] memory calls = new Multicall3.Call3[](1);
            calls[0] = _deliverCall(first);
            uint256 callerBefore = _balance(callers[i]);
            Multicall3.Result[] memory results = _aggregateAs(callers[i], calls);
            assertTrue(results[0].success, "the call of any account delivers");
            assertTrue(bridgeB.messageCallStatus(first.messageId), "the message is delivered");
            assertEq(_balance(reward), (i + 1) * TIP, "one more tip sits in the reward address");
            uint256 expected = callers[i] == reward ? callerBefore + TIP : callerBefore;
            assertEq(_balance(callers[i]), expected, "the caller takes nothing, except the tip when it is the reward address");
        }
        assertEq(_balance(bob), 0);
        assertEq(_balance(makeAddr("third caller")), 0);
    }

    /// Claim: an empty list does nothing and returns an empty array. Matters: a bot that finds nothing to deliver must
    /// not be able to break the router.
    function test_batch_anEmptyListReturnsNothing() public {
        Multicall3.Result[] memory results = _aggregateAs(batcher, new Multicall3.Call3[](0));
        assertEq(results.length, 0);
    }

    /// Claim: a gas based tip is paid in the callback of each call. Shows: two messages with a gas based tip, run in one
    /// list with 6,000,000 gas supplied for the whole list; the reward address holds a tip that is above the fixed
    /// overhead of the two calls and below twice the tip that the supplied gas allows, under the cap, and the reward address
    /// and the recipient hold all the value. Matters: each call measures its own gas, so the gas of one call does not
    /// leak into the tip of another, and the router is idle again after the list.
    function test_batch_aGasBasedTipIsPaidInTheCallbackOfEachCall() public {
        vm.txGasPrice(1 gwei);
        DeliveryRouter.FeeDirector memory director = DeliveryRouter.FeeDirector(recipient, 0, 1 ether, 1 ether, 0);
        Transit[] memory transits = new Transit[](2);
        for (uint256 i = 0; i < 2; i++) {
            vm.chainId(CHAIN_A);
            vm.recordLogs();
            vm.prank(alice);
            mediatorA.relayTokensAndCall(address(nativeToken), address(router), VALUE, abi.encode(director), TEST_CALLBACK_GAS);
            transits[i] = _proveForB(vm.getRecordedLogs());
        }
        Multicall3.Call3[] memory calls = _two(_deliverCall(transits[0]), _deliverCall(transits[1]));
        vm.chainId(CHAIN_B);
        vm.prank(batcher, batcher);
        Multicall3.Result[] memory results = multicall.aggregate3{gas: 6_000_000}(calls);

        assertTrue(results[0].success);
        assertTrue(results[1].success);
        uint256 paid = _balance(reward);
        uint256 overhead = router.TOKEN_GAS_OVERHEAD();
        assertGt(paid, 2 * overhead * 1 gwei, "both calls paid more than the fixed overhead");
        assertLt(paid, 2 * (6_000_000 + overhead) * 1 gwei, "each call measures at most the supplied gas");
        assertLt(paid, 2 ether, "both tips are below the cap");
        assertEq(paid + _balance(recipient), 2 * VALUE, "the reward address and the recipient hold all the value");
        _assertIdle();
    }

    /// Claim: the single entry pays the tip to the reward address whoever calls it, a failure reverts, and a direct
    /// delivery on the bridge pays no tip. Matters: an operator who runs one message wants the error, and the user
    /// loses nothing when nobody calls the router.
    function test_single_tipGoesToTheRewardAddressAndAFailureReverts() public {
        Transit memory first = _tipMessage(recipient);
        vm.chainId(CHAIN_B);
        vm.prank(batcher, batcher);
        router.executeMessage(first.proof);
        assertEq(_balance(reward), TIP);
        assertEq(_balance(batcher), 0);
        vm.prank(batcher, batcher);
        vm.expectRevert(abi.encodeWithSelector(MessageBridge.AlreadyDelivered.selector, first.messageId));
        router.executeMessage(first.proof);
        assertEq(_balance(reward), TIP, "the failed run changed nothing");
        assertEq(uint256(vm.load(address(router), router.DELIVERY_SLOT())), 1, "a revert leaves the slot idle");

        Transit memory direct = _tipMessage(makeAddr("recipient of the direct message"));
        _execute(bridgeB, direct);
        assertEq(_balance(makeAddr("recipient of the direct message")), VALUE, "no tip on a direct delivery");
        assertEq(_balance(reward), TIP, "the direct delivery added no tip");
    }

    // ---------------------------------------------------------------- the block proof

    /// Claim: the block proof rides in the same list, straight to the light client, and any origin may post it. Shows:
    /// a stranger posts the update through Multicall3, the anchor of the message is stored, and the head moves.
    /// Matters: the light client checks the proof itself, so the router needs no part in it.
    function test_update_anyoneCanPostAProofThroughMulticall3() public {
        Transit memory first = _tipMessage(recipient);
        BeaconLightClient.LightClientOutput memory output = _withheldAnchor(first);
        Multicall3.Call3[] memory calls = new Multicall3.Call3[](1);
        calls[0] = _updateCall(output);
        Multicall3.Result[] memory results = _aggregateAs(bob, calls);
        assertTrue(results[0].success);
        assertEq(lightClientForB.head(), first.proof.anchorHeader.slot, "the head moved");
        assertTrue(lightClientForB.headers(first.proof.anchorHeader.slot) != bytes32(0), "the anchor is stored");
    }

    /// Claim: a message that rides behind its update delivers in the same transaction, and without the update it fails
    /// alone. Shows: the first run has no update, so the message call fails and the message stays open; the second run
    /// with the update first delivers it. Matters: the caller pays for one transaction, not two.
    function test_update_theMessageNeedsTheUpdateBeforeIt() public {
        Transit memory first = _tipMessage(recipient);
        BeaconLightClient.LightClientOutput memory output = _withheldAnchor(first);
        Multicall3.Call3[] memory alone = new Multicall3.Call3[](1);
        alone[0] = _deliverCall(first);
        Multicall3.Result[] memory results = _aggregateAs(batcher, alone);
        assertFalse(results[0].success, "the anchor is not stored yet");
        assertFalse(bridgeB.messageCallStatus(first.messageId));
        assertEq(_balance(reward), 0);

        results = _aggregateAs(batcher, _two(_updateCall(output), _deliverCall(first)));
        assertTrue(results[0].success);
        assertTrue(results[1].success);
        assertEq(_balance(reward), TIP);
    }

    /// Claim: a bad update fails alone, and so does an update that someone posted first. Shows: a corrupted proof
    /// and a second post of the same update each give a failed first call, and the message after them still delivers
    /// when the anchor is stored. Matters: another account can win the race for the update, and that must not cost the
    /// caller its deliveries.
    function test_update_aFailedUpdateDoesNotStopTheMessages() public {
        Transit memory first = _tipMessage(recipient);
        BeaconLightClient.LightClientOutput memory output = _withheldAnchor(first);
        Multicall3.Call3 memory bad = Multicall3.Call3(
            address(lightClientForB), true, abi.encodeCall(BeaconLightClient.update, (hex"deadbeef", abi.encode(output)))
        );
        Multicall3.Result[] memory results = _aggregateAs(batcher, _two(bad, _deliverCall(first)));
        assertFalse(results[0].success, "a corrupted proof");
        assertFalse(results[1].success, "the anchor is still not stored");

        vm.chainId(CHAIN_B);
        lightClientForB.update(_lightClientProof(output), abi.encode(output));
        Transit memory second = _tipMessage(makeAddr("recipient of the second message"));
        results = _aggregateAs(batcher, _two(_updateCall(output), _deliverCall(first)));
        assertFalse(results[0].success, "an update posted first by someone else");
        assertTrue(results[1].success, "the message still delivers");
        assertEq(_balance(reward), TIP);
        assertFalse(bridgeB.messageCallStatus(second.messageId));
    }

    // ---------------------------------------------------------------- gas

    /// Measures the gas of one `aggregate3` with one update and two messages, and of one message through the single entry.
    /// The bot reads the figures to size a list. The mock verifier of the light client makes the update cheaper than
    /// a real proof check.
    function test_gas_aggregate3WithOneUpdateAndTwoMessages() public {
        Transit memory warm = _tipMessage(recipient);
        vm.chainId(CHAIN_B);
        vm.prank(batcher, batcher);
        router.executeMessage(warm.proof);

        Transit memory alone = _tipMessage(recipient);
        vm.prank(batcher, batcher);
        uint256 before = gasleft();
        router.executeMessage(alone.proof);
        uint256 singleGas = before - gasleft();

        Multicall3.Call3[] memory pair = _two(_deliverCall(_tipMessage(recipient)), _deliverCall(_tipMessage(recipient)));
        vm.chainId(CHAIN_B);
        vm.prank(batcher, batcher);
        before = gasleft();
        multicall.aggregate3(pair);
        uint256 pairGas = before - gasleft();
        console2.log("aggregate3 overhead for each message (call gas):", (pairGas - 2 * singleGas) / 2);

        Transit memory first = _tipMessage(recipient);
        Transit memory second = _tipMessage(recipient);
        BeaconLightClient.LightClientOutput memory output = _withheldAnchor(second);
        Multicall3.Call3[] memory calls = new Multicall3.Call3[](3);
        calls[0] = _updateCall(output);
        calls[1] = _deliverCall(first);
        calls[2] = _deliverCall(second);
        vm.chainId(CHAIN_B);
        vm.prank(batcher, batcher);
        before = gasleft();
        Multicall3.Result[] memory results = multicall.aggregate3(calls);
        uint256 multicallGas = before - gasleft();
        for (uint256 i = 0; i < 3; i++) {
            assertTrue(results[i].success, "call");
        }

        console2.log("single entry, one message (call gas):", singleGas);
        console2.log("aggregate3, one update and two messages (call gas):", multicallGas);
        assertLt(multicallGas, 2 * singleGas + 600_000, "Multicall3 adds little to its calls");
    }

    // ---------------------------------------------------------------- the immutables


    function test_theRewardAddressIsFixedAndNeverZero() public {
        assertEq(router.rewardAddress(), reward);
        IWETH wrapped = IWETH(address(new MockWrappedNative()));
        vm.expectRevert(DeliveryRouter.ZeroRewardAddress.selector);
        new DeliveryRouter(ITokenMediator(address(mediatorB)), wrapped, address(0), reward);
        bytes4[3] memory selectors = [
            bytes4(keccak256("setRewardAddress(address)")),
            bytes4(keccak256("changeRewardAddress(address)")),
            bytes4(keccak256("transferRewardAddress(address)"))
        ];
        for (uint256 i = 0; i < selectors.length; i++) {
            (bool ok,) = address(router).call(abi.encodeWithSelector(selectors[i], bob));
            assertFalse(ok);
        }
    }
}
