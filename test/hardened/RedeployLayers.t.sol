// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {TokenMediator} from "../../src/hardened/mediator/TokenMediator.sol";
import {BridgedToken} from "../../src/hardened/mediator/BridgedToken.sol";
import {DeliveryRouter} from "../../src/hardened/mediator/DeliveryRouter.sol";
import {ITokenMediator} from "../../src/hardened/mediator/ITokenMediator.sol";
import {IWETH} from "../../src/hardened/mediator/IWETH.sol";
import {RedeployLayers} from "../../script/hardened/RedeployLayers.s.sol";
import {WorldSupport} from "./utils/WorldSupport.sol";
import {MockWrappedNative} from "./mediator/utils/MediatorSupport.sol";

/// @notice The redeploy script on a two chain world: it reads what it keeps from the running contracts, deploys new
/// layers at the predicted addresses on both chains, and the new layers carry a token over the kept light clients and
/// gates. It also replaces a router alone.
contract RedeployLayersTest is WorldSupport {
    RedeployLayers internal script = new RedeployLayers();
    address internal deployer = makeAddr("deployer");
    address internal reward = makeAddr("reward");
    address internal failedDelivery = makeAddr("failed delivery");
    DeliveryRouter internal routerA;
    DeliveryRouter internal routerB;

    uint256 internal constant NONCE_A = 40;
    uint256 internal constant NONCE_B = 73;

    function setUp() public override {
        super.setUp();
        vm.chainId(CHAIN_A);
        routerA = new DeliveryRouter(
            ITokenMediator(address(mediatorA)), IWETH(address(new MockWrappedNative())), reward, failedDelivery
        );
        vm.chainId(CHAIN_B);
        routerB = new DeliveryRouter(
            ITokenMediator(address(mediatorB)), IWETH(address(new MockWrappedNative())), reward, failedDelivery
        );
    }

    function _chain(uint64 chainId, uint256 nonce, MessageBridge bridge, TokenMediator mediator, DeliveryRouter router)
        internal
        pure
        returns (RedeployLayers.ChainConfig memory chain)
    {
        chain.rpcAlias = "local";
        chain.chainId = chainId;
        chain.deployerNonce = nonce;
        chain.previousBridge = address(bridge);
        chain.previousMediator = address(mediator);
        chain.previousRouter = address(router);
    }

    /// Claim: the script keeps the light clients, the gates and every shared value, and puts new bridges, mediators and
    /// routers at the predicted addresses of both chains, which then carry a token. Shows: the kept values equal those
    /// of the old contracts; the new contracts sit at the plan; the new bridges name each other and the new mediators
    /// name each other; a token relayed through the new mediator on chain A arrives on chain B through the new bridge.
    /// Matters: layers 1 and 2 change in this redeploy, and nothing below them may change with them.
    function test_theNewLayersUseTheKeptContractsAndCarryAToken() public {
        RedeployLayers.ChainConfig memory chainA = _chain(uint64(CHAIN_A), NONCE_A, bridgeA, mediatorA, routerA);
        RedeployLayers.ChainConfig memory chainB = _chain(uint64(CHAIN_B), NONCE_B, bridgeB, mediatorB, routerB);
        vm.chainId(CHAIN_A);
        RedeployLayers.Kept memory keptA = script.readKept(chainA);
        vm.chainId(CHAIN_B);
        RedeployLayers.Kept memory keptB = script.readKept(chainB);
        assertEq(keptA.lightClient, address(lightClientForA), "chain A keeps its light client");
        assertEq(keptA.gate, address(bridgeA.depositGate()), "and its gate");
        assertEq(keptB.remoteLightClient, address(lightClientForA), "chain B keeps the remote light client");
        assertEq(keptA.rewardAddress, reward);
        assertEq(keptA.remoteChainName, "Chain B");

        RedeployLayers.Planned memory planA = script.plan(deployer, NONCE_A);
        RedeployLayers.Planned memory planB = script.plan(deployer, NONCE_B);
        vm.chainId(CHAIN_A);
        vm.setNonce(deployer, uint64(NONCE_A));
        script.deployLayers(deployer, chainA, keptA, planA, uint64(CHAIN_B), planB);
        vm.chainId(CHAIN_B);
        vm.setNonce(deployer, uint64(NONCE_B));
        script.deployLayers(deployer, chainB, keptB, planB, uint64(CHAIN_A), planA);

        MessageBridge newBridgeA = MessageBridge(planA.bridge);
        assertEq(newBridgeA.remoteBridge(), planB.bridge, "the new bridges name each other");
        assertEq(TokenMediator(planA.mediator).mediatorContractOnOtherSide(), planB.mediator, "and the new mediators");
        assertEq(address(newBridgeA.lightClient()), address(lightClientForA), "over the kept light client");
        assertEq(address(DeliveryRouter(payable(planB.router)).bridge()), planB.mediator, "the new router names it");

        bridgeA = newBridgeA;
        bridgeB = MessageBridge(planB.bridge);
        mediatorA = TokenMediator(planA.mediator);
        mediatorB = TokenMediator(planB.mediator);
        _openDepositsWithoutProof(bridgeA);
        _openDepositsWithoutProof(bridgeB);

        MockERC20 token = new MockERC20("Token", "TKN");
        token.mint(alice, 10 ether);
        vm.chainId(CHAIN_A);
        vm.startPrank(alice);
        token.approve(address(mediatorA), 10 ether);
        vm.recordLogs();
        mediatorA.relayTokens(address(token), bob, 10 ether);
        vm.stopPrank();
        Transit memory transit = _deliverToB(vm.getRecordedLogs());
        assertTrue(bridgeB.messageCallStatus(transit.messageId), "the new bridge on chain B delivers");
        assertEq(BridgedToken(mediatorB.bridgedTokenAddress(address(token))).balanceOf(bob), 10 ether);
    }

    /// Claim: a router can be replaced alone. Shows: `deployRouter` puts a router for the running mediator at the
    /// deployer nonce, with the kept wrapped token, reward address and failed delivery address. Matters: layer 3 is
    /// swappable with no change to layers 1 and 2.
    function test_aRouterIsReplacedAlone() public {
        RedeployLayers.ChainConfig memory chainA = _chain(uint64(CHAIN_A), NONCE_A, bridgeA, mediatorA, routerA);
        vm.chainId(CHAIN_A);
        RedeployLayers.Kept memory kept = script.readKept(chainA);
        vm.setNonce(deployer, uint64(NONCE_A));
        address replaced = script.deployRouter(chainA, kept, deployer);
        assertEq(replaced, vm.computeCreateAddress(deployer, NONCE_A));
        assertEq(address(DeliveryRouter(payable(replaced)).bridge()), address(mediatorA), "the running mediator");
        assertEq(DeliveryRouter(payable(replaced)).rewardAddress(), reward);
    }

    /// Claim: the read-back refuses a deployment that differs from what was kept. Shows: a router for another mediator
    /// fails `verifyRouter` with the field name; a contract with no code is refused as a previous contract.
    function test_theReadBackRefusesAMismatch() public {
        RedeployLayers.ChainConfig memory chainA = _chain(uint64(CHAIN_A), NONCE_A, bridgeA, mediatorA, routerA);
        vm.chainId(CHAIN_A);
        RedeployLayers.Kept memory kept = script.readKept(chainA);
        vm.expectRevert(abi.encodeWithSelector(RedeployLayers.DeploymentMismatch.selector, "router.mediator"));
        script.verifyRouter(routerA, address(mediatorB), kept);

        chainA.previousRouter = makeAddr("nothing here");
        vm.expectRevert(abi.encodeWithSelector(RedeployLayers.NoCode.selector, "previousRouter", chainA.previousRouter));
        script.readKept(chainA);
    }

    /// Claim: the configuration is read, and a placeholder nonce is refused. Shows: the testnet file parses with the
    /// placeholder refused by name.
    function test_theTestnetConfigurationRefusesItsPlaceholderNonce() public {
        string memory json = vm.readFile("script/testnet/redeploy.config.testnet.json");
        vm.expectRevert(abi.encodeWithSelector(RedeployLayers.PlaceholderValue.selector, ".chainA.deployerNonce"));
        script.readChain(json, ".chainA");
    }
}
