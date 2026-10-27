// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {DeliveryRouter} from "../../../src/hardened/mediator/DeliveryRouter.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {MediatorFixture, MockWrappedNative} from "./utils/MediatorSupport.sol";
import {CallBurner, CallRecorder} from "./utils/CallTargets.sol";

/// @notice Measures the gas of a whole delivery through the delivery router: the bridge execution, the mediator release,
/// and the callback of the router, which pays the tip and the recipient. The explorer uses the figure as the default delivery gas
/// when the indexer has no delivery samples (`EXPLORER_DEFAULT_DELIVERY_GAS`, documented in `docs/explorer.md`).
/// The delivery goes through the mock bridge, which reads no proof. So the figure leaves out the cost of the proof check
/// of the real bridge (`MessageBridgeGas.t.sol`: about 290,000 gas on the recent path). A transaction adds 21,000 gas
/// and the cost of its calldata.
contract DeliveryRouterGasTest is MediatorFixture {
    uint256 internal constant TRANSACTION_BASE_GAS = 21_000;
    /// @dev The proof check of the real bridge on the recent path, from `MessageBridgeGas.t.sol`.
    uint256 internal constant BRIDGE_EXECUTION_GAS = 290_655;
    /// @dev The default delivery gas of the explorer indexer (`EXPLORER_DEFAULT_DELIVERY_GAS`).
    uint256 internal constant EXPLORER_DEFAULT_DELIVERY_GAS = 550_000;

    MockERC20 internal tokenB;
    DeliveryRouter internal router;
    address internal reward = makeAddr("reward address");

    function setUp() public override {
        super.setUp();
        router = new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(new MockWrappedNative())), reward, reward);
        tokenB = new MockERC20("Token B", "TKB");
        tokenB.mint(alice, 1_000_000 ether);
        vm.startPrank(alice);
        tokenB.approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokens(address(tokenB), alice, 1 ether);
        vm.stopPrank();
        // The first message of a token deploys its copy. The measures below are of later messages.
        _deliverBtoA(_lastIndexB());
    }

    function _send(uint256 settings, uint256 limit, uint256 multiplier) private returns (uint256) {
        DeliveryRouter.FeeDirector memory director = DeliveryRouter.FeeDirector(makeAddr("recipient"), settings, limit, multiplier);
        vm.prank(alice);
        mediatorB.relayTokensAndCall(address(tokenB), address(router), 100 ether, abi.encode(director));
        return _lastIndexB();
    }

    function _measure(uint256 settings, uint256 limit, uint256 multiplier) private returns (uint256 used) {
        // A first run warms the storage of the router, as every run after the first finds it.
        MessageBridge.MessageProof memory warmProof = ambA.proofOf(ambB, _send(settings, limit, multiplier));
        vm.prank(alice, alice);
        router.executeMessage(warmProof);
        uint256 index = _send(settings, limit, multiplier);
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, index);
        vm.prank(alice, alice);
        uint256 before = gasleft();
        router.executeMessage(proof);
        used = before - gasleft();
    }

    function test_gasOfADeliveryThroughTheDeliveryRouter() public {
        vm.txGasPrice(10 gwei);
        uint256 fixedFee = _measure(router.FIXED_FEE(), 1 ether, 0);
        uint256 multiplier = _measure(router.MULTIPLIER_OF_TOTAL(), 0, 0.01 ether);
        uint256 gasBased = _measure(0, 10 ether, 1 ether);
        console2.log("delivery router delivery, fixed fee (call gas):    ", fixedFee);
        console2.log("delivery router delivery, multiplier of total fee (call gas):", multiplier);
        console2.log("delivery router delivery, gas based fee (call gas):", gasBased);
        console2.log("add for a transaction:                        ", TRANSACTION_BASE_GAS);
        assertLt(
            gasBased + BRIDGE_EXECUTION_GAS + TRANSACTION_BASE_GAS,
            EXPLORER_DEFAULT_DELIVERY_GAS,
            "the default of the explorer stays above a real delivery"
        );
        assertLt(gasBased, 150_000, "a delivery stays below 150,000 gas of call gas");
        assertGe(gasBased, fixedFee, "measuring the gas costs a little more than a fixed tip");
        assertLt(gasBased - fixedFee, 5_000, "the gas based tip is paid in the callback, so it costs about the same as a fixed tip");
    }

    // ------------------------------------------------------------------------------------------------ the call

    /// @dev The harness: the test contract is the mediator of this router, so a test calls `onTokenBridged` with exact gas.
    function _harnessRouter(MockWrappedNative wrapped) private returns (DeliveryRouter) {
        return new DeliveryRouter(ITokenMediator(address(this)), IWETH(address(wrapped)), reward, reward);
    }

    /// Claim: the reserve of 10,000 gas that the router keeps for the call after a delivery is more than twice what the
    /// router needs after the call. Shows: with a burning target, 500,000 gas supplied and a router that runs a
    /// direct delivery, the gas that comes back to the caller is measured, and the need (reserve less returned gas)
    /// is logged. The measure includes the cost of the call into the router, so the need is a little too high. This
    /// holds while 1/64 of the gas at the call is below the reserve, which is true below 640,000 gas. Matters: a
    /// reserve that is too small lets the burning target starve the exit of the callback; one that is far too
    /// large wastes the gas of the deliverer.
    function test_theReserveOfTheCallCoversTheWorkAfterTheCallWithRoom() public {
        MockERC20 token = new MockERC20("Harness", "HRN");
        DeliveryRouter harness = _harnessRouter(new MockWrappedNative());
        CallBurner burner = new CallBurner();
        address recipient = makeAddr("recipient");
        token.mint(address(harness), 100 ether);
        // The recipient exists already, so the payment before the call is not the first one to a new account.
        token.mint(recipient, 1);
        bytes memory data = bytes.concat(
            abi.encode(DeliveryRouter.FeeDirector(recipient, harness.FIXED_FEE(), 1 ether, 0)),
            abi.encodePacked(address(burner)),
            hex"01"
        );
        bytes memory payload = abi.encodeCall(DeliveryRouter.onTokenBridged, (address(token), 100 ether, data));
        uint256 reserve = harness.CALL_GAS_RESERVE();
        // Warm the router, so the measure does not count the first access to its address.
        harness.CALL_GAS_RESERVE();

        uint256 gasBefore = gasleft();
        (bool succeeded,) = address(harness).call{gas: 500_000}(payload);
        uint256 gasAfter = gasleft();

        assertTrue(succeeded, "the delivery finished");
        assertEq(token.balanceOf(recipient), 1 + 100 ether, "the payment stands, with no tip on a direct delivery");
        uint256 returned = 500_000 - (gasBefore - gasAfter);
        uint256 need = reserve - returned;
        console2.log("gas returned to the caller after the burn:", returned);
        console2.log("gas of the reserve that the router needs after the call:", need);
        console2.log("reserve:", reserve);
        assertLt(need * 2, reserve, "the router needs less than half of the reserve");
    }

    /// @dev Runs one gas based delivery in the harness with the starting gas equal to the supplied gas, and returns the
    /// gas that ran after the measure point of the fee: the whole frame less the gas at the measure. The whole frame is
    /// measured from outside, so it includes the cost of the call into the router and the figure is an upper bound.
    function _gasAfterTheMeasure(DeliveryRouter harness, address token, uint256 value, address recipient, bytes memory data)
        private
        returns (uint256 gasAfterMeasure)
    {
        uint256 supplied = 400_000;
        vm.store(address(harness), harness.DELIVERY_SLOT(), bytes32(supplied));
        bytes memory payload = abi.encodeCall(DeliveryRouter.onTokenBridged, (token, value, data));
        // Warm the router address.
        harness.DELIVERY_SLOT();
        uint256 gasBefore = gasleft();
        (bool succeeded,) = address(harness).call{gas: supplied}(payload);
        uint256 gasAfter = gasleft();
        assertTrue(succeeded, "the delivery finished");
        uint256 frameGas = gasBefore - gasAfter;
        // The tip in gas units: the gas used before the measure plus the overhead, at a multiplier of 1 and a price of 1.
        uint256 measuredGas = _tipOf(token, harness.rewardAddress()) - _overheadOf(harness, token);
        assertLt(measuredGas, frameGas, "the measure is part of the frame");
        gasAfterMeasure = frameGas - measuredGas;
        assertEq(_balanceOf(token, address(harness)), 0, "the router kept nothing");
        assertGt(_balanceOf(token, recipient) + recipient.balance, 0, "the recipient was paid");
    }

    function _balanceOf(address token, address account) private view returns (uint256) {
        return MockERC20(token).balanceOf(account);
    }

    function _tipOf(address token, address account) private view returns (uint256) {
        // The gas price is 1 wei and the multiplier 1e18, so the tip in token units or coin units equals the gas.
        uint256 asToken = _balanceOf(token, account);
        return asToken == 0 ? account.balance : asToken;
    }

    function _overheadOf(DeliveryRouter harness, address token) private view returns (uint256) {
        return token == address(harness.wNative()) ? harness.NATIVE_GAS_OVERHEAD() : harness.TOKEN_GAS_OVERHEAD();
    }

    /// Claim: the token overhead of 100,000 gas covers the work that runs after the measure point of the gas based fee.
    /// Shows: a token payout in the harness (tip transfer to a new account, payment to a new account, guard exit)
    /// uses less gas after the measure than `TOKEN_GAS_OVERHEAD`; both figures are logged. Matters: if the overhead is
    /// below the real work, the tip under-charges the deliverer.
    function test_theTokenOverheadCoversTheWorkAfterTheMeasure() public {
        vm.txGasPrice(1);
        MockERC20 token = new MockERC20("Harness", "HRN");
        DeliveryRouter harness = _harnessRouter(new MockWrappedNative());
        address recipient = makeAddr("fresh recipient");
        token.mint(address(harness), 1_000_000 ether);
        bytes memory data = abi.encode(DeliveryRouter.FeeDirector(recipient, 0, type(uint128).max, 1 ether));

        uint256 afterMeasure = _gasAfterTheMeasure(harness, address(token), 1_000_000 ether, recipient, data);
        console2.log("token payout, gas after the measure (upper bound):", afterMeasure);
        console2.log("TOKEN_GAS_OVERHEAD:", harness.TOKEN_GAS_OVERHEAD());
        assertLt(afterMeasure, harness.TOKEN_GAS_OVERHEAD(), "the token overhead covers the work after the measure");
    }

    /// @dev Funds the harness router with wrapped native token, backed by coin held in the wrapped token.
    function _fundWithWrapped(MockWrappedNative wrapped, DeliveryRouter harness, uint256 amount) private {
        vm.deal(address(this), amount);
        wrapped.deposit{value: amount}();
        wrapped.transfer(address(harness), amount);
    }

    /// Claim: the native overhead of 50,000 gas covers the work after the measure point when both payees are accounts
    /// that exist. Shows: an unwrapped payout to a recipient and a reward address that hold coin already uses less gas
    /// after the measure than `NATIVE_GAS_OVERHEAD`; both figures are logged. Matters: an overhead below the real work
    /// under-charges the deliverer.
    function test_theNativeOverheadCoversTheWorkAfterTheMeasureForExistingAccounts() public {
        vm.txGasPrice(1);
        MockWrappedNative wrapped = new MockWrappedNative();
        DeliveryRouter harness = _harnessRouter(wrapped);
        address recipient = makeAddr("existing recipient");
        vm.deal(recipient, 1 wei);
        vm.deal(harness.rewardAddress(), 1 wei);
        _fundWithWrapped(wrapped, harness, 100 ether);
        bytes memory data = abi.encode(DeliveryRouter.FeeDirector(recipient, harness.UNWRAP(), type(uint128).max, 1 ether));

        uint256 afterMeasure = _gasAfterTheMeasure(harness, address(wrapped), 100 ether, recipient, data);
        console2.log("native payout to existing accounts, gas after the measure (upper bound):", afterMeasure);
        console2.log("NATIVE_GAS_OVERHEAD:", harness.NATIVE_GAS_OVERHEAD());
        assertLt(afterMeasure, harness.NATIVE_GAS_OVERHEAD(), "the native overhead covers the work after the measure");
    }

    /// Claim: the native overhead of 50,000 gas covers the work after the measure point when both payees are new
    /// accounts. Shows: the same payout to a recipient and a reward address with no coin uses less gas after the
    /// measure than `NATIVE_GAS_OVERHEAD`; both figures are logged. Matters: the first coin sent to an empty account
    /// costs 25,000 gas more, and a tip that under-charges for it is a real loss for the deliverer.
    function test_theNativeOverheadCoversTheWorkAfterTheMeasureForNewAccounts() public {
        vm.txGasPrice(1);
        MockWrappedNative wrapped = new MockWrappedNative();
        DeliveryRouter harness = _harnessRouter(wrapped);
        address recipient = makeAddr("new recipient");
        _fundWithWrapped(wrapped, harness, 100 ether);
        bytes memory data = abi.encode(DeliveryRouter.FeeDirector(recipient, harness.UNWRAP(), type(uint128).max, 1 ether));

        uint256 afterMeasure = _gasAfterTheMeasure(harness, address(wrapped), 100 ether, recipient, data);
        console2.log("native payout to new accounts, gas after the measure (upper bound):", afterMeasure);
        console2.log("NATIVE_GAS_OVERHEAD:", harness.NATIVE_GAS_OVERHEAD());
        assertLt(afterMeasure, harness.NATIVE_GAS_OVERHEAD(), "the native overhead covers the work after the measure");
    }

    /// Claim: the native overhead of 50,000 gas covers the work after the measure point in the usual case: the reward
    /// address holds coin already and the recipient is a new account. Shows: the figure is below
    /// `NATIVE_GAS_OVERHEAD`; both numbers are logged. Matters: this is the case that the reward address meets after its first tip.
    function test_theNativeOverheadCoversTheWorkAfterTheMeasureForANewRecipientAndAFundedRewardAddress() public {
        vm.txGasPrice(1);
        MockWrappedNative wrapped = new MockWrappedNative();
        DeliveryRouter harness = _harnessRouter(wrapped);
        address recipient = makeAddr("new recipient only");
        vm.deal(harness.rewardAddress(), 1 wei);
        _fundWithWrapped(wrapped, harness, 100 ether);
        bytes memory data = abi.encode(DeliveryRouter.FeeDirector(recipient, harness.UNWRAP(), type(uint128).max, 1 ether));

        uint256 afterMeasure = _gasAfterTheMeasure(harness, address(wrapped), 100 ether, recipient, data);
        console2.log("native payout to a new recipient, funded reward address (upper bound):", afterMeasure);
        console2.log("NATIVE_GAS_OVERHEAD:", harness.NATIVE_GAS_OVERHEAD());
        assertLt(afterMeasure, harness.NATIVE_GAS_OVERHEAD(), "the native overhead covers the work after the measure");
    }
}
