// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {MockWrappedNative} from "../../../src/mocks/MockWrappedNative.sol";
import {IAMB} from "../../../src/hardened/IAMB.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";
import {DeliveryRouter} from "../../../src/hardened/mediator/DeliveryRouter.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {Multicall3} from "../../../src/hardened/vendor/multicall3/Multicall3.sol";
import {WorldSupport} from "../utils/WorldSupport.sol";

/// @dev What a sent message asks the destination to do.
enum SentKind {
    Application,
    TokenToAccount,
    TokenToRouter
}

/// @notice An application target that counts the calls it receives for each message identifier. The count is kept by the
/// target, so it is evidence that does not depend on the bridge.
contract CountingTarget {
    mapping(bytes32 messageId => uint256) public calls;

    fallback() external {
        calls[IAMB(msg.sender).messageId()]++;
    }
}

/// @notice Drives the real `MessageBridge` pair of `WorldSupport` with real proofs. Messages go both ways: application
/// messages, tokens to accounts and tokens to a `DeliveryRouter` with a tip. Deliveries come in four forms: a direct call, the
/// router with the runner as origin, a Multicall3 batch with the runner as origin, and replays of delivered messages. A
/// proof is built once at send time, and the handler delivers it at any later point, in any order.
/// @dev What this handler claims. It counts every execution that did not revert, for each identifier (`executions`). The
/// target keeps its own count. The invariants require that both stay at most one. A refused attempt must change no
/// balance. The handler never reverts: a refusal of the bridge is caught and counted.
contract RealBridgeHandler is WorldSupport {
    uint256 internal constant MAXIMUM_MESSAGES = 40;
    uint256 internal constant MAXIMUM_AMOUNT = 1_000 ether;
    uint256 internal constant APPLICATION_GAS = 300_000;
    uint256 internal constant BATCH_SIZE = 4;

    struct Sent {
        bytes proof;
        bytes32 messageId;
        bool towardB;
        SentKind kind;
        uint256 net;
        uint256 tip;
    }

    MockERC20 public nativeToken;
    CountingTarget public countingTarget;
    DeliveryRouter public routerA;
    DeliveryRouter public routerB;
    Multicall3 public multicall;
    address public runner = makeAddr("real bridge runner");
    address public rewardA = makeAddr("real bridge reward on A");
    address public rewardB = makeAddr("real bridge reward on B");
    address public carol = makeAddr("carol");
    address public tipRecipient = makeAddr("tip recipient");
    address[] internal _actors;

    Sent[] internal _sent;
    mapping(bytes32 messageId => uint256) public executions;
    mapping(bytes32 messageId => bool) internal _known;
    /// @dev Tips that the router paid to the reward address on chain A (native token) and chain B (copy).
    uint256 public tipsPaidOnA;
    uint256 public tipsPaidOnB;

    uint256 public applicationSends;
    uint256 public accountSends;
    uint256 public routerSends;
    uint256 public copyBackSends;
    uint256 public directDeliveries;
    uint256 public routerDeliveries;
    uint256 public batchDeliveries;
    uint256 public batchesRun;
    uint256 public replayAttempts;
    uint256 public replayRefusals;
    uint256 public replayChanges;
    uint256 public replayExecutions;
    uint256 public wrongBridgeAttempts;
    uint256 public wrongBridgeExecutions;
    uint256 public strangerAttempts;
    uint256 public strangerExecutions;
    uint256 public duplicateIdentifiers;
    uint256 public outOfOrderDeliveries;

    constructor() {
        setUp();
        nativeToken = new MockERC20("Token A", "TKA");
        countingTarget = new CountingTarget();
        multicall = new Multicall3();
        routerA = new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(new MockWrappedNative())), runner, rewardA, rewardA);
        routerB = new DeliveryRouter(ITokenMediator(address(mediatorB)), IWETH(address(new MockWrappedNative())), runner, rewardB, rewardB);
        _actors.push(alice);
        _actors.push(bob);
        _actors.push(carol);
        _actors.push(tipRecipient);
    }

    // ------------------------------------------------------------------------------------------------------ views

    function sentCount() external view returns (uint256) {
        return _sent.length;
    }

    function sentAt(uint256 index) external view returns (bytes32 messageId, bool towardB, SentKind kind, uint256 net) {
        Sent storage message = _sent[index];
        return (message.messageId, message.towardB, message.kind, message.net);
    }

    function bridgeOfDestination(uint256 index) external view returns (MessageBridge) {
        return _destinationOf(_sent[index]);
    }

    function mediatorOnA() external view returns (TokenMediator) {
        return mediatorA;
    }

    function mediatorOnB() external view returns (TokenMediator) {
        return mediatorB;
    }

    function copy() public view returns (address) {
        return mediatorB.bridgedTokenAddress(address(nativeToken));
    }

    function actors() external view returns (address[] memory) {
        return _actors;
    }

    /// @notice Every account that can hold a token of this world, apart from the mediators.
    function holders() public view returns (address[] memory list) {
        list = new address[](_actors.length + 5);
        for (uint256 i = 0; i < _actors.length; i++) {
            list[i] = _actors[i];
        }
        list[_actors.length] = address(routerA);
        list[_actors.length + 1] = address(routerB);
        list[_actors.length + 2] = rewardA;
        list[_actors.length + 3] = rewardB;
        list[_actors.length + 4] = runner;
    }

    // ----------------------------------------------------------------------------------------------------- sending

    /// @notice Sends an application message to the counting target, from a bridge chosen by the seed.
    function sendApplication(uint8 directionSeed, uint256 payloadSeed) external {
        if (_sent.length >= MAXIMUM_MESSAGES) return;
        bool towardB = directionSeed % 2 == 0;
        MessageBridge source = towardB ? bridgeA : bridgeB;
        bytes memory data = abi.encodePacked(bytes4(0xdeadbeef), payloadSeed);
        address target = address(countingTarget);
        vm.chainId(towardB ? CHAIN_A : CHAIN_B);
        vm.recordLogs();
        vm.prank(alice);
        source.requireToPassMessage(target, data, APPLICATION_GAS);
        applicationSends++;
        _store(vm.getRecordedLogs(), towardB, SentKind.Application, 0, 0);
    }

    /// @notice Relays the native token from chain A to an account on chain B.
    function relayToAccount(uint96 amountSeed, uint8 receiverSeed) external {
        if (_sent.length >= MAXIMUM_MESSAGES) return;
        uint256 amount = bound(amountSeed, 1, MAXIMUM_AMOUNT);
        address receiver = _actors[receiverSeed % _actors.length];
        _fundAndApproveOnA(amount);
        vm.recordLogs();
        vm.prank(alice);
        mediatorA.relayTokens(address(nativeToken), receiver, amount);
        accountSends++;
        _store(vm.getRecordedLogs(), true, SentKind.TokenToAccount, amount, 0);
    }

    /// @notice Relays the native token from chain A to the router on chain B with a tip.
    function relayToRouterOnB(uint96 amountSeed, uint8 receiverSeed, uint8 modeSeed, uint96 tipSeed) external {
        if (_sent.length >= MAXIMUM_MESSAGES) return;
        uint256 amount = bound(amountSeed, 1, MAXIMUM_AMOUNT);
        (bytes memory data, uint256 tip) = _directorData(routerB, amount, receiverSeed, modeSeed, tipSeed);
        _fundAndApproveOnA(amount);
        vm.recordLogs();
        vm.prank(alice);
        mediatorA.relayTokensAndCall(address(nativeToken), address(routerB), amount, data);
        routerSends++;
        _store(vm.getRecordedLogs(), true, SentKind.TokenToRouter, amount, tip);
    }

    /// @notice Relays the copy from chain B back to an account on chain A.
    function relayCopyBack(uint8 holderSeed, uint96 amountSeed, uint8 receiverSeed) external {
        (address holder, uint256 amount) = _copyHolder(holderSeed, amountSeed);
        if (amount == 0 || _sent.length >= MAXIMUM_MESSAGES) return;
        address receiver = _actors[receiverSeed % _actors.length];
        address copyToken = copy();
        _approveCopy(holder, copyToken);
        vm.recordLogs();
        vm.prank(holder);
        mediatorB.relayTokens(copyToken, receiver, amount);
        copyBackSends++;
        _store(vm.getRecordedLogs(), false, SentKind.TokenToAccount, amount, 0);
    }

    /// @notice Relays the copy from chain B back to the router on chain A with a tip.
    function relayCopyBackToRouter(uint8 holderSeed, uint96 amountSeed, uint8 receiverSeed, uint8 modeSeed, uint96 tipSeed)
        external
    {
        (address holder, uint256 amount) = _copyHolder(holderSeed, amountSeed);
        if (amount == 0 || _sent.length >= MAXIMUM_MESSAGES) return;
        (bytes memory data, uint256 tip) = _directorData(routerA, amount, receiverSeed, modeSeed, tipSeed);
        address copyToken = copy();
        _approveCopy(holder, copyToken);
        vm.recordLogs();
        vm.prank(holder);
        mediatorB.relayTokensAndCall(copyToken, address(routerA), amount, data);
        routerSends++;
        copyBackSends++;
        _store(vm.getRecordedLogs(), false, SentKind.TokenToRouter, amount, tip);
    }

    // --------------------------------------------------------------------------------------------------- delivering

    /// @notice Calls `executeMessage` on the destination bridge for a message that is not delivered yet.
    function deliverDirect(uint256 seed) external {
        (bool found, uint256 index) = _pickByExecutions(seed, 0);
        if (!found) return;
        _noteOrder(index);
        if (!_tryDirect(index)) return;
        executions[_sent[index].messageId]++;
        directDeliveries++;
    }

    /// @notice Delivers through the router, with the runner as the origin of the transaction.
    function deliverViaRouter(uint256 seed) external {
        (bool found, uint256 index) = _pickByExecutions(seed, 0);
        if (!found) return;
        _noteOrder(index);
        if (!_tryRouter(index, runner)) return;
        _recordRouterExecution(index);
        routerDeliveries++;
    }

    /// @notice Delivers through the router with an origin that is not the runner. The router must refuse.
    function deliverViaRouterAsStranger(uint256 seed) external {
        (bool found, uint256 index) = _pickByExecutions(seed, 0);
        if (!found) return;
        bytes32 before = _fingerprint();
        strangerAttempts++;
        if (_tryRouter(index, makeAddr("stranger"))) {
            strangerExecutions++;
            executions[_sent[index].messageId]++;
        }
        if (_fingerprint() != before) replayChanges++;
    }

    /// @notice Runs a Multicall3 batch of deliveries with the runner as origin. The batch may repeat a message, and may hold
    /// messages that are delivered already. All its messages go to the same chain, the one of the first pick.
    function deliverViaBatch(uint256 firstSeed, uint256 secondSeed, uint256 thirdSeed, uint256 fourthSeed) external {
        if (_sent.length == 0) return;
        uint256[] memory seeds = new uint256[](BATCH_SIZE);
        seeds[0] = firstSeed;
        seeds[1] = secondSeed;
        seeds[2] = thirdSeed;
        seeds[3] = fourthSeed;
        uint256[] memory indexes = _batchIndexes(seeds);
        _runBatch(indexes);
    }

    /// @notice Delivers a message again, through the path that the seed names. The bridge must refuse and no balance may
    /// change.
    function replay(uint256 seed, uint8 pathSeed) external {
        (bool found, uint256 index) = _pickByExecutions(seed, 1);
        if (!found) return;
        bytes32 before = _fingerprint();
        replayAttempts++;
        uint256 path = pathSeed % 3;
        bool executed;
        if (path == 0) executed = _tryDirect(index);
        if (path == 1) executed = _tryRouter(index, runner);
        if (executed && path != 2) executions[_sent[index].messageId]++;
        if (path == 2) {
            uint256[] memory single = new uint256[](1);
            single[0] = index;
            executed = _runBatch(single) > 0;
        }
        if (executed) {
            replayExecutions++;
        } else {
            replayRefusals++;
        }
        if (_fingerprint() != before) replayChanges++;
    }

    /// @notice Gives a proof to the bridge that sent the message, not to its destination. The bridge must refuse.
    function deliverOnWrongBridge(uint256 seed) external {
        if (_sent.length == 0) return;
        uint256 index = seed % _sent.length;
        Sent storage message = _sent[index];
        MessageBridge wrong = message.towardB ? bridgeA : bridgeB;
        MessageBridge.MessageProof memory proof = abi.decode(message.proof, (MessageBridge.MessageProof));
        bytes32 before = _fingerprint();
        wrongBridgeAttempts++;
        vm.chainId(wrong.localChainId());
        try wrong.executeMessage(proof) {
            wrongBridgeExecutions++;
            executions[message.messageId]++;
        } catch {}
        if (_fingerprint() != before) replayChanges++;
    }

    // ---------------------------------------------------------------------------------------------------- internals

    function _fundAndApproveOnA(uint256 amount) private {
        vm.chainId(CHAIN_A);
        nativeToken.mint(alice, amount);
        vm.prank(alice);
        nativeToken.approve(address(mediatorA), type(uint256).max);
    }

    function _approveCopy(address holder, address copyToken) private {
        vm.chainId(CHAIN_B);
        vm.prank(holder);
        IERC20(copyToken).approve(address(mediatorB), type(uint256).max);
    }

    /// @dev An account that holds the copy, and an amount in its balance. Amount zero means that no account holds any.
    function _copyHolder(uint8 holderSeed, uint96 amountSeed) private view returns (address holder, uint256 amount) {
        address copyToken = copy();
        if (copyToken == address(0)) return (address(0), 0);
        for (uint256 i = 0; i < _actors.length; i++) {
            address candidate = _actors[(holderSeed + i) % _actors.length];
            uint256 held = IERC20(copyToken).balanceOf(candidate);
            if (held == 0) continue;
            return (candidate, bound(amountSeed, 1, held));
        }
    }

    /// @dev The encoded fee terms for a router and the tip that they must produce for `amount`.
    function _directorData(DeliveryRouter router, uint256 amount, uint8 receiverSeed, uint8 modeSeed, uint96 tipSeed)
        private
        view
        returns (bytes memory data, uint256 tip)
    {
        address receiver = _actors[receiverSeed % _actors.length];
        if (modeSeed % 2 == 0) {
            uint256 multiplier = bound(tipSeed, 0.001 ether, 0.05 ether);
            tip = amount * multiplier / 1 ether;
            data = abi.encode(DeliveryRouter.FeeDirector(receiver, router.SHARE_OF_VALUE(), 0, multiplier));
            return (data, tip);
        }
        tip = bound(tipSeed, 1, amount);
        data = abi.encode(DeliveryRouter.FeeDirector(receiver, router.FIXED_FEE(), tip, 0));
    }

    /// @dev Builds the proof of the message among the recorded logs and stores it.
    function _store(Vm.Log[] memory recorded, bool towardB, SentKind kind, uint256 net, uint256 tip) private {
        Transit memory transit = towardB ? _proveForB(recorded) : _proveForA(recorded);
        if (_known[transit.messageId]) duplicateIdentifiers++;
        _known[transit.messageId] = true;
        _sent.push(Sent(abi.encode(transit.proof), transit.messageId, towardB, kind, net, tip));
    }

    function _destinationOf(Sent storage message) private view returns (MessageBridge) {
        return message.towardB ? bridgeB : bridgeA;
    }

    function _routerOf(Sent storage message) private view returns (DeliveryRouter) {
        return message.towardB ? routerB : routerA;
    }

    /// @dev The nth message, by the seed, whose execution count is `count`.
    function _pickByExecutions(uint256 seed, uint256 count) private view returns (bool, uint256) {
        uint256 matching;
        for (uint256 i = 0; i < _sent.length; i++) {
            if (executions[_sent[i].messageId] == count) matching++;
        }
        if (matching == 0) return (false, 0);
        uint256 target = seed % matching;
        for (uint256 i = 0; i < _sent.length; i++) {
            if (executions[_sent[i].messageId] != count) continue;
            if (target == 0) return (true, i);
            target--;
        }
        return (false, 0);
    }

    /// @dev Counts a delivery that skips an older message of the same direction.
    function _noteOrder(uint256 index) private {
        for (uint256 i = 0; i < index; i++) {
            if (executions[_sent[i].messageId] != 0 || _sent[i].towardB != _sent[index].towardB) continue;
            outOfOrderDeliveries++;
            return;
        }
    }

    function _tryDirect(uint256 index) private returns (bool) {
        Sent storage message = _sent[index];
        MessageBridge destination = _destinationOf(message);
        MessageBridge.MessageProof memory proof = abi.decode(message.proof, (MessageBridge.MessageProof));
        vm.chainId(destination.localChainId());
        try destination.executeMessage(proof) {
            return true;
        } catch {
            return false;
        }
    }

    function _tryRouter(uint256 index, address origin) private returns (bool) {
        Sent storage message = _sent[index];
        DeliveryRouter router = _routerOf(message);
        MessageBridge.MessageProof memory proof = abi.decode(message.proof, (MessageBridge.MessageProof));
        address reward = router.rewardAddress();
        vm.chainId(_destinationOf(message).localChainId());
        vm.prank(origin, origin);
        try router.executeMessageWithRunner(proof, reward) {
            return true;
        } catch {
            return false;
        }
    }

    /// @dev A router execution of a message adds its tip, once, when the message asked for one.
    function _recordRouterExecution(uint256 index) private {
        Sent storage message = _sent[index];
        executions[message.messageId]++;
        if (message.kind != SentKind.TokenToRouter) return;
        if (message.towardB) tipsPaidOnB += message.tip;
        if (!message.towardB) tipsPaidOnA += message.tip;
    }

    /// @dev Picks the messages of a batch: all go to the chain of the first pick.
    function _batchIndexes(uint256[] memory seeds) private view returns (uint256[] memory indexes) {
        indexes = new uint256[](seeds.length);
        bool towardB = _sent[seeds[0] % _sent.length].towardB;
        uint256 count;
        for (uint256 i = 0; i < seeds.length; i++) {
            uint256 index = seeds[i] % _sent.length;
            if (_sent[index].towardB != towardB) continue;
            indexes[count++] = index;
        }
        assembly {
            mstore(indexes, count)
        }
    }

    /// @dev Runs the batch and counts the deliveries that succeeded. Returns how many messages executed.
    function _runBatch(uint256[] memory indexes) private returns (uint256 executed) {
        Sent storage first = _sent[indexes[0]];
        DeliveryRouter router = _routerOf(first);
        address reward = router.rewardAddress();
        Multicall3.Call3[] memory calls = new Multicall3.Call3[](indexes.length);
        for (uint256 i = 0; i < indexes.length; i++) {
            MessageBridge.MessageProof memory proof = abi.decode(_sent[indexes[i]].proof, (MessageBridge.MessageProof));
            calls[i] = Multicall3.Call3(
                address(router), true, abi.encodeCall(DeliveryRouter.executeMessageWithRunner, (proof, reward))
            );
        }
        vm.chainId(_destinationOf(first).localChainId());
        vm.prank(runner, runner);
        Multicall3.Result[] memory results = multicall.aggregate3(calls);
        batchesRun++;
        for (uint256 i = 0; i < results.length; i++) {
            if (!results[i].success) continue;
            executed++;
            // A message that executed before this call counts a second execution, which the invariant refuses.
            _recordRouterExecution(indexes[i]);
            batchDeliveries++;
        }
    }

    /// @dev One hash over the balances that a refused attempt must not change.
    function _fingerprint() private view returns (bytes32 digest) {
        address copyToken = copy();
        address[] memory list = holders();
        digest = keccak256(
            abi.encode(
                nativeToken.balanceOf(address(mediatorA)),
                mediatorA.mediatorBalance(address(nativeToken)),
                copyToken == address(0) ? 0 : IERC20(copyToken).totalSupply(),
                copyToken == address(0) ? 0 : IERC20(copyToken).balanceOf(address(mediatorB))
            )
        );
        for (uint256 i = 0; i < list.length; i++) {
            digest = keccak256(
                abi.encode(
                    digest,
                    nativeToken.balanceOf(list[i]),
                    copyToken == address(0) ? 0 : IERC20(copyToken).balanceOf(list[i])
                )
            );
        }
    }
}

