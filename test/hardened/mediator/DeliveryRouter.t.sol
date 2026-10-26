// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {DeliveryRouter} from "../../../src/hardened/mediator/DeliveryRouter.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";
import {Multicall3} from "../../../src/hardened/vendor/multicall3/Multicall3.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {
    MediatorFixture,
    MockAMB,
    MockWrappedNative,
    DenyListToken,
    CoinRefuser,
    GasBurner,
    CoinReverter,
    ContractWallet
} from "./utils/MediatorSupport.sol";
import {MedCutToken} from "./utils/MedMocks.sol";

/// @notice Tests of the executor delivery router. Tokens flow from chain B to chain A, where the router lives. A runner
/// executes the message through the router and earns the fee that the sender wrote in the `FeeDirector`.
contract DeliveryRouterTest is MediatorFixture {
    MockERC20 internal tokenB;
    MockWrappedNative internal weth;
    DeliveryRouter internal router;
    address internal runner = makeAddr("runner");
    address internal reward = makeAddr("reward address");
    address internal failedDelivery = makeAddr("failed delivery address");
    address internal recipient = makeAddr("recipient");

    function setUp() public override {
        super.setUp();
        weth = new MockWrappedNative();
        router = _routerFor(reward);
        tokenB = new MockERC20("Token B", "TKB");
        tokenB.mint(alice, 1_000_000 ether);
        // Warm up: the first message of a token deploys its copy. Later messages do not, so gas based fees stay small.
        vm.startPrank(alice);
        tokenB.approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokens(address(tokenB), alice, 1 ether);
        vm.stopPrank();
        _deliverBtoA(_lastIndexB());
        vm.deal(alice, 1_000 ether);
    }

    function _routerFor(address rewardAccount) internal returns (DeliveryRouter) {
        return new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), runner, rewardAccount, failedDelivery);
    }

    /// @dev A new router whose reward address is `account`. Call it before the message is sent: the sender names the
    /// router.
    function _useReward(address account) internal {
        router = _routerFor(account);
    }

    function _director(uint256 settings, uint256 limit, uint256 multiplier)
        internal
        view
        returns (DeliveryRouter.FeeDirector memory)
    {
        return DeliveryRouter.FeeDirector(recipient, settings, limit, multiplier);
    }

    /// @dev Chain B to the router on chain A. Returns the index of the message.
    function _sendTokenB(DeliveryRouter.FeeDirector memory director, uint256 value) internal returns (uint256) {
        vm.prank(alice);
        mediatorB.relayTokensAndCall(address(tokenB), address(router), value, abi.encode(director));
        return _lastIndexB();
    }

    /// @dev The runner of the router delivers the message and names the reward address.
    function _runThroughRouter(uint256 index) internal {
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, index);
        address rewardAddress = router.rewardAddress();
        vm.prank(router.runner(), router.runner());
        router.executeMessageWithRunner(proof, rewardAddress);
    }

    function _copyB() internal view returns (IERC20) {
        return IERC20(mediatorA.bridgedTokenAddress(address(tokenB)));
    }

    /// @dev Gives alice the copy of the wrapped token on chain B and sends it back to the router with a director.
    function _sendWrappedBack(DeliveryRouter.FeeDirector memory director, uint256 value, bytes memory data)
        internal
        returns (uint256)
    {
        vm.startPrank(alice);
        weth.deposit{value: value}();
        weth.approve(address(mediatorA), type(uint256).max);
        vm.stopPrank();
        _bridgeAtoB(alice, address(weth), alice, value);
        address copy = _copyOf(address(weth));
        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(copy, address(router), value, data.length == 0 ? abi.encode(director) : data);
        vm.stopPrank();
        return _lastIndexB();
    }

    // ------------------------------------------------------------------------------------------------ fee modes

    function test_aFixedFeeGoesToTheRunnerAndTheRestToTheRecipient() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 3 ether, 0), 100 ether);
        _runThroughRouter(index);

        assertEq(_copyB().balanceOf(reward), 3 ether);
        assertEq(_copyB().balanceOf(recipient), 97 ether);
        assertEq(_copyB().balanceOf(address(router)), 0, "the router keeps nothing");
    }

    /// Claim: the runner check reads the origin of the transaction, not the caller. Shows: through a generic Multicall3
    /// the runner delivers and the reward address is paid; the same call with another origin gets `NotRunner` for that
    /// origin in the result, delivers nothing, and does not revert the multicall. Matters: the runner batches through
    /// Multicall3, and a copier of the call still cannot take the tip.
    function test_theRunnerCheckReadsTheOriginSoMulticall3CanBatch() public {
        Multicall3 multicall = new Multicall3();
        DeliveryRouter.FeeDirector memory director = _director(router.FIXED_FEE(), 3 ether, 0);
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, _sendTokenB(director, 100 ether));
        Multicall3.Call3[] memory calls = new Multicall3.Call3[](1);
        calls[0] = Multicall3.Call3(
            address(router), true, abi.encodeCall(DeliveryRouter.executeMessageWithRunner, (proof, reward))
        );

        vm.prank(bob, bob);
        Multicall3.Result[] memory refused = multicall.aggregate3(calls);
        assertFalse(refused[0].success);
        assertEq(refused[0].returnData, abi.encodeWithSelector(DeliveryRouter.NotRunner.selector, bob));
        assertEq(_copyB().balanceOf(reward), 0, "a copier delivers nothing");

        vm.prank(runner, runner);
        Multicall3.Result[] memory results = multicall.aggregate3(calls);
        assertTrue(results[0].success);
        assertEq(_copyB().balanceOf(reward), 3 ether);
        assertEq(_copyB().balanceOf(recipient), 97 ether);
    }

    function test_aShareOfTheValueGoesToTheRunner() public {
        // The multiplier is scaled by 1e18: 0.02 is 2%.
        uint256 index = _sendTokenB(_director(router.SHARE_OF_VALUE(), 0, 0.02 ether), 500 ether);
        _runThroughRouter(index);

        assertEq(_copyB().balanceOf(reward), 10 ether);
        assertEq(_copyB().balanceOf(recipient), 490 ether);
    }

    function test_theFixedModeWinsOverTheShareMode() public {
        uint256 index =
            _sendTokenB(_director(router.FIXED_FEE() | router.SHARE_OF_VALUE(), 1 ether, 0.5 ether), 100 ether);
        _runThroughRouter(index);
        assertEq(_copyB().balanceOf(reward), 1 ether);
    }

    function test_aGasBasedFeeUsesTheGasPriceAndTheMultiplier() public {
        vm.txGasPrice(10 gwei);
        uint256 index = _sendTokenB(_director(0, 100 ether, 1 ether), 1_000 ether);
        _runThroughRouter(index);

        uint256 fee = _copyB().balanceOf(reward);
        // The fee is (gas used + 100,000 overhead) times the gas price, with the multiplier at one.
        assertGt(fee, 100_000 * 10 gwei, "at least the overhead");
        assertLt(fee, (100_000 + 1_000_000) * 10 gwei, "less than a million gas for the run");
        assertEq(fee % 10 gwei, 0, "the unit is the gas price");
        assertEq(_copyB().balanceOf(recipient), 1_000 ether - fee, "the rest of the cap went back to the recipient");
        assertEq(_copyB().balanceOf(address(router)), 0, "nothing stays in the router");
    }

    function test_extraGasFromTheExecutorDoesNotRaiseAGasBasedFee() public {
        vm.txGasPrice(10 gwei);
        uint256 indexOne = _sendTokenB(_director(0, 100 ether, 1 ether), 1_000 ether);
        _runThroughRouter(indexOne);
        uint256 plainFee = _copyB().balanceOf(reward);

        // The mock bridge, like the real one, forwards exactly the gas limit of the message and holds the rest back.
        uint256 indexTwo = _sendTokenB(_director(0, 100 ether, 1 ether), 1_000 ether);
        MessageBridge.MessageProof memory proofTwo = ambA.proofOf(ambB, indexTwo);
        vm.prank(runner, runner);
        router.executeMessageWithRunner{gas: 50_000_000}(proofTwo, reward);
        uint256 greedyFee = _copyB().balanceOf(reward) - plainFee;

        assertGt(greedyFee, 0);
        assertLt(greedyFee, plainFee * 12 / 10, "supplying 50 million gas buys no extra fee");
    }

    function test_theMultiplierScalesAGasBasedFee() public {
        vm.txGasPrice(10 gwei);
        // A first run warms the storage of the router, so the two measured runs cost nearly the same.
        _runThroughRouter(_sendTokenB(_director(0, 100 ether, 1 ether), 1_000 ether));
        uint256 warmFee = _copyB().balanceOf(reward);
        uint256 indexOne = _sendTokenB(_director(0, 100 ether, 1 ether), 1_000 ether);
        _runThroughRouter(indexOne);
        uint256 feeOne = _copyB().balanceOf(reward) - warmFee;

        uint256 indexTwo = _sendTokenB(_director(0, 100 ether, 2 ether), 1_000 ether);
        _runThroughRouter(indexTwo);
        uint256 feeTwo = _copyB().balanceOf(reward) - warmFee - feeOne;

        // The two runs use nearly the same gas, so doubling the multiplier nearly doubles the fee.
        assertGt(feeTwo, feeOne * 19 / 10);
        assertLt(feeTwo, feeOne * 21 / 10);
    }

    function test_aGasBasedFeeIsCappedByTheLimit() public {
        vm.txGasPrice(10 gwei);
        uint256 index = _sendTokenB(_director(0, 12_345, 1 ether), 1_000 ether);
        _runThroughRouter(index);
        assertEq(_copyB().balanceOf(reward), 12_345, "capped");
        assertEq(_copyB().balanceOf(recipient), 1_000 ether - 12_345);
    }

    function test_theBaseFeeOnlyFlagPricesGasAtTheBaseFee() public {
        vm.txGasPrice(50 gwei);
        vm.fee(7 gwei);
        uint256 index = _sendTokenB(_director(router.BASE_FEE_ONLY(), 100 ether, 1 ether), 1_000 ether);
        _runThroughRouter(index);
        uint256 fee = _copyB().balanceOf(reward);
        assertEq(fee % 7 gwei, 0, "priced at the base fee");
        assertGt(fee, 100_000 * 7 gwei);
        assertLt(fee, (100_000 + 1_000_000) * 7 gwei);
    }

    function test_aGasBasedFeeInTheNativeCoinIsSettledInTheCoin() public {
        vm.txGasPrice(10 gwei);
        uint256 index = _sendWrappedBack(_director(router.UNWRAP(), 1 ether, 1 ether), 5 ether, "");
        uint256 recipientBefore = recipient.balance;
        _runThroughRouter(index);
        uint256 fee = reward.balance;
        assertGt(fee, 50_000 * 10 gwei);
        assertLe(fee, 1 ether);
        assertEq(recipient.balance - recipientBefore, 5 ether - fee);
        assertEq(address(router).balance, 0);
        assertEq(weth.totalSupply(), 0);
    }

    function test_aGasBasedFeeWithNoRunnerIsZero() public {
        vm.txGasPrice(10 gwei);
        uint256 index = _sendTokenB(_director(0, 100 ether, 1 ether), 1_000 ether);
        ambA.executeMessage(ambA.proofOf(ambB, index));
        assertEq(_copyB().balanceOf(recipient), 1_000 ether);
    }

    function test_aGasBasedRunnerThatCannotTakeTheCoinLeavesTheRecipientWholeInCoin() public {
        vm.txGasPrice(10 gwei);
        address refuser = address(new CoinRefuser());
        _useReward(refuser);
        uint256 index = _sendWrappedBack(_director(router.UNWRAP(), 1 ether, 1 ether), 5 ether, "");
        uint256 recipientBefore = recipient.balance;
        _runThroughRouter(index);
        assertEq(recipient.balance - recipientBefore, 5 ether);
    }

    function test_feeInfoPricesAGasBasedFeeFromTheGasUsed() public {
        vm.txGasPrice(10 gwei);
        (uint256 fee, uint256 toRecipient) =
            router.feeInfo(address(tokenB), 1_000 ether, 400_000, _director(0, 100 ether, 1 ether));
        assertEq(fee, (400_000 + 100_000) * 10 gwei, "gas used plus the token overhead, times the gas price");
        assertEq(toRecipient, 1_000 ether - fee);
        (fee,) = router.feeInfo(address(tokenB), 1_000 ether, 400_000, _director(0, 1 gwei, 1 ether));
        assertEq(fee, 1 gwei, "capped");
        (fee,) = router.feeInfo(address(weth), 1_000 ether, 400_000, _director(router.UNWRAP(), 100 ether, 1 ether));
        assertEq(fee, (400_000 + 50_000) * 10 gwei, "the native overhead is smaller");
    }

    function test_theFeeNeverExceedsTheValue() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 500 ether, 0), 100 ether);
        _runThroughRouter(index);
        assertEq(_copyB().balanceOf(reward), 100 ether);
        assertEq(_copyB().balanceOf(recipient), 0);
    }

    function test_noRunnerMeansNoFee() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 3 ether, 0), 100 ether);
        // Anyone executes the message on the bridge directly. The router sees no runner.
        ambA.executeMessage(ambA.proofOf(ambB, index));
        assertEq(_copyB().balanceOf(recipient), 100 ether, "everything goes to the recipient");
        assertEq(_copyB().balanceOf(reward), 0);
    }

    function test_theRunnerSlotIsClearedAfterTheRun() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 1 ether, 0), 10 ether);
        _runThroughRouter(index);
        assertEq(uint256(vm.load(address(router), router.RUNNER_SLOT())), 1, "back to the idle value");

        // A later direct execution pays no fee, because the slot holds no runner.
        uint256 next = _sendTokenB(_director(router.FIXED_FEE(), 1 ether, 0), 10 ether);
        ambA.executeMessage(ambA.proofOf(ambB, next));
        assertEq(_copyB().balanceOf(reward), 1 ether, "still the first fee only");
    }

    function test_aRunWhileAnotherRunIsInProgressIsRefused() public {
        vm.store(address(router), router.RUNNER_SLOT(), bytes32(uint256(5)));
        vm.expectRevert(DeliveryRouter.RunnerSlotInUse.selector);
        MessageBridge.MessageProof memory empty;
        vm.prank(runner, runner);
        router.executeMessageWithRunner(empty, reward);
    }

    function test_theSlotIsTheOneOfGibsfinance() public view {
        assertEq(router.RUNNER_SLOT(), keccak256(abi.encode("omnibridgerouter.runner")), "the slot of gibsfinance");
    }

    // ------------------------------------------------------------------------------------------------ unwrap

    function test_unwrapPaysTheRecipientAndTheRunnerInTheNativeCoin() public {
        uint256 index = _sendWrappedBack(_director(router.FIXED_FEE() | router.UNWRAP(), 0.4 ether, 0), 5 ether, "");
        uint256 recipientBefore = recipient.balance;
        uint256 runnerBefore = reward.balance;
        _runThroughRouter(index);

        assertEq(reward.balance - runnerBefore, 0.4 ether);
        assertEq(recipient.balance - recipientBefore, 4.6 ether);
        assertEq(weth.totalSupply(), 0, "unwrapped");
        assertEq(weth.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }

    function test_unwrapWithARunnerThatCannotTakeTheCoinPaysTheRecipientInFull() public {
        address refuser = address(new CoinRefuser());
        _useReward(refuser);
        uint256 index = _sendWrappedBack(_director(router.FIXED_FEE() | router.UNWRAP(), 0.4 ether, 0), 5 ether, "");
        uint256 recipientBefore = recipient.balance;
        _runThroughRouter(index);
        assertEq(recipient.balance - recipientBefore, 5 ether, "a runner cannot block the recipient");
        assertEq(refuser.balance, 0);
    }

    /// @dev A native coin delivery to `receiver` with a 10 percent share fee for the runner, delivered at exactly the gas
    /// limit that the mediator asked for.
    function _deliverNativeTo(address receiver, uint256 value) internal returns (uint256 toRecipientBefore) {
        DeliveryRouter.FeeDirector memory director =
            DeliveryRouter.FeeDirector(receiver, router.UNWRAP() | router.SHARE_OF_VALUE(), 0, 0.1 ether);
        uint256 index = _sendWrappedBack(director, value, "");
        assertEq(
            ambB.messageAt(index).gasLimit,
            mediatorB.RELEASE_GAS_LIMIT() + mediatorB.CALLBACK_GAS_LIMIT(),
            "the gas limit of a release with a call"
        );
        toRecipientBefore = receiver.balance;
        _runThroughRouter(index);
        assertEq(address(router).balance, 0, "no coin stays in the router");
        assertEq(weth.balanceOf(address(router)), 0, "no wrapped token stays in the router");
    }

    /// Claim: a recipient that burns all its gas, reverts, or needs some gas to receive cannot strand the value, and the
    /// whole path passes at exactly the gas limit of the message. Shows: the router gives the recipient 50,000 gas; a
    /// burner and a reverter get the wrapped token; a contract wallet gets the coin; the runner holds its fee in each
    /// case and the router holds nothing. Matters: with all gas forwarded, a burner leaves nothing for the fallback.
    function test_aRecipientThatBurnsItsGasOrRevertsStillGetsTheValue() public {
        GasBurner burner = new GasBurner();
        _deliverNativeTo(address(burner), 5 ether);
        assertEq(weth.balanceOf(address(burner)), 4.5 ether, "the burner gets the wrapped token");
        assertEq(reward.balance, 0.5 ether, "the runner is paid");

        CoinReverter reverter = new CoinReverter();
        _deliverNativeTo(address(reverter), 5 ether);
        assertEq(weth.balanceOf(address(reverter)), 4.5 ether);
        assertEq(reward.balance, 1 ether);
    }

    function test_aContractWalletRecipientGetsTheCoin() public {
        ContractWallet wallet = new ContractWallet();
        _deliverNativeTo(address(wallet), 5 ether);
        assertEq(address(wallet).balance, 4.5 ether);
        assertEq(wallet.received(), 1);
        assertEq(weth.balanceOf(address(wallet)), 0);
    }

    /// Claim: a runner that burns its gas or reverts loses its fee and nothing else. Matters: the runner is an account
    /// that can refuse, and it must not leave the recipient short or the router holding value.
    function test_aRunnerThatBurnsItsGasLosesOnlyItsFee() public {
        GasBurner burner = new GasBurner();
        _useReward(address(burner));
        uint256 recipientBefore = _deliverNativeTo(recipient, 5 ether);
        assertEq(recipient.balance - recipientBefore, 5 ether, "the recipient gets the fee as well");
        assertEq(address(burner).balance, 0);
    }

    function test_theGasGivenToAReceiverIsFixed() public view {
        assertEq(router.NATIVE_SEND_GAS(), 50_000);
    }

    function test_unwrapWithARecipientThatCannotTakeTheCoinPaysTheWrappedToken() public {
        address refuser = address(new CoinRefuser());
        DeliveryRouter.FeeDirector memory director =
            DeliveryRouter.FeeDirector(refuser, router.UNWRAP() | router.SHARE_OF_VALUE(), 0, 0.1 ether);
        uint256 index = _sendWrappedBack(director, 5 ether, "");
        _runThroughRouter(index);
        assertEq(weth.balanceOf(refuser), 4.5 ether, "paid as the wrapped token");
        assertEq(reward.balance, 0.5 ether);
        assertEq(address(router).balance, 0);
    }

    function test_theUnwrapFlagIsIgnoredForAnotherToken() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE() | router.UNWRAP(), 1 ether, 0), 10 ether);
        _runThroughRouter(index);
        assertEq(_copyB().balanceOf(recipient), 9 ether, "only the wrapped native token unwraps");
        assertEq(_copyB().balanceOf(reward), 1 ether);
    }

    function test_theLegacyTwentyByteFormUnwrapsWithNoFee() public {
        uint256 index = _sendWrappedBack(_director(0, 0, 0), 2 ether, abi.encodePacked(carol));
        uint256 carolBefore = carol.balance;
        _runThroughRouter(index);
        assertEq(carol.balance - carolBefore, 2 ether);
        assertEq(reward.balance, 0, "no fee in the legacy form");
    }

    // ------------------------------------------------------------------------------------------------ a runner the token refuses

    function test_aRunnerThatTheTokenRefusesCannotBlockTheRecipient() public {
        DenyListToken token = new DenyListToken();
        token.mint(alice, 100 ether);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), alice, 100 ether);
        vm.stopPrank();
        _deliverAtoB(_lastIndexA());
        address copy = _copyOf(address(token));
        token.setDenied(reward, true);

        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(
            copy, address(router), 50 ether, abi.encode(_director(router.FIXED_FEE(), 5 ether, 0))
        );
        vm.stopPrank();
        _runThroughRouter(_lastIndexB());

        assertEq(token.balanceOf(recipient), 50 ether, "the fee that the runner could not take goes to the recipient");
        assertEq(token.balanceOf(reward), 0);
        assertEq(token.balanceOf(address(router)), 0);
    }

    /// Claim: a token that takes a cut on transfer cannot make the router pay more than it holds. Shows: the mediator
    /// reports 100 but the router receives 90, so the fee (a fixed 3) and the share of the recipient are computed on 90:
    /// the reward address gets 3, the recipient gets 87, and the router holds nothing. Matters: a cut would otherwise
    /// make the payout of the recipient revert and block the message.
    function test_aTokenThatTakesACutOnTransferIsPaidOutOfWhatTheRouterHolds() public {
        MedCutToken token = new MedCutToken();
        token.mint(alice, 100 ether);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), alice, 100 ether);
        vm.stopPrank();
        _deliverAtoB(_lastIndexA());
        address copy = _copyOf(address(token));
        token.setCut(address(mediatorA), 1_000);

        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(
            copy, address(router), 100 ether, abi.encode(_director(router.FIXED_FEE(), 3 ether, 0))
        );
        vm.stopPrank();
        _runThroughRouter(_lastIndexB());

        assertEq(token.balanceOf(reward), 3 ether, "the fixed fee");
        assertEq(token.balanceOf(recipient), 87 ether, "the rest of the 90 that arrived");
        assertEq(token.balanceOf(address(router)), 0, "the router keeps nothing");
    }

    /// Claim: a gas based fee with a cap of zero takes no fee and holds nothing back. Shows: the recipient gets the whole
    /// value, the reward address gets nothing, and the runner slot returns to the idle value. Matters: a cap of zero
    /// means that the sender pays no tip, and the router must not hold a settlement that it cannot pay.
    function test_aGasBasedFeeWithACapOfZeroTakesNoFee() public {
        vm.txGasPrice(10 gwei);
        uint256 index = _sendTokenB(_director(0, 0, 1 ether), 100 ether);
        _runThroughRouter(index);
        assertEq(_copyB().balanceOf(reward), 0, "no fee");
        assertEq(_copyB().balanceOf(recipient), 100 ether, "the whole value");
        assertEq(_copyB().balanceOf(address(router)), 0);
        assertEq(uint256(vm.load(address(router), router.RUNNER_SLOT())), 1, "back to the idle value");
    }

    // ------------------------------------------------------------------------------------------------ access

    /// Claim: only the runner of the router can deliver through it. Shows: a stranger, the recipient and the sender each
    /// revert with the caller named, and the message stays undelivered and can still be delivered. Matters: the whitelist
    /// stops front-running by block builders and searchers, who would copy the call of the runner and take the fee.
    function test_onlyTheRunnerCanDeliverThroughTheRouter() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 3 ether, 0), 100 ether);
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, index);
        address[3] memory others = [bob, recipient, alice];
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i], others[i]);
            vm.expectRevert(abi.encodeWithSelector(DeliveryRouter.NotRunner.selector, others[i]));
            router.executeMessageWithRunner(proof, reward);
        }
        assertEq(_copyB().balanceOf(recipient), 0, "nothing was delivered");

        _runThroughRouter(index);
        assertEq(_copyB().balanceOf(reward), 3 ether, "the runner still delivers it");
    }

    /// Claim: a stranger cannot take the fee of a message by delivering it directly. Shows: for each fee mode, delivery
    /// on the bridge with no runner sends the whole amount to the recipient and nothing to any other account. Matters:
    /// the bridge stays permissionless, so a user is never stuck if the runner is offline, and the user pays nothing.
    function test_aDirectDeliveryPaysNoTipInAnyMode() public {
        vm.txGasPrice(10 gwei);
        DeliveryRouter.FeeDirector[3] memory directors = [
            _director(router.FIXED_FEE(), 3 ether, 0),
            _director(router.SHARE_OF_VALUE(), 0, 0.02 ether),
            _director(0, 100 ether, 1 ether)
        ];
        for (uint256 i = 0; i < directors.length; i++) {
            uint256 index = _sendTokenB(directors[i], 100 ether);
            vm.prank(bob);
            ambA.executeMessage(ambA.proofOf(ambB, index));
            assertEq(_copyB().balanceOf(recipient), 100 ether * (i + 1), "the recipient gets everything");
        }
        assertEq(_copyB().balanceOf(reward), 0, "the runner earns nothing from a direct delivery");
        assertEq(_copyB().balanceOf(bob), 0);
        assertEq(_copyB().balanceOf(address(router)), 0);
    }

    function test_theRunnerIsFixedAtDeployment() public {
        assertEq(router.runner(), runner);
        assertEq(router.failedDeliveryAddress(), failedDelivery, "the failed delivery address is fixed");
        vm.expectRevert(DeliveryRouter.ZeroFailedDeliveryAddress.selector);
        new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), runner, reward, address(0));
        vm.expectRevert(DeliveryRouter.ZeroRunner.selector);
        new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), address(0), reward, failedDelivery);

        // No function changes the runner.
        bytes4[3] memory selectors = [
            bytes4(keccak256("setRunner(address)")),
            bytes4(keccak256("transferRunner(address)")),
            bytes4(keccak256("changeRunner(address)"))
        ];
        for (uint256 i = 0; i < selectors.length; i++) {
            (bool ok,) = address(router).call(abi.encodeWithSelector(selectors[i], bob));
            assertFalse(ok);
        }
    }

    function test_onlyTheMediatorCanCallOnTokenBridged() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DeliveryRouter.NotMediator.selector, bob));
        router.onTokenBridged(address(tokenB), 1, abi.encode(_director(0, 0, 0)));
    }

    function test_theRouterTakesTheCoinOnlyFromTheWrappedToken() public {
        vm.prank(bob);
        (bool ok, bytes memory returned) = address(router).call{value: 0}("");
        assertFalse(ok);
        assertEq(returned, abi.encodeWithSelector(DeliveryRouter.NotWrappedTokenSender.selector, bob));
    }

    function test_theRouterHasNoOwnerNoClaimAndNoValidatorFilter() public view {
        bytes4[5] memory selectors = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("claimTokens(address,address)")),
            bytes4(keccak256("validatorsFilter()")),
            bytes4(keccak256("isValidator(address)")),
            bytes4(keccak256("setValidatorStatus(address,bool)"))
        ];
        for (uint256 i = 0; i < selectors.length; i++) {
            (bool ok,) = address(router).staticcall(abi.encodeWithSelector(selectors[i], address(1), true));
            assertFalse(ok);
        }
    }

    function test_feeInfoMatchesTheFixedAndShareModes() public view {
        (uint256 fee, uint256 toRecipient) =
            router.feeInfo(address(tokenB), 100 ether, 0, _director(router.FIXED_FEE(), 4 ether, 0));
        assertEq(fee, 4 ether);
        assertEq(toRecipient, 96 ether);
        (fee, toRecipient) =
            router.feeInfo(address(tokenB), 100 ether, 0, _director(router.SHARE_OF_VALUE(), 0, 0.25 ether));
        assertEq(fee, 25 ether);
        assertEq(toRecipient, 75 ether);
    }
}
