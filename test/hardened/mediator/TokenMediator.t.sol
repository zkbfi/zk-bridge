// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {FeeOnTransferToken} from "../../../src/mocks/FeeOnTransferToken.sol";
import {BridgedToken} from "../../../src/hardened/mediator/BridgedToken.sol";
import {TokenFactory} from "../../../src/hardened/mediator/TokenFactory.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {
    MediatorFixture,
    MockAMB,
    RecordingReceiver,
    DenyListToken,
    DecimalsToken,
    NamelessToken,
    HookToken
} from "./utils/MediatorSupport.sol";

/// @notice Tests of the token mediator: the two directions, the first message that deploys the copy, the accounting,
/// the callers that may trigger a release, the callback, and the fallback and claim path.
contract TokenMediatorTest is MediatorFixture {
    event TokensBridgingInitiated(
        address indexed token, address indexed sender, uint256 value, bytes32 indexed messageId
    );
    event TokensBridged(address indexed token, address indexed recipient, uint256 value, bytes32 indexed messageId);
    event NewTokenRegistered(address indexed nativeToken, address indexed bridgedToken);
    event FallbackUsed(
        address indexed token, address indexed recipient, address indexed fallbackRecipient, bytes32 messageId
    );
    event ClaimableRecorded(address indexed token, address indexed account, uint256 value, bytes32 indexed messageId);
    event Claimed(address indexed token, address indexed account, uint256 value);
    event CallbackFailed(address indexed token, address indexed recipient, bytes32 indexed messageId);

    // ------------------------------------------------------------------------------------------------ directions

    function test_nativeTokensLockOnSourceAndMintCopyOnDestination() public {
        bytes32 expectedId = keccak256(abi.encode(CHAIN_A, uint256(0)));
        vm.expectEmit(true, true, true, true, address(mediatorA));
        emit TokensBridgingInitiated(address(tokenA), alice, 400 ether, expectedId);
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 400 ether);

        assertEq(tokenA.balanceOf(address(mediatorA)), 400 ether, "locked");
        assertEq(tokenA.balanceOf(alice), 1_000_000 ether - 400 ether);
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 400 ether);
        assertEq(ambA.sentCount(), 1);
        MockAMB.Sent memory message = ambA.messageAt(0);
        assertEq(message.target, address(mediatorB), "the target is the mediator on the other chain");
        assertEq(message.sender, address(mediatorA));
        assertEq(message.gasLimit, mediatorA.DEPLOY_GAS_LIMIT());
        assertEq(_selectorOf(message.data), TokenMediator.deployAndHandleBridgedTokensWithFallback.selector);

        address predicted = mediatorB.tokenFactory().predictAddress(CHAIN_A, address(tokenA));
        vm.expectEmit(true, true, false, true, address(mediatorB));
        emit NewTokenRegistered(address(tokenA), predicted);
        vm.expectEmit(true, true, true, true, address(mediatorB));
        emit TokensBridged(predicted, bob, 400 ether, expectedId);
        (bool ok,) = _deliverAtoB(0);
        assertTrue(ok);

        BridgedToken copy = BridgedToken(_copyOf(address(tokenA)));
        assertEq(address(copy), predicted, "the copy is at the computed address");
        assertEq(copy.balanceOf(bob), 400 ether);
        assertEq(copy.totalSupply(), 400 ether);
        assertEq(mediatorB.nativeTokenAddress(address(copy)), address(tokenA));
        assertEq(copy.bridgeContract(), address(mediatorB));
    }

    function test_firstMessageCarriesTheMetadataOfTheNativeToken() public {
        DecimalsToken sixDecimals = new DecimalsToken("USD Coin", "USDC", 6);
        sixDecimals.mint(alice, 1_000_000);
        vm.prank(alice);
        sixDecimals.approve(address(mediatorA), type(uint256).max);

        _bridgeAtoB(alice, address(sixDecimals), bob, 1_000_000);

        BridgedToken copy = BridgedToken(_copyOf(address(sixDecimals)));
        assertEq(copy.name(), "USD Coin from Chain A");
        assertEq(copy.symbol(), "zkbUSDC");
        assertEq(copy.decimals(), 6);
        assertEq(address(copy), mediatorB.tokenFactory().predictAddress(CHAIN_A, address(sixDecimals)));
    }

    /// Claim: a copy is named for its native token and its home chain, in both directions. Shows: with the chains named
    /// Ethereum (A) and PulseChain (B), the copy on chain B of `Wrapped Ether` is `Wrapped Ether from Ethereum` with the
    /// symbol `zkbWETH`, and the copy on chain A of `Pulse Token` is `Pulse Token from PulseChain` with the symbol
    /// `zkbPLS`. The factory holds the name. Matters: the name is the only sign of where a token came from. A wrong
    /// name or a missing separator rule would mislead holders, and no setter can fix a name later.
    function test_aCopyIsNamedForItsNativeTokenAndItsHomeChain() public {
        nameOfChainA = "Ethereum";
        nameOfChainB = "PulseChain";
        _deployMediators(_noTerms(), _noTerms());
        MockERC20 weth = new MockERC20("Wrapped Ether", "WETH");
        MockERC20 pulse = new MockERC20("Pulse Token", "PLS");
        weth.mint(alice, 10 ether);
        pulse.mint(alice, 10 ether);
        vm.startPrank(alice);
        weth.approve(address(mediatorA), type(uint256).max);
        pulse.approve(address(mediatorB), type(uint256).max);
        vm.stopPrank();

        _bridgeAtoB(alice, address(weth), bob, 1 ether);
        BridgedToken onB = BridgedToken(mediatorB.bridgedTokenAddress(address(weth)));
        assertEq(onB.name(), "Wrapped Ether from Ethereum");
        assertEq(onB.symbol(), "zkbWETH");
        assertEq(mediatorB.tokenFactory().homeChainName(), "Ethereum");

        _bridgeBtoA(alice, address(pulse), bob, 1 ether);
        BridgedToken onA = BridgedToken(mediatorA.bridgedTokenAddress(address(pulse)));
        assertEq(onA.name(), "Pulse Token from PulseChain");
        assertEq(onA.symbol(), "zkbPLS");
        assertEq(mediatorA.tokenFactory().homeChainName(), "PulseChain");
    }

    function test_theSecondTokenGetsItsOwnCopy() public {
        MockERC20Named other = new MockERC20Named();
        other.mint(alice, 10 ether);
        vm.prank(alice);
        other.approve(address(mediatorA), type(uint256).max);

        _bridgeAtoB(alice, address(tokenA), bob, 1 ether);
        _bridgeAtoB(alice, address(other), bob, 2 ether);

        address copyOne = _copyOf(address(tokenA));
        address copyTwo = _copyOf(address(other));
        assertTrue(copyOne != address(0) && copyTwo != address(0));
        assertTrue(copyOne != copyTwo, "one copy for each token");
        assertEq(IERC20(copyOne).balanceOf(bob), 1 ether);
        assertEq(IERC20(copyTwo).balanceOf(bob), 2 ether);
        assertEq(BridgedToken(copyTwo).name(), "Other from Chain A");
        assertEq(copyTwo, mediatorB.tokenFactory().predictAddress(CHAIN_A, address(other)));
    }

    function test_copyAddressDoesNotDependOnTheMetadata() public {
        address predicted = mediatorB.tokenFactory().predictAddress(CHAIN_A, address(tokenA));
        // The prediction is made before any message, from the home chain and the native token only.
        _bridgeAtoB(alice, address(tokenA), bob, 1 ether);
        assertEq(_copyOf(address(tokenA)), predicted);
        // A different home chain gives a different address for the same native token.
        assertTrue(mediatorB.tokenFactory().predictAddress(CHAIN_B, address(tokenA)) != predicted);
    }

    function test_copyBurnsOnSourceAndUnlocksNativeTokensOnDestination() public {
        _bridgeAtoB(alice, address(tokenA), bob, 400 ether);
        address copy = _copyOf(address(tokenA));

        vm.startPrank(bob);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokens(copy, 150 ether);
        vm.stopPrank();

        assertEq(IERC20(copy).balanceOf(bob), 250 ether);
        assertEq(IERC20(copy).totalSupply(), 250 ether, "burned");
        assertEq(IERC20(copy).balanceOf(address(mediatorB)), 0);
        MockAMB.Sent memory message = ambB.messageAt(0);
        assertEq(
            message.data,
            abi.encodeWithSelector(TokenMediator.handleNativeTokens.selector, address(tokenA), bob, 150 ether),
            "with the recipient as fallback the payload is the OmniBridge payload"
        );
        assertEq(message.gasLimit, mediatorB.RELEASE_GAS_LIMIT());

        (bool ok,) = _deliverBtoA(0);
        assertTrue(ok);
        assertEq(tokenA.balanceOf(bob), 150 ether, "unlocked");
        assertEq(tokenA.balanceOf(address(mediatorA)), 250 ether);
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 250 ether);
    }

    function test_returnTripAcknowledgesTheCopyAndLaterMessagesUseTheShortForm() public {
        assertFalse(mediatorA.isBridgedTokenDeployAcknowledged(address(tokenA)));
        _bridgeAtoB(alice, address(tokenA), alice, 100 ether);
        assertEq(_selectorOf(ambA.messageAt(0).data), TokenMediator.deployAndHandleBridgedTokens.selector);
        assertFalse(mediatorA.isBridgedTokenDeployAcknowledged(address(tokenA)), "no proof yet");

        _bridgeBtoA(alice, _copyOf(address(tokenA)), alice, 40 ether);
        assertTrue(mediatorA.isBridgedTokenDeployAcknowledged(address(tokenA)));

        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), 10 ether);
        MockAMB.Sent memory message = ambA.messageAt(1);
        assertEq(
            message.data,
            abi.encodeWithSelector(TokenMediator.handleBridgedTokens.selector, address(tokenA), alice, 10 ether)
        );
        assertEq(message.gasLimit, mediatorA.RELEASE_GAS_LIMIT());
        (bool ok,) = _deliverAtoB(1);
        assertTrue(ok);
    }

    function test_messagesBeforeTheFirstReturnTripExecuteInAnyOrder() public {
        vm.startPrank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 10 ether);
        mediatorA.relayTokens(address(tokenA), bob, 20 ether);
        vm.stopPrank();
        assertEq(_selectorOf(ambA.messageAt(0).data), TokenMediator.deployAndHandleBridgedTokensWithFallback.selector);
        assertEq(_selectorOf(ambA.messageAt(1).data), TokenMediator.deployAndHandleBridgedTokensWithFallback.selector);

        (bool second,) = _deliverAtoB(1);
        (bool first,) = _deliverAtoB(0);
        assertTrue(second && first, "each message carries the metadata, so neither depends on the other");
        assertEq(IERC20(_copyOf(address(tokenA))).balanceOf(bob), 30 ether);
    }

    function test_theFallbackOfTheSenderIsInThePayloadWhenItDiffersFromTheReceiver() public {
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether);
        bytes memory expected = abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokensWithFallback.selector,
            address(tokenA),
            "Token A",
            "TKA",
            uint8(18),
            bob,
            1 ether,
            alice
        );
        assertEq(ambA.messageAt(0).data, expected);
    }

    function test_theOmnibridgePayloadIsSentWhenReceiverAndFallbackAreTheSame() public {
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), 1 ether);
        bytes memory expected = abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokens.selector,
            address(tokenA),
            "Token A",
            "TKA",
            uint8(18),
            alice,
            1 ether
        );
        assertEq(ambA.messageAt(0).data, expected);
    }

    // ------------------------------------------------------------------------------------------------ accounting

    function test_feeOnTransferTokenBridgesTheAmountThatArrived() public {
        FeeOnTransferToken taxed = new FeeOnTransferToken("Taxed", "TAX");
        taxed.mint(alice, 1_000 ether);
        vm.prank(alice);
        taxed.approve(address(mediatorA), type(uint256).max);

        _bridgeAtoB(alice, address(taxed), bob, 1_000 ether);

        // The token burns 1% on the transfer into the mediator, so 990 arrive.
        assertEq(taxed.balanceOf(address(mediatorA)), 990 ether);
        assertEq(mediatorA.mediatorBalance(address(taxed)), 990 ether, "the record counts what arrived");
        assertEq(IERC20(_copyOf(address(taxed))).balanceOf(bob), 990 ether, "the copy is minted for what arrived");

        // The way back: the mediator releases 990 and the token takes its 1% again.
        _bridgeBtoA(bob, _copyOf(address(taxed)), carol, 990 ether);
        assertEq(taxed.balanceOf(carol), 990 ether - 9.9 ether);
        assertEq(mediatorA.mediatorBalance(address(taxed)), 0);
        assertEq(taxed.balanceOf(address(mediatorA)), 0, "nothing is left behind");
    }

    function test_strayTransferIsNeverPaidOut() public {
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        vm.prank(alice);
        tokenA.transfer(address(mediatorA), 500 ether);
        assertEq(tokenA.balanceOf(address(mediatorA)), 600 ether);
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 100 ether, "the stray tokens are in no record");

        // Even the remote mediator, through the bridge, cannot release more than the record holds.
        bytes memory greedy =
            abi.encodeWithSelector(TokenMediator.handleNativeTokens.selector, address(tokenA), carol, 101 ether);
        (bool ok, bytes memory returned) = ambA.execute(
            address(mediatorA), greedy, address(mediatorB), bytes32(CHAIN_B), bytes32(uint256(1)), 1_000_000
        );
        assertFalse(ok);
        assertEq(
            returned,
            abi.encodeWithSelector(
                TokenMediator.InsufficientMediatorBalance.selector, address(tokenA), 100 ether, 101 ether
            )
        );

        // The honest way back pays the record and leaves the stray tokens where they are.
        _bridgeBtoA(bob, _copyOf(address(tokenA)), carol, 100 ether);
        assertEq(tokenA.balanceOf(carol), 100 ether);
        assertEq(tokenA.balanceOf(address(mediatorA)), 500 ether, "the stray tokens stay");
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 0);
    }

    function test_mediatorBalanceTracksLocksAndUnlocks() public {
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 0);
        _bridgeAtoB(alice, address(tokenA), alice, 300 ether);
        _bridgeAtoB(alice, address(tokenA), bob, 200 ether);
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 500 ether);
        _bridgeBtoA(alice, _copyOf(address(tokenA)), alice, 120 ether);
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 380 ether);
        _bridgeBtoA(bob, _copyOf(address(tokenA)), bob, 200 ether);
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 180 ether);
        assertEq(tokenA.balanceOf(address(mediatorA)), 180 ether);
        assertEq(IERC20(_copyOf(address(tokenA))).totalSupply(), 180 ether, "supply on B equals the record on A");
    }

    function test_registrationViews() public {
        assertFalse(mediatorA.isTokenRegistered(address(tokenA)));
        assertFalse(mediatorA.isRegisteredAsNativeToken(address(tokenA)));
        _bridgeAtoB(alice, address(tokenA), bob, 1 ether);
        address copy = _copyOf(address(tokenA));

        assertTrue(mediatorA.isTokenRegistered(address(tokenA)));
        assertTrue(mediatorA.isRegisteredAsNativeToken(address(tokenA)));
        assertEq(mediatorA.nativeTokenAddress(address(tokenA)), address(0));
        assertTrue(mediatorB.isTokenRegistered(copy));
        assertFalse(mediatorB.isRegisteredAsNativeToken(copy));
        assertEq(mediatorB.nativeTokenAddress(copy), address(tokenA));
        assertEq(mediatorB.bridgedTokenAddress(address(tokenA)), copy);
    }

    function test_interfaceViews() public view {
        assertEq(address(mediatorA.bridgeContract()), address(ambA));
        assertEq(mediatorA.mediatorContractOnOtherSide(), address(mediatorB));
        assertEq(mediatorA.remoteChainId(), CHAIN_B);
        (uint64 major, uint64 minor, uint64 patch) = mediatorA.getBridgeInterfacesVersion();
        assertEq(uint256(major) * 1_000_000 + uint256(minor) * 1_000 + patch, 3_003_000);
        assertEq(mediatorA.getBridgeMode(), bytes4(keccak256("multi-erc-to-erc-amb")));
        assertEq(mediatorA.tokenFactory().mediator(), address(mediatorA));
    }

    // ------------------------------------------------------------------------------------------------ callers

    function test_everyHandlerRefusesACallerThatIsNotTheBridge() public {
        bytes[] memory calls = _allHandlerCalls();
        assertEq(calls.length, 12, "twelve handlers");
        for (uint256 i = 0; i < calls.length; i++) {
            vm.prank(bob);
            (bool ok, bytes memory returned) = address(mediatorA).call(calls[i]);
            assertFalse(ok);
            assertEq(returned, abi.encodeWithSelector(TokenMediator.NotBridge.selector, bob), "NotBridge");
        }
    }

    function test_theRemoteMediatorItselfCannotCallAHandlerDirectly() public {
        bytes[] memory calls = _allHandlerCalls();
        for (uint256 i = 0; i < calls.length; i++) {
            vm.prank(address(mediatorB));
            (bool ok, bytes memory returned) = address(mediatorA).call(calls[i]);
            assertFalse(ok);
            assertEq(returned, abi.encodeWithSelector(TokenMediator.NotBridge.selector, address(mediatorB)));
        }
    }

    function test_everyHandlerRefusesAMessageFromAnotherSender() public {
        bytes[] memory calls = _allHandlerCalls();
        address stranger = makeAddr("stranger");
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory returned) =
                ambA.execute(address(mediatorA), calls[i], stranger, bytes32(CHAIN_B), bytes32(uint256(7)), 1_000_000);
            assertFalse(ok);
            assertEq(
                returned,
                abi.encodeWithSelector(TokenMediator.WrongRemoteMediator.selector, address(mediatorB), stranger)
            );
        }
    }

    function test_everyHandlerRefusesAMessageFromAnotherChain() public {
        bytes[] memory calls = _allHandlerCalls();
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory returned) = ambA.execute(
                address(mediatorA), calls[i], address(mediatorB), bytes32(uint256(999)), bytes32(uint256(7)), 1_000_000
            );
            assertFalse(ok);
            assertEq(
                returned,
                abi.encodeWithSelector(TokenMediator.WrongSourceChain.selector, bytes32(CHAIN_B), bytes32(uint256(999)))
            );
        }
    }

    function test_aShortFormMessageForAnUnknownCopyIsRefused() public {
        bytes memory call =
            abi.encodeWithSelector(TokenMediator.handleBridgedTokens.selector, address(tokenA), bob, 1 ether);
        (bool ok, bytes memory returned) =
            ambB.execute(address(mediatorB), call, address(mediatorA), bytes32(CHAIN_A), bytes32(uint256(1)), 1_000_000);
        assertFalse(ok);
        assertEq(returned, abi.encodeWithSelector(TokenMediator.UnknownBridgedToken.selector, address(tokenA)));
    }

    // ------------------------------------------------------------------------------------------------ callbacks

    function test_relayTokensAndCallCallsTheReceiverOnDelivery() public {
        RecordingReceiver receiver = new RecordingReceiver();
        vm.prank(alice);
        mediatorA.relayTokensAndCall(address(tokenA), address(receiver), 100 ether, "hello");
        MockAMB.Sent memory message = ambA.messageAt(0);
        assertEq(message.gasLimit, mediatorA.DEPLOY_GAS_LIMIT() + mediatorA.CALLBACK_GAS_LIMIT());
        assertEq(_selectorOf(message.data), TokenMediator.deployAndHandleBridgedTokensAndCallWithFallback.selector);

        (bool ok,) = _deliverAtoB(0);
        assertTrue(ok);
        assertEq(receiver.calls(), 1);
        assertEq(receiver.lastCaller(), address(mediatorB));
        assertEq(receiver.lastToken(), _copyOf(address(tokenA)), "the callback names the token on this chain");
        assertEq(receiver.lastValue(), 100 ether);
        assertEq(receiver.lastData(), bytes("hello"));
        assertEq(IERC20(_copyOf(address(tokenA))).balanceOf(address(receiver)), 100 ether, "paid before the call");
    }

    function test_relayTokensAndCallCallsEvenWithEmptyData() public {
        RecordingReceiver receiver = new RecordingReceiver();
        vm.prank(alice);
        mediatorA.relayTokensAndCall(address(tokenA), address(receiver), 1 ether, "");
        (bool ok,) = _deliverAtoB(0);
        assertTrue(ok);
        assertEq(receiver.calls(), 1, "OmniBridge calls the receiver when the entry is relayTokensAndCall");
    }

    function test_plainRelayNeverCallsTheReceiver() public {
        RecordingReceiver receiver = new RecordingReceiver();
        _bridgeAtoB(alice, address(tokenA), address(receiver), 1 ether);
        assertEq(receiver.calls(), 0);
        assertEq(IERC20(_copyOf(address(tokenA))).balanceOf(address(receiver)), 1 ether);
    }

    function test_callbackOnTheNativeSideAfterTheTripBack() public {
        _bridgeAtoB(alice, address(tokenA), bob, 10 ether);
        RecordingReceiver receiver = new RecordingReceiver();
        address copy = _copyOf(address(tokenA));
        vm.startPrank(bob);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(copy, address(receiver), 4 ether, hex"c0ffee");
        vm.stopPrank();
        assertEq(_selectorOf(ambB.messageAt(0).data), TokenMediator.handleNativeTokensAndCallWithFallback.selector);

        (bool ok,) = _deliverBtoA(0);
        assertTrue(ok);
        assertEq(receiver.lastToken(), address(tokenA));
        assertEq(receiver.lastValue(), 4 ether);
        assertEq(receiver.lastData(), hex"c0ffee");
        assertEq(tokenA.balanceOf(address(receiver)), 4 ether);
    }

    function test_aRevertingReceiverKeepsTheTokensAndTheDeliveryHolds() public {
        RecordingReceiver receiver = new RecordingReceiver();
        receiver.setRefuse(true);
        vm.prank(alice);
        mediatorA.relayTokensAndCall(address(tokenA), address(receiver), 5 ether, "x");

        bytes32 id = ambA.messageAt(0).id;
        address predicted = mediatorB.tokenFactory().predictAddress(CHAIN_A, address(tokenA));
        vm.expectEmit(true, true, true, true, address(mediatorB));
        emit CallbackFailed(predicted, address(receiver), id);
        (bool ok,) = _deliverAtoB(0);
        assertTrue(ok, "a failing callback does not fail the delivery");
        assertEq(IERC20(predicted).balanceOf(address(receiver)), 5 ether);
    }

    function test_relayWithFallbackCallsOnlyWhenThereIsData() public {
        vm.startPrank(alice);
        mediatorA.relayTokensWithFallback(address(tokenA), bob, 1 ether, "", carol);
        mediatorA.relayTokensWithFallback(address(tokenA), bob, 1 ether, "d", carol);
        vm.stopPrank();
        assertEq(_selectorOf(ambA.messageAt(0).data), TokenMediator.deployAndHandleBridgedTokensWithFallback.selector);
        assertEq(
            _selectorOf(ambA.messageAt(1).data), TokenMediator.deployAndHandleBridgedTokensAndCallWithFallback.selector
        );
        // The explicit fallback is in the payload.
        (,,,,,, address fallbackRecipient) = abi.decode(
            _dropSelector(ambA.messageAt(0).data), (address, string, string, uint8, address, uint256, address)
        );
        assertEq(fallbackRecipient, carol);
    }

    // ------------------------------------------------------------------------------------------------ fallback and claim

    function test_aRecipientThatTheTokenRefusesIsPaidThroughTheFallback() public {
        DenyListToken token = new DenyListToken();
        token.mint(alice, 100 ether);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), alice, 100 ether);
        vm.stopPrank();
        _deliverAtoB(0);
        address copy = _copyOf(address(token));

        token.setDenied(bob, true);
        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensWithFallback(copy, bob, 60 ether, "", carol);
        vm.stopPrank();

        bytes32 id = ambB.messageAt(0).id;
        vm.expectEmit(true, true, true, true, address(mediatorA));
        emit FallbackUsed(address(token), bob, carol, id);
        vm.expectEmit(true, true, true, true, address(mediatorA));
        emit TokensBridged(address(token), carol, 60 ether, id);
        (bool ok,) = _deliverBtoA(0);
        assertTrue(ok, "the delivery does not revert");
        assertEq(token.balanceOf(carol), 60 ether, "the fallback received the tokens");
        assertEq(token.balanceOf(bob), 0);
        assertEq(mediatorA.mediatorBalance(address(token)), 40 ether, "the record fell by the release");
    }

    function test_theSenderIsTheDefaultFallback() public {
        DenyListToken token = new DenyListToken();
        token.mint(alice, 100 ether);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), alice, 100 ether);
        vm.stopPrank();
        _deliverAtoB(0);
        address copy = _copyOf(address(token));

        token.setDenied(bob, true);
        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokens(copy, bob, 30 ether);
        vm.stopPrank();
        (bool ok,) = _deliverBtoA(0);
        assertTrue(ok);
        assertEq(token.balanceOf(alice), 30 ether, "the sender is paid on the other chain at the same address");
    }

    function test_whenBothRefuseTheAmountIsClaimableByTheFallback() public {
        DenyListToken token = new DenyListToken();
        token.mint(alice, 100 ether);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), alice, 100 ether);
        vm.stopPrank();
        _deliverAtoB(0);
        address copy = _copyOf(address(token));

        token.setDenied(bob, true);
        token.setDenied(carol, true);
        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensWithFallback(copy, bob, 60 ether, "", carol);
        vm.stopPrank();

        bytes32 id = ambB.messageAt(0).id;
        vm.expectEmit(true, true, true, true, address(mediatorA));
        emit ClaimableRecorded(address(token), carol, 60 ether, id);
        (bool ok,) = _deliverBtoA(0);
        assertTrue(ok, "the message stays delivered");
        assertEq(mediatorA.claimable(address(token), carol), 60 ether);
        assertEq(token.balanceOf(address(mediatorA)), 100 ether, "the tokens are still in the mediator");
        assertEq(mediatorA.mediatorBalance(address(token)), 100 ether, "the record still counts them");

        // While the token still refuses the fallback, the claim fails and the amount stays.
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.ClaimTransferFailed.selector, address(token), carol));
        mediatorA.claim(address(token), carol);
        assertEq(mediatorA.claimable(address(token), carol), 60 ether);

        token.setDenied(carol, false);
        vm.expectEmit(true, true, false, true, address(mediatorA));
        emit Claimed(address(token), carol, 60 ether);
        vm.prank(dave);
        mediatorA.claim(address(token), carol);
        assertEq(token.balanceOf(carol), 60 ether, "anyone may claim for the account, and it pays the account");
        assertEq(token.balanceOf(dave), 0);
        assertEq(mediatorA.claimable(address(token), carol), 0);
        assertEq(mediatorA.mediatorBalance(address(token)), 40 ether);

        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NothingToClaim.selector, address(token), carol));
        mediatorA.claim(address(token), carol);
    }

    function test_mintToTheZeroAddressFallsBackToTheFallback() public {
        _bridgeAtoB(alice, address(tokenA), alice, 1 ether);
        address copy = _copyOf(address(tokenA));
        bytes memory call = abi.encodeWithSelector(
            TokenMediator.handleBridgedTokensWithFallback.selector, address(tokenA), address(0), 5 ether, carol
        );
        (bool ok,) =
            ambB.execute(address(mediatorB), call, address(mediatorA), bytes32(CHAIN_A), bytes32(uint256(3)), 1_000_000);
        assertTrue(ok);
        assertEq(IERC20(copy).balanceOf(carol), 5 ether);
    }

    // ------------------------------------------------------------------------------------------------ input checks

    function test_relayRefusesAnInvalidReceiver() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.InvalidReceiver.selector, address(0)));
        mediatorA.relayTokens(address(tokenA), address(0), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.InvalidReceiver.selector, address(mediatorB)));
        mediatorA.relayTokens(address(tokenA), address(mediatorB), 1 ether);
        vm.stopPrank();
    }

    function test_relayRefusesAZeroFallbackAndAZeroAmount() public {
        vm.startPrank(alice);
        vm.expectRevert(TokenMediator.ZeroFallback.selector);
        mediatorA.relayTokensWithFallback(address(tokenA), bob, 1 ether, "", address(0));
        vm.expectRevert(TokenMediator.ZeroAmount.selector);
        mediatorA.relayTokens(address(tokenA), bob, 0);
        vm.stopPrank();
    }

    function test_relayRefusesATokenWithNoNameAndNoSymbol() public {
        NamelessToken nameless = new NamelessToken();
        nameless.mint(alice, 10);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NoTokenName.selector, address(nameless)));
        mediatorA.relayTokens(address(nameless), bob, 10);
    }

    function test_onlyACallerThatTheTokenBacksCanUseOnTokenTransfer() public {
        // A contract that is not a token, and moved no tokens, cannot start a relay.
        FakeToken fake = new FakeToken();
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.UnbackedTransfer.selector, address(fake), 100, 0));
        fake.callOnTokenTransfer(mediatorA, alice, 100, "");
    }

    function test_onTokenTransferRelaysTheCopyWithTheReceiverInTheData() public {
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        BridgedToken copy = BridgedToken(_copyOf(address(tokenA)));

        vm.prank(bob);
        copy.transferAndCall(address(mediatorB), 40 ether, abi.encodePacked(carol));
        assertEq(copy.totalSupply(), 60 ether, "burned");
        MockAMB.Sent memory message = ambB.messageAt(0);
        assertEq(
            message.data,
            abi.encodeWithSelector(
                TokenMediator.handleNativeTokensWithFallback.selector, address(tokenA), carol, 40 ether, bob
            ),
            "the receiver is carol, the fallback is the sender"
        );
    }

    function test_onTokenTransferWithMoreDataCallsTheReceiver() public {
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        BridgedToken copy = BridgedToken(_copyOf(address(tokenA)));
        RecordingReceiver receiver = new RecordingReceiver();

        vm.prank(bob);
        copy.transferAndCall(address(mediatorB), 40 ether, abi.encodePacked(address(receiver), hex"1234"));
        MockAMB.Sent memory message = ambB.messageAt(0);
        assertEq(_selectorOf(message.data), TokenMediator.handleNativeTokensAndCallWithFallback.selector);
        _deliverBtoA(0);
        assertEq(receiver.lastData(), hex"1234");
        assertEq(receiver.lastValue(), 40 ether);
    }

    function test_onTokenTransferWithNoReceiverSendsToTheSender() public {
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        BridgedToken copy = BridgedToken(_copyOf(address(tokenA)));
        vm.prank(bob);
        copy.transferAndCall(address(mediatorB), 10 ether, "");
        assertEq(
            ambB.messageAt(0).data,
            abi.encodeWithSelector(TokenMediator.handleNativeTokens.selector, address(tokenA), bob, 10 ether)
        );
    }

    function test_onTokenTransferIgnoresDataShorterThanAnAddress() public {
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        BridgedToken copy = BridgedToken(_copyOf(address(tokenA)));
        vm.prank(bob);
        copy.transferAndCall(address(mediatorB), 10 ether, hex"010203");
        assertEq(
            ambB.messageAt(0).data,
            abi.encodeWithSelector(TokenMediator.handleNativeTokens.selector, address(tokenA), bob, 10 ether),
            "short data names no receiver and asks for no call"
        );
    }

    function test_aTokenThatCallsBackDuringThePullCreatesOneMessageOnly() public {
        HookToken hooked = new HookToken();
        hooked.mint(alice, 100 ether);
        hooked.setCallMediator(true);
        vm.startPrank(alice);
        hooked.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(hooked), bob, 100 ether);
        vm.stopPrank();
        assertEq(ambA.sentCount(), 1, "the callback returned true and relayed nothing");
        assertTrue(hooked.hookOk());
        assertEq(mediatorA.mediatorBalance(address(hooked)), 100 ether);
    }

    function test_aReleaseDuringThePullIsRefused() public {
        _bridgeAtoB(alice, address(tokenA), bob, 1 ether);
        HookToken hooked = new HookToken();
        hooked.mint(alice, 10 ether);
        // During the pull, the token makes the bridge deliver a release from the remote mediator.
        bytes memory release =
            abi.encodeWithSelector(TokenMediator.handleNativeTokens.selector, address(tokenA), carol, 1 ether);
        bytes memory viaBridge = abi.encodeCall(
            MockAMB.execute,
            (address(mediatorA), release, address(mediatorB), bytes32(CHAIN_B), bytes32(uint256(9)), 1_000_000)
        );
        hooked.arm(address(ambA), viaBridge);
        vm.startPrank(alice);
        hooked.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(hooked), bob, 10 ether);
        vm.stopPrank();

        assertTrue(hooked.hookOk(), "the bridge call itself ran");
        (bool innerOk, bytes memory innerReturned) = abi.decode(hooked.hookReturned(), (bool, bytes));
        assertFalse(innerOk, "the release was refused");
        assertEq(innerReturned, abi.encodeWithSelector(TokenMediator.HandlerDuringTransfer.selector));
        assertEq(tokenA.balanceOf(carol), 0);
    }

    function test_aTokenCannotReenterRelayDuringThePull() public {
        HookToken hooked = new HookToken();
        hooked.mint(alice, 10 ether);
        bytes memory again = abi.encodeWithSignature("relayTokens(address,uint256)", address(hooked), 1 ether);
        hooked.arm(address(mediatorA), again);
        vm.startPrank(alice);
        hooked.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(hooked), bob, 5 ether);
        vm.stopPrank();
        assertFalse(hooked.hookOk(), "the reentrant call failed");
        assertEq(ambA.sentCount(), 1);
    }

    function test_constructorRefusesBadTerms() public {
        TokenMediator.MediatorTerms memory terms = _noTerms();
        terms.bridge = address(ambA);
        terms.remoteMediator = address(mediatorB);
        terms.remoteChainId = CHAIN_B;

        terms.bridge = address(0xdead);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.ZeroValue.selector, "bridge"));
        new TokenMediator(terms);
        terms.bridge = address(ambA);

        terms.remoteMediator = address(0);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.ZeroValue.selector, "remoteMediator"));
        new TokenMediator(terms);
        terms.remoteMediator = address(mediatorB);

        terms.remoteChainId = 0;
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.ZeroValue.selector, "remoteChainId"));
        new TokenMediator(terms);
        terms.remoteChainId = CHAIN_B;

        terms.remoteChainName = "";
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.ZeroValue.selector, "remoteChainName"));
        new TokenMediator(terms);
    }

    /// Claim: a mediator refuses a bridge that allows less gas per message than the mediator's largest message asks for.
    /// Shows: with the ceiling one below the largest limit the constructor reverts, and with the ceiling at the largest
    /// limit it works. Matters: such a mediator would send messages that the bridge refuses, so no relay of a new token
    /// would ever succeed. The deploy script must fail early, not at the first relay.
    function test_constructorRefusesABridgeWithTooLittleGasPerMessage() public {
        TokenMediator.MediatorTerms memory terms = _noTerms();
        terms.bridge = address(ambA);
        terms.remoteMediator = address(mediatorB);
        terms.remoteChainId = CHAIN_B;
        uint256 largest = mediatorA.DEPLOY_GAS_LIMIT() + mediatorA.CALLBACK_GAS_LIMIT();

        ambA.setMaxGasPerTx(largest - 1);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.GasLimitAboveBridgeMaximum.selector, largest, largest - 1));
        new TokenMediator(terms);

        ambA.setMaxGasPerTx(largest);
        new TokenMediator(terms);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _dropSelector(bytes memory data) private pure returns (bytes memory rest) {
        rest = new bytes(data.length - 4);
        for (uint256 i = 0; i < rest.length; i++) {
            rest[i] = data[i + 4];
        }
    }

    /// @dev One call of each of the twelve handlers, with arbitrary arguments.
    function _allHandlerCalls() private view returns (bytes[] memory calls) {
        address token = address(tokenA);
        calls = new bytes[](12);
        calls[0] = abi.encodeWithSelector(TokenMediator.handleNativeTokens.selector, token, bob, 1);
        calls[1] = abi.encodeWithSelector(TokenMediator.handleNativeTokensAndCall.selector, token, bob, 1, hex"01");
        calls[2] = abi.encodeWithSelector(TokenMediator.handleNativeTokensWithFallback.selector, token, bob, 1, carol);
        calls[3] = abi.encodeWithSelector(
            TokenMediator.handleNativeTokensAndCallWithFallback.selector, token, bob, 1, hex"01", carol
        );
        calls[4] = abi.encodeWithSelector(TokenMediator.handleBridgedTokens.selector, token, bob, 1);
        calls[5] = abi.encodeWithSelector(TokenMediator.handleBridgedTokensAndCall.selector, token, bob, 1, hex"01");
        calls[6] = abi.encodeWithSelector(TokenMediator.handleBridgedTokensWithFallback.selector, token, bob, 1, carol);
        calls[7] = abi.encodeWithSelector(
            TokenMediator.handleBridgedTokensAndCallWithFallback.selector, token, bob, 1, hex"01", carol
        );
        calls[8] = abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokens.selector, token, "N", "S", uint8(18), bob, 1
        );
        calls[9] = abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokensAndCall.selector, token, "N", "S", uint8(18), bob, 1, hex"01"
        );
        calls[10] = abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokensWithFallback.selector, token, "N", "S", uint8(18), bob, 1, carol
        );
        calls[11] = abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokensAndCallWithFallback.selector,
            token,
            "N",
            "S",
            uint8(18),
            bob,
            1,
            hex"01",
            carol
        );
    }
}

/// @notice A token with a name that differs from the fixture token.
contract MockERC20Named is DecimalsToken {
    constructor() DecimalsToken("Other", "OTH", 18) {}
}

/// @notice A contract that is not a token and calls `onTokenTransfer` on a mediator.
contract FakeToken {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function callOnTokenTransfer(TokenMediator mediator, address from, uint256 value, bytes calldata data) external {
        mediator.onTokenTransfer(from, value, data);
    }
}
