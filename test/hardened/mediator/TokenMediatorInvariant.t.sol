// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {FeeOnTransferToken} from "../../../src/mocks/FeeOnTransferToken.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {MediatorFixture, MockAMB, DenyListToken} from "./utils/MediatorSupport.sol";

/// @dev The three kinds of native token share this call.
interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice Drives two mediators joined by two mock bridges. Four kinds of native token live on the two chains: a plain
/// token and a fee on transfer token and a token with a deny list on chain A, and a plain token on chain B. Senders
/// relay natives and copies, messages arrive late and out of order, anyone donates tokens by a plain
/// transfer, and an attacker forges messages.
/// @dev What this handler claims. Every message that it sends is delivered at most once, by the mock bridge, with the
/// context that the real bridge would set. The mock does not read a proof, so the handler does not show that the
/// message bridge refuses a forged proof. It shows that the mediators refuse a forged context: a wrong sender, a wrong
/// source chain and a direct call. A delivery that fails is counted, and the invariants require zero.
contract MediatorHandler is Test {
    /// @dev Where a message goes. The sender's chain is the other one.
    enum Direction {
        AtoB,
        BtoA
    }

    /// @dev Whether an action delivers the message that it sends.
    enum Timing {
        DeliverNow,
        Defer
    }

    struct Pending {
        Direction direction;
        uint256 index;
        bool delivered;
    }

    uint256 internal constant MAXIMUM_AMOUNT = 1_000 ether;
    uint256 internal constant ACTOR_COUNT = 4;

    MockAMB public immutable ambA;
    MockAMB public immutable ambB;
    TokenMediator public immutable mediatorA;
    TokenMediator public immutable mediatorB;
    DenyListToken public immutable denyToken;
    address public immutable attacker = address(0xBAD);

    /// @dev The native tokens, and the side that each one is native to.
    address[] internal _natives;
    Direction[] internal _homeDirection;
    address[] public actors;
    Pending[] internal _pending;
    /// @dev For each native token, the tokens that arrived at the home mediator by a plain transfer.
    mapping(uint256 index => uint256) public donated;
    /// @dev For each native token, the value of the messages that are sent and not yet delivered.
    mapping(uint256 index => uint256) public inFlight;
    /// @dev For each native token, the value of releases that failed: it stays in the home mediator, owed to nobody.
    mapping(uint256 index => uint256) public stuck;

    uint256 public pendingCount;
    uint256 public failedDeliveries;
    uint256 public relaysFromNative;
    uint256 public relaysFromCopy;
    uint256 public deliveredReleases;
    uint256 public failedReleases;
    uint256 public donatedCount;
    uint256 public outOfOrderDeliveries;
    uint256 public forgedAttempts;
    uint256 public forgedSuccesses;
    uint256 public forgedChanges;
    uint256 public relayValueMismatches;

    constructor(MockAMB ambA_, MockAMB ambB_, TokenMediator mediatorA_, TokenMediator mediatorB_) {
        ambA = ambA_;
        ambB = ambB_;
        mediatorA = mediatorA_;
        mediatorB = mediatorB_;
        denyToken = new DenyListToken();
        _addNative(address(new MockERC20("Plain A", "PLA")), Direction.AtoB);
        _addNative(address(new FeeOnTransferToken("Taxed A", "TXA")), Direction.AtoB);
        _addNative(address(denyToken), Direction.AtoB);
        _addNative(address(new MockERC20("Plain B", "PLB")), Direction.BtoA);
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            actors.push(address(uint160(0x1000 + i)));
        }
    }

    // ---------------------------------------------------------------------------------------------------- views

    function nativeCount() external view returns (uint256) {
        return _natives.length;
    }

    function nativeAt(uint256 index) external view returns (address) {
        return _natives[index];
    }

    /// @notice The mediator on the chain that the token is native to.
    function homeMediator(uint256 index) public view returns (TokenMediator) {
        return _homeDirection[index] == Direction.AtoB ? mediatorA : mediatorB;
    }

    /// @notice The mediator on the other chain, which holds the copy.
    function awayMediator(uint256 index) public view returns (TokenMediator) {
        return _homeDirection[index] == Direction.AtoB ? mediatorB : mediatorA;
    }

    /// @notice The bridged copy of a native token, or zero before the first delivery.
    function copyOf(uint256 index) public view returns (address) {
        return awayMediator(index).bridgedTokenAddress(_natives[index]);
    }

    function actorCount() external pure returns (uint256) {
        return ACTOR_COUNT;
    }

    // -------------------------------------------------------------------------------------------------- actions

    function relayNativeAndDeliver(uint8 tokenSeed, uint8 actorSeed, uint96 amountSeed, uint8 receiverSeed) external {
        _relayNative(tokenSeed, actorSeed, amountSeed, receiverSeed, Timing.DeliverNow);
    }

    function relayNativeDeferred(uint8 tokenSeed, uint8 actorSeed, uint96 amountSeed, uint8 receiverSeed) external {
        _relayNative(tokenSeed, actorSeed, amountSeed, receiverSeed, Timing.Defer);
    }

    function relayCopyAndDeliver(uint8 tokenSeed, uint8 actorSeed, uint96 amountSeed, uint8 receiverSeed) external {
        _relayCopy(tokenSeed, actorSeed, amountSeed, receiverSeed, Timing.DeliverNow);
    }

    function relayCopyDeferred(uint8 tokenSeed, uint8 actorSeed, uint96 amountSeed, uint8 receiverSeed) external {
        _relayCopy(tokenSeed, actorSeed, amountSeed, receiverSeed, Timing.Defer);
    }

    /// @notice Delivers a pending message chosen by the seed, so the order is random.
    function deliverPending(uint256 seed) external {
        if (pendingCount == 0) return;
        _deliver(_nthPending(seed % pendingCount));
    }

    /// @notice Delivers the newest pending message first, which is the opposite of the order of sending.
    function deliverNewestPending() external {
        if (pendingCount == 0) return;
        _deliver(_nthPending(pendingCount - 1));
    }

    /// @notice Sends tokens to the home mediator by a plain transfer, as a mistaken sender does. The record does not
    /// count them, and nothing pays them out.
    function donate(uint8 tokenSeed, uint96 amountSeed) external {
        uint256 index = tokenSeed % _natives.length;
        uint256 amount = bound(amountSeed, 1, MAXIMUM_AMOUNT);
        IMintable(_natives[index]).mint(address(homeMediator(index)), amount);
        donated[index] += amount;
        donatedCount++;
    }

    /// @notice Denies or allows an account on the token with a deny list, so that releases to it fail.
    function toggleDeny(uint8 actorSeed) external {
        address account = _actor(actorSeed);
        denyToken.setDenied(account, !denyToken.denied(account));
    }

    /// @notice Delivers a forged message to one mediator. Nothing may change. The forgery is a wrong sender, a wrong
    /// source chain, or a direct call from an account that is not the bridge.
    function forge(uint8 kindSeed, uint8 sideSeed, uint8 tokenSeed, uint96 amountSeed, uint256 entropy) external {
        bool toA = sideSeed % 2 == 0;
        TokenMediator target = toA ? mediatorA : mediatorB;
        bytes memory call = _forgedCall(kindSeed, _natives[tokenSeed % _natives.length], amountSeed);

        bytes32 before = _fingerprint();
        forgedAttempts++;
        if (_deliverForged(target, toA ? ambA : ambB, call, entropy)) forgedSuccesses++;
        if (_fingerprint() != before) forgedChanges++;
    }

    /// @dev Sends the forged call in one of three forms, chosen by the entropy. It returns whether the call succeeded.
    function _deliverForged(TokenMediator target, MockAMB bridge, bytes memory call, uint256 entropy)
        private
        returns (bool succeeded)
    {
        address remote = target.mediatorContractOnOtherSide();
        bytes32 remoteChain = bytes32(target.remoteChainId());
        uint256 form = entropy % 3;
        if (form == 0) {
            address sender = address(uint160(entropy >> 8) | 1);
            if (sender == remote) sender = address(target);
            (succeeded,) = bridge.execute(address(target), call, sender, remoteChain, bytes32(entropy), 1_500_000);
        }
        if (form == 1) {
            bytes32 chain = bytes32(entropy >> 8);
            if (chain == remoteChain) chain = bytes32(uint256(chain) + 1);
            (succeeded,) = bridge.execute(address(target), call, remote, chain, bytes32(entropy), 1_500_000);
        }
        if (form == 2) {
            vm.prank(attacker);
            (succeeded,) = address(target).call(call);
        }
    }

    // ----------------------------------------------------------------------------------------------- internals

    function _addNative(address token, Direction home) private {
        _natives.push(token);
        _homeDirection.push(home);
    }

    function _actor(uint8 seed) private view returns (address) {
        return actors[seed % ACTOR_COUNT];
    }

    function _relayNative(uint8 tokenSeed, uint8 actorSeed, uint96 amountSeed, uint8 receiverSeed, Timing timing)
        private
    {
        uint256 index = tokenSeed % _natives.length;
        address sender = _actor(actorSeed);
        address token = _natives[index];
        if (token == address(denyToken) && denyToken.denied(sender)) return;
        uint256 amount = bound(amountSeed, 1, MAXIMUM_AMOUNT);
        IMintable(token).mint(sender, amount);
        TokenMediator mediator = homeMediator(index);
        _relay(mediator, token, sender, amount, receiverSeed, _homeDirection[index]);
        relaysFromNative++;
        if (timing == Timing.DeliverNow) _deliver(_pending.length - 1);
    }

    function _relayCopy(uint8 tokenSeed, uint8 actorSeed, uint96 amountSeed, uint8 receiverSeed, Timing timing)
        private
    {
        uint256 index = tokenSeed % _natives.length;
        address copy = copyOf(index);
        if (copy == address(0)) return;
        address sender = _actor(actorSeed);
        uint256 held = IERC20(copy).balanceOf(sender);
        if (held == 0) return;
        uint256 amount = bound(amountSeed, 1, held);
        Direction awayDirection = _homeDirection[index] == Direction.AtoB ? Direction.BtoA : Direction.AtoB;
        _relay(awayMediator(index), copy, sender, amount, receiverSeed, awayDirection);
        relaysFromCopy++;
        if (timing == Timing.DeliverNow) _deliver(_pending.length - 1);
    }

    /// @dev The balance of the mediator and the supply of the token before a relay. A native token stays in the
    /// balance. A copy leaves the supply.
    struct Snapshot {
        uint256 balance;
        uint256 supply;
    }

    /// @dev Relays with the plain form or with the form that has a gas limit, by the seed. It checks that the message carries
    /// exactly the value that the mediator took in, and it queues the message.
    function _relay(
        TokenMediator mediator,
        address token,
        address sender,
        uint256 amount,
        uint8 receiverSeed,
        Direction direction
    ) private {
        MockAMB bridge = direction == Direction.AtoB ? ambA : ambB;
        Snapshot memory before = _snapshot(mediator, token);
        vm.startPrank(sender);
        IERC20(token).approve(address(mediator), amount);
        if (receiverSeed % 2 == 0) mediator.relayTokens(token, _actor(receiverSeed), amount);
        if (receiverSeed % 2 == 1) {
            mediator.relayTokens(token, _actor(receiverSeed), amount, uint256(receiverSeed) * 1_000);
        }
        vm.stopPrank();
        _recordSent(bridge, _movedIn(mediator, token, before));
        _pending.push(Pending(direction, bridge.sentCount() - 1, false));
        pendingCount++;
    }

    function _snapshot(TokenMediator mediator, address token) private view returns (Snapshot memory) {
        return Snapshot(IERC20(token).balanceOf(address(mediator)), IERC20(token).totalSupply());
    }

    /// @dev What a relay took in: the growth of the balance for a native token, the fall of the supply for a copy.
    function _movedIn(TokenMediator mediator, address token, Snapshot memory before) private view returns (uint256) {
        if (mediator.nativeTokenAddress(token) != address(0)) return before.supply - IERC20(token).totalSupply();
        return IERC20(token).balanceOf(address(mediator)) - before.balance;
    }

    /// @dev Counts a message whose value is not what the relay took in, and adds the value to the tokens in flight.
    function _recordSent(MockAMB bridge, uint256 movedIn) private {
        (address token, uint256 value) = _tokenAndValueOf(bridge.messageAt(bridge.sentCount() - 1).data);
        if (value != movedIn) relayValueMismatches++;
        inFlight[_nativeIndexOf(token)] += value;
    }

    function _nativeIndexOf(address token) private view returns (uint256) {
        for (uint256 i = 0; i < _natives.length; i++) {
            if (_natives[i] == token) return i;
        }
        revert("not a native token of the handler");
    }

    function _deliver(uint256 pendingIndex) private {
        Pending storage message = _pending[pendingIndex];
        if (message.delivered) return;
        for (uint256 i = 0; i < pendingIndex; i++) {
            Pending storage older = _pending[i];
            if (!older.delivered && older.direction == message.direction) {
                outOfOrderDeliveries++;
                break;
            }
        }
        message.delivered = true;
        pendingCount--;
        bytes memory data = (message.direction == Direction.AtoB ? ambA : ambB).messageAt(message.index).data;
        (address token, uint256 value) = _tokenAndValueOf(data);
        bool ok;
        bool isRelease = _isRelease(message);
        uint256 index = _nativeIndexOf(token);
        uint256 heldBefore = IERC20(token).balanceOf(address(homeMediator(index)));
        if (message.direction == Direction.AtoB) (ok,) = ambB.deliver(ambA, message.index);
        if (message.direction == Direction.BtoA) (ok,) = ambA.deliver(ambB, message.index);
        if (!ok) failedDeliveries++;
        if (!ok) return;
        inFlight[index] -= value;
        if (!isRelease) return;
        // A release that paid took exactly its value out of the home mediator. A failed one took nothing out.
        uint256 paidOut = heldBefore - IERC20(token).balanceOf(address(homeMediator(index)));
        if (paidOut == value) deliveredReleases++;
        if (paidOut != value) {
            failedReleases++;
            stuck[index] += value;
        }
    }

    /// @dev The token that a message names and the value that it delivers. The token, the recipient and the
    /// value come first in every release message. A deploying message has the name, the symbol and the decimals
    /// between the token and the recipient.
    function _tokenAndValueOf(bytes memory data) private pure returns (address token, uint256 value) {
        bytes memory arguments = new bytes(data.length - 4);
        for (uint256 i = 0; i < arguments.length; i++) {
            arguments[i] = data[i + 4];
        }
        if (_isDeploy(bytes4(data))) {
            (token,,,,, value) = abi.decode(arguments, (address, string, string, uint8, address, uint256));
            return (token, value);
        }
        (token,, value) = abi.decode(arguments, (address, address, uint256));
    }

    function _isDeploy(bytes4 selector) private pure returns (bool) {
        return selector == TokenMediator.deployAndHandleBridgedTokens.selector
            || selector == TokenMediator.deployAndHandleBridgedTokensAndCall.selector
            || selector == TokenMediator.deployAndHandleBridgedTokens.selector
            || selector == TokenMediator.deployAndHandleBridgedTokensAndCall.selector;
    }

    function _isRelease(Pending storage message) private view returns (bool) {
        bytes memory data = message.direction == Direction.AtoB
            ? ambA.messageAt(message.index).data
            : ambB.messageAt(message.index).data;
        bytes4 selector;
        assembly {
            selector := mload(add(data, 0x20))
        }
        return selector == TokenMediator.handleNativeTokens.selector;
    }

    /// @dev The position among the messages that are not delivered, counted in the order of sending.
    function _nthPending(uint256 n) private view returns (uint256) {
        uint256 seen;
        for (uint256 i = 0; i < _pending.length; i++) {
            if (_pending[i].delivered) continue;
            if (seen == n) return i;
            seen++;
        }
        revert("no such pending message");
    }

    function _forgedCall(uint8 kindSeed, address token, uint96 amountSeed) private view returns (bytes memory) {
        uint256 amount = bound(amountSeed, 1, MAXIMUM_AMOUNT);
        uint256 kind = kindSeed % 3;
        if (kind == 0) {
            return abi.encodeWithSelector(TokenMediator.handleNativeTokens.selector, token, attacker, amount);
        }
        if (kind == 1) {
            return abi.encodeWithSelector(TokenMediator.handleBridgedTokens.selector, token, attacker, amount);
        }
        return abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokens.selector, token, "Forged", "FRG", uint8(18), attacker, amount
        );
    }

    /// @dev One hash over everything that a forged message could change: the balances of the mediators and the
    /// attacker, the records, the supply of the copies, and the registry of the copies.
    function _fingerprint() public view returns (bytes32 digest) {
        digest = keccak256("fingerprint");
        for (uint256 i = 0; i < _natives.length; i++) {
            address token = _natives[i];
            address copy = copyOf(i);
            digest = keccak256(
                abi.encode(
                    digest,
                    IERC20(token).balanceOf(address(mediatorA)),
                    IERC20(token).balanceOf(address(mediatorB)),
                    IERC20(token).balanceOf(attacker),
                    homeMediator(i).mediatorBalance(token),
                    copy
                )
            );
            if (copy == address(0)) continue;
            digest = keccak256(
                abi.encode(
                    digest,
                    IERC20(copy).totalSupply(),
                    IERC20(copy).balanceOf(attacker),
                    IERC20(copy).balanceOf(address(mediatorA)),
                    IERC20(copy).balanceOf(address(mediatorB))
                )
            );
        }
    }
}

