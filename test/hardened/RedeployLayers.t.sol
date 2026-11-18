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
import {RouterCaller} from "../../src/hardened/mediator/RouterCaller.sol";
import {ITokenMediator} from "../../src/hardened/mediator/ITokenMediator.sol";
import {IWETH} from "../../src/hardened/mediator/IWETH.sol";
import {RedeployLayers} from "../../script/hardened/RedeployLayers.s.sol";
import {WorldSupport} from "./utils/WorldSupport.sol";
import {MockWrappedNative} from "./mediator/utils/MediatorSupport.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {ForkRegistry} from "../../src/hardened/ForkRegistry.sol";

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
    /// with `LibraryCodeMismatch`; a plan whose factory is other code fails with `BuiltCodeMismatch`, and so does a
    /// router whose `RouterCaller` holds other code. Matters: a linked library is part of the immutable code of the bridge; a bridge linked
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

        address caller = address(DeliveryRouter(payable(planA.router)).routerCaller());
        assertEq(caller, vm.computeCreateAddress(planA.router, 1), "the router's first creation");
        bytes memory callerCode = caller.code;
        vm.etch(caller, planA.factory.code);
        vm.expectRevert(abi.encodeWithSelector(LinkedCode.BuiltCodeMismatch.selector, "RouterCaller", caller));
        script.verifyLinks(planA);
        vm.etch(caller, callerCode);
        script.verifyLinks(planA);

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

    /// Claim: the configuration is read, names the running contracts, and a placeholder nonce is refused. Shows: the
    /// testnet file (filled for the seal-only gate run, nonces read on 2026-11-11) parses, its previous contracts are the
    /// bridge, the mediator and the router of `deploy/deployments/sepolia-pls943.json`, its `gateConfig` is the testnet
    /// bridge configuration, and the same file with a placeholder nonce is refused by name.
    function test_theTestnetConfigurationRefusesItsPlaceholderNonce() public {
        string memory json = vm.readFile("script/testnet/redeploy.config.testnet.json");
        RedeployLayers.ChainConfig memory chainA = script.readChain(json, ".chainA");
        RedeployLayers.ChainConfig memory chainB = script.readChain(json, ".chainB");
        assertEq(vm.parseJsonAddress(json, ".deployer"), 0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc);
        assertEq(vm.parseJsonString(json, ".gateConfig"), "script/testnet/bridge.config.testnet.json");
        assertEq(chainA.chainId, 11155111);
        assertEq(chainA.deployerNonce, 23);
        assertEq(chainB.chainId, 943);
        assertEq(chainB.deployerNonce, 27);
        string memory deployment = vm.readFile("deploy/deployments/sepolia-pls943.json");
        assertEq(chainA.previousBridge, vm.parseJsonAddress(deployment, ".chain_a.bridge"));
        assertEq(chainA.previousMediator, vm.parseJsonAddress(deployment, ".chain_a.mediator"));
        assertEq(chainA.previousRouter, vm.parseJsonAddress(deployment, ".chain_a.delivery_router"));
        assertEq(chainB.previousBridge, vm.parseJsonAddress(deployment, ".chain_b.bridge"));
        assertEq(chainB.previousMediator, vm.parseJsonAddress(deployment, ".chain_b.mediator"));
        assertEq(chainB.previousRouter, vm.parseJsonAddress(deployment, ".chain_b.delivery_router"));

        string memory placeholder = vm.replace(json, '"deployerNonce": "23"', '"deployerNonce": "REPLACE_WITH_DEPLOYER_NONCE_ON_SEPOLIA"');
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

    /// Claim: a send cutoff of the old bridge that has passed is refused before the run, and one that is unset or still
    /// ahead is kept. Shows: a cutoff at the current time and one before it revert with `SendCutoffPassed`, the chain,
    /// the cutoff and the time; zero and a later time pass; the check reads the cutoff that `readKept` copies from the
    /// old bridge. Matters: the new bridge takes the cutoff as an immutable, and a bridge whose cutoff has passed
    /// refuses every send (`SendCutoffReached`) for good, while the read-back of the deployment would find the value it
    /// expects.
    function test_aPassedSendCutoffIsRefusedBeforeTheRun() public {
        vm.warp(1_000_000);
        uint64 chainId = uint64(CHAIN_A);
        vm.expectRevert(abi.encodeWithSelector(RedeployLayers.SendCutoffPassed.selector, chainId, 1_000_000, 1_000_000));
        script.requireSendsOpen(chainId, 1_000_000);
        vm.expectRevert(abi.encodeWithSelector(RedeployLayers.SendCutoffPassed.selector, chainId, 999_999, 1_000_000));
        script.requireSendsOpen(chainId, 999_999);
        script.requireSendsOpen(chainId, 0);
        script.requireSendsOpen(chainId, 1_000_001);

        RedeployLayers.ChainConfig memory chainA = _chain(chainId, NONCE_A, bridgeA, mediatorA, routerA);
        vm.chainId(CHAIN_A);
        vm.mockCall(address(bridgeA), abi.encodeWithSignature("sendCutoffTimestamp()"), abi.encode(uint64(999_999)));
        RedeployLayers.Kept memory kept = script.readKept(chainA);
        vm.expectRevert(abi.encodeWithSelector(RedeployLayers.SendCutoffPassed.selector, chainId, 999_999, 1_000_000));
        script.requireSendsOpen(chainId, kept.cutoffTimestamp);
    }

    /// Claim: the router mode checks the code it deployed against the build output. Shows: the replaced router holds the
    /// compiled `DeliveryRouter`, immutables aside, so `requireBuiltCode` passes inside `deployRouter`; the router created
    /// its `RouterCaller` in the same transaction (`requireRouterCaller` passes too).
    function test_aReplacedRouterIsTheBuiltCode() public {
        RedeployLayers.ChainConfig memory chainA = _chain(uint64(CHAIN_A), NONCE_A, bridgeA, mediatorA, routerA);
        vm.chainId(CHAIN_A);
        RedeployLayers.Kept memory kept = script.readKept(chainA);
        vm.setNonce(deployer, uint64(NONCE_A));
        vm.recordLogs();
        address replaced = script.deployRouter(chainA, kept, deployer);
        assertGt(replaced.code.length, 0);
        assertEq(DeliveryRouter(payable(replaced)).NATIVE_GAS_OVERHEAD(), 105_000, "the router of this build");
        address caller = address(DeliveryRouter(payable(replaced)).routerCaller());
        assertEq(caller, vm.computeCreateAddress(replaced, 1), "the router created its caller");
        assertEq(RouterCaller(caller).router(), replaced, "and the caller names it");
        assertEq(vm.getNonce(deployer), NONCE_A + 1, "the caller took no nonce of the deployer");
    }
}

