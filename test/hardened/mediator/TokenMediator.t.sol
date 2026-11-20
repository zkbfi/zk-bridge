// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MediatorBuild} from "../utils/MediatorBuild.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";
import {FeeOnTransferToken} from "../../mocks/FeeOnTransferToken.sol";
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
    HookToken, TEST_CALLBACK_GAS} from "./utils/MediatorSupport.sol";

/// @notice Tests of the token mediator: the two directions, the first message that deploys the copy, the accounting,
/// the callers that may trigger a release, the callback, and the path of a release that fails.
contract TokenMediatorTest is MediatorFixture {
    event TokensBridgingInitiated(
        address indexed token, address indexed sender, uint256 value, bytes32 indexed messageId
    );
    event TokensBridged(address indexed token, address indexed recipient, uint256 value, bytes32 indexed messageId);
    event NewTokenRegistered(address indexed nativeToken, address indexed bridgedToken);
    event ReleaseFailed(address indexed token, address indexed recipient, uint256 value, bytes32 indexed messageId);
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
        assertEq(message.gasLimit, 0, "the mediator asks the bridge for no gas");
        assertEq(_selectorOf(message.data), TokenMediator.deployAndHandleBridgedTokens.selector);

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
        assertEq(copy.symbol(), "zUSDC");
        assertEq(copy.decimals(), 6);
        assertEq(address(copy), mediatorB.tokenFactory().predictAddress(CHAIN_A, address(sixDecimals)));
    }

    /// Claim: a copy is named for its native token and its home chain, in both directions. Shows: with the chains named
    /// Ethereum (A) and PulseChain (B), the copy on chain B of `Wrapped Ether` is `Wrapped Ether from Ethereum` with the
    /// symbol `zWETH`, and the copy on chain A of `Pulse Token` is `Pulse Token from PulseChain` with the symbol
    /// `zPLS`. The factory holds the name. Matters: the name is the only sign of where a token came from. A wrong
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
        assertEq(onB.symbol(), "zWETH");
        assertEq(mediatorB.tokenFactory().homeChainName(), "Ethereum");

        _bridgeBtoA(alice, address(pulse), bob, 1 ether);
        BridgedToken onA = BridgedToken(mediatorA.bridgedTokenAddress(address(pulse)));
        assertEq(onA.name(), "Pulse Token from PulseChain");
        assertEq(onA.symbol(), "zPLS");
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
            "the payload is the OmniBridge payload"
        );
        assertEq(message.gasLimit, 0, "the mediator asks the bridge for no gas");

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
        assertEq(message.gasLimit, 0, "the mediator asks the bridge for no gas");
        (bool ok,) = _deliverAtoB(1);
        assertTrue(ok);
    }

    function test_messagesBeforeTheFirstReturnTripExecuteInAnyOrder() public {
        vm.startPrank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 10 ether);
        mediatorA.relayTokens(address(tokenA), bob, 20 ether);
        vm.stopPrank();
        assertEq(_selectorOf(ambA.messageAt(0).data), TokenMediator.deployAndHandleBridgedTokens.selector);
        assertEq(_selectorOf(ambA.messageAt(1).data), TokenMediator.deployAndHandleBridgedTokens.selector);

        (bool second,) = _deliverAtoB(1);
        (bool first,) = _deliverAtoB(0);
        assertTrue(second && first, "each message carries the metadata, so neither depends on the other");
        assertEq(IERC20(_copyOf(address(tokenA))).balanceOf(bob), 30 ether);
    }

    function test_theOmnibridgePayloadCarriesNoFallbackWhateverTheReceiverIs() public {
        vm.startPrank(alice);
        mediatorA.relayTokens(address(tokenA), 1 ether);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether);
        vm.stopPrank();
        bytes memory toSender = abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokens.selector,
            address(tokenA),
            "Token A",
            "TKA",
            uint8(18),
            alice,
            1 ether
        );
        bytes memory toOther = abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokens.selector,
            address(tokenA),
            "Token A",
            "TKA",
            uint8(18),
            bob,
            1 ether
        );
        assertEq(ambA.messageAt(0).data, toSender);
        assertEq(ambA.messageAt(1).data, toOther, "a receiver other than the sender adds nothing to the payload");
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
        assertEq(calls.length, 6, "six handlers");
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
        mediatorA.relayTokensAndCall(address(tokenA), address(receiver), 100 ether, "hello", TEST_CALLBACK_GAS);
        MockAMB.Sent memory message = ambA.messageAt(0);
        assertEq(message.gasLimit, 0, "the mediator asks the bridge for no gas");
        assertEq(_selectorOf(message.data), TokenMediator.deployAndHandleBridgedTokensAndCall.selector);

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
        mediatorA.relayTokensAndCall(address(tokenA), address(receiver), 1 ether, "", TEST_CALLBACK_GAS);
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
        mediatorB.relayTokensAndCall(copy, address(receiver), 4 ether, hex"c0ffee", TEST_CALLBACK_GAS);
        vm.stopPrank();
        assertEq(_selectorOf(ambB.messageAt(0).data), TokenMediator.handleNativeTokensAndCall.selector);

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
        mediatorA.relayTokensAndCall(address(tokenA), address(receiver), 5 ether, "x", TEST_CALLBACK_GAS);

        bytes32 id = ambA.messageAt(0).id;
        address predicted = mediatorB.tokenFactory().predictAddress(CHAIN_A, address(tokenA));
        vm.expectEmit(true, true, true, true, address(mediatorB));
        emit CallbackFailed(predicted, address(receiver), id);
        (bool ok,) = _deliverAtoB(0);
        assertTrue(ok, "a failing callback does not fail the delivery");
        assertEq(IERC20(predicted).balanceOf(address(receiver)), 5 ether);
    }

    /// Claim: `relayTokens` never calls the receiver, and `relayTokensAndCall` always does, as OmniBridge does, even
    /// with empty data. Shows: the first message is the plain form and the second is the form with a call.
    /// Matters: a receiver that expects a callback must get one whatever the length of the data.
    function test_relayTokensAndCallSendsTheCallFormEvenWithEmptyData() public {
        vm.startPrank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether);
        mediatorA.relayTokensAndCall(address(tokenA), bob, 1 ether, "", TEST_CALLBACK_GAS);
        vm.stopPrank();
        assertEq(_selectorOf(ambA.messageAt(0).data), TokenMediator.deployAndHandleBridgedTokens.selector);
        assertEq(_selectorOf(ambA.messageAt(1).data), TokenMediator.deployAndHandleBridgedTokensAndCall.selector);
    }

    // ------------------------------------------------------------------------------------------------ claim

    /// @dev Bridges `value` of a fresh deny list token from alice to alice, then sends `value` of its copy from alice
    /// on chain B to `receiver`, and returns the token. The caller denies `receiver` before the delivery.
    function _denyListTokenSentBackTo(address receiver, uint256 value) private returns (DenyListToken token) {
        token = new DenyListToken();
        token.mint(alice, 100 ether);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), alice, 100 ether);
        vm.stopPrank();
        _deliverAtoB(0);
        address copy = _copyOf(address(token));

        token.setDenied(receiver, true);
        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokens(copy, receiver, value);
        vm.stopPrank();
    }

    /// Claim: a recipient that the token refuses ends the release for good, and nobody else is paid. Shows: the
    /// delivery does not revert, `ReleaseFailed` names the recipient, the recipient and the sender receive nothing, the
    /// record falls by the release (the copies are burned) and the tokens stay in the mediator, owed to nobody. A
    /// second delivery of a later message to an accepted account still works. Matters: the mediator pays the
    /// recipient and only the recipient, there is no claim, and the books of the two chains agree.
    function test_aRecipientThatTheTokenRefusesEndsTheReleaseForGood() public {
        DenyListToken token = _denyListTokenSentBackTo(bob, 60 ether);

        bytes32 id = ambB.messageAt(0).id;
        vm.expectEmit(true, true, true, true, address(mediatorA));
        emit ReleaseFailed(address(token), bob, 60 ether, id);
        (bool ok,) = _deliverBtoA(0);
        assertTrue(ok, "the delivery does not revert");
        assertEq(token.balanceOf(bob), 0, "the recipient received nothing");
        assertEq(token.balanceOf(alice), 0, "nobody else is paid");
        assertEq(token.balanceOf(address(mediatorA)), 100 ether, "the tokens are still in the mediator");
        assertEq(mediatorA.mediatorBalance(address(token)), 40 ether, "the record fell by the release");
        assertEq(IERC20(_copyOf(address(token))).totalSupply(), 40 ether, "the record equals the copies that remain");

        token.setDenied(bob, false);
        vm.prank(dave);
        (bool claimed,) = address(mediatorA).call(abi.encodeWithSignature("claim(address,address)", address(token), bob));
        assertFalse(claimed, "the mediator has no claim function");
        assertEq(token.balanceOf(bob), 0, "nothing pays the release later");

        vm.startPrank(alice);
        mediatorB.relayTokens(_copyOf(address(token)), carol, 10 ether);
        vm.stopPrank();
        _deliverBtoA(1);
        assertEq(token.balanceOf(carol), 10 ether, "a later release to an accepted account is paid");
        assertEq(mediatorA.mediatorBalance(address(token)), 30 ether);
    }

    function test_aMintToTheZeroAddressFailsAndMintsNothing() public {
        _bridgeAtoB(alice, address(tokenA), alice, 1 ether);
        address copy = _copyOf(address(tokenA));
        bytes memory call = abi.encodeWithSelector(
            TokenMediator.handleBridgedTokens.selector, address(tokenA), address(0), 5 ether
        );
        vm.expectEmit(true, true, true, true, address(mediatorB));
        emit ReleaseFailed(copy, address(0), 5 ether, bytes32(uint256(3)));
        (bool ok,) =
            ambB.execute(address(mediatorB), call, address(mediatorA), bytes32(CHAIN_A), bytes32(uint256(3)), 1_000_000);
        assertTrue(ok);
        assertEq(IERC20(copy).totalSupply(), 1 ether, "nothing was minted");
        assertEq(IERC20(copy).balanceOf(carol), 0, "nobody else is paid");
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

    function test_relayRefusesAZeroAmount() public {
        vm.startPrank(alice);
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
            abi.encodeWithSelector(TokenMediator.handleNativeTokens.selector, address(tokenA), carol, 40 ether),
            "the receiver is carol and the payload has no other address"
        );
    }

    function test_onTokenTransferWithMoreDataCallsTheReceiver() public {
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        BridgedToken copy = BridgedToken(_copyOf(address(tokenA)));
        RecordingReceiver receiver = new RecordingReceiver();

        vm.prank(bob);
        copy.transferAndCall(
            address(mediatorB), 40 ether, abi.encodePacked(address(receiver), uint256(TEST_CALLBACK_GAS), hex"1234")
        );
        MockAMB.Sent memory message = ambB.messageAt(0);
        assertEq(
            message.data,
            abi.encodeWithSelector(
                TokenMediator.handleNativeTokensAndCall.selector,
                address(tokenA),
                address(receiver),
                40 ether,
                hex"1234",
                TEST_CALLBACK_GAS
            ),
            "the receiver, then the callback gas word, then the callback data"
        );
        _deliverBtoA(0);
        assertEq(receiver.lastData(), hex"1234");
        assertEq(receiver.lastValue(), 40 ether);
    }

    /// Claim: ERC-677 data of a receiver and a callback gas word with nothing after it asks for a call with empty data.
    /// Shows: the message is `handleNativeTokensAndCall` with empty data and the gas. Matters: the same as
    /// `relayTokensAndCall` with empty data, which calls the receiver.
    function test_onTokenTransferWithAReceiverAndAGasWordCallsWithEmptyData() public {
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        BridgedToken copy = BridgedToken(_copyOf(address(tokenA)));
        vm.prank(bob);
        copy.transferAndCall(address(mediatorB), 1 ether, abi.encodePacked(carol, uint256(70_000)));
        assertEq(
            ambB.messageAt(0).data,
            abi.encodeWithSelector(
                TokenMediator.handleNativeTokensAndCall.selector, address(tokenA), carol, 1 ether, "", uint256(70_000)
            )
        );
    }

    /// Claim: ERC-677 data longer than a receiver and shorter than a receiver with a gas word is refused, and so is a gas
    /// word of zero. Shows: 21 and 51 bytes revert with `MalformedTransferData` and the length; a zero gas word reverts
    /// with `ZeroCallbackGas`; no message is sent. Matters: there is no default gas for a callback, and a cut word must
    /// not be read as a small gas number.
    function test_onTokenTransferRefusesACutGasWordAndAZeroGas() public {
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        BridgedToken copy = BridgedToken(_copyOf(address(tokenA)));
        // The copy wraps the error of the callback in its own, so the test moves the tokens and then makes the call of
        // the copy itself, to read the error of the mediator.
        vm.prank(bob);
        copy.transfer(address(mediatorB), 1 ether);
        vm.startPrank(address(copy));
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.MalformedTransferData.selector, 21));
        mediatorB.onTokenTransfer(bob, 1 ether, abi.encodePacked(carol, hex"01"));
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.MalformedTransferData.selector, 51));
        mediatorB.onTokenTransfer(bob, 1 ether, abi.encodePacked(carol, bytes31(0)));
        vm.expectRevert(TokenMediator.ZeroCallbackGas.selector);
        mediatorB.onTokenTransfer(bob, 1 ether, abi.encodePacked(carol, uint256(0), hex"01"));
        vm.stopPrank();
        assertEq(ambB.sentCount(), 0, "no message");
    }

    /// Claim: `relayTokensAndCall` refuses a callback gas of zero. Shows: the revert and no message. Matters: the owner's
    /// rule, "there should be no defaults".
    function test_relayTokensAndCallRefusesZeroCallbackGas() public {
        vm.prank(alice);
        vm.expectRevert(TokenMediator.ZeroCallbackGas.selector);
        mediatorA.relayTokensAndCall(address(tokenA), bob, 1 ether, "x", 0);
        assertEq(ambA.sentCount(), 0);
    }

    /// Claim: `relayTokensAndCall` refuses a callback gas above `MAX_CALLBACK_GAS`, and takes the maximum itself.
    /// Shows: one above the maximum reverts with `CallbackGasTooHigh` and the two numbers, sends no message and leaves
    /// the tokens with the sender; the maximum sends a message that carries it. Matters: a callback gas that no
    /// transaction can give (EIP-7825 caps one at 16,777,216) would leave a message that no one can ever deliver, after
    /// the tokens were locked or burned.
    function test_relayTokensAndCallRefusesACallbackGasAboveTheMaximum() public {
        uint256 maximum = mediatorA.MAX_CALLBACK_GAS();
        assertEq(maximum, 10_468_731, "the figure of the frontends (MAX_CALLBACK_GAS of @zkb/core)");
        uint256 held = tokenA.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.CallbackGasTooHigh.selector, maximum + 1, maximum));
        mediatorA.relayTokensAndCall(address(tokenA), bob, 1 ether, "x", maximum + 1);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(TokenMediator.CallbackGasTooHigh.selector, type(uint256).max, maximum)
        );
        mediatorA.relayTokensAndCall(address(tokenA), bob, 1 ether, "x", type(uint256).max);
        assertEq(ambA.sentCount(), 0, "a refused relay sends nothing");
        assertEq(tokenA.balanceOf(alice), held, "and takes nothing");

        vm.prank(alice);
        mediatorA.relayTokensAndCall(address(tokenA), bob, 1 ether, "x", maximum);
        bytes memory data = ambA.messageAt(0).data;
        uint256 gasWord;
        assembly {
            gasWord := mload(add(data, add(36, mul(7, 32))))
        }
        assertEq(gasWord, maximum, "the maximum is carried");
    }

    /// Claim: ERC-677 data whose gas word is above `MAX_CALLBACK_GAS` is refused, for a bridged copy too. Shows: the
    /// revert names the gas word and the maximum, and no message is sent. Matters: `transferAndCall` reaches the same
    /// check as `relayTokensAndCall`, so neither entry can lock or burn tokens for a message that cannot be delivered.
    function test_onTokenTransferRefusesACallbackGasAboveTheMaximum() public {
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        BridgedToken copy = BridgedToken(_copyOf(address(tokenA)));
        uint256 maximum = mediatorB.MAX_CALLBACK_GAS();
        vm.prank(bob);
        copy.transfer(address(mediatorB), 1 ether);
        vm.prank(address(copy));
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.CallbackGasTooHigh.selector, maximum + 1, maximum));
        mediatorB.onTokenTransfer(bob, 1 ether, abi.encodePacked(carol, maximum + 1, hex"01"));
        assertEq(ambB.sentCount(), 0, "no message");
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

        terms.bridge = address(0xdead);
        _expectRefused(terms, "Chain", abi.encodeWithSelector(TokenMediator.ZeroValue.selector, "bridge"));
        terms.bridge = address(ambA);

        terms.remoteMediator = address(0);
        _expectRefused(terms, "Chain", abi.encodeWithSelector(TokenMediator.ZeroValue.selector, "remoteMediator"));
        terms.remoteMediator = address(mediatorB);

        // The other chain comes from the bridge, so a bridge with no destination chain is refused.
        terms.bridge = address(new MockAMB(CHAIN_A, 0));
        _expectRefused(terms, "Chain", abi.encodeWithSelector(TokenMediator.ZeroValue.selector, "remoteChainId"));
        terms.bridge = address(ambA);
        assertEq(MediatorBuild.deploy(terms, "Chain").remoteChainId(), CHAIN_B, "the other chain is read from the bridge");

        // The factory is a term: it must have code, name this mediator and carry a home chain name.
        _expectRefused(terms, "", abi.encodeWithSelector(TokenMediator.ZeroValue.selector, "remoteChainName"));
        terms.tokenFactory = address(0xbeef);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.ZeroValue.selector, "tokenFactory"));
        new TokenMediator(terms);
        TokenFactory ofAnother = new TokenFactory(address(mediatorA), "Chain");
        terms.tokenFactory = address(ofAnother);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.FactoryOfAnotherMediator.selector, address(mediatorA)));
        new TokenMediator(terms);
    }

    /// @dev Deploys a factory that names the next mediator of this contract, then expects the mediator to be refused.
    function _expectRefused(TokenMediator.MediatorTerms memory terms, string memory name, bytes memory reason) private {
        address next = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        terms.tokenFactory = address(new TokenFactory(next, name));
        vm.expectRevert(reason);
        new TokenMediator(terms);
    }

    /// Claim: the home chain name is kept in immutables and read back exactly, up to 32 bytes; a longer name is refused
    /// at deployment. Shows: names of 0, 1, 7 and 32 bytes come back from `homeChainName()` unchanged, and 33 bytes
    /// revert with `HomeChainNameTooLong(33)`. Matters: the name is part of the code, not of the storage, so it must
    /// fit one word, and a cut name would rename every copy for good.
    function test_theHomeChainNameIsImmutableAndAtMost32Bytes() public {
        string[4] memory names = ["", "A", "Chain B", "abcdefghijklmnopqrstuvwxyz012345"];
        for (uint256 i = 0; i < names.length; i++) {
            TokenFactory factory = new TokenFactory(address(this), names[i]);
            assertEq(factory.homeChainName(), names[i], "read back exactly");
        }
        vm.expectRevert(abi.encodeWithSelector(TokenFactory.HomeChainNameTooLong.selector, 33));
        new TokenFactory(address(this), "abcdefghijklmnopqrstuvwxyz0123456");
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /// @dev One call of each of the six handlers, with arbitrary arguments.
    function _allHandlerCalls() private view returns (bytes[] memory calls) {
        address token = address(tokenA);
        calls = new bytes[](6);
        calls[0] = abi.encodeWithSelector(TokenMediator.handleNativeTokens.selector, token, bob, 1);
        calls[1] = abi.encodeWithSelector(TokenMediator.handleNativeTokensAndCall.selector, token, bob, 1, hex"01", 1);
        calls[2] = abi.encodeWithSelector(TokenMediator.handleBridgedTokens.selector, token, bob, 1);
        calls[3] = abi.encodeWithSelector(TokenMediator.handleBridgedTokensAndCall.selector, token, bob, 1, hex"01", 1);
        calls[4] = abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokens.selector, token, "N", "S", uint8(18), bob, 1
        );
        calls[5] = abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokensAndCall.selector, token, "N", "S", uint8(18), bob, 1, hex"01", 1
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