/// @notice Invariants of the two mediators. See `MediatorHandler` for what the handler claims.
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 100
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: deep.invariant.runs = 2000
/// forge-config: deep.invariant.depth = 100
/// forge-config: deep.invariant.fail-on-revert = true
contract TokenMediatorInvariantTest is StdInvariant, MediatorFixture {
    MediatorHandler internal handler;

    function setUp() public override {
        _deployMediators(_noTerms(), _noTerms());
        handler = new MediatorHandler(ambA, ambB, mediatorA, mediatorB);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = MediatorHandler.relayNativeAndDeliver.selector;
        selectors[1] = MediatorHandler.relayNativeDeferred.selector;
        selectors[2] = MediatorHandler.relayCopyAndDeliver.selector;
        selectors[3] = MediatorHandler.relayCopyDeferred.selector;
        selectors[4] = MediatorHandler.deliverPending.selector;
        selectors[5] = MediatorHandler.deliverNewestPending.selector;
        selectors[6] = MediatorHandler.donate.selector;
        selectors[7] = MediatorHandler.toggleDeny.selector;
        selectors[8] = MediatorHandler.forge.selector;
        // Deliveries are the most useful action, so the list names it twice.
        selectors[9] = MediatorHandler.deliverPending.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Claim: the home mediator holds exactly its record, plus the tokens of failed releases, plus the tokens that
    /// arrived by a plain transfer, and the away mediator holds no copy. Shows: after every call sequence, for each
    /// native token, balance == record + stuck + donations, and the copy balance of the away mediator is zero.
    /// Matters: the mediator takes no cut of a relay or of a release. A failed release leaves its tokens in the
    /// mediator, owed to nobody, and the record falls by them: the other chain burned the copies. Honest limit: for a
    /// token that charges a fee on transfer, the balance is the real balance, and the record counts what arrived.
    function invariant_theHomeBalanceIsTheRecordPlusStuckPlusDonations() public view {
        for (uint256 i = 0; i < handler.nativeCount(); i++) {
            address token = handler.nativeAt(i);
            TokenMediator home = handler.homeMediator(i);
            uint256 record = home.mediatorBalance(token);
            assertEq(
                IERC20(token).balanceOf(address(home)), record + handler.stuck(i) + handler.donated(i), "native balance"
            );

            address copy = handler.copyOf(i);
            if (copy == address(0)) continue;
            assertEq(IERC20(copy).balanceOf(address(handler.awayMediator(i))), 0, "no copy stays in the mediator");
        }
    }

    /// Claim: the record equals the copies plus the value in flight, at every moment, whether or not a release failed.
    /// Shows: for each native token, record == supply of the copy + the value of the messages that are sent and not
    /// delivered. A native token with no copy has only the value in flight. Matters: a copy without a locked token
    /// behind it is a claim on nothing, and a locked token without a copy or a message is lost. A failed release
    /// burned its copies on the other chain and lowered the record by the same value, so the sum holds.
    function invariant_theRecordIsTheCopiesPlusWhatIsInFlight() public view {
        for (uint256 i = 0; i < handler.nativeCount(); i++) {
            address token = handler.nativeAt(i);
            uint256 record = handler.homeMediator(i).mediatorBalance(token);
            address copy = handler.copyOf(i);
            uint256 supply = copy == address(0) ? 0 : IERC20(copy).totalSupply();
            assertEq(record, supply + handler.inFlight(i), "the record is not accounted for");
        }
    }

    /// Claim: no delivery fails. Shows: the handler delivers each message once with the gas that the sender asked
    /// for, and none reverts. Matters: a failed delivery loses tokens, because the bridge marks it delivered. This
    /// holds with fee on transfer tokens, a deny list, and messages in any order.
    function invariant_noDeliveryFails() public view {
        assertEq(handler.failedDeliveries(), 0);
    }

    /// Claim: a forged message never moves a token and never changes a record. Shows: zero successes and zero
    /// changes over every attempt, for a wrong sender, a wrong source chain and a direct call. Matters: only the
    /// mediator on the other chain, through the bridge, can release or mint.
    function invariant_forgedMessagesChangeNothing() public view {
        assertEq(handler.forgedSuccesses(), 0, "a forged message succeeded");
        assertEq(handler.forgedChanges(), 0, "a forged message changed the state");
    }

    /// Claim: a message carries exactly the value that its relay took in. Shows: over every relay, the value in the
    /// message equals the growth of the mediator balance for a native token, and the fall of the supply for a copy.
    /// Matters: the mediator keeps no share of a relay, so the bridged amount is the relayed amount.
    function invariant_everyMessageCarriesTheValueThatTheRelayTookIn() public view {
        assertEq(handler.relayValueMismatches(), 0, "a message carries another value than the relay took in");
    }

    /// Claim: the handler reaches the paying paths. Shows: after a fixed sequence, a native token is locked, its copy
    /// is minted and returned and released, a donation stays out of the record, a release to a denied account is claimed,
    /// messages arrive out of order, and forged messages are tried. Matters: an invariant over a handler that never acts
    /// proves nothing.
    function test_handlerReachesThePayingPaths() public {
        // Plain token 0: relay twice and deliver the second first, then the first.
        handler.relayNativeDeferred(0, 0, 100 ether, 1);
        handler.relayNativeDeferred(0, 1, 200 ether, 2);
        handler.deliverNewestPending();
        handler.deliverPending(0);
        assertEq(handler.pendingCount(), 0);
        assertEq(handler.outOfOrderDeliveries(), 1, "one message arrived before an older one");
        address copy = handler.copyOf(0);
        assertTrue(copy != address(0), "the copy exists");
        assertGt(IERC20(copy).totalSupply(), 0);

        // The way back.
        handler.relayCopyAndDeliver(0, 1, 50 ether, 3);
        assertEq(handler.deliveredReleases(), 1, "a release paid");
        assertEq(handler.failedDeliveries(), 0);
        assertEq(handler.relayValueMismatches(), 0);
        assertEq(handler.inFlight(0), 0, "nothing is in flight at rest");
        assertEq(mediatorA.mediatorBalance(handler.nativeAt(0)), 250 ether, "the release left the record");

        // The token that charges a fee on transfer and the token on chain B.
        handler.relayNativeAndDeliver(1, 2, 70 ether, 0);
        handler.relayNativeAndDeliver(3, 3, 60 ether, 0);
        assertTrue(handler.copyOf(1) != address(0));
        assertTrue(handler.copyOf(3) != address(0));

        // A release to a denied account is final: it fails, and the tokens stay in the mediator.
        handler.relayNativeAndDeliver(2, 0, 80 ether, 0);
        handler.toggleDeny(1);
        handler.toggleDeny(2);
        // Seed 9: the receiver is actor 1, who is denied.
        handler.relayCopyAndDeliver(2, 0, 10 ether, 9);
        assertEq(handler.failedReleases(), 1, "the release to a denied account failed");
        assertEq(handler.stuck(2), 10 ether, "its value stays in the mediator");
        assertEq(handler.failedDeliveries(), 0, "the handler did not revert");
        assertEq(
            mediatorA.mediatorBalance(handler.nativeAt(2)) + handler.stuck(2),
            IERC20(handler.nativeAt(2)).balanceOf(address(mediatorA)),
            "the balance is the record plus the stuck value"
        );
        handler.toggleDeny(1);
        handler.toggleDeny(2);

        handler.donate(0, 7 ether);
        assertEq(handler.donatedCount(), 1);
        assertEq(
            IERC20(handler.nativeAt(0)).balanceOf(address(mediatorA)),
            mediatorA.mediatorBalance(handler.nativeAt(0)) + handler.donated(0),
            "a donation stays out of the record"
        );
        handler.relayNativeAndDeliver(0, 0, 100 ether, 1);
        assertEq(handler.failedDeliveries(), 0);

        handler.forge(0, 0, 0, 5 ether, 0);
        handler.forge(1, 1, 1, 5 ether, 1);
        handler.forge(2, 0, 3, 5 ether, 2);
        assertEq(handler.forgedAttempts(), 3);
        assertEq(handler.forgedSuccesses(), 0);
        assertEq(handler.forgedChanges(), 0);
    }
}
