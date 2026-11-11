// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IAMB} from "../../../../src/hardened/IAMB.sol";
import {MessageBridge} from "../../../../src/hardened/MessageBridge.sol";
import {DeliveryRouter} from "../../../../src/hardened/mediator/DeliveryRouter.sol";
import {TokenMediator} from "../../../../src/hardened/mediator/TokenMediator.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Multicall3} from "../../../../src/hardened/vendor/multicall3/Multicall3.sol";
import {MockAMB, TEST_CALLBACK_GAS} from "../../mediator/utils/MediatorSupport.sol";
import {MessageReading} from "./MessageReading.sol";
import {RouterWorld} from "./RouterWorld.sol";

/// @notice The money that sits around one token of the universe before and after a delivery.
/// @param held What the holders hold, counting the coin for the wrapped native token.
/// @param stuck The value of failed releases of the token, which stay in the mediator.
/// @param rewardHeld What each reward address holds, in the sense of `held`.
struct Probe {
    uint256 held;
    uint256 stuck;
    uint256[3] rewardHeld;
}

/// @notice One message that an operation delivers.
/// @param messageId The position in the list of messages of the handler.
/// @param executor The delivery router that executes the message, or the zero address for a direct execution.
/// @param reading What the message delivers.
/// @param universe The token of the universe that the delivery pays.
/// @param payee The account that should end with the value after the tip: the recipient of the terms for a
/// delivery router, the receiver in the data for the legacy form, and the recipient otherwise.
/// @param payeeBefore What the payee holds before, in the sense of `held`.
struct Item {
    uint256 messageId;
    address executor;
    MessageReading.Reading reading;
    uint256 universe;
    address payee;
    uint256 payeeBefore;
}

