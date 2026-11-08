// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {TokenMediator} from "../../src/hardened/mediator/TokenMediator.sol";
import {BridgedToken} from "../../src/hardened/mediator/BridgedToken.sol";
import {TokenFactory} from "../../src/hardened/mediator/TokenFactory.sol";
import {LinkedCode} from "../../script/hardened/LinkedCode.sol";
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
        assertEq(vm.getNonce(deployer), NONCE_A + script.LAYER_CREATIONS(), "eight creations on chain A");
        vm.chainId(CHAIN_B);
        vm.setNonce(deployer, uint64(NONCE_B));
        script.deployLayers(deployer, chainB, keptB, planB, uint64(CHAIN_A), planA);
        assertEq(vm.getNonce(deployer), NONCE_B + script.LAYER_CREATIONS(), "eight creations on chain B");
        assertEq(TokenFactory(planA.factory).mediator(), planA.mediator, "the factory names the new mediator");
        assertEq(address(TokenMediator(planA.mediator).tokenFactory()), planA.factory, "and the mediator takes it");
        assertEq(TokenFactory(planA.factory).homeChainName(), "Chain B", "with the kept home chain name");

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

    /// Claim: the plan puts the eight creations of a chain at eight consecutive deployer nonces, in the order of the
    /// table of the script. Shows: each planned address is `computeCreateAddress(deployer, n + i)`. Matters: the bridges
    /// and the mediators name their twins by these addresses before anything is sent.
    function test_thePlanPutsEightCreationsAtConsecutiveNonces() public view {
        RedeployLayers.Planned memory planned = script.plan(deployer, NONCE_A);
        address[8] memory order = [
            planned.receiptProofLib,
            planned.openingProofLib,
            planned.beaconLayoutLib,
            planned.bridge,
            planned.mediatorPayloadsLib,
            planned.factory,
            planned.mediator,
            planned.router
        ];
        assertEq(order.length, script.LAYER_CREATIONS());
        for (uint256 i = 0; i < order.length; i++) {
            assertEq(order[i], vm.computeCreateAddress(deployer, NONCE_A + i));
        }
    }

    /// Claim: the read-back checks the code of every library and every link site of the bridge and the mediator.
    /// Shows: after an honest deployment both checks pass; a plan whose bridge is a bridge linked to other libraries (the
    /// old bridge of the world) fails with `LinkMismatch`; a plan that names one library at the address of another fails
    /// with `LibraryCodeMismatch`; a plan whose factory is other code fails with `BuiltCodeMismatch`. Matters: a linked library is part of the immutable code of the bridge; a bridge linked
    /// to the wrong code would verify messages by other rules.
    function test_theReadBackChecksTheLibrariesAndTheLinks() public {
        RedeployLayers.ChainConfig memory chainA = _chain(uint64(CHAIN_A), NONCE_A, bridgeA, mediatorA, routerA);
        vm.chainId(CHAIN_A);
        RedeployLayers.Kept memory keptA = script.readKept(chainA);
        RedeployLayers.Planned memory planA = script.plan(deployer, NONCE_A);
        RedeployLayers.Planned memory planB = script.plan(deployer, NONCE_B);
        vm.setNonce(deployer, uint64(NONCE_A));
        script.deployLayers(deployer, chainA, keptA, planA, uint64(CHAIN_B), planB);
        script.verifyLibraries(planA);
        script.verifyLinks(planA);

        RedeployLayers.Planned memory moved = script.plan(deployer, NONCE_A);
        moved.bridge = address(bridgeA);
        vm.expectPartialRevert(LinkedCode.LinkMismatch.selector);
        script.verifyLinks(moved);

        moved = script.plan(deployer, NONCE_A);
        moved.factory = planA.router;
        vm.expectRevert(abi.encodeWithSelector(LinkedCode.BuiltCodeMismatch.selector, "TokenFactory", planA.router));
        script.verifyLinks(moved);

        moved = script.plan(deployer, NONCE_A);
        moved.openingProofLib = planA.receiptProofLib;
        vm.expectRevert(
            abi.encodeWithSelector(LinkedCode.LibraryCodeMismatch.selector, "OpeningProofLib", planA.receiptProofLib)
        );
        script.verifyLibraries(moved);
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

    /// Claim: the configuration is read, and a placeholder nonce is refused. Shows: the testnet file (filled for the run
    /// of 2026-11-08) parses with the nonces that ran, and the same file with its placeholder back is refused by name.
    function test_theTestnetConfigurationRefusesItsPlaceholderNonce() public {
        string memory json = vm.readFile("script/testnet/redeploy.config.testnet.json");
        RedeployLayers.ChainConfig memory chainA = script.readChain(json, ".chainA");
        RedeployLayers.ChainConfig memory chainB = script.readChain(json, ".chainB");
        assertEq(chainA.chainId, 11155111);
        assertEq(chainA.deployerNonce, 14);
        assertEq(chainB.chainId, 943);
        assertEq(chainB.deployerNonce, 18);

        string memory placeholder = vm.replace(json, '"deployerNonce": "14"', '"deployerNonce": "REPLACE_WITH_DEPLOYER_NONCE_ON_SEPOLIA"');
        vm.expectRevert(abi.encodeWithSelector(RedeployLayers.PlaceholderValue.selector, ".chainA.deployerNonce"));
        script.readChain(placeholder, ".chainA");
    }

    /// Claim: the router configuration names the contracts of 2026-11-08 and refuses its placeholder nonces. Shows: the
    /// file as run (nonces 22 and 26) names the bridge and the mediator of `deploy/deployments/sepolia-pls943.json` and,
    /// as the previous router, the router that the deployment file now keeps in `delivery_routers`; the same file with a
    /// placeholder nonce is refused by name. Matters: the router run replaces the router of the running mediator, and
    /// nothing is sent with a guessed nonce.
    function test_theRouterConfigurationNamesTheRunningContractsAndRefusesItsPlaceholders() public {
        string memory json = vm.readFile("script/testnet/router-redeploy.config.testnet.json");
        RedeployLayers.ChainConfig memory chainA = script.readChain(json, ".chainA");
        RedeployLayers.ChainConfig memory chainB = script.readChain(json, ".chainB");
        assertEq(vm.parseJsonAddress(json, ".deployer"), 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc);
        assertEq(chainA.chainId, 11155111);
        assertEq(chainA.deployerNonce, 22);
        assertEq(chainA.previousBridge, 0xD4b1ECc1b919cf9BA7Ff45e57e1712B31abA4C66);
        assertEq(chainA.previousMediator, 0x2c00675092e2955d27F476B5a1baC9AC5Bb6FA86);
        assertEq(chainA.previousRouter, 0x3846e483C98cD0f164c29A5e40F7295A5765ABa4);
        assertEq(chainB.chainId, 943);
        assertEq(chainB.deployerNonce, 26);
        assertEq(chainB.previousMediator, 0x8eeF4098D3726955F7D227C4D1D92487C99F7e62);
        assertEq(chainB.previousRouter, 0xBEa5F0fd3712B02c25Bda32C7719fB9373C0fA20);

        string memory deployment = vm.readFile("deploy/deployments/sepolia-pls943.json");
        assertEq(chainA.previousBridge, vm.parseJsonAddress(deployment, ".chain_a.bridge"));
        assertEq(chainA.previousMediator, vm.parseJsonAddress(deployment, ".chain_a.mediator"));
        assertEq(chainA.previousRouter, vm.parseJsonAddress(deployment, ".chain_a.delivery_routers[0]"));
        assertEq(chainB.previousBridge, vm.parseJsonAddress(deployment, ".chain_b.bridge"));
        assertEq(chainB.previousMediator, vm.parseJsonAddress(deployment, ".chain_b.mediator"));
        assertEq(chainB.previousRouter, vm.parseJsonAddress(deployment, ".chain_b.delivery_routers[0]"));
        assertEq(vm.parseJsonAddress(deployment, ".chain_a.delivery_router"), 0x1c4627D76e6b423e06C61f055C2ce0d3E944Ce8a);
        assertEq(vm.parseJsonAddress(deployment, ".chain_b.delivery_router"), 0x6e0178049277442d5BF58963f9a1E0469B46Fce3);

        string memory placeholderA = vm.replace(json, '"deployerNonce": "22"', '"deployerNonce": "REPLACE_WITH_DEPLOYER_NONCE_ON_SEPOLIA"');
        vm.expectRevert(abi.encodeWithSelector(RedeployLayers.PlaceholderValue.selector, ".chainA.deployerNonce"));
        script.readChain(placeholderA, ".chainA");
        string memory placeholderB = vm.replace(json, '"deployerNonce": "26"', '"deployerNonce": "REPLACE_WITH_DEPLOYER_NONCE_ON_943"');
        vm.expectRevert(abi.encodeWithSelector(RedeployLayers.PlaceholderValue.selector, ".chainB.deployerNonce"));
        script.readChain(placeholderB, ".chainB");
    }

    /// Claim: the kept router values come only from a router of the running mediator. Shows: a previous router bound to
    /// the other mediator is refused by `readKept`. Matters: a configuration that names a router of an older pair would
    /// copy its reward and failed delivery addresses into the new router for good.
    function test_aPreviousRouterOfAnotherMediatorIsRefused() public {
        RedeployLayers.ChainConfig memory chainA = _chain(uint64(CHAIN_A), NONCE_A, bridgeA, mediatorA, routerB);
        vm.chainId(CHAIN_A);
        vm.expectRevert(
            abi.encodeWithSelector(RedeployLayers.PreviousRouterOfAnotherMediator.selector, address(routerB))
        );
        script.readKept(chainA);
    }

    /// Claim: the router mode checks the code it deployed against the build output. Shows: the replaced router holds the
    /// compiled `DeliveryRouter`, immutables aside, so `requireBuiltCode` passes inside `deployRouter`.
    function test_aReplacedRouterIsTheBuiltCode() public {
        RedeployLayers.ChainConfig memory chainA = _chain(uint64(CHAIN_A), NONCE_A, bridgeA, mediatorA, routerA);
        vm.chainId(CHAIN_A);
        RedeployLayers.Kept memory kept = script.readKept(chainA);
        vm.setNonce(deployer, uint64(NONCE_A));
        vm.recordLogs();
        address replaced = script.deployRouter(chainA, kept, deployer);
        assertGt(replaced.code.length, 0);
        assertEq(DeliveryRouter(payable(replaced)).NATIVE_GAS_OVERHEAD(), 105_000, "the router of this build");
    }
}