/// @notice The `layers-and-gate` mode on a two chain world: a new seal-only gate first on each chain (with the registry
/// of the old gate on the registry chain), then the eight layer creations naming it, nine creations per chain, and the
/// checks that refuse a gate that follows another beacon chain.
contract RedeployLayersAndGateTest is WorldSupport {
    RedeployLayers internal script = new RedeployLayers();
    address internal deployer = makeAddr("deployer");
    address internal reward = makeAddr("reward");
    address internal failedDelivery = makeAddr("failed delivery");
    DeliveryRouter internal routerA;
    DeliveryRouter internal routerB;
    ForkRegistry internal registryB;
    BeaconForkGate internal oldGateB;

    uint256 internal constant NONCE_A = 40;
    uint256 internal constant NONCE_B = 73;
    uint64 internal constant GATE_GENESIS = 1_606_824_023;
    bytes32 internal constant OBSERVATION_VKEY = keccak256("fork observation program");

    /// @dev Chain A runs a gate without a registry (as Sepolia), chain B a gate with a registry (as chain 943). The
    /// registry of B reads `lightClientForA`, which follows the beacon chain of B. The beacon roots contract has code,
    /// as on Sepolia, so a `SealOnly` gate may be created.
    function setUp() public override {
        super.setUp();
        _etchMock();
        vm.chainId(CHAIN_B);
        registryB = new ForkRegistry(address(lightClientForA), address(verifier), OBSERVATION_VKEY);
        oldGateB = new BeaconForkGate(
            BEACON_ROOTS,
            BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry,
            GATE_GENESIS,
            12,
            32,
            GENESIS_ROOT_B,
            address(registryB)
        );
        _deployWorld(address(gateA), address(oldGateB));
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

    function _gate(BeaconForkGate.GateMode mode, bytes32 root)
        internal
        pure
        returns (RedeployLayers.GateConfig memory gate)
    {
        gate.mode = mode;
        gate.genesisTime = GATE_GENESIS;
        gate.secondsPerSlot = 12;
        gate.slotsPerEpoch = 32;
        gate.genesisValidatorsRoot = root;
    }

    /// Claim: the mode creates a new gate at the deployer nonce of each chain, then the eight layers after it, and the
    /// new bridge names the new gate. Shows: nine creations per chain; the gate at `n` and the layers at `n + 1` to
    /// `n + 8`; the gate of A is `SealOnly` with no registry, the gate of B `SealOnlyWithRegistry` with the registry of
    /// the old gate; both enforce from deployment and are not sealed; each new bridge's `depositGate()` is the new gate;
    /// a token relayed through the new layers on A arrives on B. Matters: the seal-only gate is immutable, and so is the
    /// bridge that names it; the registry of 943 holds the observed fork history and stays.
    function test_theNewGateComesFirstAndTheNewBridgeNamesIt() public {
        RedeployLayers.ChainConfig memory chainA = _chain(uint64(CHAIN_A), NONCE_A, bridgeA, mediatorA, routerA);
        RedeployLayers.ChainConfig memory chainB = _chain(uint64(CHAIN_B), NONCE_B, bridgeB, mediatorB, routerB);
        vm.chainId(CHAIN_A);
        RedeployLayers.Kept memory keptA = script.readKept(chainA);
        RedeployLayers.GateConfig memory gateConfigA = _gate(BeaconForkGate.GateMode.SealOnly, GENESIS_ROOT_A);
        gateConfigA.forkRegistry = script.readKeptRegistry(keptA.gate, gateConfigA.mode);
        assertEq(gateConfigA.forkRegistry, address(0), "a mode without a registry keeps none");
        script.checkGateOnItsChain(gateConfigA, keptA.gate, uint64(CHAIN_A));
        vm.chainId(CHAIN_B);
        RedeployLayers.Kept memory keptB = script.readKept(chainB);
        RedeployLayers.GateConfig memory gateConfigB =
            _gate(BeaconForkGate.GateMode.SealOnlyWithRegistry, GENESIS_ROOT_B);
        gateConfigB.forkRegistry = script.readKeptRegistry(keptB.gate, gateConfigB.mode);
        assertEq(gateConfigB.forkRegistry, address(registryB), "the registry of the old gate is kept");
        script.checkGateOnItsChain(gateConfigB, keptB.gate, uint64(CHAIN_B));

        address plannedGateA = vm.computeCreateAddress(deployer, NONCE_A);
        address plannedGateB = vm.computeCreateAddress(deployer, NONCE_B);
        RedeployLayers.Planned memory planA = script.plan(deployer, NONCE_A + 1);
        RedeployLayers.Planned memory planB = script.plan(deployer, NONCE_B + 1);

        vm.chainId(CHAIN_A);
        vm.setNonce(deployer, uint64(NONCE_A));
        script.deployGateAndLayers(deployer, chainA, keptA, gateConfigA, plannedGateA, planA, uint64(CHAIN_B), planB);
        assertEq(vm.getNonce(deployer), NONCE_A + script.GATE_AND_LAYER_CREATIONS(), "nine creations on chain A");
        vm.chainId(CHAIN_B);
        vm.setNonce(deployer, uint64(NONCE_B));
        script.deployGateAndLayers(deployer, chainB, keptB, gateConfigB, plannedGateB, planB, uint64(CHAIN_A), planA);
        assertEq(vm.getNonce(deployer), NONCE_B + script.GATE_AND_LAYER_CREATIONS(), "nine creations on chain B");
        assertEq(script.GATE_AND_LAYER_CREATIONS(), script.LAYER_CREATIONS() + 1);

        BeaconForkGate newGateA = BeaconForkGate(plannedGateA);
        BeaconForkGate newGateB = BeaconForkGate(plannedGateB);
        assertEq(uint256(newGateA.mode()), uint256(BeaconForkGate.GateMode.SealOnly));
        assertEq(uint256(newGateB.mode()), uint256(BeaconForkGate.GateMode.SealOnlyWithRegistry));
        assertEq(address(newGateA.forkRegistry()), address(0));
        assertEq(address(newGateB.forkRegistry()), address(registryB));
        assertTrue(newGateA.enforcing() && newGateB.enforcing(), "seal-only gates enforce from deployment");
        assertFalse(newGateA.isSealed() || newGateB.isSealed());
        assertEq(newGateB.genesisValidatorsRoot(), GENESIS_ROOT_B);
        assertEq(address(MessageBridge(planA.bridge).depositGate()), plannedGateA, "the new bridge of A names it");
        assertEq(address(MessageBridge(planB.bridge).depositGate()), plannedGateB, "the new bridge of B names it");
        assertEq(planA.receiptProofLib, vm.computeCreateAddress(deployer, NONCE_A + 1), "the layers follow the gate");
        assertEq(planA.router, vm.computeCreateAddress(deployer, NONCE_A + 8));
        assertEq(MessageBridge(planA.bridge).remoteBridge(), planB.bridge, "the new bridges name each other");

        bridgeA = MessageBridge(planA.bridge);
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
        assertTrue(bridgeB.messageCallStatus(transit.messageId), "the new seal-only gate admits the send");
        assertEq(BridgedToken(mediatorB.bridgedTokenAddress(address(token))).balanceOf(bob), 10 ether);
    }

    /// Claim: the gate settings come from the testnet bridge configuration, chain by chain. Shows: the Sepolia section
    /// reads `SealOnly` with the Sepolia beacon clock and root; the 943 section reads `SealOnlyWithRegistry` with the 943
    /// clock and root; a section of another chain is refused; an unknown mode name is refused. Matters: the plan of
    /// 2026-11-11 names these two modes, and the file is the one place they are written.
    function test_theGateSettingsComeFromTheTestnetBridgeConfiguration() public {
        string memory json = vm.readFile("script/testnet/bridge.config.testnet.json");
        RedeployLayers.GateConfig memory sepolia = script.readGate(json, ".chainA", 11155111);
        assertEq(uint256(sepolia.mode), uint256(BeaconForkGate.GateMode.SealOnly));
        assertEq(sepolia.genesisTime, 1655733600);
        assertEq(sepolia.secondsPerSlot, 12);
        assertEq(sepolia.slotsPerEpoch, 32);
        assertEq(sepolia.genesisValidatorsRoot, 0xd8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078);
        assertEq(sepolia.forkRegistry, address(0), "the registry is read from the old gate, never from the file");
        RedeployLayers.GateConfig memory pls = script.readGate(json, ".chainB", 943);
        assertEq(uint256(pls.mode), uint256(BeaconForkGate.GateMode.SealOnlyWithRegistry));
        assertEq(pls.genesisTime, 1681356369);
        assertEq(pls.secondsPerSlot, 10);
        assertEq(pls.genesisValidatorsRoot, 0xd81664ba97279a6fa0832041b4aee6009172b4750a99467ff670a9faf3a34e64);

        vm.expectRevert(abi.encodeWithSelector(RedeployLayers.GateConfigOfAnotherChain.selector, 943, 11155111));
        script.readGate(json, ".chainA", 943);
        string memory unknown = vm.replace(json, '"mode": "SealOnly",', '"mode": "Sealed",');
        vm.expectRevert(abi.encodeWithSelector(RedeployLayers.UnknownGateMode.selector, "Sealed"));
        script.readGate(unknown, ".chainA", 11155111);
    }

    /// Claim: a gate that follows another beacon chain, or a mode that cannot work on the chain, is refused before
    /// anything is sent. Shows: a root or a clock that differs from the old gate fails `GateMismatch`; a registry mode on
    /// a chain whose old gate has no registry fails; a `SealOnly` gate on a chain without the beacon roots contract
    /// fails `BeaconRootsHaveNoCode`; a registry whose light client follows another root fails. Matters: the gate is
    /// immutable, and a wrong root or clock makes every seal proof fail for good.
    function test_aGateOfAnotherBeaconChainIsRefusedBeforeTheRun() public {
        RedeployLayers.GateConfig memory gate = _gate(BeaconForkGate.GateMode.SealOnly, GENESIS_ROOT_B);
        vm.expectRevert(
            abi.encodeWithSelector(RedeployLayers.GateMismatch.selector, "genesisValidatorsRoot differs from the old gate")
        );
        script.checkGateOnItsChain(gate, address(gateA), uint64(CHAIN_A));

        gate = _gate(BeaconForkGate.GateMode.SealOnly, GENESIS_ROOT_A);
        gate.secondsPerSlot = 10;
        vm.expectRevert(
            abi.encodeWithSelector(RedeployLayers.GateMismatch.selector, "secondsPerSlot differs from the old gate")
        );
        script.checkGateOnItsChain(gate, address(gateA), uint64(CHAIN_A));

        vm.expectRevert(
            abi.encodeWithSelector(
                RedeployLayers.GateMismatch.selector, "oldGate.forkRegistry is empty, and the new mode needs one"
            )
        );
        script.readKeptRegistry(address(gateA), BeaconForkGate.GateMode.SealOnlyWithRegistry);

        gate = _gate(BeaconForkGate.GateMode.SealOnlyWithRegistry, GENESIS_ROOT_A);
        gate.forkRegistry = address(registryB);
        BeaconForkGate oldGateFollowingA = new BeaconForkGate(
            BEACON_ROOTS,
            BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry,
            GATE_GENESIS,
            12,
            32,
            GENESIS_ROOT_A,
            address(registryB)
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                RedeployLayers.GateMismatch.selector,
                "genesisValidatorsRoot differs from the light client of the registry"
            )
        );
        script.checkGateOnItsChain(gate, address(oldGateFollowingA), uint64(CHAIN_B));

        gate = _gate(BeaconForkGate.GateMode.SealOnly, GENESIS_ROOT_A);
        vm.etch(BEACON_ROOTS, "");
        vm.expectRevert(abi.encodeWithSelector(RedeployLayers.BeaconRootsHaveNoCode.selector, uint64(CHAIN_A)));
        script.checkGateOnItsChain(gate, address(gateA), uint64(CHAIN_A));
        // A registry mode reads no EIP-4788 evidence: it passes on a chain without the beacon roots contract (943).
        RedeployLayers.GateConfig memory registryGate =
            _gate(BeaconForkGate.GateMode.SealOnlyWithRegistry, GENESIS_ROOT_B);
        registryGate.forkRegistry = address(registryB);
        script.checkGateOnItsChain(registryGate, address(oldGateB), uint64(CHAIN_B));
    }

    /// Claim: the gate of a chain must follow the beacon chain that the light client on the other chain tracks, with the
    /// same clock. Shows: a light client with the root and the clock of the gate passes; the fixture light client that
    /// follows the same root on another clock fails on `genesisTime`; the light client of the other beacon chain fails on
    /// the root. Matters: the two descriptions of one beacon chain live in two files and two chains; this check ties them.
    function test_theGateMatchesTheLightClientThatTracksItsChain() public {
        RedeployLayers.GateConfig memory gate = _gate(BeaconForkGate.GateMode.SealOnly, GENESIS_ROOT_A);
        BeaconLightClient matching = new BeaconLightClient(
            address(verifier),
            LIGHT_CLIENT_VKEY,
            GENESIS_ROOT_A,
            SLOTS_PER_PERIOD,
            GATE_GENESIS,
            12,
            INITIAL_SLOT,
            INITIAL_HEADER_ROOT,
            COMMITTEE_100,
            COMMITTEE_101
        );
        script.checkGateAgainstTrackingLightClient(gate, address(matching));

        vm.expectRevert(
            abi.encodeWithSelector(
                RedeployLayers.GateMismatch.selector, "genesisTime differs from the light client on the other chain"
            )
        );
        script.checkGateAgainstTrackingLightClient(gate, address(lightClientForB));
        vm.expectRevert(
            abi.encodeWithSelector(
                RedeployLayers.GateMismatch.selector,
                "genesisValidatorsRoot differs from the light client on the other chain"
            )
        );
        script.checkGateAgainstTrackingLightClient(gate, address(lightClientForA));
    }

    /// Claim: the gate read-back refuses a gate that is not the one configured. Shows: the old detection gate read as
    /// the configured `SealOnly` gate fails on `gate.mode`; a new registry gate read with no registry expected fails on
    /// `gate.forkRegistry`. Matters: the read-back is the last check before the bridge that names the gate is created.
    function test_theGateReadBackRefusesAnotherGate() public {
        RedeployLayers.GateConfig memory gate = _gate(BeaconForkGate.GateMode.SealOnly, GENESIS_ROOT_A);
        vm.expectRevert(abi.encodeWithSelector(RedeployLayers.DeploymentMismatch.selector, "gate.mode"));
        script.verifyGate(gateA, gate);

        BeaconForkGate registryGate = new BeaconForkGate(
            BEACON_ROOTS,
            BeaconForkGate.GateMode.SealOnlyWithRegistry,
            GATE_GENESIS,
            12,
            32,
            GENESIS_ROOT_B,
            address(registryB)
        );
        gate = _gate(BeaconForkGate.GateMode.SealOnlyWithRegistry, GENESIS_ROOT_B);
        vm.expectRevert(abi.encodeWithSelector(RedeployLayers.DeploymentMismatch.selector, "gate.forkRegistry"));
        script.verifyGate(registryGate, gate);
    }
}