/// @notice Invariants of the real bridge pair. See `RealBridgeHandler` for what the handler claims.
/// forge-config: deep.invariant.runs = 300
/// forge-config: deep.invariant.depth = 100
/// forge-config: deep.invariant.fail-on-revert = true
/// forge-config: default.invariant.runs = 8
/// forge-config: default.invariant.depth = 20
/// forge-config: default.invariant.fail-on-revert = true
contract RealBridgeInvariantTest is StdInvariant, Test {
    RealBridgeHandler internal handler;

    function setUp() public {
        handler = new RealBridgeHandler();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = RealBridgeHandler.sendApplication.selector;
        selectors[1] = RealBridgeHandler.relayToAccount.selector;
        selectors[2] = RealBridgeHandler.relayToRouterOnB.selector;
        selectors[3] = RealBridgeHandler.relayCopyBack.selector;
        selectors[4] = RealBridgeHandler.relayCopyBackToRouter.selector;
        selectors[5] = RealBridgeHandler.deliverDirect.selector;
        selectors[6] = RealBridgeHandler.deliverViaRouter.selector;
        selectors[7] = RealBridgeHandler.deliverViaRouterAsStranger.selector;
        selectors[8] = RealBridgeHandler.deliverViaBatch.selector;
        selectors[9] = RealBridgeHandler.replay.selector;
        selectors[10] = RealBridgeHandler.deliverOnWrongBridge.selector;
        // Deliveries are the most useful action, so the list names one twice.
        selectors[11] = RealBridgeHandler.deliverViaBatch.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Claim: a message identifier executes at most once. Shows: for every message ever sent, the handler counted at most
    /// one execution that did not revert (over a direct call, the router, a batch, a replay and a wrong bridge), the
    /// application target saw at most one call, and the destination bridge reports a success only for a message that the
    /// handler executed. Matters: a second execution of a release would mint or unlock the same tokens twice.
    function invariant_aMessageExecutesAtMostOnce() public view {
        CountingTarget target = handler.countingTarget();
        for (uint256 i = 0; i < handler.sentCount(); i++) {
            (bytes32 id,, SentKind kind,) = handler.sentAt(i);
            uint256 executed = handler.executions(id);
            assertLe(executed, 1, "a message executed twice");
            assertLe(target.calls(id), 1, "the target was called twice");
            bool status = handler.bridgeOfDestination(i).messageCallStatus(id);
            if (status) assertEq(executed, 1, "the bridge reports a success that the handler did not cause");
            if (kind == SentKind.Application) assertEq(target.calls(id), executed, "target count equals executions");
            // A token message that executed must have succeeded: the bridge marks a failed one delivered as well.
            if (kind != SentKind.Application && executed == 1) assertTrue(status, "a token delivery failed");
        }
    }

    /// Claim: no refused attempt succeeds or changes a balance. Shows: a replay, a call from a stranger origin and a proof
    /// on the wrong bridge never execute, and the balances of the mediators, the routers, the reward addresses, the
    /// accounts and the runner are the same before and after every such attempt. Matters: a replay that moved tokens
    /// would be a double spend even if the bridge reported a revert.
    function invariant_refusedAttemptsChangeNothing() public view {
        assertEq(handler.replayExecutions(), 0, "a replay executed");
        assertEq(handler.replayChanges(), 0, "a refused attempt changed a balance");
        assertEq(handler.strangerExecutions(), 0, "a stranger origin executed through the router");
        assertEq(handler.wrongBridgeExecutions(), 0, "a proof executed on the wrong bridge");
    }

    /// Claim: the identifiers of sent messages are unique. Shows: no send produced an identifier that an earlier send
    /// produced, on either bridge. Matters: the identifier is the key of the delivery record.
    function invariant_sentIdentifiersAreUnique() public view {
        assertEq(handler.duplicateIdentifiers(), 0);
    }

    /// Claim: custody. Shows, as `TokenMediator` defines it with no fee: the record of chain A equals the supply of the
    /// copy on chain B, plus the amounts waiting in `claimable` on both chains, plus the net value of every token message
    /// that is not executed (in flight in either direction); the token balance of the mediator on chain A equals the
    /// record; the copy balance of the mediator on chain B is zero (no fee); the supply of the copy equals the balances of
    /// all accounts that can hold it. Matters: every copy is backed by a locked token, and every locked token is owed to a
    /// copy, a claim or a message.
    function invariant_custodyIdentity() public view {
        address token = address(handler.nativeToken());
        address copyToken = handler.copy();
        uint256 supply = copyToken == address(0) ? 0 : IERC20(copyToken).totalSupply();
        uint256 record = handler.mediatorOnA().mediatorBalance(token);

        uint256 claims;
        address[] memory list = handler.holders();
        for (uint256 i = 0; i < list.length; i++) {
            claims += handler.mediatorOnA().claimable(token, list[i]);
            if (copyToken != address(0)) claims += handler.mediatorOnB().claimable(copyToken, list[i]);
        }
        uint256 inFlight;
        for (uint256 i = 0; i < handler.sentCount(); i++) {
            (bytes32 id,,, uint256 net) = handler.sentAt(i);
            if (handler.executions(id) == 0) inFlight += net;
        }
        assertEq(record, supply + claims + inFlight, "record == copy supply + claims + in flight");
        assertEq(IERC20(token).balanceOf(address(handler.mediatorOnA())), record, "balance == record + fees (no fee)");
        if (copyToken == address(0)) return;
        assertEq(IERC20(copyToken).balanceOf(address(handler.mediatorOnB())), 0, "no copy is held as a fee");
        uint256 held;
        for (uint256 i = 0; i < list.length; i++) {
            held += IERC20(copyToken).balanceOf(list[i]);
        }
        assertEq(held, supply, "the supply is the sum of the balances of the accounts");
    }

    /// Claim: a router keeps nothing. Shows: after every action neither router holds the token, the copy or the native
    /// coin, and the runner slot is idle (at most one). Matters: a token that stays in a router has no owner to recover
    /// it, and a slot left in use would block the next run.
    function invariant_routersHoldNothing() public view {
        address token = address(handler.nativeToken());
        address copyToken = handler.copy();
        address[2] memory routers = [address(handler.routerA()), address(handler.routerB())];
        for (uint256 i = 0; i < routers.length; i++) {
            assertEq(IERC20(token).balanceOf(routers[i]), 0, "the router holds the token");
            assertEq(routers[i].balance, 0, "the router holds the native coin");
            if (copyToken != address(0)) assertEq(IERC20(copyToken).balanceOf(routers[i]), 0, "the router holds the copy");
            assertLe(uint256(vm.load(routers[i], DeliveryRouter(payable(routers[i])).RUNNER_SLOT())), 1, "the slot is idle");
        }
    }

    /// Claim: only the reward address receives tips, and exactly the tips of the router deliveries. Shows: the reward
    /// address of each router holds the sum of the tips that the handler computed from the terms of the messages that the
    /// router delivered; the runner holds nothing. Matters: a tip that goes anywhere else, or a direct delivery that
    /// pays a tip, breaks the equality.
    function invariant_onlyTheRewardAddressesReceiveTips() public view {
        address copyToken = handler.copy();
        uint256 tipsOnB = copyToken == address(0) ? 0 : IERC20(copyToken).balanceOf(handler.rewardB());
        assertEq(tipsOnB, handler.tipsPaidOnB(), "reward address on chain B");
        assertEq(handler.nativeToken().balanceOf(handler.rewardA()), handler.tipsPaidOnA(), "reward address on chain A");
        assertEq(handler.nativeToken().balanceOf(handler.runner()), 0, "the runner holds no native token");
        if (copyToken != address(0)) assertEq(IERC20(copyToken).balanceOf(handler.runner()), 0, "the runner holds no copy");
    }

    /// Claim: the handler reaches every path. Shows: a fixed sequence sends all four kinds both ways and delivers them
    /// out of order by a direct call, the router and a batch with a repeat; replays through all three paths, a stranger
    /// origin and a wrong bridge are refused; tips are paid; the copy returns. Matters: an invariant over a handler that
    /// never acts proves nothing.
    function test_handlerReachesThePayingPaths() public {
        handler.sendApplication(0, 1);
        handler.sendApplication(1, 2);
        handler.relayToAccount(100 ether, 0);
        handler.relayToRouterOnB(200 ether, 3, 0, 0.02 ether);
        handler.relayToRouterOnB(300 ether, 2, 1, 7 ether);
        assertEq(handler.sentCount(), 5);

        // Out of order: the newest first (index 4 of the 5 undelivered), through the router.
        handler.deliverViaRouterAsStranger(4);
        handler.deliverViaRouter(4);
        assertEq(handler.routerDeliveries(), 1);
        assertGt(handler.outOfOrderDeliveries(), 0);
        assertGt(handler.tipsPaidOnB(), 0, "a tip was paid");
        handler.deliverDirect(0);
        assertEq(handler.directDeliveries(), 1);
        // A batch with a repeat and a delivered message: the pick is by index modulo 5. Chain B messages are 2, 3, 4.
        handler.deliverViaBatch(3, 3, 4, 2);
        assertGe(handler.batchDeliveries(), 1);
        assertEq(handler.batchesRun(), 1);

        handler.replay(0, 0);
        handler.replay(1, 1);
        handler.replay(2, 2);
        assertEq(handler.replayAttempts(), 3);
        assertEq(handler.replayRefusals(), 3, "every replay is refused");
        handler.deliverOnWrongBridge(2);
        assertEq(handler.wrongBridgeAttempts(), 1);
        assertEq(handler.strangerAttempts(), 1);

        // The copy exists now. It returns plainly and with a tip, and the application message toward A is delivered.
        handler.relayCopyBack(0, 50 ether, 1);
        handler.relayCopyBackToRouter(0, 20 ether, 2, 0, 0.01 ether);
        assertEq(handler.copyBackSends(), 2);
        handler.deliverViaBatch(6, 5, 1, 6);
        handler.deliverDirect(0);
        handler.deliverViaRouter(0);
        assertGt(handler.tipsPaidOnA(), 0, "a tip was paid on chain A");

        invariant_aMessageExecutesAtMostOnce();
        invariant_refusedAttemptsChangeNothing();
        invariant_sentIdentifiersAreUnique();
        invariant_custodyIdentity();
        invariant_routersHoldNothing();
        invariant_onlyTheRewardAddressesReceiveTips();
    }
}
