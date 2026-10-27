// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {BridgedToken} from "../../../src/hardened/mediator/BridgedToken.sol";
import {DeliveryRouter} from "../../../src/hardened/mediator/DeliveryRouter.sol";
import {TokenFactory} from "../../../src/hardened/mediator/TokenFactory.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {RouterHandler} from "./utils/RouterHandler.sol";

/// @notice Invariants of the two mediators, the delivery routers and the wrapped native router, under random sequences of
/// relays, deliveries by three paths, claims and attacks. See `RouterHandler` for the actions and
/// for what the handler claims, and `RouterWorld` for the two chains.
/// forge-config: default.invariant.runs = 8
/// forge-config: default.invariant.depth = 40
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: deep.invariant.runs = 2000
/// forge-config: deep.invariant.depth = 100
/// forge-config: deep.invariant.fail-on-revert = true
contract MediatorRouterInvariantTest is StdInvariant, Test {
    RouterHandler internal handler;

    function setUp() public {
        handler = new RouterHandler();
        targetContract(address(handler));
        // One outside sender. A sender that is a holder would receive coin from the test runner and break the sum of the coin.
        targetSender(makeAddr("fuzzer"));
        bytes4[] memory selectors = new bytes4[](19);
        selectors[0] = RouterHandler.relay.selector;
        selectors[1] = RouterHandler.relay.selector;
        selectors[2] = RouterHandler.relay.selector;
        selectors[3] = RouterHandler.deliver.selector;
        selectors[4] = RouterHandler.deliver.selector;
        selectors[5] = RouterHandler.deliver.selector;
        selectors[6] = RouterHandler.deliverNewest.selector;
        selectors[7] = RouterHandler.claim.selector;
        selectors[8] = RouterHandler.toggleDeny.selector;
        selectors[9] = RouterHandler.attack.selector;
        selectors[10] = RouterHandler.wrapCoin.selector;
        selectors[11] = RouterHandler.unwrapCoin.selector;
        selectors[12] = RouterHandler.donate.selector;
        selectors[13] = RouterHandler.toggleRefusal.selector;
        selectors[14] = RouterHandler.deliver.selector;
        selectors[15] = RouterHandler.claimFromRouter.selector;
        selectors[16] = RouterHandler.claimFromRouter.selector;
        selectors[17] = RouterHandler.deliverReentrant.selector;
        selectors[18] = RouterHandler.deliverReentrant.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ------------------------------------------------------------------------------------------------ invariants

    /// Claim: the record of a native token equals what stands behind it. Shows: for each native token, the record of
    /// the home mediator equals the supply of the bridged copy, plus the claims on the home chain, plus the claims on the
    /// other chain, plus the value of the messages in flight (in both directions). Matters: this is the whole solvency of the bridge. A copy without a record
    /// behind it, or a record without a copy, a claim or a message, is a loss or a theft. The claims are in the sum
    /// because a release that a token refused burned its copies and left the record in place, and a mint that a copy
    /// refused is recorded as a claim and not minted.
    function invariant_theRecordEqualsTheCopiesPlusTheClaimsPlusTheMessagesInFlight() public view {
        for (uint256 index = 0; index < 5; index++) {
            address native = handler.nativeAt(index);
            uint256 home = handler.homeOf(index);
            uint256 record = handler.mediatorOf(home).mediatorBalance(native);
            uint256 backing = handler.supplyOrZero(handler.copyAt(index)) + handler.claimableOfHolders(index)
                + handler.claimableOfHolders(index + 5) + handler.inFlight(native);
            assertEq(record, backing, "record != copy supply + claims + in flight");
        }
    }

    /// Claim: the home mediator holds exactly what its record says, and the other mediator holds no copy. Shows: for
    /// each native token, `balanceOf(mediator)` equals the record plus what strangers sent by plain transfer. For each
    /// bridged copy, the other mediator holds what strangers sent, and nothing else. Matters: the mediator takes no cut
    /// of a relay or of a release, so the balance has no other term. The test tightens the stated cover to equality
    /// for tokens that charge nothing on transfer, so a leak in either direction shows.
    function invariant_theMediatorHoldsTheRecordExactly() public view {
        for (uint256 index = 0; index < 5; index++) {
            address native = handler.nativeAt(index);
            address copy = handler.copyAt(index);
            uint256 home = handler.homeOf(index);
            uint256 held = handler.balanceOrZero(native, address(handler.mediatorOf(home)));
            assertEq(held, handler.mediatorOf(home).mediatorBalance(native) + handler.donated(native), "native balance");
            uint256 heldCopies = handler.balanceOrZero(copy, address(handler.mediatorOf(1 - home)));
            assertEq(heldCopies, handler.donated(copy), "copy balance");
        }
    }

    /// Claim: a message executes at most once, nothing fails, and the handler broke no rule. Shows: the count of
    /// executions of every message is at most one, no delivery call failed, no message identifier repeated, and the
    /// handler recorded no violation: every delivery split its value exactly into recipient, tip and hand-off, no tip
    /// passed the terms, no caller received a token, in every token payout by a router the payee received exactly one transfer
    /// and a reward address at most one. Matters: the
    /// bridge marks a message delivered whether or not the call succeeded, so a failed call loses tokens.
    function invariant_noViolationAndNoRepeatedExecution() public view {
        for (uint256 i = 0; i < handler.messageCount(); i++) {
            assertLe(handler.executions(handler.messageAt(i).bridgeMessageId), 1, "a message executed twice");
        }
        assertEq(handler.failedDeliveries(), 0, "a delivery failed");
        assertEq(handler.violations(), 0, handler.firstViolation());
    }

    /// Claim: a delivery router holds exactly what it recorded, no coin, and no run stays open. The router pays its
    /// payee and its reward address inside the callback, so nothing waits in it between two actions. Shows: after every action,
    /// each of the six delivery routers holds, in each of the ten tokens, a balance that equals the sum of its claimable
    /// records (only the failed delivery address can have one, and the balance equals its own `totalClaimable`), exactly; it holds none of the coin; and its delivery slot is at
    /// most 1 (not running). Matters: the routers have no owner and no way
    /// to recover a token. A balance with no record behind it would be lost for good, and a record with no balance
    /// behind it would take from another claimant.
    function invariant_aRouterHoldsExactlyWhatItRecordedAndNoRunStaysOpen() public view {
        for (uint256 chain = 0; chain < 2; chain++) {
            for (uint256 k = 0; k < 3; k++) {
                DeliveryRouter router = handler.deliveryRouterAt(chain, k);
                for (uint256 u = 0; u < 10; u++) {
                    (uint256 sum, uint256 stated) = handler.routerClaimableOfHolders(router, u);
                    uint256 balance = handler.balanceOrZero(handler.tokenAt(u), address(router));
                    assertEq(balance, sum, "a router balance differs from the sum of its claimable balances");
                    assertEq(stated, sum, "totalClaimable differs from the sum of the claimable balances");
                }
                assertEq(address(router).balance, 0, "a router holds the coin");
                assertLe(uint256(vm.load(address(router), router.DELIVERY_SLOT())), 1, "the delivery slot is open");
            }
        }
    }

    /// Claim: the tip, whenever taken, goes to the immutable reward address, and a caller earns nothing. Shows: no
    /// outside caller and no stranger is ever paid by any delivery, whoever calls and by whichever path (the handler
    /// reports a breach as a violation, and a direct delivery pays no tip), and the routers name the reward address and
    /// the failed delivery address that they were built with. Matters: any account may call a router, so a tip that
    /// followed the caller would be a prize for front-running.
    function invariant_theTipGoesToTheRewardAddressAndCallersHoldNothing() public view {
        for (uint256 index = 0; index < 10; index++) {
            for (uint256 c = 0; c < handler.callerCount(); c++) {
                assertEq(handler.holding(index, handler.callerAt(c)), 0, "a caller");
            }
            assertEq(handler.holding(index, handler.strangerAddress()), 0, "a stranger");
        }
        for (uint256 chain = 0; chain < 2; chain++) {
            for (uint256 k = 0; k < 3; k++) {
                DeliveryRouter router = handler.deliveryRouterAt(chain, k);
                assertEq(router.rewardAddress(), handler.rewardAt(k), "the reward address changed");
                assertEq(
                    router.failedDeliveryAddress(), handler.failedSinkAddress(), "the failed delivery address changed"
                );
            }
        }
    }

    /// Claim: the wrapped native token is backed one for one, and the coin is conserved. Shows: the supply of each
    /// wrapped token equals the coin that it holds, and the coin of the holders and the two wrapped tokens equals the
    /// coin that the handler created. Matters: the routers wrap and unwrap, and a rounding or a double unwrap would
    /// break the backing.
    function invariant_theWrappedNativeTokenIsBackedAndTheCoinIsConserved() public view {
        uint256 coin;
        for (uint256 chain = 0; chain < 2; chain++) {
            assertEq(handler.wrappedAt(chain).totalSupply(), address(handler.wrappedAt(chain)).balance, "backing");
            coin += address(handler.wrappedAt(chain)).balance;
        }
        for (uint256 i = 0; i < handler.holderCount(); i++) {
            coin += handler.holderAt(i).balance;
        }
        assertEq(coin, handler.coinDealt(), "the coin changed");
    }

    /// Claim: the copies are where the factory rule puts them, and the two registries agree. Shows: for each deployed
    /// copy, the other mediator maps the native token to the copy and the copy back to the native token, the copy
    /// stands at the address that the factory predicts from the chain and the native token, the copy obeys the mediator
    /// of its chain, and its name, symbol and decimals follow the rule of the mediator. The home mediator knows no copy
    /// for it. Matters: a copy at another address, or a registry that does not point back, would let a second token
    /// pass as the first.
    function invariant_theCopiesAreWhereTheFactoryRuleSaysAndTheRegistriesAgree() public view {
        for (uint256 index = 0; index < 5; index++) {
            address native = handler.nativeAt(index);
            address copy = handler.copyAt(index);
            uint256 home = handler.homeOf(index);
            TokenMediator away = handler.mediatorOf(1 - home);
            TokenMediator homeMediator = handler.mediatorOf(home);
            assertEq(homeMediator.bridgedTokenAddress(native), address(0), "the home chain has a copy of its own token");
            assertEq(homeMediator.nativeTokenAddress(native), address(0), "the native token is a copy");
            if (copy.code.length == 0) {
                assertEq(away.bridgedTokenAddress(native), address(0), "registered with no code");
                continue;
            }
            assertEq(away.bridgedTokenAddress(native), copy, "forward registry");
            assertEq(away.nativeTokenAddress(copy), native, "reverse registry");
            TokenFactory factory = away.tokenFactory();
            assertEq(factory.predictAddress(away.remoteChainId(), native), copy, "factory rule");
            assertEq(BridgedToken(copy).bridgeContract(), address(away), "the copy obeys its mediator");
            assertEq(IERC20Metadata(copy).decimals(), IERC20Metadata(native).decimals(), "decimals");
            assertEq(
                IERC20Metadata(copy).name(),
                string.concat(IERC20Metadata(native).name(), " from ", factory.homeChainName()),
                "name"
            );
            assertEq(IERC20Metadata(copy).symbol(), string.concat("zkb", IERC20Metadata(native).symbol()), "symbol");
        }
    }

    // -------------------------------------------------------------------------------------------------- reach

    /// Claim: the handler reaches the paying paths. Shows: after a fixed sequence, every counter of a path is above
    /// zero: direct, router and batch deliveries, a routed delivery with a tip, a native payout, a fallback, a recorded
    /// claim and its payment, a failed callback, the wrapped router, and refused attacks. Matters: an
    /// invariant over a handler that never acts proves nothing.
    function test_handlerReachesThePayingPaths() public {
        // A delivery router delivery with a fixed fee, then a share, then gas based, each executed by its own router.
        // Route 3, director shape in detail bits 32..: 0 fixed, 1 share, 2 gas, 3 gas on the base fee.
        for (uint256 shape = 0; shape < 4; shape++) {
            handler.relay(0, 0, 3, 0, 5e18, (shape << 32) | (1 << 40) | 7, 1);
            handler.deliver(0, 1, 0x55, 30 gwei);
        }
        assertGt(handler.routerDeliveries(), 0, "router deliveries");
        assertGt(handler.routedDeliveries(), 0, "routed deliveries");
        assertGt(handler.tipsPaid(), 0, "a tip was paid");
        assertGt(handler.payeeTransferChecks(), 0, "the transfers to a payee were counted");
        assertGt(handler.exactTransferChecks(), 0, "one transfer to the payee and at most one to the reward address");

        // A batch of four through Multicall3.
        for (uint256 i = 0; i < 4; i++) {
            handler.relay(0, 0, 3, uint8(i), 3e18, (i << 32) | (1 << 40) | i, 1);
        }
        handler.deliver(0, 2, 0x55, 30 gwei);
        assertGt(handler.batchDeliveries(), 0, "batch deliveries");

        // A direct delivery, and a delivery that waits.
        handler.relay(0, 0, 0, 1, 2e18, 3, 1);
        handler.deliver(0, 0, 0, 0);
        assertGt(handler.directDeliveries(), 0, "direct deliveries");

        // The wrapped native token goes to B by the wrap form and comes back to A through the delivery router and unwrap.
        handler.relay(1, 0, 5, 2, 4e18, 1, 1);
        handler.deliver(0, 0, 0, 0);
        handler.relay(1, 1, 3, 2, 1e18, (1 << 32) | 5 | (1 << 8), 1);
        handler.deliver(0, 1, 0x55, 30 gwei);
        handler.relay(1, 0, 5, 2, 4e18, 1, 1);
        handler.deliver(0, 0, 0, 0);
        handler.relay(1, 1, 4, 2, 1e18, 2, 1);
        handler.deliver(0, 1, 0x55, 30 gwei);

        // A recipient that the token refuses. Actor 2 holds copies of the deny list token. Actors 0 and 1 are denied.
        // The first release names a denied receiver and a fallback that is allowed (the fallback is paid). The second
        // names two denied accounts (a claim is recorded). Both are delivered at once (timing seed 0).
        handler.relay(4, 0, 1, 0, 9e18, 2 | (2 << 8), 0);
        handler.toggleDeny(0);
        handler.toggleDeny(1);
        // The amount seeds of the two copy relays are small, so that actor 2 keeps copies for the second one: the
        // first release holds 10,000 units, and a seed above the balance would spend all of it.
        handler.relay(4, 1, 1, 2, 1_000, 0 | (3 << 8), 0);
        assertGt(handler.fallbacksUsed(), 0, "a fallback was used");
        handler.relay(4, 1, 1, 2, 1_000, 0 | (1 << 8), 0);
        assertGt(handler.claimsRecorded(), 0, "a claim was recorded");
        handler.toggleDeny(0);
        handler.toggleDeny(1);
        handler.claim(4, 1);
        assertGt(handler.claimsPaid(), 0, "a claim was paid");

        // The three cases that used to strand value in a delivery router, each with a recipient that the sender chose. Token 4
        // refuses the denied accounts, and the copies on chain B go back to it on chain A. In `detail`, bits 136.. choose
        // the receiver (1 the router, 2 the zero address) and bits 144.. choose data of no known shape (1).
        handler.toggleDeny(0);
        // A payout that the token refuses, after a tip that a router executes. The failed delivery address is denied
        // too (accounts are the recipients, then the failed delivery address at index 9), so the push fails and a record stays.
        handler.toggleDeny(9);
        handler.relay(4, 1, 3, 2, 9e18 + 1, (1 << 32) | (1 << 40), 1);
        handler.deliver(handler.pendingCount() - 1, 1, 0x55, 30 gwei);
        assertGt(handler.payoutsRefused(), 0, "a payout was refused and recorded");
        // Terms that name the router, terms that name nobody, data of no known shape, a legacy receiver that is the router.
        handler.relay(4, 1, 3, 2, 9e18 + 1, uint256(1) << 136, 0);
        handler.relay(4, 1, 3, 2, 9e18 + 1, uint256(2) << 136, 0);
        handler.relay(4, 1, 3, 2, 9e18 + 1, uint256(1) << 144, 0);
        handler.relay(4, 1, 4, 2, 9e18 + 1, uint256(1) << 136, 0);
        assertGt(handler.termsForfeited(), 0, "invalid terms were handed off");
        // Terms that decode but name the router, run by the router: the tip is paid, the rest is handed off.
        handler.relay(4, 1, 3, 2, 9e18 + 1, (uint256(1) << 136) | (2 << 48) | (4000 << 56), 1);
        handler.deliver(handler.pendingCount() - 1, 1, 0x55, 30 gwei);
        assertGt(handler.tippedInvalidTerms(), 0, "invalid terms still paid the tip");
        // The legacy form with a token that cannot unwrap pays the token to the receiver.
        handler.relay(4, 1, 4, 2, 9e18 + 1, 5, 0);
        assertGt(handler.legacyTokenPayouts(), 0, "the legacy form paid a token");
        // A recipient whose payout hook delivers a second message to the same router: the router hands it off.
        handler.deliverReentrant(0, 5e18, 0, 1, 30);
        handler.deliverReentrant(1, 5e18, 4, 0, 30);
        assertGt(handler.reentriesRun(), 0, "a payout hook delivered a second message");
        assertGt(handler.reenteredHandOffs(), 0, "a reentrant callback was handed off");
        // The claims: refused while the token refuses the account, paid after.
        handler.claimFromRouter(4);
        assertGt(handler.routerClaimsRefused(), 0, "a claim was refused while the token refused");
        handler.toggleDeny(9);
        handler.claimFromRouter(4);
        assertGt(handler.routerClaimsPaid(), 0, "a claim was paid");

        // Strangers and attacks.
        handler.donate(0, 0, 1 ether);
        for (uint256 kind = 0; kind < 6; kind++) {
            handler.attack(uint8(kind), uint8(kind));
        }
        assertGt(handler.attacksRefused(), 0, "attacks were refused");
        assertEq(handler.violations(), 0, handler.firstViolation());
    }

    // --------------------------------------------------------------------------------------------------- helpers

    function _assertEmpty(address account) internal view {
        for (uint256 u = 0; u < 10; u++) {
            assertEq(handler.balanceOrZero(handler.tokenAt(u), account), 0, "a router holds a token");
        }
        assertEq(account.balance, 0, "a router holds the coin");
    }

    /// Claim: the bridged copy of the deny list token refuses nobody, so a router pays a denied account there and
    /// hands nothing off. Shows: the sequence that the deep run shrank to (deny recipient 1, then a routed relay of the
    /// copy) raises no violation. Matters: the handler once expected a hand-off for the copy, which is a plain mint.
    function test_theCopyOfTheDenyListTokenIsPaidToADeniedAccount() public {
        handler.toggleDeny(1);
        handler.relay(89, 14, 3, 0, 13100816989, 88226229587750968710862750950606603947805906805010179756, 0);
        assertEq(handler.violations(), 0, handler.firstViolation());
    }
}
