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
/// relay natives and copies, messages arrive late and out of order, accounts claim, the fee is set, the fees are
/// collected, and an attacker forges messages.
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
    address public immutable treasury;
    address public immutable authority;
    DenyListToken public immutable denyToken;
    address public immutable attacker = address(0xBAD);

    /// @dev The native tokens, and the side that each one is native to.
    address[] internal _natives;
    Direction[] internal _homeDirection;
    address[] public actors;
    Pending[] internal _pending;

    uint256 public pendingCount;
    uint256 public failedDeliveries;
    uint256 public relaysFromNative;
    uint256 public relaysFromCopy;
    uint256 public deliveredReleases;
    uint256 public claimsPaid;
    uint256 public claimAttemptsRefused;
    uint256 public feesCollectedTotal;
    uint256 public feeRaisesAccepted;
    uint256 public feeRaisesRefused;
    uint256 public outOfOrderDeliveries;
    uint256 public forgedAttempts;
    uint256 public forgedSuccesses;
    uint256 public forgedChanges;
    uint256 public feeCeilingBreaches;
    uint256 public feeSwitchViolations;
    uint256 public chargedFeeCount;

    constructor(
        MockAMB ambA_,
        MockAMB ambB_,
        TokenMediator mediatorA_,
        TokenMediator mediatorB_,
        address treasury_,
        address authority_
    ) {
        ambA = ambA_;
        ambB = ambB_;
        mediatorA = mediatorA_;
        mediatorB = mediatorB_;
        treasury = treasury_;
        authority = authority_;
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

    /// @notice Pays what a failed release left for an account. The call may fail while the token still refuses.
    function claim(uint8 tokenSeed, uint8 actorSeed) external {
        uint256 index = tokenSeed % _natives.length;
        address account = _actor(actorSeed);
        TokenMediator mediator = homeMediator(index);
        address token = _natives[index];
        uint256 amount = mediator.claimable(token, account);
        if (amount == 0) return;
        try mediator.claim(token, account) {
            claimsPaid += amount;
        } catch {
            claimAttemptsRefused++;
        }
    }

    /// @notice Sends the accrued fees of a native token or a copy to the recipient.
    function collectFees(uint8 tokenSeed, uint8 sideSeed) external {
        uint256 index = tokenSeed % _natives.length;
        bool onHomeSide = sideSeed % 2 == 0;
        TokenMediator mediator = onHomeSide ? homeMediator(index) : awayMediator(index);
        address token = onHomeSide ? _natives[index] : copyOf(index);
        if (token == address(0)) return;
        uint256 accrued = mediator.accruedFees(token);
        if (accrued == 0) return;
        uint256 before = IERC20(token).balanceOf(treasury);
        mediator.collectFees(token);
        // A fee on transfer token takes its own share, so the treasury receives at most the accrued amount.
        assertLe(IERC20(token).balanceOf(treasury) - before, accrued, "the treasury received more than accrued");
        feesCollectedTotal += accrued;
    }

    /// @notice The fee authority tries to set the fee. A value above the ceiling must revert, and one within it must not.
    /// The rate is a count of steps of 0.01% (1e14), so the fuzzed values land around the ceiling of 1% (1e16).
    function setFee(uint8 sideSeed, uint16 rateSteps) external {
        TokenMediator mediator = sideSeed % 2 == 0 ? mediatorA : mediatorB;
        uint256 rate = uint256(rateSteps) * 1e14;
        bool withinCeiling = rate <= mediator.feeCeiling();
        vm.prank(authority);
        try mediator.setFee(rate, treasury) {
            if (!withinCeiling) feeSwitchViolations++;
            if (withinCeiling) feeRaisesAccepted++;
        } catch {
            if (withinCeiling) feeSwitchViolations++;
            if (!withinCeiling) feeRaisesRefused++;
        }
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

    /// @dev Relays with the plain form or with an explicit fallback, by the seed. It records the fee that the relay
    /// charged and checks it against the ceiling. It queues the message.
    function _relay(
        TokenMediator mediator,
        address token,
        address sender,
        uint256 amount,
        uint8 receiverSeed,
        Direction direction
    ) private {
        address receiver = _actor(receiverSeed);
        address fallbackRecipient = _actor(receiverSeed >> 2);
        MockAMB bridge = direction == Direction.AtoB ? ambA : ambB;
        uint256 feesBefore = mediator.accruedFees(token);
        uint256 balanceBefore = IERC20(token).balanceOf(address(mediator));
        vm.startPrank(sender);
        IERC20(token).approve(address(mediator), amount);
        if (receiverSeed % 2 == 0) mediator.relayTokens(token, receiver, amount);
        if (receiverSeed % 2 == 1) mediator.relayTokensWithFallback(token, receiver, amount, "", fallbackRecipient);
        vm.stopPrank();
        _checkFee(mediator, token, balanceBefore, feesBefore);
        _pending.push(Pending(direction, bridge.sentCount() - 1, false));
        pendingCount++;
    }

    /// @dev The fee charged by one relay is the growth of `accruedFees`. The amount that the fee applies to is the
    /// growth of the balance of the mediator for a native token. For a copy, the balance grows by the fee only, and the
    /// relayed amount is the fee plus the burned net amount, so the check uses the supply that fell.
    function _checkFee(TokenMediator mediator, address token, uint256 balanceBefore, uint256 feesBefore) private {
        uint256 fee = mediator.accruedFees(token) - feesBefore;
        if (fee == 0) return;
        chargedFeeCount++;
        uint256 received = _receivedAmount(mediator, token, balanceBefore, fee);
        uint256 ceiling = mediator.feeCeiling();
        if (fee * mediator.FEE_DENOMINATOR() > received * ceiling) feeCeilingBreaches++;
    }

    /// @dev The amount that a relay put into the mediator, before the fee. A native token stays in the balance. A copy
    /// is burned, except for the fee, so the amount is the burn plus the fee, which the mediator logs as the net value.
    function _receivedAmount(TokenMediator mediator, address token, uint256 balanceBefore, uint256 fee)
        private
        view
        returns (uint256)
    {
        if (mediator.nativeTokenAddress(token) == address(0)) {
            return IERC20(token).balanceOf(address(mediator)) - balanceBefore;
        }
        // A copy: the sender gave `value`, the mediator burned `value - fee`. The last message holds the net value.
        MockAMB bridge = mediator == mediatorA ? ambA : ambB;
        bytes memory data = bridge.messageAt(bridge.sentCount() - 1).data;
        uint256 net = _netValueOf(data);
        return net + fee;
    }

    /// @dev Reads the value of a release message: the third argument of every `handleNative...` call.
    function _netValueOf(bytes memory data) private pure returns (uint256 value) {
        assembly {
            value := mload(add(data, 100))
        }
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
        bool ok;
        if (message.direction == Direction.AtoB) (ok,) = ambB.deliver(ambA, message.index);
        if (message.direction == Direction.BtoA) (ok,) = ambA.deliver(ambB, message.index);
        if (!ok) failedDeliveries++;
        if (ok && _isRelease(message)) deliveredReleases++;
    }

    function _isRelease(Pending storage message) private view returns (bool) {
        bytes memory data = message.direction == Direction.AtoB
            ? ambA.messageAt(message.index).data
            : ambB.messageAt(message.index).data;
        bytes4 selector;
        assembly {
            selector := mload(add(data, 0x20))
        }
        return selector == TokenMediator.handleNativeTokens.selector
            || selector == TokenMediator.handleNativeTokensWithFallback.selector;
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
    /// attacker, the records, the claims of the attacker, the supply of the copies, and the registry of the copies.
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
                    homeMediator(i).claimable(token, attacker),
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
contract TokenMediatorInvariantTest is StdInvariant, MediatorFixture {
    MediatorHandler internal handler;
    address internal authority = makeAddr("authority");
    address internal treasury = makeAddr("treasury");

    function setUp() public override {
        TokenMediator.MediatorTerms memory termsA = _noTerms();
        termsA.feeAuthority = authority;
        termsA.feeRecipient = treasury;
        termsA.feeRate = 100e14;
        termsA.feeCeiling = 100e14;
        TokenMediator.MediatorTerms memory termsB = _noTerms();
        termsB.feeAuthority = authority;
        termsB.feeRecipient = treasury;
        termsB.feeRate = 50e14;
        termsB.feeCeiling = 80e14;
        _deployMediators(termsA, termsB);
        handler = new MediatorHandler(ambA, ambB, mediatorA, mediatorB, treasury, authority);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](12);
        selectors[0] = MediatorHandler.relayNativeAndDeliver.selector;
        selectors[1] = MediatorHandler.relayNativeDeferred.selector;
        selectors[2] = MediatorHandler.relayCopyAndDeliver.selector;
        selectors[3] = MediatorHandler.relayCopyDeferred.selector;
        selectors[4] = MediatorHandler.deliverPending.selector;
        selectors[5] = MediatorHandler.deliverNewestPending.selector;
        selectors[6] = MediatorHandler.claim.selector;
        selectors[7] = MediatorHandler.collectFees.selector;
        selectors[8] = MediatorHandler.setFee.selector;
        selectors[9] = MediatorHandler.toggleDeny.selector;
        selectors[10] = MediatorHandler.forge.selector;
        // Deliveries are the most useful action, so the list names it twice.
        selectors[11] = MediatorHandler.deliverPending.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Claim: for each native token the mediator holds at least what it owes plus the fees. Shows: after every call
    /// sequence, balance >= record + accrued fees, and the record covers every amount that waits in `claimable`. The
    /// fees of a copy are held as copies, so the copy balance of the mediator covers them. Matters: the record
    /// already counts the claimable amounts (a refused release returns to it), so the claims are not added a
    /// second time. Honest limit: the balance of a token that charges a fee on transfer is the real balance.
    function invariant_balanceCoversTheRecordAndTheFees() public view {
        for (uint256 i = 0; i < handler.nativeCount(); i++) {
            address token = handler.nativeAt(i);
            TokenMediator home = handler.homeMediator(i);
            uint256 record = home.mediatorBalance(token);
            assertGe(IERC20(token).balanceOf(address(home)), record + home.accruedFees(token), "native balance");

            assertGe(record, _claimsOnToken(i), "the record covers the claims");

            address copy = handler.copyOf(i);
            if (copy == address(0)) continue;
            TokenMediator away = handler.awayMediator(i);
            assertGe(IERC20(copy).balanceOf(address(away)), away.accruedFees(copy), "copy fees are held");
        }
    }

    /// Claim: the copies and the claims never exceed the record, and together they equal it when no message is in
    /// flight. Shows: supply of the copy + claims <= record always; supply + claims == record at rest; a native token
    /// with no copy has an empty record at rest. Matters: a copy without a locked token behind it is a claim on
    /// nothing. The claims are part of the sum because a release that the token refused burned its copies on the other
    /// chain and stays in the record, owed to the fallback.
    function invariant_theCopiesAndTheClaimsEqualTheRecordWhenNothingIsInFlight() public view {
        for (uint256 i = 0; i < handler.nativeCount(); i++) {
            address token = handler.nativeAt(i);
            uint256 record = handler.homeMediator(i).mediatorBalance(token);
            address copy = handler.copyOf(i);
            uint256 backed = (copy == address(0) ? 0 : IERC20(copy).totalSupply()) + _claimsOnToken(i);
            assertLe(backed, record, "the copies and the claims exceed the record");
            if (handler.pendingCount() != 0) continue;
            assertEq(backed, record, "at rest the copies and the claims equal the record");
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

    /// Claim: no fee passes the ceiling, and the fee switch obeys it. Shows: every charged fee is at most the ceiling
    /// share of the amount that it applies to; the live fee never exceeds the ceiling; `setFee` above the ceiling
    /// always reverts and within it never does. Matters: users read the worst case before they relay.
    function invariant_theFeeCeilingIsNeverExceeded() public view {
        assertEq(handler.feeCeilingBreaches(), 0);
        assertEq(handler.feeSwitchViolations(), 0);
        assertLe(mediatorA.feeRate(), mediatorA.feeCeiling());
        assertLe(mediatorB.feeRate(), mediatorB.feeCeiling());
    }

    /// Claim: the handler reaches the paying paths. Shows: after a fixed sequence, a native token is locked, its copy
    /// is minted and returned and released, fees accrue and are collected, a release to a denied account is claimed,
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

        // The way back, with a fee on chain B.
        handler.relayCopyAndDeliver(0, 1, 50 ether, 3);
        assertEq(handler.deliveredReleases(), 1, "a release paid");
        assertEq(handler.failedDeliveries(), 0);
        assertGt(mediatorA.accruedFees(handler.nativeAt(0)), 0, "fees accrue on chain A");
        assertGt(mediatorB.accruedFees(copy), 0, "fees accrue on chain B");
        assertGt(handler.chargedFeeCount(), 0);

        // The fee on transfer token and the token on chain B.
        handler.relayNativeAndDeliver(1, 2, 70 ether, 0);
        handler.relayNativeAndDeliver(3, 3, 60 ether, 0);
        assertTrue(handler.copyOf(1) != address(0));
        assertTrue(handler.copyOf(3) != address(0));

        // A release to a denied account goes to the fallback, and to a claim when both are denied.
        handler.relayNativeAndDeliver(2, 0, 80 ether, 0);
        handler.toggleDeny(1);
        handler.toggleDeny(2);
        // Seed 9: the receiver is actor 1, and the explicit fallback is actor 2. Both are denied.
        handler.relayCopyAndDeliver(2, 0, 10 ether, 9);
        assertGt(_claimsOnToken(2), 0, "a release is held for a claim");
        handler.toggleDeny(1);
        handler.toggleDeny(2);
        handler.claim(2, 1);
        handler.claim(2, 2);
        assertGt(handler.claimsPaid(), 0, "a claim paid");

        handler.collectFees(0, 0);
        handler.collectFees(0, 1);
        assertGt(handler.feesCollectedTotal(), 0, "fees were collected");
        handler.setFee(0, 40);
        handler.setFee(0, 101);
        assertEq(handler.feeRaisesAccepted(), 1);
        assertEq(handler.feeRaisesRefused(), 1);

        handler.forge(0, 0, 0, 5 ether, 0);
        handler.forge(1, 1, 1, 5 ether, 1);
        handler.forge(2, 0, 3, 5 ether, 2);
        assertEq(handler.forgedAttempts(), 3);
        assertEq(handler.forgedSuccesses(), 0);
        assertEq(handler.forgedChanges(), 0);
        assertEq(handler.feeCeilingBreaches(), 0);
    }

    function _claimsOnToken(uint256 index) internal view returns (uint256 total) {
        address token = handler.nativeAt(index);
        for (uint256 j = 0; j < handler.actorCount(); j++) {
            total += handler.homeMediator(index).claimable(token, handler.actors(j));
        }
    }
}
