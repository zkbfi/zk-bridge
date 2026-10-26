// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {FeeRouter} from "../../../src/hardened/mediator/FeeRouter.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {MediatorFixture, MockWrappedNative} from "./utils/MediatorSupport.sol";

/// @notice Measures the gas of a whole delivery through the fee router: the bridge execution, the mediator release,
/// the callback of the router, and the settlement of the fee. The explorer uses the figure as the default delivery gas
/// when the indexer has no delivery samples (`EXPLORER_DEFAULT_DELIVERY_GAS`, documented in `docs/explorer.md`).
/// The delivery goes through the mock bridge, which reads no proof. So the figure leaves out the cost of the proof check
/// of the real bridge (`MessageBridgeGas.t.sol`: about 290,000 gas on the recent path). A transaction adds 21,000 gas
/// and the cost of its calldata.
contract FeeRouterGasTest is MediatorFixture {
    uint256 internal constant TRANSACTION_BASE_GAS = 21_000;
    /// @dev The proof check of the real bridge on the recent path, from `MessageBridgeGas.t.sol`.
    uint256 internal constant BRIDGE_EXECUTION_GAS = 290_655;
    /// @dev The default delivery gas of the explorer indexer (`EXPLORER_DEFAULT_DELIVERY_GAS`).
    uint256 internal constant EXPLORER_DEFAULT_DELIVERY_GAS = 550_000;

    MockERC20 internal tokenB;
    FeeRouter internal router;
    address internal runner = makeAddr("runner");
    address internal reward = makeAddr("reward address");

    function setUp() public override {
        super.setUp();
        router = new FeeRouter(ITokenMediator(address(mediatorA)), IWETH(address(new MockWrappedNative())), runner, reward, reward);
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
        FeeRouter.FeeDirector memory director = FeeRouter.FeeDirector(makeAddr("recipient"), settings, limit, multiplier);
        vm.prank(alice);
        mediatorB.relayTokensAndCall(address(tokenB), address(router), 100 ether, abi.encode(director));
        return _lastIndexB();
    }

    function _measure(uint256 settings, uint256 limit, uint256 multiplier) private returns (uint256 used) {
        // A first run warms the storage of the router, as every run after the first finds it.
        MessageBridge.MessageProof memory warmProof = ambA.proofOf(ambB, _send(settings, limit, multiplier));
        vm.prank(runner, runner);
        router.executeMessageWithRunner(warmProof, reward);
        uint256 index = _send(settings, limit, multiplier);
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, index);
        vm.prank(runner, runner);
        uint256 before = gasleft();
        router.executeMessageWithRunner(proof, reward);
        used = before - gasleft();
    }

    function test_gasOfADeliveryThroughTheFeeRouter() public {
        vm.txGasPrice(10 gwei);
        uint256 fixedFee = _measure(router.FIXED_FEE(), 1 ether, 0);
        uint256 share = _measure(router.SHARE_OF_VALUE(), 0, 0.01 ether);
        uint256 gasBased = _measure(0, 10 ether, 1 ether);
        console2.log("fee router delivery, fixed fee (call gas):    ", fixedFee);
        console2.log("fee router delivery, share fee (call gas):    ", share);
        console2.log("fee router delivery, gas based fee (call gas):", gasBased);
        console2.log("add for a transaction:                        ", TRANSACTION_BASE_GAS);
        assertLt(
            gasBased + BRIDGE_EXECUTION_GAS + TRANSACTION_BASE_GAS,
            EXPLORER_DEFAULT_DELIVERY_GAS,
            "the default of the explorer stays above a real delivery"
        );
        assertGt(gasBased, fixedFee, "settlement after the call costs more than a fee paid in the callback");
    }
}
