// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {TokenMediator} from "../../src/hardened/mediator/TokenMediator.sol";
import {TokenFactory} from "../../src/hardened/mediator/TokenFactory.sol";
import {DeliveryRouter} from "../../src/hardened/mediator/DeliveryRouter.sol";
import {ITokenMediator} from "../../src/hardened/mediator/ITokenMediator.sol";
import {IWETH} from "../../src/hardened/mediator/IWETH.sol";

/// @title RedeployLayers
/// @notice Deploys new message layers on two chains that already run the bridge, and keeps everything below them: the
/// SP1 verifiers, the light clients, the own-chain light client and the fork registry, and the deposit gates. None of
/// them names a bridge, a mediator or a router, so they serve the new contracts as they are.
/// @dev Two modes, chosen by the environment variable `REDEPLOY_MODE`:
/// - `layers` (layers 1 to 3): on each chain, in this order, at the deployer nonce `n` of the chain: the message bridge
///   (n), the token mediator (n + 1, which creates its token factory) and the delivery router (n + 2). The bridges and
///   the mediators name their twins on the other chain, so both nonces must be right before anything is sent.
/// - `router` (layer 3 only): on one chain (`REDEPLOY_CHAIN` = `chainA` or `chainB`), one delivery router at the
///   deployer nonce `n`, for the mediator of `previousMediator`. The bridge and the mediator do not change, so a router
///   can be replaced at any time with no change on the other chain.
///
/// Every value that the new contracts share with the old ones is read from the old contracts on chain, not from a
/// file: the light client, the remote light client, the gate, the Capella era, the Gloas slot and the send cutoff of
/// the bridge; the flow limiter and the home chain name of the mediator; the wrapped native token, the reward address
/// and the failed delivery address of the router. After deployment the script reads every value back from the new
/// contracts and refuses a mismatch. The new bridges start locked and with no layout rows: see
/// `docs/redeploy-2026-11-gas.md` for the steps after the deployment.
///
/// Run with `REDEPLOY_CONFIG=<path> REDEPLOY_MODE=layers forge script script/hardened/RedeployLayers.s.sol --account
/// <keystore>`. Add `--broadcast` to send the transactions. Without it, nothing reaches a chain.
contract RedeployLayers is Script {
    /// @notice One chain: where to connect, the nonce of the deployer, and the contracts that run there now.
    struct ChainConfig {
        string rpcAlias;
        uint64 chainId;
        uint256 deployerNonce;
        address previousBridge;
        address previousMediator;
        address previousRouter;
    }

    /// @notice What the new contracts of one chain take, read from the old ones.
    struct Kept {
        address lightClient;
        address remoteLightClient;
        address gate;
        uint64 capellaEra;
        uint64 gloasForkSlot;
        uint64 cutoffTimestamp;
        address flowLimiter;
        string remoteChainName;
        address wrappedNative;
        address rewardAddress;
        address failedDeliveryAddress;
    }

    /// @notice The predicted addresses of the new contracts of one chain.
    struct Planned {
        address bridge;
        address mediator;
        address factory;
        address router;
    }

    error PlaceholderValue(string key);
    error ChainIdMismatch(uint64 configured, uint256 actual);
    error DeployerNonceMismatch(uint64 chainId, uint256 configured, uint256 actual);
    error DeployerMismatch(address configured, address actual);
    error NoCode(string name, address account);
    error UnknownMode(string mode);
    error AddressNotAsPredicted(string name, address predicted, address actual);
    error DeploymentMismatch(string field);

    function run() external {
        string memory json = vm.readFile(vm.envString("REDEPLOY_CONFIG"));
        address deployer = vm.parseJsonAddress(json, ".deployer");
        vm.startBroadcast();
        (, address signer,) = vm.readCallers();
        vm.stopBroadcast();
        if (signer != deployer) revert DeployerMismatch(deployer, signer);

        string memory mode = vm.envString("REDEPLOY_MODE");
        if (keccak256(bytes(mode)) == keccak256("layers")) {
            _redeployLayers(json, deployer);
        } else if (keccak256(bytes(mode)) == keccak256("router")) {
            string memory chainKey = vm.envString("REDEPLOY_CHAIN");
            ChainConfig memory chain = readChain(json, string.concat(".", chainKey));
            _connect(chain, deployer);
            address router = deployRouter(chain, readKept(chain), deployer);
            console2.log("new delivery router", router);
        } else {
            revert UnknownMode(mode);
        }
    }

    function _redeployLayers(string memory json, address deployer) private {
        ChainConfig memory chainA = readChain(json, ".chainA");
        ChainConfig memory chainB = readChain(json, ".chainB");
        uint256 forkA = _connect(chainA, deployer);
        Kept memory keptA = readKept(chainA);
        uint256 forkB = _connect(chainB, deployer);
        Kept memory keptB = readKept(chainB);
        Planned memory planA = plan(deployer, chainA.deployerNonce);
        Planned memory planB = plan(deployer, chainB.deployerNonce);
        _log("chain A", chainA, planA);
        _log("chain B", chainB, planB);

        vm.selectFork(forkA);
        deployLayers(deployer, chainA, keptA, planA, chainB.chainId, planB);
        vm.selectFork(forkB);
        deployLayers(deployer, chainB, keptB, planB, chainA.chainId, planA);
    }

    /// @notice Reads one chain section of the configuration. Placeholders are refused.
    function readChain(string memory json, string memory prefix) public pure returns (ChainConfig memory chain) {
        chain.rpcAlias = vm.parseJsonString(json, string.concat(prefix, ".rpcAlias"));
        chain.chainId = uint64(_readUint(json, string.concat(prefix, ".chainId")));
        chain.deployerNonce = _readUint(json, string.concat(prefix, ".deployerNonce"));
        chain.previousBridge = vm.parseJsonAddress(json, string.concat(prefix, ".previousBridge"));
        chain.previousMediator = vm.parseJsonAddress(json, string.concat(prefix, ".previousMediator"));
        chain.previousRouter = vm.parseJsonAddress(json, string.concat(prefix, ".previousRouter"));
    }

    /// @notice Reads what the new contracts keep from the old contracts of the connected chain.
    function readKept(ChainConfig memory chain) public view returns (Kept memory kept) {
        _requireCode("previousBridge", chain.previousBridge);
        _requireCode("previousMediator", chain.previousMediator);
        _requireCode("previousRouter", chain.previousRouter);
        MessageBridge bridge = MessageBridge(chain.previousBridge);
        kept.lightClient = address(bridge.lightClient());
        kept.remoteLightClient = bridge.remoteLightClient();
        kept.gate = address(bridge.depositGate());
        kept.capellaEra = bridge.capellaEra();
        kept.gloasForkSlot = bridge.gloasForkSlot();
        kept.cutoffTimestamp = bridge.sendCutoffTimestamp();
        TokenMediator mediator = TokenMediator(chain.previousMediator);
        kept.flowLimiter = address(mediator.flowLimiter());
        kept.remoteChainName = mediator.tokenFactory().homeChainName();
        DeliveryRouter router = DeliveryRouter(payable(chain.previousRouter));
        kept.wrappedNative = address(router.wNative());
        kept.rewardAddress = router.rewardAddress();
        kept.failedDeliveryAddress = router.failedDeliveryAddress();
    }

    /// @notice The addresses of the new contracts of a chain, from the deployer and its nonce.
    function plan(address deployer, uint256 nonce) public pure returns (Planned memory planned) {
        planned.bridge = vm.computeCreateAddress(deployer, nonce);
        planned.mediator = vm.computeCreateAddress(deployer, nonce + 1);
        planned.factory = vm.computeCreateAddress(planned.mediator, 1);
        planned.router = vm.computeCreateAddress(deployer, nonce + 2);
    }

    /// @notice Deploys the bridge, the mediator and the router of one chain, then reads every value back.
    function deployLayers(
        address deployer,
        ChainConfig memory chain,
        Kept memory kept,
        Planned memory planned,
        uint64 remoteChainId,
        Planned memory remote
    ) public {
        vm.startBroadcast(deployer);
        MessageBridge bridge = new MessageBridge(
            kept.lightClient,
            remoteChainId,
            remote.bridge,
            MessageBridge.BridgeTerms(kept.cutoffTimestamp, kept.remoteLightClient, kept.gloasForkSlot),
            kept.capellaEra,
            kept.gate
        );
        TokenMediator mediator = new TokenMediator(
            TokenMediator.MediatorTerms({
                bridge: address(bridge),
                remoteMediator: remote.mediator,
                flowLimiter: kept.flowLimiter,
                remoteChainName: kept.remoteChainName
            })
        );
        DeliveryRouter router = new DeliveryRouter(
            ITokenMediator(address(mediator)), IWETH(kept.wrappedNative), kept.rewardAddress, kept.failedDeliveryAddress
        );
        vm.stopBroadcast();

        _requireAsPredicted("bridge", planned.bridge, address(bridge));
        _requireAsPredicted("mediator", planned.mediator, address(mediator));
        _requireAsPredicted("factory", planned.factory, address(mediator.tokenFactory()));
        _requireAsPredicted("router", planned.router, address(router));
        verifyBridge(bridge, chain, kept, remoteChainId, remote.bridge);
        verifyMediator(mediator, address(bridge), kept, remote.mediator, remoteChainId);
        verifyRouter(router, address(mediator), kept);
        console2.log("deployed on chain", chain.chainId);
    }

    /// @notice Deploys one router for the mediator that runs now (layer 3 alone).
    function deployRouter(ChainConfig memory chain, Kept memory kept, address deployer) public returns (address) {
        address predicted = vm.computeCreateAddress(deployer, chain.deployerNonce);
        vm.startBroadcast(deployer);
        DeliveryRouter router = new DeliveryRouter(
            ITokenMediator(chain.previousMediator),
            IWETH(kept.wrappedNative),
            kept.rewardAddress,
            kept.failedDeliveryAddress
        );
        vm.stopBroadcast();
        _requireAsPredicted("router", predicted, address(router));
        verifyRouter(router, chain.previousMediator, kept);
        return address(router);
    }

    function verifyBridge(
        MessageBridge bridge,
        ChainConfig memory chain,
        Kept memory kept,
        uint64 remoteChainId,
        address remoteBridge
    ) public view {
        if (address(bridge.lightClient()) != kept.lightClient) revert DeploymentMismatch("bridge.lightClient");
        if (bridge.localChainId() != chain.chainId) revert DeploymentMismatch("bridge.localChainId");
        if (bridge.remoteChainId() != remoteChainId) revert DeploymentMismatch("bridge.remoteChainId");
        if (bridge.remoteBridge() != remoteBridge) revert DeploymentMismatch("bridge.remoteBridge");
        if (bridge.remoteLightClient() != kept.remoteLightClient) revert DeploymentMismatch("bridge.remoteLightClient");
        if (address(bridge.depositGate()) != kept.gate) revert DeploymentMismatch("bridge.depositGate");
        if (bridge.capellaEra() != kept.capellaEra) revert DeploymentMismatch("bridge.capellaEra");
        if (bridge.gloasForkSlot() != kept.gloasForkSlot) revert DeploymentMismatch("bridge.gloasForkSlot");
        if (bridge.sendCutoffTimestamp() != kept.cutoffTimestamp) revert DeploymentMismatch("bridge.sendCutoff");
        if (bridge.depositsOpen()) revert DeploymentMismatch("bridge.depositsOpen must start false");
    }

    function verifyMediator(
        TokenMediator mediator,
        address bridge,
        Kept memory kept,
        address remoteMediator,
        uint64 remoteChainId
    ) public view {
        if (address(mediator.bridgeContract()) != bridge) revert DeploymentMismatch("mediator.bridgeContract");
        if (mediator.mediatorContractOnOtherSide() != remoteMediator) {
            revert DeploymentMismatch("mediator.mediatorContractOnOtherSide");
        }
        if (mediator.remoteChainId() != remoteChainId) revert DeploymentMismatch("mediator.remoteChainId");
        if (address(mediator.flowLimiter()) != kept.flowLimiter) revert DeploymentMismatch("mediator.flowLimiter");
        TokenFactory factory = mediator.tokenFactory();
        if (factory.mediator() != address(mediator)) revert DeploymentMismatch("factory.mediator");
        if (keccak256(bytes(factory.homeChainName())) != keccak256(bytes(kept.remoteChainName))) {
            revert DeploymentMismatch("factory.homeChainName");
        }
    }

    function verifyRouter(DeliveryRouter router, address mediator, Kept memory kept) public view {
        if (address(router.bridge()) != mediator) revert DeploymentMismatch("router.mediator");
        if (address(router.wNative()) != kept.wrappedNative) revert DeploymentMismatch("router.wrappedNative");
        if (router.rewardAddress() != kept.rewardAddress) revert DeploymentMismatch("router.rewardAddress");
        if (router.failedDeliveryAddress() != kept.failedDeliveryAddress) {
            revert DeploymentMismatch("router.failedDeliveryAddress");
        }
    }

    /// @dev Connects to the chain, checks its identifier and the nonce of the deployer, and returns the fork.
    function _connect(ChainConfig memory chain, address deployer) private returns (uint256 forkId) {
        forkId = vm.createSelectFork(chain.rpcAlias);
        if (block.chainid != chain.chainId) revert ChainIdMismatch(chain.chainId, block.chainid);
        uint256 nonce = vm.getNonce(deployer);
        if (nonce != chain.deployerNonce) revert DeployerNonceMismatch(chain.chainId, chain.deployerNonce, nonce);
    }

    function _requireCode(string memory name, address account) private view {
        if (account.code.length == 0) revert NoCode(name, account);
    }

    function _requireAsPredicted(string memory name, address predicted, address actual) private pure {
        if (predicted != actual) revert AddressNotAsPredicted(name, predicted, actual);
    }

    function _readUint(string memory json, string memory key) private pure returns (uint256) {
        string memory text = vm.parseJsonString(json, key);
        if (bytes(text).length >= 7 && keccak256(bytes(_prefix(text, 7))) == keccak256("REPLACE")) {
            revert PlaceholderValue(key);
        }
        return vm.parseUint(text);
    }

    function _prefix(string memory text, uint256 length) private pure returns (string memory) {
        bytes memory result = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            result[i] = bytes(text)[i];
        }
        return string(result);
    }

    function _log(string memory label, ChainConfig memory chain, Planned memory planned) private pure {
        console2.log(label, chain.chainId, chain.rpcAlias);
        console2.log("  message bridge", planned.bridge);
        console2.log("  token mediator", planned.mediator);
        console2.log("  token factory", planned.factory);
        console2.log("  delivery router", planned.router);
    }
}