/// @notice Drives the two chains of `RouterWorld` with random sequences and checks every delivery against the rules that
/// the contracts state.
/// @dev What it does. Senders relay native tokens and bridged copies both ways, through the plain forms, the forms with a
/// call, a delivery router, and the wrap and relay form of a delivery router. Messages
/// wait in a list and arrive in random order, by three paths: directly, through `executeMessage` of a router from
/// an outside caller (caller and origin the same), and in a batch through Multicall3 from an outside caller. Accounts wrap and unwrap the
/// coin, accounts are denied and allowed, routers are swept, and strangers send tokens to a mediator or to a router.
/// An attacker tries the callback entry and the coin entry of the routers.
///
/// What it claims. The mock bridge reads no proof, so the handler never delivers a message twice itself. It counts the
/// executions of each message from the `AffirmationCompleted` logs, as a check on itself. The handler does not claim to
/// test the proofs of the message bridge: `RealBridgeInvariant.t.sol` does that with real proofs.
///
/// Every breach goes to `violations` with the first reason in `firstViolation`, so one invariant reports all of them.
contract RouterHandler is RouterWorld {
    /// @dev How an operation executes its messages.
    enum Path {
        Direct,
        RouterSingle,
        RouterBatch
    }

    /// @dev A message in the list: where it was sent and which of the sends it is.
    struct Message {
        uint256 sourceChain;
        uint256 index;
        bytes32 bridgeMessageId;
        bool delivered;
    }

    uint256 internal constant MAXIMUM_AMOUNT = 1_000 ether;
    /// @dev The fixed overhead that a gas based tip adds to the measured gas, at its largest (the token payout).
    uint256 internal constant GAS_OVERHEAD_BOUND = 100_000;
    /// @dev The gas that the caller of a router supplies. The router measures from the entry of `executeMessage`, so it
    /// can measure no more than this, and the handler bounds a gas based tip by it. It exceeds the largest callback gas
    /// of the handler's messages (3,000,000 for the outer message of a reentry), so every callback gets its gas.
    uint256 internal constant SUPPLIED_GAS = 5_000_000;
    uint256 internal constant BATCH_SIZE = 4;
    bytes32 internal constant COMPLETED_TOPIC = keccak256("AffirmationCompleted(address,address,bytes32,bool)");
    bytes32 internal constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");

    Message[] internal _messages;
    uint256[] internal _pending;
    mapping(bytes32 bridgeMessageId => uint256) public executions;
    mapping(bytes32 bridgeMessageId => bool) internal _sentIds;
    /// @notice The value of the messages in flight for each native token.
    mapping(address nativeToken => uint256) public inFlight;
    /// @notice The tokens that strangers sent to a mediator by plain transfer, for each token and mediator.
    mapping(address token => uint256) public donated;
    /// @notice For each token, the value of releases that failed. It stays in the mediator, owed to nobody.
    mapping(address token => uint256) public stuckOf;
    /// @notice What each router must hold of each token, by the handler's own count: the amounts of the `HandOffRefused`
    /// logs, plus the stray amounts that the handler sent to the router, less what a sweep paid out.
    mapping(address router => mapping(address token => uint256)) public expectedInRouter;
    uint256 public coinDealt;

    uint256 public violations;
    string public firstViolation;

    uint256 public relaysFromNative;
    uint256 public relaysFromCopy;
    uint256 public directDeliveries;
    uint256 public routerDeliveries;
    uint256 public batchDeliveries;
    uint256 public routedDeliveries;
    uint256 public tipsPaid;
    uint256 public nativePayouts;
    uint256 public releasesFailed;
    uint256 public callbacksFailed;
    uint256 public attacksRefused;
    uint256 public outOfOrderDeliveries;
    uint256 public failedDeliveries;
    uint256 public payoutsRefused;
    uint256 public termsForfeited;
    uint256 public tippedInvalidTerms;
    /// @notice The sweeps of a router that paid the failed delivery address.
    uint256 public sweepsPaid;
    /// @notice The sweeps that the token refused: the tokens stayed and the router emitted `HandOffRefused`.
    uint256 public sweepsRefused;
    /// @notice The sweeps of an empty router, which must revert.
    uint256 public sweepsEmpty;
    uint256 public legacyTokenPayouts;
    /// @notice The hand-offs of a reentrant callback that the logs showed.
    uint256 public reenteredHandOffs;
    /// @notice The reentering deliveries in which the payout hook of the recipient executed a second message.
    uint256 public reentriesRun;
    /// @notice The deliveries whose transfers to the payee the handler counted: a token payout by a delivery router.
    uint256 public payeeTransferChecks;
    /// @notice The single deliveries whose payee received exactly one transfer and whose reward address received one
    /// transfer if it was paid, and none otherwise.
    uint256 public exactTransferChecks;

    constructor() RouterWorld() {}

    // ----------------------------------------------------------------------------------------------- views

    function messageCount() external view returns (uint256) {
        return _messages.length;
    }

    function pendingCount() public view returns (uint256) {
        return _pending.length;
    }

    function messageAt(uint256 index) external view returns (Message memory) {
        return _messages[index];
    }

    // -------------------------------------------------------------------------------------------------- sending

    /// @dev What one relay does. The fields are the decisions that the seeds make.
    struct Plan {
        uint256 index;
        uint256 universe;
        uint256 source;
        uint256 route;
        address sender;
        uint256 amount;
        uint256 detail;
    }

    /// @notice One relay. The seeds choose the token, the chain it leaves, the route, the sender, the amount, and the
    /// details of the receiver and the fee terms. The message waits unless the timing seed delivers it now.
    function relay(
        uint8 tokenSeed,
        uint8 leaveSeed,
        uint8 routeSeed,
        uint8 actorSeed,
        uint96 amountSeed,
        uint256 detail,
        uint8 timingSeed
    ) external {
        Plan memory plan;
        plan.index = tokenSeed % NATIVE_COUNT;
        plan.source = leaveSeed % 2 == 0 ? homes[plan.index] : 1 - homes[plan.index];
        plan.sender = actors[actorSeed % actors.length];
        plan.detail = detail;
        if (plan.index == 4 && denyToken.denied(plan.sender)) return;
        plan.amount = _fundSender(plan, amountSeed);
        if (plan.amount == 0) return;
        plan.route = _routeFor(plan, routeSeed);
        plan.universe = plan.source == homes[plan.index] ? plan.index : plan.index + NATIVE_COUNT;
        if (!_send(plan)) return;
        if (plan.source == homes[plan.index]) relaysFromNative++;
        if (plan.source != homes[plan.index]) relaysFromCopy++;
        uint256 id = _recordSend(plan.source);
        if (timingSeed % 3 == 0) _deliverDirect(id);
    }

    /// @notice Wraps the coin of an actor into the wrapped native token of a chain.
    function wrapCoin(uint8 chainSeed, uint8 actorSeed, uint96 amountSeed) external {
        uint256 chain = chainSeed % 2;
        address account = actors[actorSeed % actors.length];
        uint256 amount = bound(amountSeed, 1, MAXIMUM_AMOUNT);
        _dealCoin(account, amount);
        vm.prank(account);
        wrapped[chain].deposit{value: amount}();
    }

    /// @notice Unwraps part of the wrapped native token of an actor.
    function unwrapCoin(uint8 chainSeed, uint8 actorSeed, uint96 amountSeed) external {
        uint256 chain = chainSeed % 2;
        address account = actors[actorSeed % actors.length];
        uint256 held = wrapped[chain].balanceOf(account);
        if (held == 0) return;
        vm.prank(account);
        wrapped[chain].withdraw(bound(amountSeed, 1, held));
    }

    /// @notice A stranger sends tokens of the universe to a mediator by plain transfer. Nothing pays them out.
    function donate(uint8 universeSeed, uint8 actorSeed, uint96 amountSeed) external {
        uint256 universe = universeSeed % UNIVERSE;
        if (isWrappedNativeOfItsChain(universe)) return;
        address token = tokenAt(universe);
        address giver = actors[actorSeed % actors.length];
        uint256 chain = chainOfToken(universe);
        if (universe == 4 && denyToken.denied(giver)) return;
        uint256 amount;
        if (universe < NATIVE_COUNT) {
            amount = bound(amountSeed, 1, MAXIMUM_AMOUNT);
            _mintPlain(token, giver, amount);
        } else {
            uint256 held = balanceOrZero(token, giver);
            if (held == 0) return;
            amount = bound(amountSeed, 1, held);
        }
        vm.prank(giver);
        IERC20Transfer(token).transfer(address(mediatorOf(chain)), amount);
        donated[token] += amount;
    }

    // ------------------------------------------------------------------------------------------------ delivery

    /// @notice Delivers a message that waits, by the path that the seed chooses. A direct execution takes one message.
    /// A router takes one message. A batch takes up to four messages for the same chain through Multicall3.
    function deliver(uint256 messageSeed, uint8 pathSeed, uint8 routerSeed, uint256 priceSeed) external {
        if (_pending.length == 0) return;
        vm.txGasPrice(1 + priceSeed % 100 gwei);
        vm.fee((priceSeed >> 64) % 50 gwei);
        uint256 position = messageSeed % _pending.length;
        uint256 pathChoice = pathSeed % 3;
        if (pathChoice == uint256(Path.Direct)) {
            _deliverDirect(_pending[position]);
            return;
        }
        uint256 count = pathChoice == uint256(Path.RouterSingle) ? 1 : BATCH_SIZE;
        _deliverThroughRouters(_collect(position, count), routerSeed);
    }

    /// @notice Delivers the newest message that waits, which is the opposite of the order of sending.
    function deliverNewest() external {
        if (_pending.length == 0) return;
        _deliverDirect(_pending[_pending.length - 1]);
    }

    // ---------------------------------------------------------------------------------------- other actions

    /// @notice Sweeps a token of a router. Anyone may call it. The seeds choose the token and where the search starts for
    /// a router that holds some of it. The handler states the outcome before it calls. An empty router must revert. A
    /// token that refuses the failed delivery address must leave the tokens and emit `HandOffRefused` and no `Swept`. Any
    /// other token must pay the whole balance to that address, with one `Swept` event.
    function sweepRouter(uint8 universeSeed, uint8 routerSeed) external {
        uint256 universe = universeSeed % UNIVERSE;
        address token = tokenAt(universe);
        if (token.code.length == 0) return;
        DeliveryRouter router = _routerHolding(universe, routerSeed);
        uint256 balance = balanceOrZero(token, address(router));
        uint256 sinkBefore = balanceOrZero(token, failedSink);
        bool refusedByToken = token == address(denyToken) && denyToken.denied(failedSink);

        vm.recordLogs();
        vm.getRecordedLogs();
        vm.prank(stranger, stranger);
        try router.sweep(token) {
            _checkSweepOutcome(router, token, balance, sinkBefore, refusedByToken);
        } catch {
            if (balance != 0) _violate("a sweep of a router that holds tokens reverted");
            if (balance == 0) sweepsEmpty++;
            return;
        }
        if (balance == 0) _violate("a sweep of an empty router did not revert");
    }

    /// @notice Denies or allows an account on the deny list token: a recipient, or the failed delivery address.
    function toggleDeny(uint8 accountSeed) external {
        uint256 pick = accountSeed % (recipients.length + 1);
        address account = pick == recipients.length ? failedSink : recipients[pick];
        denyToken.setDenied(account, !denyToken.denied(account));
    }

    /// @notice A recipient whose payout hook makes the bridge deliver a second message to the same router while the
    /// first delivery runs. The handler sends its own two messages of the deny list token from chain B to a router on
    /// chain A: the first names the reentering recipient, the second names an actor, in the terms, as a legacy receiver,
    /// or as data of no known shape. It arms the token, delivers the first message directly or through the router, and
    /// checks that the second message executed inside the first, that the router handed it off as `Reentered`, that its
    /// named receiver gained nothing, and that the value split exactly.
    function deliverReentrant(uint8 routerSeed, uint96 amountSeed, uint8 shapeSeed, uint8 pathSeed, uint8 priceSeed)
        external
    {
        address sender = actors[routerSeed % actors.length];
        if (denyToken.denied(sender)) return;
        DeliveryRouter router = deliveryRouterAt(0, (routerSeed >> 2) % ROUTERS_PER_CHAIN);
        uint256 outerAmount = bound(amountSeed, 1e6, MAXIMUM_AMOUNT);
        uint256 nestedAmount = bound(uint256(amountSeed) >> 20, 1e6, MAXIMUM_AMOUNT);
        if (!_stockCopies(sender, outerAmount + nestedAmount)) return;

        address nestedReceiver = actors[(shapeSeed >> 4) % actors.length];
        // The nested message runs inside the callback of the outer one, so the outer callback gas leaves room for it.
        uint256 outerId =
            _sendBack(sender, router, _reentryTerms(reenterer, shapeSeed, outerAmount), outerAmount, 3_000_000);
        uint256 nestedId =
            _sendBack(sender, router, _nestedData(nestedReceiver, shapeSeed, nestedAmount), nestedAmount, 300_000);
        _runReentrant(Reentry(router, outerId, nestedId, nestedReceiver, shapeSeed, pathSeed, priceSeed));
    }

    /// @notice A stranger sends tokens of the universe to a delivery router by plain transfer, as a plain relay or a
    /// mistake would. The router has no callback for it, so only `sweep` can move it.
    function strayToRouter(uint8 universeSeed, uint8 actorSeed, uint8 routerSeed, uint96 amountSeed) external {
        uint256 universe = universeSeed % UNIVERSE;
        if (isWrappedNativeOfItsChain(universe)) return;
        address token = tokenAt(universe);
        address giver = actors[actorSeed % actors.length];
        if (universe == DENY_TOKEN_UNIVERSE && denyToken.denied(giver)) return;
        DeliveryRouter router = deliveryRouterAt(chainOfToken(universe), routerSeed % ROUTERS_PER_CHAIN);
        uint256 amount;
        if (universe < NATIVE_COUNT) {
            amount = bound(amountSeed, 1, MAXIMUM_AMOUNT);
            _mintPlain(token, giver, amount);
        } else {
            uint256 held = balanceOrZero(token, giver);
            if (held == 0) return;
            amount = bound(amountSeed, 1, held);
        }
        vm.prank(giver);
        IERC20Transfer(token).transfer(address(router), amount);
        expectedInRouter[address(router)][token] += amount;
    }

    /// @notice Lets the receiver that refuses callbacks refuse or accept for a while.
    function toggleRefusal() external {
        refusingReceiver.setRefuse(!refusingReceiver.refuse());
    }

    /// @notice An attacker tries the entries that only the mediator or the wrapped token may use. Each try must
    /// revert, and no message may execute.
    function attack(uint8 kindSeed, uint8 routerSeed) external {
        uint256 chain = routerSeed % 2;
        DeliveryRouter router = deliveryRouterAt(chain, (routerSeed >> 1) % ROUTERS_PER_CHAIN);
        uint256 kind = kindSeed % 2;
        uint256 executedBefore = _executionTotal();
        if (kind == 0) _attackCallback(address(router));
        if (kind == 1) _attackCoinEntry(address(router));
        if (_executionTotal() != executedBefore) _violate("an attack executed a message");
    }

    // ---------------------------------------------------------------------------------------------- modifier

    /// @dev The first router of the chain of the token, from the seed, that holds some of the token, or the router that
    /// the seed names when none does.
    function _routerHolding(uint256 universe, uint8 routerSeed) private view returns (DeliveryRouter) {
        uint256 chain = chainOfToken(universe);
        for (uint256 step = 0; step < ROUTERS_PER_CHAIN; step++) {
            DeliveryRouter candidate = deliveryRouterAt(chain, (routerSeed + step) % ROUTERS_PER_CHAIN);
            if (balanceOrZero(tokenAt(universe), address(candidate)) != 0) return candidate;
        }
        return deliveryRouterAt(chain, routerSeed % ROUTERS_PER_CHAIN);
    }

    /// @dev The checks after a sweep that did not revert, against the state that the handler recorded before it.
    function _checkSweepOutcome(
        DeliveryRouter router,
        address token,
        uint256 balance,
        uint256 sinkBefore,
        bool refusedByToken
    ) private {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 swept;
        uint256 refused;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(router)) continue;
            bool sameToken = logs[i].topics[1] == bytes32(uint256(uint160(token)));
            if (!sameToken) continue;
            if (logs[i].topics[0] == DeliveryRouter.Swept.selector && abi.decode(logs[i].data, (uint256)) == balance) swept++;
            if (logs[i].topics[0] == DeliveryRouter.HandOffRefused.selector && abi.decode(logs[i].data, (uint256)) == balance) {
                refused++;
            }
        }
        uint256 sinkAfter = balanceOrZero(token, failedSink);
        if (balance == 0) return;
        if (refusedByToken) {
            sweepsRefused++;
            if (balanceOrZero(token, address(router)) != balance) _violate("a refused sweep moved tokens");
            if (sinkAfter != sinkBefore) _violate("a refused sweep paid the failed delivery address");
            if (swept != 0 || refused != 1) _violate("a refused sweep emitted the wrong events");
            return;
        }
        sweepsPaid++;
        expectedInRouter[address(router)][token] = 0;
        if (balanceOrZero(token, address(router)) != 0) _violate("a sweep left tokens in the router");
        if (sinkAfter - sinkBefore != balance) _violate("a sweep did not pay the whole balance");
        if (swept != 1 || refused != 0) _violate("a paid sweep emitted the wrong events");
    }

    // ------------------------------------------------------------------------------------------- reentry, internal

    /// @dev Gives the sender bridged copies of the deny list token on chain B: it relays `amount` from chain A and the
    /// message is delivered directly. Returns false when the send reverted.
    function _stockCopies(address sender, uint256 amount) private returns (bool) {
        _mintPlain(address(denyToken), sender, amount);
        vm.prank(sender);
        denyToken.approve(address(mediatorA), amount);
        vm.prank(sender);
        try mediatorA.relayTokens(address(denyToken), sender, amount) {}
        catch {
            return _refused("a relay that stocks the copies reverted");
        }
        _deliverDirect(_recordSend(0));
        return true;
    }

    /// @dev Sends copies from chain B to `router` on chain A with `data`, and records the message.
    function _sendBack(address sender, DeliveryRouter router, bytes memory data, uint256 amount, uint256 callbackGas)
        private
        returns (uint256)
    {
        address copy = copies[4];
        vm.prank(sender);
        IERC20Transfer(copy).approve(address(mediatorB), amount);
        vm.prank(sender);
        try mediatorB.relayTokensAndCall(copy, address(router), amount, data, callbackGas) {}
        catch {
            _violate("a relay of the reentry test reverted");
        }
        return _recordSend(1);
    }

    /// @dev Terms for the first message: a fixed fee, a share, a gas based fee at the transaction price or at the base fee,
    /// each with a tip of at most a tenth of the value, so a payout to the recipient always follows.
    function _reentryTerms(address receiver, uint8 shapeSeed, uint256 amount) private pure returns (bytes memory) {
        uint256 shape = shapeSeed % 4;
        uint256 settings = shape == 0 ? 1 : shape == 1 ? 8 : shape == 2 ? 0 : 4;
        uint256 multiplier = shape == 1 ? 0.1 ether : 1 ether;
        return abi.encode(DeliveryRouter.FeeDirector(receiver, settings, amount / 10, multiplier, 0));
    }

    /// @dev The data of the second message: terms (shape 0 and 1 of `shapeSeed >> 2`), the legacy receiver, or no known shape.
    function _nestedData(address receiver, uint8 shapeSeed, uint256 amount) private pure returns (bytes memory) {
        uint256 form = (shapeSeed >> 2) % 3;
        if (form == 1) return abi.encodePacked(receiver);
        if (form == 2) return new bytes(7);
        return _reentryTerms(receiver, shapeSeed >> 1, amount / 2);
    }

    /// @dev What one reentering delivery runs: the router, the two messages, who the second names, and the seeds.
    struct Reentry {
        DeliveryRouter router;
        uint256 outerId;
        uint256 nestedId;
        address nestedReceiver;
        uint8 shapeSeed;
        uint8 pathSeed;
        uint8 priceSeed;
    }

    /// @dev Arms the hook, executes the first message, and checks the outcome. The hook runs when the router pays the
    /// reentering recipient, which is inside the callback of the first message.
    function _runReentrant(Reentry memory run) private {
        Item memory outer = _itemFor(run.outerId);
        Item memory nested = _itemFor(run.nestedId);
        Probe memory before = _probe(4);
        uint256 receiverBefore = standing(4, run.nestedReceiver);
        uint256 handOffsBefore = reenteredHandOffs;
        uint256 hooksBefore = denyToken.hooksRun();
        _arm(run.nestedId);
        vm.txGasPrice(1 + uint256(run.priceSeed) * 1 gwei);
        vm.fee(uint256(run.priceSeed) * 1 gwei / 2);

        vm.recordLogs();
        vm.getRecordedLogs();
        _executeOuter(run.router, run.outerId, run.pathSeed);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        denyToken.arm(address(0), address(0), "");

        _readLogs(logs, 0);
        _checkReentry(outer, nested, before, hooksBefore, handOffsBefore);
        bool namesReceiver = (run.shapeSeed >> 2) % 3 != 2;
        if (namesReceiver && standing(4, run.nestedReceiver) != receiverBefore) {
            _violate("the receiver of a reentrant message gained");
        }
        _finish(outer);
        if (executions[_messages[run.nestedId].bridgeMessageId] == 1) _finish(nested);
    }

    function _arm(uint256 nestedId) private {
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, _messages[nestedId].index);
        denyToken.arm(reenterer, address(ambA), abi.encodeCall(ambA.executeMessage, (proof)));
    }

    function _executeOuter(DeliveryRouter router, uint256 outerId, uint8 pathSeed) private {
        Message storage message = _messages[outerId];
        if (pathSeed % 2 == 0) {
            directDeliveries++;
            ambA.deliver(ambB, message.index);
            return;
        }
        routerDeliveries++;
        address caller = _callerFor(outerId);
        vm.prank(caller, caller);
        (bool ok,) = address(router).call{gas: SUPPLIED_GAS}(
            abi.encodeCall(router.executeMessage, (ambA.proofOf(ambB, message.index)))
        );
        if (!ok) _violate("a router refused a caller in the reentry test");
    }

    /// @dev The first message executed once. The second executed exactly when the hook ran, with one hand-off of the reason
    /// `Reentered`, and the value of both split exactly.
    function _checkReentry(
        Item memory outer,
        Item memory nested,
        Probe memory before,
        uint256 hooksBefore,
        uint256 handOffsBefore
    ) private {
        bool hookRan = denyToken.hooksRun() > hooksBefore;
        bool nestedRan = executions[_messages[nested.messageId].bridgeMessageId] == 1;
        if (executions[_messages[outer.messageId].bridgeMessageId] != 1) _violate("the first message did not execute once");
        if (hookRan != nestedRan) _violate("the hook and the second execution disagree");
        if (nestedRan) reentriesRun++;
        if (nestedRan && reenteredHandOffs != handOffsBefore + 1) _violate("a reentrant callback was not handed off once");
        if (!nestedRan && reenteredHandOffs != handOffsBefore) _violate("a hand-off of a reentry without a reentry");
        _checkMoney(4, before, outer.reading.value + (nestedRan ? nested.reading.value : 0));
    }

    // ------------------------------------------------------------------------------------------ sending, internal

    function _routeFor(Plan memory plan, uint8 routeSeed) private view returns (uint256) {
        uint256 route = routeSeed % 6;
        bool isWrappedNative = plan.index == 1 || plan.index == 3;
        if (route == WRAP_ROUTE && !(isWrappedNative && plan.source == homes[plan.index])) return route % 3;
        return route;
    }

    /// @dev Gives the sender what it relays. A native token is minted, the wrapped native token is wrapped, and a copy
    /// is taken from the balance of the sender. Returns the amount, or zero when the sender has nothing to relay.
    function _fundSender(Plan memory plan, uint96 amountSeed) private returns (uint256 amount) {
        if (plan.source != homes[plan.index]) {
            uint256 held = balanceOrZero(copies[plan.index], plan.sender);
            if (held == 0) return 0;
            return bound(amountSeed, 1, held);
        }
        amount = amountSeed % 8 == 0 ? bound(amountSeed, 1, 10_000) : bound(amountSeed, 1e6, MAXIMUM_AMOUNT);
        if (plan.index == 1 || plan.index == 3) {
            _dealCoin(plan.sender, amount);
            vm.prank(plan.sender);
            wrapped[plan.source].deposit{value: amount}();
            return amount;
        }
        _mintPlain(natives[plan.index], plan.sender, amount);
    }

    function _mintPlain(address token, address to, uint256 amount) private {
        IMintable(token).mint(to, amount);
    }

    function _dealCoin(address account, uint256 amount) private {
        vm.deal(account, account.balance + amount);
        coinDealt += amount;
    }

    /// @dev The route that wraps the coin and relays it by a delivery router of the source chain.
    uint256 private constant WRAP_ROUTE = 5;

    /// @dev Sends by one of the six routes. Returns false when the send reverted. A revert is a violation: every send
    /// that the handler makes is valid.
    function _send(Plan memory plan) private returns (bool) {
        if (plan.route == WRAP_ROUTE) return _wrapAndRelay(plan);
        TokenMediator mediator = mediatorOf(plan.source);
        address token = tokenAt(plan.universe);
        address receiver = recipients[uint8(plan.detail) % RECIPIENT_COUNT];
        vm.prank(plan.sender);
        IERC20Transfer(token).approve(address(mediator), plan.amount);

        address target = receiver;
        bytes memory data = _dataFor(plan, receiver);
        if (plan.route == 3 || plan.route == 4) target = address(_routerOf(plan));
        vm.prank(plan.sender);
        if (plan.route == 0 || data.length == 0) {
            try mediator.relayTokens(token, target, plan.amount) {
                return true;
            } catch {
                return _refused("a plain relay reverted");
            }
        }
        try mediator.relayTokensAndCall(token, target, plan.amount, data, TEST_CALLBACK_GAS) {
            return true;
        } catch {
            return _refused("a relay with a call reverted");
        }
    }

    function _routerOf(Plan memory plan) private view returns (DeliveryRouter) {
        return deliveryRouterAt(1 - plan.source, uint8(plan.detail >> 16) % ROUTERS_PER_CHAIN);
    }

    /// @dev The data of the relay: empty for the plain routes, a call for route 2, the terms for route 3, and the
    /// receiver of the coin for route 4.
    function _dataFor(Plan memory plan, address receiver) private view returns (bytes memory) {
        if (plan.route == 2) return abi.encodePacked("call", plan.detail);
        if (plan.route == 3) return _termsData(plan, receiver);
        if (plan.route == 4) return abi.encodePacked(_invalidOr(plan, receiver));
        return "";
    }

    /// @dev The data for a delivery router: the terms, or one time in eight data of no known shape (bits 144.. equal 1).
    function _termsData(Plan memory plan, address receiver) private view returns (bytes memory) {
        if (uint8(plan.detail >> 144) % 8 == 1) return new bytes(_oddLengthFor(plan.detail));
        return abi.encode(_director(plan, _invalidOr(plan, receiver)));
    }

    /// @dev A length that is neither 20 nor the five words of the terms.
    function _oddLengthFor(uint256 detail) private pure returns (uint256) {
        uint256[5] memory lengths = [uint256(1), 7, 19, 21, 159];
        return lengths[uint8(detail >> 152) % lengths.length];
    }

    /// @dev One time in four the receiver is the router that the message names (bits 136.. equal 1) or the zero address
    /// (equal 2): terms that no account can be paid under.
    function _invalidOr(Plan memory plan, address receiver) private view returns (address) {
        uint256 pick = uint8(plan.detail >> 136) % 8;
        if (pick == 1) return address(_routerOf(plan));
        if (pick == 2) return address(0);
        return receiver;
    }

    function _wrapAndRelay(Plan memory plan) private returns (bool) {
        address receiver = recipients[uint8(plan.detail) % RECIPIENT_COUNT];
        uint256 form = uint8(plan.detail >> 24) % 3;
        _dealCoin(plan.sender, plan.amount);
        DeliveryRouter router = deliveryRouterAt(plan.source, uint8(plan.detail >> 16) % ROUTERS_PER_CHAIN);
        vm.prank(plan.sender);
        if (form == 0) {
            try router.wrapAndRelayTokens{value: plan.amount}() {
                return true;
            } catch {
                return _refused("wrapAndRelayTokens reverted");
            }
        }
        if (form == 1) {
            try router.wrapAndRelayTokens{value: plan.amount}(receiver, "") {
                return true;
            } catch {
                return _refused("wrapAndRelayTokens with a receiver reverted");
            }
        }
        try router.relayTokensAndCall{value: plan.amount}(receiver, abi.encodePacked(receiver), TEST_CALLBACK_GAS, "") {
            return true;
        } catch {
            return _refused("relayTokensAndCall of the delivery router reverted");
        }
    }

    /// @dev The fee terms for one message to a delivery router. The seeds reach a fixed fee, a share, a gas based fee that
    /// reads the price of the transaction, a gas based fee that reads the base fee, with and without the unwrap bit, and
    /// a limit that is below, near and above the value.
    function _director(Plan memory plan, address receiver) private view returns (DeliveryRouter.FeeDirector memory) {
        uint256 detail = plan.detail;
        uint256 shape = uint8(detail >> 32) % 4;
        uint256 settings = shape == 0 ? 1 : shape == 1 ? 8 : shape == 2 ? 0 : 4;
        if (uint8(detail >> 40) % 2 == 0) settings |= 2;
        uint256 limitKind = uint8(detail >> 48) % 4;
        uint256 limit = limitKind == 0 ? plan.amount : limitKind == 1 ? 0 : bound(detail >> 56, 0, plan.amount);
        uint256 multiplier = shape == 1 ? bound(detail >> 120, 0, 1.5e18) : bound(detail >> 120, 0, 5e18);
        return DeliveryRouter.FeeDirector(receiver, settings, limit, multiplier, 0);
    }

    function _refused(string memory reason) private returns (bool) {
        _violate(reason);
        return false;
    }

    /// @dev Records the message that the last send of `source` made, and adds its value to the value in flight.
    function _recordSend(uint256 source) private returns (uint256 id) {
        MockAMB bridge = bridgeOf(source);
        uint256 index = bridge.sentCount() - 1;
        bytes32 bridgeMessageId = bridge.messageAt(index).id;
        if (_sentIds[bridgeMessageId]) _violate("a message identifier repeated");
        _sentIds[bridgeMessageId] = true;
        id = _messages.length;
        _messages.push(Message(source, index, bridgeMessageId, false));
        _pending.push(id);
        MessageReading.Reading memory reading = MessageReading.read(bridge.messageAt(index).data);
        inFlight[reading.nativeToken] += reading.value;
    }

    // ----------------------------------------------------------------------------------------- delivery, internal

    /// @dev The ids of up to `count` messages that wait, for the chain of the message at `position`, starting there.
    function _collect(uint256 position, uint256 count) private view returns (uint256[] memory ids) {
        uint256 destination = 1 - _messages[_pending[position]].sourceChain;
        uint256[] memory found = new uint256[](count);
        uint256 total;
        for (uint256 step = 0; step < _pending.length && total < count; step++) {
            uint256 id = _pending[(position + step) % _pending.length];
            if (1 - _messages[id].sourceChain != destination) continue;
            found[total++] = id;
        }
        ids = new uint256[](total);
        for (uint256 i = 0; i < total; i++) {
            ids[i] = found[i];
        }
    }

    function _deliverDirect(uint256 id) private {
        Item[] memory items = new Item[](1);
        items[0] = _itemFor(id);
        _operate(items, Path.Direct);
    }

    /// @dev One router call for one message, or one Multicall3 batch for several. Each message goes to the router that the
    /// recipient names, three times in four, and to a router that the seed names otherwise.
    function _deliverThroughRouters(uint256[] memory ids, uint8 routerSeed) private {
        uint256 destination = 1 - _messages[ids[0]].sourceChain;
        Item[] memory items = new Item[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 pick = uint8(routerSeed >> (2 * i)) % 4;
            items[i] = _itemFor(ids[i]);
            items[i].executor = _executorFor(items[i].reading.recipient, destination, pick);
        }
        _operate(items, ids.length == 1 ? Path.RouterSingle : Path.RouterBatch);
    }

    function _executorFor(address recipient, uint256 destination, uint256 pick) private view returns (address) {
        if (pick != 0) {
            for (uint256 k = 0; k < ROUTERS_PER_CHAIN; k++) {
                if (recipient == address(deliveryRouterAt(destination, k))) return recipient;
            }
        }
        return address(deliveryRouterAt(destination, pick % ROUTERS_PER_CHAIN));
    }

    function _itemFor(uint256 id) private view returns (Item memory item) {
        Message storage message = _messages[id];
        item.messageId = id;
        item.reading = MessageReading.read(bridgeOf(message.sourceChain).messageAt(message.index).data);
        uint256 index = _nativeIndexOf(item.reading.nativeToken);
        item.universe = item.reading.releasesNative ? index : index + NATIVE_COUNT;
        item.payee = _payeeOf(item.reading, item.universe);
        item.payeeBefore = standing(item.universe, item.payee);
    }

    /// @dev Who ends with the value after the tip. A delivery router pays the recipient of the terms, or the
    /// receiver that the 20 byte data names, and hands off to its failed delivery address when it cannot. The wrapped
    /// router pays the receiver that its 20 byte data names.
    function _payeeOf(MessageReading.Reading memory reading, uint256 universe) private view returns (address) {
        uint256 chain = chainOfToken(universe);
        if (!reading.hasCall) return reading.recipient;
        if (!_isDeliveryRouter(reading.recipient, chain)) return reading.recipient;
        // Invalid terms, a payout that the token refuses and data of no known shape all go to the failed delivery
        // address.
        DeliveryRouter router = DeliveryRouter(payable(reading.recipient));
        if (reading.callData.length == 20) return _deliverableOr(router, universe, address(bytes20(reading.callData)));
        if (reading.callData.length != 160) return router.failedDeliveryAddress();
        return _deliverableOr(router, universe, abi.decode(reading.callData, (DeliveryRouter.FeeDirector)).recipient);
    }

    /// @dev The deny list token itself refuses accounts. Its bridged copy (universe 9) is a plain mint and refuses nobody.
    uint256 private constant DENY_TOKEN_UNIVERSE = 4;

    /// @dev `account` when the router can pay it, and the failed delivery address of the router when it cannot: the
    /// account is invalid, or the deny list token refuses it.
    function _deliverableOr(DeliveryRouter router, uint256 universe, address account) private view returns (address) {
        bool refused = universe == DENY_TOKEN_UNIVERSE && denyToken.denied(account);
        return account == address(0) || account == address(router) || refused ? router.failedDeliveryAddress() : account;
    }

    function _nativeIndexOf(address nativeToken) private view returns (uint256) {
        for (uint256 i = 0; i < natives.length; i++) {
            if (natives[i] == nativeToken) return i;
        }
        revert("RouterHandler: not a native token");
    }

    /// @dev Executes the items on their destination chain, reads the logs, and checks the money.
    function _operate(Item[] memory items, Path path) private {
        uint256 destination = 1 - _messages[items[0].messageId].sourceChain;
        Probe[] memory before = new Probe[](UNIVERSE);
        uint256[] memory expectedValue = new uint256[](UNIVERSE);
        for (uint256 i = 0; i < items.length; i++) {
            uint256 u = items[i].universe;
            if (expectedValue[u] == 0) before[u] = _probe(u);
            expectedValue[u] += items[i].reading.value;
        }
        if (_isOutOfOrder(items[0].messageId)) outOfOrderDeliveries++;

        vm.recordLogs();
        vm.getRecordedLogs();
        _execute(items, path, destination);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        _readLogs(logs, destination);
        for (uint256 i = 0; i < items.length; i++) {
            if (executions[_messages[items[i].messageId].bridgeMessageId] != 1) {
                _violate("a message did not execute exactly once");
            }
        }
        for (uint256 u = 0; u < UNIVERSE; u++) {
            if (expectedValue[u] == 0) continue;
            _checkMoney(u, before[u], expectedValue[u]);
            _checkTips(u, before[u], items);
        }
        _checkTransferCounts(items, logs);
        if (items.length == 1) _checkSingle(items[0], before[items[0].universe]);
        for (uint256 i = 0; i < items.length; i++) {
            _finish(items[i]);
        }
    }

    function _execute(Item[] memory items, Path path, uint256 destination) private {
        MockAMB bridge = bridgeOf(destination);
        if (path == Path.Direct) {
            Message storage message = _messages[items[0].messageId];
            directDeliveries++;
            bridge.deliver(bridgeOf(message.sourceChain), message.index);
            return;
        }
        if (path == Path.RouterSingle) {
            routerDeliveries++;
            Multicall3.Call3 memory call = _routerCall(items[0], bridge);
            address caller = _callerFor(items[0].messageId);
            vm.prank(caller, caller);
            (bool ok,) = call.target.call{gas: SUPPLIED_GAS}(call.callData);
            if (!ok) _violate("a router refused a caller");
            return;
        }
        batchDeliveries++;
        Multicall3.Call3[] memory calls = new Multicall3.Call3[](items.length);
        for (uint256 i = 0; i < items.length; i++) {
            calls[i] = _routerCall(items[i], bridge);
        }
        address batcher = _callerFor(items[0].messageId);
        vm.prank(batcher, batcher);
        Multicall3.Result[] memory results = multicall.aggregate3{gas: SUPPLIED_GAS}(calls);
        for (uint256 i = 0; i < results.length; i++) {
            if (!results[i].success) _violate("a router refused a caller in a batch");
        }
    }

    /// @dev The outside account that makes the call for a message. Any account may, so the choice follows the message.
    function _callerFor(uint256 messageId) private view returns (address) {
        return callers[messageId % callers.length];
    }

    function _routerCall(Item memory item, MockAMB bridge) private view returns (Multicall3.Call3 memory) {
        Message storage message = _messages[item.messageId];
        DeliveryRouter router = DeliveryRouter(payable(item.executor));
        MessageBridge.MessageProof memory proof = bridge.proofOf(bridgeOf(message.sourceChain), message.index);
        return Multicall3.Call3(item.executor, true, abi.encodeCall(router.executeMessage, (proof)));
    }

    /// @dev Counts the executions that the logs of the destination bridge show, and the events of the mediator.
    function _readLogs(Vm.Log[] memory logs, uint256 destination) private {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(bridgeOf(destination)) && logs[i].topics[0] == COMPLETED_TOPIC) {
                bytes32 id = logs[i].topics[3];
                executions[id]++;
                if (executions[id] > 1) _violate("a message executed twice");
                if (!abi.decode(logs[i].data, (bool))) {
                    failedDeliveries++;
                    _violate("the call of a delivery failed");
                }
            }
            if (
                logs[i].topics[0] == DeliveryRouter.DeliveryFailed.selector
                    && _isDeliveryRouter(logs[i].emitter, destination)
            ) {
                DeliveryRouter.Reason cause = abi.decode(_dataAfterAmount(logs[i].data), (DeliveryRouter.Reason));
                if (cause == DeliveryRouter.Reason.PayoutRefused) payoutsRefused++;
                if (cause == DeliveryRouter.Reason.InvalidTerms) termsForfeited++;
                if (cause == DeliveryRouter.Reason.Reentered) reenteredHandOffs++;
            }
            if (logs[i].topics[0] == DeliveryRouter.HandOffRefused.selector && _isDeliveryRouter(logs[i].emitter, destination)) {
                _recordRefusal(logs[i]);
            }
            if (logs[i].emitter != address(mediatorOf(destination))) continue;
            bytes32 topic = logs[i].topics[0];
            if (topic == TokenMediator.ReleaseFailed.selector) {
                releasesFailed++;
                stuckOf[address(uint160(uint256(logs[i].topics[1])))] += abi.decode(logs[i].data, (uint256));
            }
            if (topic == TokenMediator.CallbackFailed.selector) callbacksFailed++;
        }
    }

    /// @dev Counts a hand-off that the token refused as held by the router. Only the deny list token refuses the failed
    /// delivery address, and only while that address is denied, so any other refusal is a violation.
    function _recordRefusal(Vm.Log memory log) private {
        address token = address(uint160(uint256(log.topics[1])));
        bool tokenRefuses = token == address(denyToken) && denyToken.denied(failedSink);
        if (!tokenRefuses) _violate("a router reported a refusal by a token that accepts the failed delivery address");
        expectedInRouter[log.emitter][token] += abi.decode(log.data, (uint256));
    }

    /// @dev The data of a `DeliveryFailed` log is the amount and then the cause. Returns the cause word alone.
    function _dataAfterAmount(bytes memory data) private pure returns (bytes memory cause) {
        cause = new bytes(32);
        for (uint256 i = 0; i < 32; i++) {
            cause[i] = data[32 + i];
        }
    }

    function _isOutOfOrder(uint256 id) private view returns (bool) {
        for (uint256 i = 0; i < _pending.length; i++) {
            if (_pending[i] == id) return false;
            if (_messages[_pending[i]].sourceChain == _messages[id].sourceChain) return true;
        }
        return false;
    }

    /// @dev Takes the message out of the list of messages that wait, and out of the value in flight.
    function _finish(Item memory item) private {
        Message storage message = _messages[item.messageId];
        if (message.delivered) return;
        message.delivered = true;
        inFlight[item.reading.nativeToken] -= item.reading.value;
        for (uint256 i = 0; i < _pending.length; i++) {
            if (_pending[i] != item.messageId) continue;
            _pending[i] = _pending[_pending.length - 1];
            _pending.pop();
            return;
        }
    }

    function _probe(uint256 universe) private view returns (Probe memory probe) {
        probe.held = heldByHolders(universe);
        probe.stuck = stuckOf[tokenAt(universe)];
        for (uint256 j = 0; j < 3; j++) {
            probe.rewardHeld[j] = holding(universe, rewards[j]);
        }
    }

    // -------------------------------------------------------------------------------------------------- checks

    /// @dev The delivered value is split between the holders and the failed releases, with nothing left over: the recipient, the
    /// tip and the hand-off add up to the released value.
    function _checkMoney(uint256 u, Probe memory before, uint256 value) private {
        Probe memory after_ = _probe(u);
        uint256 paid = (after_.held - before.held) + (after_.stuck - before.stuck);
        if (paid != value) _violate("recipient plus tip plus hand-off is not the released value");
    }

    /// @dev A reward address gains only from a message that a router executed when the message names that router, and
    /// never more than the cap that the terms of the message allow.
    function _checkTips(uint256 u, Probe memory before, Item[] memory items) private {
        for (uint256 j = 0; j < 3; j++) {
            uint256 gained = holding(u, rewards[j]) - before.rewardHeld[j];
            uint256 allowed;
            for (uint256 i = 0; i < items.length; i++) {
                if (items[i].universe != u) continue;
                allowed += _tipCap(items[i], j);
            }
            if (gained > allowed) _violate("a reward address gained more than the terms allow");
            if (gained > 0) tipsPaid++;
        }
        for (uint256 i = 0; i < callers.length; i++) {
            if (holding(u, callers[i]) != 0) _violate("a caller received tokens");
        }
        if (holding(u, stranger) != 0) _violate("a stranger received tokens");
    }

    /// @dev The most that reward address `j` may gain from one item: zero unless the item names a router with reward `j`
    /// and the same router executes it. The cap follows the terms of the sender: the fixed fee, the share of the value, or
    /// the smaller of the limit and the gas bound (the supplied gas plus the overhead, since the router measures from its entry); and never more than the value.
    function _tipCap(Item memory item, uint256 j) private view returns (uint256) {
        if (item.executor == address(0) || item.executor != item.reading.recipient) return 0;
        if (item.executor != address(deliveryRouterAt(chainOfToken(item.universe), j))) return 0;
        if (item.reading.callData.length != 160) return 0;
        DeliveryRouter.FeeDirector memory director = abi.decode(item.reading.callData, (DeliveryRouter.FeeDirector));
        return _directorCap(director, item.reading.value);
    }

    function _directorCap(DeliveryRouter.FeeDirector memory director, uint256 net) private view returns (uint256 cap) {
        if (director.settings & 1 != 0) return director.limit < net ? director.limit : net;
        if (director.settings & 8 != 0) {
            cap = net * director.multiplier / 1 ether;
            return cap < net ? cap : net;
        }
        uint256 price = director.settings & 4 != 0 ? block.basefee : tx.gasprice;
        cap = (SUPPLIED_GAS + GAS_OVERHEAD_BOUND) * director.multiplier * price / 1 ether;
        if (cap > director.limit) cap = director.limit;
        if (cap > net) cap = net;
    }

    /// @dev The transfers of a token payout: the payee receives exactly one transfer and a reward address at most one, as
    /// the router pays in the callback with no second transfer. Counts the `Transfer` events of the token in the logs.
    /// Applies to a delivery router with terms and a token payout (a native payout is a coin call, not a transfer).
    /// For a batch it bounds the payee by the number of items that name it. For one message it is exact, unless the
    /// payee is the failed delivery address, whose push the token may refuse and record instead.
    function _checkTransferCounts(Item[] memory items, Vm.Log[] memory logs) private {
        for (uint256 i = 0; i < items.length; i++) {
            if (!_isTokenPayoutByARouter(items[i])) continue;
            payeeTransferChecks++;
            address token = tokenAt(items[i].universe);
            uint256 sharing;
            uint256 rewardsOfTheToken;
            for (uint256 k = 0; k < items.length; k++) {
                bool sameToken = items[k].universe == items[i].universe;
                if (sameToken && items[k].payee == items[i].payee && _isTokenPayoutByARouter(items[k])) sharing++;
            }
            for (uint256 j = 0; j < rewards.length; j++) {
                rewardsOfTheToken += _transfersFromTo(logs, token, items[i].reading.recipient, rewards[j]);
            }
            uint256 received = _transfersFromTo(logs, token, items[i].reading.recipient, items[i].payee);
            if (received > sharing) _violate("a payee received more than one transfer for one delivery");
            if (rewardsOfTheToken > items.length) {
                _violate("a reward address received more than one transfer for one delivery");
            }
            if (items.length == 1) _checkExactTransfers(items[0], received, rewardsOfTheToken);
        }
    }

    /// @dev One message: the payee received one transfer when it received value, and the reward address one transfer
    /// when it was paid.
    function _checkExactTransfers(Item memory item, uint256 received, uint256 rewardTransfers) private {
        uint256 got = standing(item.universe, item.payee) - item.payeeBefore;
        if (item.payee != failedSink) {
            if (got > 0 && received != 1) _violate("the payee did not receive exactly one transfer");
            if (got == 0 && received != 0) _violate("the payee received a transfer of nothing");
        }
        exactTransferChecks++;
        if (rewardTransfers > 1) _violate("a reward address received more than one transfer");
    }

    /// @dev A message with terms to a delivery router, paid in the token and not in the coin.
    function _isTokenPayoutByARouter(Item memory item) private view returns (bool) {
        if (item.reading.callData.length != 160) return false;
        if (!_isDeliveryRouter(item.reading.recipient, chainOfToken(item.universe))) return false;
        DeliveryRouter.FeeDirector memory director = abi.decode(item.reading.callData, (DeliveryRouter.FeeDirector));
        return !(director.settings & 2 != 0 && isWrappedNativeOfItsChain(item.universe));
    }

    /// @dev The number of `Transfer` events of `token` in the logs that go from `from` to `to`. A router pays with one
    /// transfer from itself, so the count leaves out the direct mints and unlocks of other messages in the same batch.
    function _transfersFromTo(Vm.Log[] memory logs, address token, address from, address to)
        private
        pure
        returns (uint256 count)
    {
        for (uint256 i = 0; i < logs.length; i++) {
            bool isTransfer = logs[i].emitter == token && logs[i].topics.length == 3 && logs[i].topics[0] == TRANSFER_TOPIC;
            if (!isTransfer) continue;
            bool matches = address(uint160(uint256(logs[i].topics[1]))) == from
                && address(uint160(uint256(logs[i].topics[2]))) == to;
            if (matches) count++;
        }
    }

    /// @dev The exact checks of one message. A message that its own router executes pays exactly the fixed fee or the
    /// share, unless the reward address refuses the coin. The payee receives the rest. A message that no router
    /// attributes pays no tip, and its payee gets the whole value.
    function _checkSingle(Item memory item, Probe memory before) private {
        uint256 net = item.reading.value;
        uint256 destination = chainOfToken(item.universe);
        uint256 tip;
        for (uint256 j = 0; j < 3; j++) {
            tip += holding(item.universe, rewards[j]) - before.rewardHeld[j];
        }
        uint256 got = standing(item.universe, item.payee) - item.payeeBefore;
        bool legacyToRouter =
            item.reading.callData.length == 20 && _isDeliveryRouter(item.reading.recipient, destination);
        if (legacyToRouter && !isWrappedNativeOfItsChain(item.universe)) legacyTokenPayouts++;
        if (item.reading.callData.length == 160 && _isDeliveryRouter(item.reading.recipient, destination)) {
            bool attributed = item.executor == item.reading.recipient;
            bool invalid = _isInvalid(
                abi.decode(item.reading.callData, (DeliveryRouter.FeeDirector)).recipient, item.reading.recipient
            );
            if (invalid && !attributed && tip != 0) _violate("a direct delivery paid a tip");
            if (invalid && attributed && tip != 0) tippedInvalidTerms++;
            if (attributed && !invalid) routedDeliveries++;
            if (attributed) _checkAttributed(item, net, tip);
        } else if (tip != 0) {
            _violate("a message with no fee terms paid a tip");
        }
        bool paysPayee = item.payee != item.reading.recipient;
        if (item.payee == item.reading.recipient) return;
        if (paysPayee && got != net - tip) _violate("the payee did not receive the value less the tip");
    }

    function _checkAttributed(Item memory item, uint256 net, uint256 tip) private {
        DeliveryRouter.FeeDirector memory director = abi.decode(item.reading.callData, (DeliveryRouter.FeeDirector));
        uint256 rewardIndex = _rewardIndexOf(item);
        bool payoutNative = director.settings & 2 != 0 && isWrappedNativeOfItsChain(item.universe);
        bool rewardAccepts = !payoutNative || rewardIndex == 0;
        if (payoutNative) nativePayouts++;
        uint256 cap = _directorCap(director, net);
        if (!rewardAccepts && tip != 0) _violate("a reward address that refuses the coin was paid");
        if (tip > cap) _violate("the tip passed the cap");
        if (rewardAccepts && director.settings & 9 != 0 && tip != cap) {
            _violate("a fixed fee or a share was not paid in full");
        }
    }

    /// @dev Whether terms that name `recipient` under `router` are invalid: nobody can be paid.
    function _isInvalid(address recipient, address router) private pure returns (bool) {
        return recipient == address(0) || recipient == router;
    }

    function _isDeliveryRouter(address account, uint256 chain) private view returns (bool) {
        for (uint256 k = 0; k < ROUTERS_PER_CHAIN; k++) {
            if (account == address(deliveryRouterAt(chain, k))) return true;
        }
        return false;
    }

    function _rewardIndexOf(Item memory item) private view returns (uint256) {
        for (uint256 k = 0; k < ROUTERS_PER_CHAIN; k++) {
            if (item.executor == address(deliveryRouterAt(chainOfToken(item.universe), k))) return k;
        }
        revert("RouterHandler: not a delivery router");
    }

    // ------------------------------------------------------------------------------------------------- attacks

    /// @dev A call of `onTokenBridged` from a stranger. Both routers accept the callback of their mediator only.
    function _attackCallback(address router) private {
        bytes memory callData = abi.encodeWithSignature("onTokenBridged(address,uint256,bytes)", tokenAt(1), 1, "");
        vm.prank(stranger, stranger);
        (bool ok,) = router.call(callData);
        if (ok) _violate("a stranger called the callback of a router");
        if (!ok) attacksRefused++;
    }

    /// @dev A transfer of the coin to a router. A router takes the coin from the wrapped token only.
    function _attackCoinEntry(address router) private {
        _dealCoin(attacker, 1);
        vm.prank(attacker, attacker);
        (bool ok,) = router.call{value: 1}("");
        if (ok) _violate("a stranger sent the coin to a router");
        if (!ok) attacksRefused++;
    }

    function _executionTotal() private view returns (uint256 total) {
        for (uint256 i = 0; i < _messages.length; i++) {
            total += executions[_messages[i].bridgeMessageId];
        }
    }

    function _violate(string memory reason) internal {
        violations++;
        if (bytes(firstViolation).length == 0) firstViolation = reason;
    }
}

interface IMintable {
    function mint(address to, uint256 amount) external;
}

interface IERC20Transfer {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}
