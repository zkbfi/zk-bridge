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
import {MedCutToken, SlotProbeToken} from "./utils/MedMocks.sol";

/// @notice Tests of the executor delivery router. Tokens flow from chain B to chain A, where the router lives. Anyone
/// executes the message through the router, and the reward address earns the tip that the sender wrote in the
/// `FeeDirector`.
contract DeliveryRouterTest is MediatorFixture {
    MockERC20 internal tokenB;
    MockWrappedNative internal weth;
    DeliveryRouter internal router;
    address internal executor = makeAddr("executor");
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
        return new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), rewardAccount, failedDelivery);
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

    /// @dev An account with no special role delivers the message through the router.
    function _runThroughRouter(uint256 index) internal {
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, index);
        vm.prank(executor, executor);
        router.executeMessage(proof);
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

    function test_aFixedFeeGoesToTheRewardAddressAndTheRestToTheRecipient() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 3 ether, 0), 100 ether);
        _runThroughRouter(index);

        assertEq(_copyB().balanceOf(reward), 3 ether);
        assertEq(_copyB().balanceOf(recipient), 97 ether);
        assertEq(_copyB().balanceOf(address(router)), 0, "the router keeps nothing");
    }

    /// Claim: the router reads neither the origin nor the caller, so a generic Multicall3 batches deliveries from any
    /// account. Shows: through Multicall3, with a caller whose origin is the caller itself, the call succeeds, the
    /// reward address is paid the fixed tip, the recipient gets the rest, and the caller gets nothing. Matters: no
    /// batching contract and no origin rule are needed.
    function test_multicall3BatchesFromAnyAccountWithNoOriginRule() public {
        Multicall3 multicall = new Multicall3();
        DeliveryRouter.FeeDirector memory director = _director(router.FIXED_FEE(), 3 ether, 0);
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, _sendTokenB(director, 100 ether));
        Multicall3.Call3[] memory calls = new Multicall3.Call3[](1);
        calls[0] = Multicall3.Call3(address(router), true, abi.encodeCall(DeliveryRouter.executeMessage, (proof)));

        vm.prank(bob, bob);
        Multicall3.Result[] memory results = multicall.aggregate3(calls);
        assertTrue(results[0].success);
        assertEq(_copyB().balanceOf(reward), 3 ether, "the reward address gets the tip");
        assertEq(_copyB().balanceOf(recipient), 97 ether);
        assertEq(_copyB().balanceOf(bob), 0, "the caller gets nothing");
        assertEq(_copyB().balanceOf(address(multicall)), 0, "Multicall3 gets nothing");
    }

    /// Claim: a copy of a delivery pays the same tip to the same address and gains the copier nothing. Shows: for a
    /// fixed tip and a multiplier tip, and for each of three accounts (each its own caller and origin, one of them the
    /// reward address, one the recipient), the reward address receives the identical tip, the recipient the identical
    /// rest, and the caller nothing. Matters: this is why the router needs no whitelist: a front-runner pays the gas and
    /// the tip stays put.
    function test_aCopyOfADeliveryFromAnyAccountPaysTheIdenticalTip() public {
        address[3] memory copiers = [bob, reward, recipient];
        DeliveryRouter.FeeDirector[2] memory directors =
            [_director(router.FIXED_FEE(), 3 ether, 0), _director(router.MULTIPLIER_OF_TOTAL(), 0, 0.03 ether)];
        for (uint256 i = 0; i < copiers.length; i++) {
            for (uint256 j = 0; j < directors.length; j++) {
                uint256 rewardBefore = _copyB().balanceOf(reward);
                uint256 recipientBefore = _copyB().balanceOf(recipient);
                MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, _sendTokenB(directors[j], 100 ether));
                vm.prank(copiers[i], copiers[i]);
                router.executeMessage(proof);
                assertEq(_copyB().balanceOf(reward) - rewardBefore, 3 ether, "the identical tip");
                assertEq(_copyB().balanceOf(recipient) - recipientBefore, 97 ether, "the identical rest");
            }
        }
        assertEq(_copyB().balanceOf(bob), 0, "an outside copier gains nothing");
        assertEq(_copyB().balanceOf(address(router)), 0);
    }

    /// Claim: the caller and the origin may differ, and the tip still goes to the reward address. Matters: the router
    /// reads no `tx.origin`.
    function test_aCallerWithAnUnrelatedOriginDelivers() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 3 ether, 0), 100 ether);
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, index);
        vm.prank(bob, carol);
        router.executeMessage(proof);
        assertEq(_copyB().balanceOf(reward), 3 ether);
        assertEq(_copyB().balanceOf(bob), 0);
        assertEq(_copyB().balanceOf(carol), 0);
    }

    function test_aShareOfTheValueGoesToTheRewardAddress() public {
        // The multiplier is scaled by 1e18: 0.02 is 2%.
        uint256 index = _sendTokenB(_director(router.MULTIPLIER_OF_TOTAL(), 0, 0.02 ether), 500 ether);
        _runThroughRouter(index);

        assertEq(_copyB().balanceOf(reward), 10 ether);
        assertEq(_copyB().balanceOf(recipient), 490 ether);
    }

    function test_theFixedModeWinsOverTheMultiplierOfTotalMode() public {
        uint256 index =
            _sendTokenB(_director(router.FIXED_FEE() | router.MULTIPLIER_OF_TOTAL(), 1 ether, 0.5 ether), 100 ether);
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
        vm.prank(executor, executor);
        router.executeMessage{gas: 50_000_000}(proofTwo);
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

    function test_theExcludePriorityFlagPricesGasAtTheBaseFee() public {
        vm.txGasPrice(50 gwei);
        vm.fee(7 gwei);
        uint256 index = _sendTokenB(_director(router.EXCLUDE_PRIORITY(), 100 ether, 1 ether), 1_000 ether);
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

    function test_aGasBasedFeeOnADirectDeliveryIsZero() public {
        vm.txGasPrice(10 gwei);
        uint256 index = _sendTokenB(_director(0, 100 ether, 1 ether), 1_000 ether);
        ambA.executeMessage(ambA.proofOf(ambB, index));
        assertEq(_copyB().balanceOf(recipient), 1_000 ether);
    }

    function test_aRewardAddressThatCannotTakeTheCoinLeavesTheRecipientWholeInCoinForAGasBasedFee() public {
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

    /// Claim: a delivery on the bridge, not through the router, takes no tip. Shows: the recipient gets the whole
    /// value, nobody else gets anything, and the slot stays at rest. Matters: the router marks only its own deliveries.
    function test_aDirectDeliveryTakesNoTip() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 3 ether, 0), 100 ether);
        ambA.executeMessage(ambA.proofOf(ambB, index));
        assertEq(_copyB().balanceOf(recipient), 100 ether, "everything goes to the recipient");
        assertEq(_copyB().balanceOf(reward), 0);
        assertLe(uint256(vm.load(address(router), router.DELIVERY_SLOT())), 1, "the slot stays at rest (0 before the first use)");
    }

    /// Claim: the slot marks a router delivery, and only that. Shows: the slot reads 1 before a router delivery, holds
    /// the starting gas (above 1) while the callback pays out, and reads 1 after it. A direct delivery of the same
    /// kind sees 1 during the callback. A probe token reads the slot of the router each time that the router pays out
    /// of it. Matters: the tip rests on this marker alone.
    function test_theSlotHoldsTheStartingGasOnlyDuringARouterDelivery() public {
        SlotProbeToken probe = new SlotProbeToken(address(router), router.DELIVERY_SLOT());
        probe.mint(alice, 100 ether);
        vm.startPrank(alice);
        probe.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(probe), alice, 100 ether);
        vm.stopPrank();
        _deliverAtoB(_lastIndexA());
        address copy = _copyOf(address(probe));

        assertLe(uint256(vm.load(address(router), router.DELIVERY_SLOT())), 1, "at rest before (0 before the first use)");
        bytes memory data = abi.encode(_director(router.FIXED_FEE(), 1 ether, 0));
        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(copy, address(router), 20 ether, data);
        uint256 viaRouter = _lastIndexB();
        mediatorB.relayTokensAndCall(copy, address(router), 20 ether, data);
        uint256 direct = _lastIndexB();
        vm.stopPrank();

        _runThroughRouter(viaRouter);
        assertGt(probe.slotSeenAtPayout(), 1, "the starting gas during a router delivery");
        assertEq(probe.balanceOf(reward), 1 ether, "the router delivery paid the tip");
        assertEq(uint256(vm.load(address(router), router.DELIVERY_SLOT())), 1, "at rest after");

        probe.resetSeen();
        ambA.executeMessage(ambA.proofOf(ambB, direct));
        assertEq(probe.slotSeenAtPayout(), 1, "a direct delivery leaves the slot at rest");
        assertEq(probe.balanceOf(reward), 1 ether, "the direct delivery paid no tip");
        assertEq(uint256(vm.load(address(router), router.DELIVERY_SLOT())), 1, "at rest at the end");
    }

    function test_theSlotIsClearedAfterTheRun() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 1 ether, 0), 10 ether);
        _runThroughRouter(index);
        assertEq(uint256(vm.load(address(router), router.DELIVERY_SLOT())), 1, "back to the idle value");

        // A later direct execution pays no tip, because the slot holds 1.
        uint256 next = _sendTokenB(_director(router.FIXED_FEE(), 1 ether, 0), 10 ether);
        ambA.executeMessage(ambA.proofOf(ambB, next));
        assertEq(_copyB().balanceOf(reward), 1 ether, "still the first tip only");
    }

    /// Claim: a second delivery cannot start while one runs. Shows: with the slot set to a starting gas, `executeMessage`
    /// reverts with `DeliveryInProgress`. Matters: a nested run would mix the two settlements.
    function test_aDeliveryWhileAnotherDeliveryRunsIsRefused() public {
        vm.store(address(router), router.DELIVERY_SLOT(), bytes32(uint256(5)));
        vm.expectRevert(DeliveryRouter.DeliveryInProgress.selector);
        MessageBridge.MessageProof memory empty;
        vm.prank(executor, executor);
        router.executeMessage(empty);
    }

    function test_theSlotNameIsTheDeliveryRouterName() public view {
        assertEq(router.DELIVERY_SLOT(), keccak256(abi.encode("deliveryrouter.delivery")), "the slot of the router");
    }

    /// Claim: the four flag constants carry the names of gibsfinance and the bits of the `FeeDirector`.
    function test_theFlagConstantsHaveTheirNamesAndBits() public view {
        assertEq(router.FIXED_FEE(), 1);
        assertEq(router.UNWRAP(), 2);
        assertEq(router.EXCLUDE_PRIORITY(), 4);
        assertEq(router.MULTIPLIER_OF_TOTAL(), 8);
    }

    /// Claim: `baseFee(true)` is the base fee of the block, and `baseFee(false)` is the gas price of the transaction.
    /// Shows: with the two set apart, each call returns its own. Matters: a gas based tip prices gas by these.
    function test_baseFeeReadsTheBlockOrTheTransaction() public {
        vm.fee(7 gwei);
        vm.txGasPrice(50 gwei);
        assertEq(router.baseFee(true), 7 gwei);
        assertEq(router.baseFee(true), block.basefee);
        assertEq(router.baseFee(false), 50 gwei);
        assertEq(router.baseFee(false), tx.gasprice);
    }

    // ------------------------------------------------------------------------------------------------ unwrap

    function test_unwrapPaysTheRecipientAndTheRewardAddressInTheNativeCoin() public {
        uint256 index = _sendWrappedBack(_director(router.FIXED_FEE() | router.UNWRAP(), 0.4 ether, 0), 5 ether, "");
        uint256 recipientBefore = recipient.balance;
        uint256 rewardBefore = reward.balance;
        _runThroughRouter(index);

        assertEq(reward.balance - rewardBefore, 0.4 ether);
        assertEq(recipient.balance - recipientBefore, 4.6 ether);
        assertEq(weth.totalSupply(), 0, "unwrapped");
        assertEq(weth.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }

    function test_unwrapWithARewardAddressThatCannotTakeTheCoinPaysTheRecipientInFull() public {
        address refuser = address(new CoinRefuser());
        _useReward(refuser);
        uint256 index = _sendWrappedBack(_director(router.FIXED_FEE() | router.UNWRAP(), 0.4 ether, 0), 5 ether, "");
        uint256 recipientBefore = recipient.balance;
        _runThroughRouter(index);
        assertEq(recipient.balance - recipientBefore, 5 ether, "the reward address cannot block the recipient");
        assertEq(refuser.balance, 0);
    }

    /// @dev A native coin delivery to `receiver` with a 10 percent multiplier tip for the reward address, delivered at exactly the gas
    /// limit that the mediator asked for.
    function _deliverNativeTo(address receiver, uint256 value) internal returns (uint256 toRecipientBefore) {
        DeliveryRouter.FeeDirector memory director =
            DeliveryRouter.FeeDirector(receiver, router.UNWRAP() | router.MULTIPLIER_OF_TOTAL(), 0, 0.1 ether);
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
    /// burner and a reverter get the wrapped token; a contract wallet gets the coin; the reward address holds its tip in each
    /// case and the router holds nothing. Matters: with all gas forwarded, a burner leaves nothing for the fallback.
    function test_aRecipientThatBurnsItsGasOrRevertsStillGetsTheValue() public {
        GasBurner burner = new GasBurner();
        _deliverNativeTo(address(burner), 5 ether);
        assertEq(weth.balanceOf(address(burner)), 4.5 ether, "the burner gets the wrapped token");
        assertEq(reward.balance, 0.5 ether, "the reward address is paid");

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

    /// Claim: a reward address that burns its gas or reverts loses its tip and nothing else. Matters: the reward address is an account
    /// that can refuse, and it must not leave the recipient short or the router holding value.
    function test_aRewardAddressThatBurnsItsGasLosesOnlyItsTip() public {
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
            DeliveryRouter.FeeDirector(refuser, router.UNWRAP() | router.MULTIPLIER_OF_TOTAL(), 0, 0.1 ether);
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

    // ------------------------------------------------------------------------------------------------ a reward address the token refuses

    function test_aRewardAddressThatTheTokenRefusesCannotBlockTheRecipient() public {
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

        assertEq(token.balanceOf(recipient), 50 ether, "the tip that the reward address could not take goes to the recipient");
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
    /// value, the reward address gets nothing, and the delivery slot returns to the idle value. Matters: a cap of zero
    /// means that the sender pays no tip, and the router must not hold a settlement that it cannot pay.
    function test_aGasBasedFeeWithACapOfZeroTakesNoFee() public {
        vm.txGasPrice(10 gwei);
        uint256 index = _sendTokenB(_director(0, 0, 1 ether), 100 ether);
        _runThroughRouter(index);
        assertEq(_copyB().balanceOf(reward), 0, "no fee");
        assertEq(_copyB().balanceOf(recipient), 100 ether, "the whole value");
        assertEq(_copyB().balanceOf(address(router)), 0);
        assertEq(uint256(vm.load(address(router), router.DELIVERY_SLOT())), 1, "back to the idle value");
    }

    // ------------------------------------------------------------------------------------------------ access

    /// Claim: any account delivers through the router, and nothing is refused for who calls. Shows: a stranger, the
    /// recipient and the sender each call `executeMessage` as caller and origin; the first delivers, and the tip goes
    /// to the reward address. Matters: the
    /// bridge stays permissionless, and the router adds no whitelist.
    function test_anyAccountCanDeliverThroughTheRouter() public {
        address[3] memory others = [bob, recipient, alice];
        for (uint256 i = 0; i < others.length; i++) {
            uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 3 ether, 0), 100 ether);
            MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, index);
            vm.prank(others[i], others[i]);
            router.executeMessage(proof);
            assertEq(_copyB().balanceOf(reward), (i + 1) * 3 ether, "the tip goes to the reward address");

        }
    }

    /// Claim: a direct delivery pays no tip in any fee mode. Shows: for each fee mode, delivery on the bridge sends the
    /// whole amount to the recipient and nothing to any other account. Matters: the bridge stays permissionless, so a
    /// user is never stuck if nobody calls the router, and the user pays nothing.
    function test_aDirectDeliveryPaysNoTipInAnyMode() public {
        vm.txGasPrice(10 gwei);
        DeliveryRouter.FeeDirector[3] memory directors = [
            _director(router.FIXED_FEE(), 3 ether, 0),
            _director(router.MULTIPLIER_OF_TOTAL(), 0, 0.02 ether),
            _director(0, 100 ether, 1 ether)
        ];
        for (uint256 i = 0; i < directors.length; i++) {
            uint256 index = _sendTokenB(directors[i], 100 ether);
            vm.prank(bob);
            ambA.executeMessage(ambA.proofOf(ambB, index));
            assertEq(_copyB().balanceOf(recipient), 100 ether * (i + 1), "the recipient gets everything");
        }
        assertEq(_copyB().balanceOf(reward), 0, "a direct delivery pays no tip");
        assertEq(_copyB().balanceOf(bob), 0);
        assertEq(_copyB().balanceOf(address(router)), 0);
    }

    /// Claim: the reward address and the failed delivery address are fixed at deployment, and neither can be zero.
    function test_theAddressesAreFixedAtDeployment() public {
        assertEq(router.rewardAddress(), reward);
        assertEq(router.failedDeliveryAddress(), failedDelivery, "the failed delivery address is fixed");
        vm.expectRevert(DeliveryRouter.ZeroFailedDeliveryAddress.selector);
        new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), reward, address(0));
        vm.expectRevert(DeliveryRouter.ZeroRewardAddress.selector);
        new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), address(0), failedDelivery);

        // No function changes an address.
        bytes4[4] memory selectors = [
            bytes4(keccak256("setRewardAddress(address)")),
            bytes4(keccak256("changeRewardAddress(address)")),
            bytes4(keccak256("setFailedDeliveryAddress(address)")),
            bytes4(keccak256("runner()"))
        ];
        for (uint256 i = 0; i < selectors.length; i++) {
            (bool ok,) = address(router).call(abi.encodeWithSelector(selectors[i], bob));
            assertFalse(ok);
        }
    }

    /// Claim: the unwrap flag on a token that is not the wrapped native token pays the plain token, in every fee mode,
    /// and the tip comes in that token. Shows: fixed, multiplier of total, and gas based each pay the recipient the
    /// token, and the reward address holds its tip in the token and no coin.
    function test_unwrapOnAnotherTokenPaysTheTokenInEveryFeeMode() public {
        vm.txGasPrice(10 gwei);
        uint256 unwrap = router.UNWRAP();
        DeliveryRouter.FeeDirector[3] memory directors = [
            _director(router.FIXED_FEE() | unwrap, 3 ether, 0),
            _director(router.MULTIPLIER_OF_TOTAL() | unwrap, 0, 0.03 ether),
            _director(unwrap, 100 ether, 1 ether)
        ];
        for (uint256 i = 0; i < directors.length; i++) {
            uint256 rewardBefore = _copyB().balanceOf(reward);
            uint256 recipientBefore = _copyB().balanceOf(recipient);
            _runThroughRouter(_sendTokenB(directors[i], 100 ether));
            uint256 tip = _copyB().balanceOf(reward) - rewardBefore;
            assertGt(tip, 0, "the tip is taken in the token");
            assertEq(_copyB().balanceOf(recipient) - recipientBefore, 100 ether - tip, "the recipient gets the token");
            if (i < 2) assertEq(tip, 3 ether);
        }
        assertEq(reward.balance, 0, "no coin goes to the reward address");
        assertEq(recipient.balance, 0, "no coin goes to the recipient");
        assertEq(address(router).balance, 0);
        assertEq(_copyB().balanceOf(address(router)), 0);
    }

    /// Claim: the fixed tip wins when the fixed bit and the multiplier of total bit are both set. Shows: the tip is
    /// `limit`, not a share of the value, and the unit is not mixed.
    function test_fixedWinsOverMultiplierOfTotalWhenBothBitsAreSet() public {
        uint256 both = router.FIXED_FEE() | router.MULTIPLIER_OF_TOTAL();
        _runThroughRouter(_sendTokenB(_director(both, 2 ether, 0.5 ether), 100 ether));
        assertEq(_copyB().balanceOf(reward), 2 ether, "the fixed tip, not 50 percent");
        assertEq(_copyB().balanceOf(recipient), 98 ether);
        (uint256 fee,) = router.feeInfo(address(tokenB), 100 ether, 0, _director(both, 2 ether, 0.5 ether));
        assertEq(fee, 2 ether, "the view agrees");
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
            router.feeInfo(address(tokenB), 100 ether, 0, _director(router.MULTIPLIER_OF_TOTAL(), 0, 0.25 ether));
        assertEq(fee, 25 ether);
        assertEq(toRecipient, 75 ether);
    }
}
