// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {FeeRouter} from "../../../src/hardened/mediator/FeeRouter.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {MediatorFixture, MockAMB, MockWrappedNative, DenyListToken, CoinRefuser} from "./utils/MediatorSupport.sol";

/// @notice Tests of the executor fee router. Tokens flow from chain B to chain A, where the router lives. A runner
/// executes the message through the router and earns the fee that the sender wrote in the `FeeDirector`.
contract FeeRouterTest is MediatorFixture {
    MockERC20 internal tokenB;
    MockWrappedNative internal weth;
    FeeRouter internal router;
    address internal runner = makeAddr("runner");
    address internal recipient = makeAddr("recipient");

    function setUp() public override {
        super.setUp();
        weth = new MockWrappedNative();
        router = new FeeRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)));
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

    function _director(uint256 settings, uint256 limit, uint256 multiplier)
        internal
        view
        returns (FeeRouter.FeeDirector memory)
    {
        return FeeRouter.FeeDirector(recipient, settings, limit, multiplier);
    }

    /// @dev Chain B to the router on chain A. Returns the index of the message.
    function _sendTokenB(FeeRouter.FeeDirector memory director, uint256 value) internal returns (uint256) {
        vm.prank(alice);
        mediatorB.relayTokensAndCall(address(tokenB), address(router), value, abi.encode(director));
        return _lastIndexB();
    }

    function _runThroughRouter(address account, uint256 index) internal {
        router.executeMessageWithRunner(account, abi.encode(address(ambB), index));
    }

    function _copyB() internal view returns (IERC20) {
        return IERC20(mediatorA.bridgedTokenAddress(address(tokenB)));
    }

    /// @dev Gives alice the copy of the wrapped token on chain B and sends it back to the router with a director.
    function _sendWrappedBack(FeeRouter.FeeDirector memory director, uint256 value, bytes memory data)
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
        _runThroughRouter(runner, index);

        assertEq(_copyB().balanceOf(runner), 3 ether);
        assertEq(_copyB().balanceOf(recipient), 97 ether);
        assertEq(_copyB().balanceOf(address(router)), 0, "the router keeps nothing");
    }

    function test_aShareOfTheValueGoesToTheRunner() public {
        // The multiplier is scaled by 1e18: 0.02 is 2%.
        uint256 index = _sendTokenB(_director(router.SHARE_OF_VALUE(), 0, 0.02 ether), 500 ether);
        _runThroughRouter(runner, index);

        assertEq(_copyB().balanceOf(runner), 10 ether);
        assertEq(_copyB().balanceOf(recipient), 490 ether);
    }

    function test_theFixedModeWinsOverTheShareMode() public {
        uint256 index =
            _sendTokenB(_director(router.FIXED_FEE() | router.SHARE_OF_VALUE(), 1 ether, 0.5 ether), 100 ether);
        _runThroughRouter(runner, index);
        assertEq(_copyB().balanceOf(runner), 1 ether);
    }

    function test_aGasBasedFeeUsesTheGasPriceAndTheMultiplier() public {
        vm.txGasPrice(10 gwei);
        uint256 index = _sendTokenB(_director(0, 100 ether, 1 ether), 1_000 ether);
        _runThroughRouter(runner, index);

        uint256 fee = _copyB().balanceOf(runner);
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
        _runThroughRouter(runner, indexOne);
        uint256 plainFee = _copyB().balanceOf(runner);

        // The mock bridge, like the real one, forwards exactly the gas limit of the message and holds the rest back.
        address greedy = makeAddr("greedy");
        uint256 indexTwo = _sendTokenB(_director(0, 100 ether, 1 ether), 1_000 ether);
        router.executeMessageWithRunner{gas: 50_000_000}(greedy, abi.encode(address(ambB), indexTwo));
        uint256 greedyFee = _copyB().balanceOf(greedy);

        assertGt(greedyFee, 0);
        assertLt(greedyFee, plainFee * 12 / 10, "supplying 50 million gas buys no extra fee");
    }

    function test_theMultiplierScalesAGasBasedFee() public {
        vm.txGasPrice(10 gwei);
        // A first run warms the storage of the router, so the two measured runs cost nearly the same.
        _runThroughRouter(makeAddr("warm"), _sendTokenB(_director(0, 100 ether, 1 ether), 1_000 ether));
        uint256 indexOne = _sendTokenB(_director(0, 100 ether, 1 ether), 1_000 ether);
        _runThroughRouter(runner, indexOne);
        uint256 feeOne = _copyB().balanceOf(runner);

        address runnerTwo = makeAddr("runnerTwo");
        uint256 indexTwo = _sendTokenB(_director(0, 100 ether, 2 ether), 1_000 ether);
        _runThroughRouter(runnerTwo, indexTwo);
        uint256 feeTwo = _copyB().balanceOf(runnerTwo);

        // The two runs use nearly the same gas, so doubling the multiplier nearly doubles the fee.
        assertGt(feeTwo, feeOne * 19 / 10);
        assertLt(feeTwo, feeOne * 21 / 10);
    }

    function test_aGasBasedFeeIsCappedByTheLimit() public {
        vm.txGasPrice(10 gwei);
        uint256 index = _sendTokenB(_director(0, 12_345, 1 ether), 1_000 ether);
        _runThroughRouter(runner, index);
        assertEq(_copyB().balanceOf(runner), 12_345, "capped");
        assertEq(_copyB().balanceOf(recipient), 1_000 ether - 12_345);
    }

    function test_theBaseFeeOnlyFlagPricesGasAtTheBaseFee() public {
        vm.txGasPrice(50 gwei);
        vm.fee(7 gwei);
        uint256 index = _sendTokenB(_director(router.BASE_FEE_ONLY(), 100 ether, 1 ether), 1_000 ether);
        _runThroughRouter(runner, index);
        uint256 fee = _copyB().balanceOf(runner);
        assertEq(fee % 7 gwei, 0, "priced at the base fee");
        assertGt(fee, 100_000 * 7 gwei);
        assertLt(fee, (100_000 + 1_000_000) * 7 gwei);
    }

    function test_aGasBasedFeeInTheNativeCoinIsSettledInTheCoin() public {
        vm.txGasPrice(10 gwei);
        uint256 index = _sendWrappedBack(_director(router.UNWRAP(), 1 ether, 1 ether), 5 ether, "");
        uint256 recipientBefore = recipient.balance;
        _runThroughRouter(runner, index);
        uint256 fee = runner.balance;
        assertGt(fee, 50_000 * 10 gwei);
        assertLe(fee, 1 ether);
        assertEq(recipient.balance - recipientBefore, 5 ether - fee);
        assertEq(address(router).balance, 0);
        assertEq(weth.totalSupply(), 0);
    }

    function test_aGasBasedFeeWithNoRunnerIsZero() public {
        vm.txGasPrice(10 gwei);
        uint256 index = _sendTokenB(_director(0, 100 ether, 1 ether), 1_000 ether);
        ambA.executeMessage(abi.encode(address(ambB), index));
        assertEq(_copyB().balanceOf(recipient), 1_000 ether);
    }

    function test_aGasBasedRunnerThatCannotTakeTheCoinLeavesTheRecipientWholeInCoin() public {
        vm.txGasPrice(10 gwei);
        address refuser = address(new CoinRefuser());
        uint256 index = _sendWrappedBack(_director(router.UNWRAP(), 1 ether, 1 ether), 5 ether, "");
        uint256 recipientBefore = recipient.balance;
        _runThroughRouter(refuser, index);
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
        _runThroughRouter(runner, index);
        assertEq(_copyB().balanceOf(runner), 100 ether);
        assertEq(_copyB().balanceOf(recipient), 0);
    }

    function test_noRunnerMeansNoFee() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 3 ether, 0), 100 ether);
        // Anyone executes the message on the bridge directly. The router sees no runner.
        ambA.executeMessage(abi.encode(address(ambB), index));
        assertEq(_copyB().balanceOf(recipient), 100 ether, "everything goes to the recipient");
        assertEq(_copyB().balanceOf(runner), 0);
    }

    function test_theRunnerSlotIsClearedAfterTheRun() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 1 ether, 0), 10 ether);
        _runThroughRouter(runner, index);
        assertEq(uint256(vm.load(address(router), router.RUNNER_SLOT())), 1, "back to the idle value");

        // A later direct execution pays no fee, because the slot holds no runner.
        uint256 next = _sendTokenB(_director(router.FIXED_FEE(), 1 ether, 0), 10 ether);
        ambA.executeMessage(abi.encode(address(ambB), next));
        assertEq(_copyB().balanceOf(runner), 1 ether, "still the first fee only");
    }

    function test_aRunWhileAnotherRunIsInProgressIsRefused() public {
        vm.store(address(router), router.RUNNER_SLOT(), bytes32(uint256(5)));
        vm.expectRevert(FeeRouter.RunnerSlotInUse.selector);
        router.executeMessageWithRunner(runner, "");
    }

    function test_theSlotIsTheOneOfGibsfinance() public view {
        assertEq(router.RUNNER_SLOT(), keccak256(abi.encode("omnibridgerouter.runner")), "the slot of gibsfinance");
    }

    // ------------------------------------------------------------------------------------------------ unwrap

    function test_unwrapPaysTheRecipientAndTheRunnerInTheNativeCoin() public {
        uint256 index = _sendWrappedBack(_director(router.FIXED_FEE() | router.UNWRAP(), 0.4 ether, 0), 5 ether, "");
        uint256 recipientBefore = recipient.balance;
        uint256 runnerBefore = runner.balance;
        _runThroughRouter(runner, index);

        assertEq(runner.balance - runnerBefore, 0.4 ether);
        assertEq(recipient.balance - recipientBefore, 4.6 ether);
        assertEq(weth.totalSupply(), 0, "unwrapped");
        assertEq(weth.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }

    function test_unwrapWithARunnerThatCannotTakeTheCoinPaysTheRecipientInFull() public {
        address refuser = address(new CoinRefuser());
        uint256 index = _sendWrappedBack(_director(router.FIXED_FEE() | router.UNWRAP(), 0.4 ether, 0), 5 ether, "");
        uint256 recipientBefore = recipient.balance;
        _runThroughRouter(refuser, index);
        assertEq(recipient.balance - recipientBefore, 5 ether, "a runner cannot block the recipient");
        assertEq(refuser.balance, 0);
    }

    function test_unwrapWithARecipientThatCannotTakeTheCoinPaysTheWrappedToken() public {
        address refuser = address(new CoinRefuser());
        FeeRouter.FeeDirector memory director =
            FeeRouter.FeeDirector(refuser, router.UNWRAP() | router.SHARE_OF_VALUE(), 0, 0.1 ether);
        uint256 index = _sendWrappedBack(director, 5 ether, "");
        _runThroughRouter(runner, index);
        assertEq(weth.balanceOf(refuser), 4.5 ether, "paid as the wrapped token");
        assertEq(runner.balance, 0.5 ether);
        assertEq(address(router).balance, 0);
    }

    function test_theUnwrapFlagIsIgnoredForAnotherToken() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE() | router.UNWRAP(), 1 ether, 0), 10 ether);
        _runThroughRouter(runner, index);
        assertEq(_copyB().balanceOf(recipient), 9 ether, "only the wrapped native token unwraps");
        assertEq(_copyB().balanceOf(runner), 1 ether);
    }

    function test_theLegacyTwentyByteFormUnwrapsWithNoFee() public {
        uint256 index = _sendWrappedBack(_director(0, 0, 0), 2 ether, abi.encodePacked(carol));
        uint256 carolBefore = carol.balance;
        _runThroughRouter(runner, index);
        assertEq(carol.balance - carolBefore, 2 ether);
        assertEq(runner.balance, 0, "no fee in the legacy form");
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
        token.setDenied(runner, true);

        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(
            copy, address(router), 50 ether, abi.encode(_director(router.FIXED_FEE(), 5 ether, 0))
        );
        vm.stopPrank();
        _runThroughRouter(runner, _lastIndexB());

        assertEq(token.balanceOf(recipient), 50 ether, "the fee that the runner could not take goes to the recipient");
        assertEq(token.balanceOf(runner), 0);
        assertEq(token.balanceOf(address(router)), 0);
    }

    // ------------------------------------------------------------------------------------------------ access

    function test_onlyTheMediatorCanCallOnTokenBridged() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.NotMediator.selector, bob));
        router.onTokenBridged(address(tokenB), 1, abi.encode(_director(0, 0, 0)));
    }

    function test_theRouterTakesTheCoinOnlyFromTheWrappedToken() public {
        vm.prank(bob);
        (bool ok, bytes memory returned) = address(router).call{value: 0}("");
        assertFalse(ok);
        assertEq(returned, abi.encodeWithSelector(FeeRouter.NotWrappedTokenSender.selector, bob));
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
