// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/Script.sol";
import {LinkedCode} from "./LinkedCode.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {TokenMediator} from "../../src/hardened/mediator/TokenMediator.sol";
import {TokenFactory} from "../../src/hardened/mediator/TokenFactory.sol";
import {DeliveryRouter} from "../../src/hardened/mediator/DeliveryRouter.sol";
import {ITokenMediator} from "../../src/hardened/mediator/ITokenMediator.sol";
import {IWETH} from "../../src/hardened/mediator/IWETH.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {ForkShape} from "../../src/hardened/ForkShape.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {ForkRegistry} from "../../src/hardened/ForkRegistry.sol";

/// @title RedeployLayers
/// @notice Deploys new message layers on two chains that already run the bridge, and keeps everything below them: the
/// SP1 verifiers, the light clients, the own-chain light client and the fork registry, and the deposit gates. None of
/// them names a bridge, a mediator or a router, so they serve the new contracts as they are.
/// @dev Two modes, chosen by the environment variable `REDEPLOY_MODE`:
/// - `layers` (layers 1 to 3): on each chain, in this order, at the deployer nonce `n` of the chain, eight creations:
///
///   | Nonce | Contract | Why it is its own transaction |
///   |---|---|---|
///   | n | `ReceiptProofLib` (library of the bridge) | gas cap |
///   | n + 1 | `OpeningProofLib` (library of the bridge) | gas cap |
///   | n + 2 | `BeaconLayoutLib` (library of the bridge) | gas cap |
///   | n + 3 | `MessageBridge`, linked to the three libraries | |
///   | n + 4 | `MediatorPayloads` (library of the mediator) | gas cap |
///   | n + 5 | `TokenFactory`, naming the mediator of n + 6 | gas cap (the mediator created it before the split) |
///   | n + 6 | `TokenMediator`, linked to `MediatorPayloads`, taking the factory | |
///   | n + 7 | `DeliveryRouter` (its constructor creates its `RouterCaller`, in the same transaction) | |
///
///   The split keeps every creation under the per-transaction gas cap of EIP-7825 (16,777,216) on Sepolia, which
///   charges about 1,580 gas per byte of runtime code (`LinkedCode`). The bridges and the mediators name their twins on
///   the other chain, so both nonces must be right before anything is sent.
/// - `layers-and-gate` (a new deposit gate, then layers 1 to 3): on each chain, at the deployer nonce `n`, nine
///   creations: a `BeaconForkGate` at `n`, then the eight creations of the `layers` mode at `n + 1` to `n + 8`, the new
///   bridge naming the new gate. The gate takes its mode and beacon settings from the file named by `gateConfig` in the
///   configuration (the `gate` section of the same chain key in the bridge configuration, for example
///   `script/testnet/bridge.config.testnet.json`); in a mode with a registry it takes the fork registry of the old gate,
///   which stays. Before anything is sent the script requires that the beacon settings equal those of the old gate,
///   that the genesis validators root and the clock equal those of the light client that tracks this beacon chain on
///   the other chain, that the kept registry observes the same beacon chain, and that a mode that reads EIP-4788
///   evidence finds the beacon roots contract. After the creation it reads the gate back (mode, enforcing from
///   deployment, not sealed, beacon settings, registry, allowed shapes, the compiled code), and the bridge read-back
///   requires `depositGate()` to be the new gate.
/// - `router` (layer 3 only): on one chain (`REDEPLOY_CHAIN` = `chainA` or `chainB`), one delivery router at the
///   deployer nonce `n`, for the mediator of `previousMediator`. The bridge and the mediator do not change, so a router
///   can be replaced at any time with no change on the other chain. The router brings its own `RouterCaller`,
///   created in its constructor; the read-back requires it (`requireRouterCaller`).
///
/// Every value that the new contracts share with the old ones is read from the old contracts on chain, not from a
/// file: the light client, the remote light client, the gate, the Capella era and the send cutoff of the bridge (a new
/// bridge takes no Gloas slot: each message proves the fork of its source state); the flow limiter and the home chain name of the mediator; the wrapped native token, the reward address
/// and the failed delivery address of the router (in the `layers-and-gate` mode the gate is new, and only its registry
/// is read from the old gate). Before anything is sent, the layer modes require that the kept send cutoff is zero or
/// still ahead (`requireSendsOpen`). After deployment the script reads every value back from the new
/// contracts and refuses a mismatch. The new bridges start locked and with no layout rows: see
/// `docs/redeploy-2026-11-gas.md` for the steps after the deployment.
///
/// Run with `REDEPLOY_CONFIG=<path> REDEPLOY_MODE=layers forge script script/hardened/RedeployLayers.s.sol --account
/// <keystore>`. Add `--broadcast` to send the transactions. Without it, nothing reaches a chain.
contract RedeployLayers is LinkedCode {
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
        uint64 cutoffTimestamp;
        address flowLimiter;
        string remoteChainName;
        address wrappedNative;
        address rewardAddress;
        address failedDeliveryAddress;
    }

    /// @notice The predicted addresses of the new contracts of one chain.
    struct Planned {
        address receiptProofLib;
        address openingProofLib;
        address beaconLayoutLib;
        address bridge;
        address mediatorPayloadsLib;
        address factory;
        address mediator;
        address router;
    }

    /// @notice The settings of a new deposit gate on one chain. They describe the beacon chain of that chain.
    /// `forkRegistry` is read from the old gate in a mode with a registry, and is zero otherwise.
    struct GateConfig {
        BeaconForkGate.GateMode mode;
        uint64 genesisTime;
        uint64 secondsPerSlot;
        uint64 slotsPerEpoch;
        bytes32 genesisValidatorsRoot;
        address forkRegistry;
    }

    /// @notice The number of creations of the `layers` mode on each chain.
    uint256 public constant LAYER_CREATIONS = 8;
    /// @notice The number of creations of the `layers-and-gate` mode on each chain: the gate and the eight of `layers`.
    uint256 public constant GATE_AND_LAYER_CREATIONS = 9;
    /// @notice The beacon roots contract of EIP-4788. Every gate takes it, as `DeployBridge` does.
    address public constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;

    error PlaceholderValue(string key);
    error ChainIdMismatch(uint64 configured, uint256 actual);
    error DeployerNonceMismatch(uint64 chainId, uint256 configured, uint256 actual);
    error DeployerMismatch(address configured, address actual);
    error NoCode(string name, address account);
    error UnknownMode(string mode);
    error AddressNotAsPredicted(string name, address predicted, address actual);
    error DeploymentMismatch(string field);
    error PreviousRouterOfAnotherMediator(address previousRouter);
    error UnknownGateMode(string mode);
    error GateConfigOfAnotherChain(uint64 configured, uint64 gateConfigChainId);
    error GateMismatch(string field);
    error BeaconRootsHaveNoCode(uint64 chainId);
    error SendCutoffPassed(uint64 chainId, uint64 cutoff, uint256 timestamp);

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
        } else if (keccak256(bytes(mode)) == keccak256("layers-and-gate")) {
            _redeployLayersAndGate(json, deployer);
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
        requireSendsOpen(chainA.chainId, keptA.cutoffTimestamp);
        uint256 forkB = _connect(chainB, deployer);
        Kept memory keptB = readKept(chainB);
        requireSendsOpen(chainB.chainId, keptB.cutoffTimestamp);
        Planned memory planA = plan(deployer, chainA.deployerNonce);
        Planned memory planB = plan(deployer, chainB.deployerNonce);
        _log("chain A", chainA, planA);
        _log("chain B", chainB, planB);

        vm.selectFork(forkA);
        deployLayers(deployer, chainA, keptA, planA, chainB.chainId, planB);
        vm.selectFork(forkB);
        deployLayers(deployer, chainB, keptB, planB, chainA.chainId, planA);
    }

    /// @notice One chain of the `layers-and-gate` mode, as prepared before anything is sent.
    struct GateSide {
        ChainConfig chain;
        Kept kept;
        GateConfig gate;
        address plannedGate;
        Planned planned;
        uint256 forkId;
    }

    function _redeployLayersAndGate(string memory json, address deployer) private {
        string memory gateJson = vm.readFile(vm.parseJsonString(json, ".gateConfig"));
        GateSide memory a = _prepareGateSide(json, gateJson, ".chainA", deployer);
        GateSide memory b = _prepareGateSide(json, gateJson, ".chainB", deployer);
        // The light client of each chain tracks the beacon chain of the other: the gate of A must follow what the light
        // client on B follows, and the other way round.
        vm.selectFork(b.forkId);
        checkGateAgainstTrackingLightClient(a.gate, b.kept.lightClient);
        vm.selectFork(a.forkId);
        checkGateAgainstTrackingLightClient(b.gate, a.kept.lightClient);
        _logWithGate("chain A", a);
        _logWithGate("chain B", b);

        vm.selectFork(a.forkId);
        deployGateAndLayers(deployer, a.chain, a.kept, a.gate, a.plannedGate, a.planned, b.chain.chainId, b.planned);
        vm.selectFork(b.forkId);
        deployGateAndLayers(deployer, b.chain, b.kept, b.gate, b.plannedGate, b.planned, a.chain.chainId, a.planned);
    }

    /// @dev Connects to one chain, reads what it keeps, reads its gate settings and the kept registry, checks the gate
    /// against its own chain, and plans the nine addresses: the gate at the deployer nonce, the layers after it.
    function _prepareGateSide(string memory json, string memory gateJson, string memory prefix, address deployer)
        private
        returns (GateSide memory side)
    {
        side.chain = readChain(json, prefix);
        side.gate = readGate(gateJson, prefix, side.chain.chainId);
        side.forkId = _connect(side.chain, deployer);
        side.kept = readKept(side.chain);
        requireSendsOpen(side.chain.chainId, side.kept.cutoffTimestamp);
        side.gate.forkRegistry = readKeptRegistry(side.kept.gate, side.gate.mode);
        checkGateOnItsChain(side.gate, side.kept.gate, side.chain.chainId);
        side.plannedGate = vm.computeCreateAddress(deployer, side.chain.deployerNonce);
        side.planned = plan(deployer, side.chain.deployerNonce + 1);
    }

    /// @notice Reads the `gate` section of one chain from the bridge configuration, and requires that the section
    /// belongs to the chain of the redeploy configuration. Placeholders are refused.
    function readGate(string memory json, string memory prefix, uint64 chainId)
        public
        pure
        returns (GateConfig memory gate)
    {
        uint64 configured = uint64(_readUint(json, string.concat(prefix, ".chainId")));
        if (configured != chainId) revert GateConfigOfAnotherChain(chainId, configured);
        string memory gatePrefix = string.concat(prefix, ".gate");
        gate.mode = readGateMode(vm.parseJsonString(json, string.concat(gatePrefix, ".mode")));
        gate.genesisTime = uint64(_readUint(json, string.concat(gatePrefix, ".genesisTime")));
        gate.secondsPerSlot = uint64(_readUint(json, string.concat(gatePrefix, ".secondsPerSlot")));
        gate.slotsPerEpoch = uint64(_readUint(json, string.concat(gatePrefix, ".slotsPerEpoch")));
        gate.genesisValidatorsRoot = vm.parseJsonBytes32(json, string.concat(gatePrefix, ".genesisValidatorsRoot"));
    }

    /// @notice The gate mode of its name in the configuration, as `DeployBridge` reads it.
    function readGateMode(string memory text) public pure returns (BeaconForkGate.GateMode) {
        bytes32 name = keccak256(bytes(text));
        if (name == keccak256("Enforcing")) return BeaconForkGate.GateMode.Enforcing;
        if (name == keccak256("DetectBeaconRoots")) return BeaconForkGate.GateMode.DetectBeaconRoots;
        if (name == keccak256("DetectBeaconRootsAndRegistry")) {
            return BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry;
        }
        if (name == keccak256("SealOnly")) return BeaconForkGate.GateMode.SealOnly;
        if (name == keccak256("SealOnlyWithRegistry")) return BeaconForkGate.GateMode.SealOnlyWithRegistry;
        revert UnknownGateMode(text);
    }

    /// @notice The fork registry that a new gate in `mode` keeps: the registry of the old gate in a mode with a
    /// registry, which must hold code, and none otherwise.
    function readKeptRegistry(address oldGate, BeaconForkGate.GateMode mode) public view returns (address registry) {
        if (!_isRegistryMode(mode)) return address(0);
        registry = address(BeaconForkGate(oldGate).forkRegistry());
        if (registry == address(0)) revert GateMismatch("oldGate.forkRegistry is empty, and the new mode needs one");
        _requireCode("forkRegistry", registry);
    }

    /// @notice The checks of a new gate against its own chain, before anything is sent: the beacon settings equal those
    /// of the old gate (the beacon chain did not change), the kept registry observes the same beacon chain, and a mode
    /// that reads EIP-4788 evidence finds the beacon roots contract.
    function checkGateOnItsChain(GateConfig memory gate, address oldGate, uint64 chainId) public view {
        BeaconForkGate old = BeaconForkGate(oldGate);
        if (old.genesisTime() != gate.genesisTime) revert GateMismatch("genesisTime differs from the old gate");
        if (old.secondsPerSlot() != gate.secondsPerSlot) {
            revert GateMismatch("secondsPerSlot differs from the old gate");
        }
        if (old.slotsPerEpoch() != gate.slotsPerEpoch) revert GateMismatch("slotsPerEpoch differs from the old gate");
        if (old.genesisValidatorsRoot() != gate.genesisValidatorsRoot) {
            revert GateMismatch("genesisValidatorsRoot differs from the old gate");
        }
        if (gate.forkRegistry != address(0)) {
            BeaconLightClient observed = BeaconLightClient(address(ForkRegistry(gate.forkRegistry).lightClient()));
            if (observed.genesisValidatorsRoot() != gate.genesisValidatorsRoot) {
                revert GateMismatch("genesisValidatorsRoot differs from the light client of the registry");
            }
        }
        if (_needsBeaconRoots(gate.mode) && BEACON_ROOTS.code.length == 0) revert BeaconRootsHaveNoCode(chainId);
    }

    /// @notice Requires that the light client on the other chain, which tracks the beacon chain of the gate, follows the
    /// same beacon chain with the same clock. Run it on the fork of the other chain.
    function checkGateAgainstTrackingLightClient(GateConfig memory gate, address trackingLightClient) public view {
        BeaconLightClient client = BeaconLightClient(trackingLightClient);
        if (client.genesisValidatorsRoot() != gate.genesisValidatorsRoot) {
            revert GateMismatch("genesisValidatorsRoot differs from the light client on the other chain");
        }
        if (client.genesisTime() != gate.genesisTime) {
            revert GateMismatch("genesisTime differs from the light client on the other chain");
        }
        if (client.secondsPerSlot() != gate.secondsPerSlot) {
            revert GateMismatch("secondsPerSlot differs from the light client on the other chain");
        }
    }

    /// @notice Creates the new gate of one chain at the planned address, reads it back, then deploys the eight layer
    /// creations naming it (`deployLayers`, whose bridge read-back requires `depositGate()` to be the new gate).
    function deployGateAndLayers(
        address deployer,
        ChainConfig memory chain,
        Kept memory kept,
        GateConfig memory gate,
        address plannedGate,
        Planned memory planned,
        uint64 remoteChainId,
        Planned memory remote
    ) public {
        Libraries memory none;
        vm.startBroadcast(deployer);
        address created = deployBuilt(
            "BeaconForkGate",
            none,
            abi.encode(
                BEACON_ROOTS,
                gate.mode,
                gate.genesisTime,
                gate.secondsPerSlot,
                gate.slotsPerEpoch,
                gate.genesisValidatorsRoot,
                gate.forkRegistry
            )
        );
        vm.stopBroadcast();
        _requireAsPredicted("gate", plannedGate, created);
        verifyGate(BeaconForkGate(created), gate);
        kept.gate = created;
        deployLayers(deployer, chain, kept, planned, remoteChainId, remote);
        if (address(MessageBridge(planned.bridge).depositGate()) != created) {
            revert DeploymentMismatch("bridge.depositGate is not the new gate");
        }
    }

    /// @notice Reads a new gate back: the beacon roots contract, the mode, enforcing from deployment in `Enforcing` and
    /// the seal-only modes, not sealed, the beacon settings, the registry, the allowed shapes and the compiled code.
    function verifyGate(BeaconForkGate gate, GateConfig memory expected) public view {
        if (gate.beaconRoots() != BEACON_ROOTS) revert DeploymentMismatch("gate.beaconRoots");
        if (gate.mode() != expected.mode) revert DeploymentMismatch("gate.mode");
        if (gate.enforcing() != _enforcesFromDeployment(expected.mode)) revert DeploymentMismatch("gate.enforcing");
        if (gate.isSealed()) revert DeploymentMismatch("gate.isSealed");
        if (gate.genesisTime() != expected.genesisTime) revert DeploymentMismatch("gate.genesisTime");
        if (gate.secondsPerSlot() != expected.secondsPerSlot) revert DeploymentMismatch("gate.secondsPerSlot");
        if (gate.slotsPerEpoch() != expected.slotsPerEpoch) revert DeploymentMismatch("gate.slotsPerEpoch");
        if (gate.genesisValidatorsRoot() != expected.genesisValidatorsRoot) {
            revert DeploymentMismatch("gate.genesisValidatorsRoot");
        }
        if (address(gate.forkRegistry()) != expected.forkRegistry) revert DeploymentMismatch("gate.forkRegistry");
        uint8[] memory shapes = gate.allowedShapes();
        uint8[] memory rule = ForkShape.allowedShapes();
        if (shapes.length != rule.length) revert DeploymentMismatch("gate.allowedShapes");
        for (uint256 i = 0; i < shapes.length; i++) {
            if (shapes[i] != rule[i]) revert DeploymentMismatch("gate.allowedShapes");
        }
        Libraries memory none;
        requireBuiltCode("BeaconForkGate", address(gate), none);
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
        kept.cutoffTimestamp = bridge.sendCutoffTimestamp();
        TokenMediator mediator = TokenMediator(chain.previousMediator);
        kept.flowLimiter = address(mediator.flowLimiter());
        kept.remoteChainName = mediator.tokenFactory().homeChainName();
        DeliveryRouter router = DeliveryRouter(payable(chain.previousRouter));
        // The kept router values are read from the router of the running mediator, never from a router of an older pair.
        if (address(router.bridge()) != chain.previousMediator) revert PreviousRouterOfAnotherMediator(chain.previousRouter);
        kept.wrappedNative = address(router.wNative());
        kept.rewardAddress = router.rewardAddress();
        kept.failedDeliveryAddress = router.failedDeliveryAddress();
    }

    /// @notice Requires that a send cutoff copied from the old bridge leaves the new bridge open: zero (no cutoff) or a
    /// time still ahead. The new bridge takes the cutoff as an immutable, and a cutoff that has passed would make it
    /// refuse every send (`SendCutoffReached`, from `block.timestamp >= cutoff`) for good, while the read-back of the
    /// deployment finds the value that it expects. It runs for both chains before anything is sent.
    function requireSendsOpen(uint64 chainId, uint64 cutoff) public view {
        if (cutoff != 0 && cutoff <= block.timestamp) revert SendCutoffPassed(chainId, cutoff, block.timestamp);
    }

    /// @notice The addresses of the new contracts of a chain, from the deployer and its nonce.
    function plan(address deployer, uint256 nonce) public pure returns (Planned memory planned) {
        planned.receiptProofLib = vm.computeCreateAddress(deployer, nonce);
        planned.openingProofLib = vm.computeCreateAddress(deployer, nonce + 1);
        planned.beaconLayoutLib = vm.computeCreateAddress(deployer, nonce + 2);
        planned.bridge = vm.computeCreateAddress(deployer, nonce + 3);
        planned.mediatorPayloadsLib = vm.computeCreateAddress(deployer, nonce + 4);
        planned.factory = vm.computeCreateAddress(deployer, nonce + 5);
        planned.mediator = vm.computeCreateAddress(deployer, nonce + 6);
        planned.router = vm.computeCreateAddress(deployer, nonce + 7);
    }

    /// @notice The library addresses of a plan.
    function librariesOf(Planned memory planned) public pure returns (Libraries memory) {
        return Libraries({
            receiptProof: planned.receiptProofLib,
            openingProof: planned.openingProofLib,
            beaconLayout: planned.beaconLayoutLib,
            mediatorPayloads: planned.mediatorPayloadsLib
        });
    }

    /// @notice Deploys the libraries, the bridge, the factory, the mediator and the router of one chain, in the order of
    /// the table above, then reads every value back.
    function deployLayers(
        address deployer,
        ChainConfig memory chain,
        Kept memory kept,
        Planned memory planned,
        uint64 remoteChainId,
        Planned memory remote
    ) public {
        Libraries memory libraries = librariesOf(planned);
        vm.startBroadcast(deployer);
        _requireAsPredicted("receiptProofLib", planned.receiptProofLib, deployLibrary("ReceiptProofLib"));
        _requireAsPredicted("openingProofLib", planned.openingProofLib, deployLibrary("OpeningProofLib"));
        _requireAsPredicted("beaconLayoutLib", planned.beaconLayoutLib, deployLibrary("BeaconLayoutLib"));
        address bridge = deployLinkedBridge(
            libraries,
            abi.encode(
                kept.lightClient,
                remoteChainId,
                remote.bridge,
                MessageBridge.BridgeTerms(kept.cutoffTimestamp, kept.remoteLightClient),
                kept.capellaEra,
                kept.gate
            )
        );
        _requireAsPredicted("bridge", planned.bridge, bridge);
        _requireAsPredicted("mediatorPayloadsLib", planned.mediatorPayloadsLib, deployLibrary("MediatorPayloads"));
        TokenFactory factory =
            TokenFactory(deployBuilt("TokenFactory", libraries, abi.encode(planned.mediator, kept.remoteChainName)));
        _requireAsPredicted("factory", planned.factory, address(factory));
        address mediator = deployLinkedMediator(
            libraries,
            abi.encode(
                TokenMediator.MediatorTerms({
                    bridge: bridge,
                    remoteMediator: remote.mediator,
                    flowLimiter: kept.flowLimiter,
                    tokenFactory: address(factory)
                })
            )
        );
        _requireAsPredicted("mediator", planned.mediator, mediator);
        DeliveryRouter router = DeliveryRouter(
            payable(deployBuilt(
                    "DeliveryRouter",
                    libraries,
                    abi.encode(mediator, kept.wrappedNative, kept.rewardAddress, kept.failedDeliveryAddress)
                ))
        );
        vm.stopBroadcast();

        _requireAsPredicted("router", planned.router, address(router));
        verifyBridge(MessageBridge(bridge), chain, kept, remoteChainId, remote.bridge);
        verifyMediator(TokenMediator(mediator), bridge, kept, remote.mediator, remoteChainId);
        if (address(TokenMediator(mediator).tokenFactory()) != planned.factory) {
            revert DeploymentMismatch("mediator.tokenFactory");
        }
        verifyRouter(router, mediator, kept);
        // Last: the code of each library, and every link site of the bridge and the mediator.
        verifyLibraries(planned);
        verifyLinks(planned);
        console2.log("deployed on chain", chain.chainId);
    }

    /// @notice Requires that every link site of the bridge and of the mediator of a plan holds the library of the plan, and
    /// that the bridge, the mediator, the factory, the router and the router's caller are the compiled code (immutables
    /// aside).
    function verifyLinks(Planned memory planned) public view {
        Libraries memory libraries = librariesOf(planned);
        requireLinked("MessageBridge", planned.bridge, libraries);
        requireLinked("TokenMediator", planned.mediator, libraries);
        requireBuiltCode("MessageBridge", planned.bridge, libraries);
        requireBuiltCode("TokenMediator", planned.mediator, libraries);
        requireBuiltCode("TokenFactory", planned.factory, libraries);
        requireBuiltCode("DeliveryRouter", planned.router, libraries);
        requireRouterCaller(planned.router);
    }

    /// @notice Requires that each library of a plan holds the code of the build output.
    function verifyLibraries(Planned memory planned) public view {
        requireLibraryCode("ReceiptProofLib", planned.receiptProofLib);
        requireLibraryCode("OpeningProofLib", planned.openingProofLib);
        requireLibraryCode("BeaconLayoutLib", planned.beaconLayoutLib);
        requireLibraryCode("MediatorPayloads", planned.mediatorPayloadsLib);
    }

    /// @notice Deploys one router for the mediator that runs now (layer 3 alone).
    function deployRouter(ChainConfig memory chain, Kept memory kept, address deployer) public returns (address) {
        address predicted = vm.computeCreateAddress(deployer, chain.deployerNonce);
        console2.log("chain", chain.chainId);
        console2.log("  n     delivery router (predicted)", predicted);
        console2.log("  for the mediator", chain.previousMediator);
        Libraries memory none;
        vm.startBroadcast(deployer);
        DeliveryRouter router = DeliveryRouter(
            payable(deployBuilt(
                    "DeliveryRouter",
                    none,
                    abi.encode(
                        chain.previousMediator, kept.wrappedNative, kept.rewardAddress, kept.failedDeliveryAddress
                    )
                ))
        );
        vm.stopBroadcast();
        _requireAsPredicted("router", predicted, address(router));
        verifyRouter(router, chain.previousMediator, kept);
        requireBuiltCode("DeliveryRouter", address(router), none);
        requireRouterCaller(address(router));
        return address(router);
    }

    function verifyBridge(
        MessageBridge bridge,
        ChainConfig memory chain,
        Kept memory kept,
        uint64 remoteChainId,
        address remoteBridge
    ) public view {
        if (address(bridge.lightClient()) != kept.lightClient) {
            revert DeploymentMismatch("bridge.lightClient");
        }
        if (bridge.localChainId() != chain.chainId) revert DeploymentMismatch("bridge.localChainId");
        if (bridge.remoteChainId() != remoteChainId) revert DeploymentMismatch("bridge.remoteChainId");
        if (bridge.remoteBridge() != remoteBridge) revert DeploymentMismatch("bridge.remoteBridge");
        if (bridge.remoteLightClient() != kept.remoteLightClient) {
            revert DeploymentMismatch("bridge.remoteLightClient");
        }
        if (address(bridge.depositGate()) != kept.gate) revert DeploymentMismatch("bridge.depositGate");
        if (bridge.capellaEra() != kept.capellaEra) revert DeploymentMismatch("bridge.capellaEra");
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
        if (address(mediator.bridgeContract()) != bridge) {
            revert DeploymentMismatch("mediator.bridgeContract");
        }
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

    function _isRegistryMode(BeaconForkGate.GateMode mode) private pure returns (bool) {
        return mode == BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry
            || mode == BeaconForkGate.GateMode.SealOnlyWithRegistry;
    }

    /// @dev `Enforcing` and the two seal-only modes apply their rules from deployment.
    function _enforcesFromDeployment(BeaconForkGate.GateMode mode) private pure returns (bool) {
        return mode == BeaconForkGate.GateMode.Enforcing || mode == BeaconForkGate.GateMode.SealOnly
            || mode == BeaconForkGate.GateMode.SealOnlyWithRegistry;
    }

    /// @dev The modes whose only proofs are EIP-4788 evidence.
    function _needsBeaconRoots(BeaconForkGate.GateMode mode) private pure returns (bool) {
        return mode == BeaconForkGate.GateMode.Enforcing || mode == BeaconForkGate.GateMode.SealOnly;
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

    function _logWithGate(string memory label, GateSide memory side) private pure {
        ChainConfig memory chain = side.chain;
        GateConfig memory gate = side.gate;
        address plannedGate = side.plannedGate;
        Planned memory planned = side.planned;
        console2.log(label, chain.chainId, chain.rpcAlias);
        console2.log("  deployer nonce n", chain.deployerNonce);
        console2.log("  n     BeaconForkGate", plannedGate);
        console2.log("        mode", uint256(gate.mode));
        console2.log("        fork registry (kept)", gate.forkRegistry);
        console2.log("  n + 1 ReceiptProofLib", planned.receiptProofLib);
        console2.log("  n + 2 OpeningProofLib", planned.openingProofLib);
        console2.log("  n + 3 BeaconLayoutLib", planned.beaconLayoutLib);
        console2.log("  n + 4 message bridge", planned.bridge);
        console2.log("  n + 5 MediatorPayloads", planned.mediatorPayloadsLib);
        console2.log("  n + 6 token factory", planned.factory);
        console2.log("  n + 7 token mediator", planned.mediator);
        console2.log("  n + 8 delivery router", planned.router);
    }

    function _log(string memory label, ChainConfig memory chain, Planned memory planned) private pure {
        console2.log(label, chain.chainId, chain.rpcAlias);
        console2.log("  n     ReceiptProofLib", planned.receiptProofLib);
        console2.log("  n + 1 OpeningProofLib", planned.openingProofLib);
        console2.log("  n + 2 BeaconLayoutLib", planned.beaconLayoutLib);
        console2.log("  n + 3 message bridge", planned.bridge);
        console2.log("  n + 4 MediatorPayloads", planned.mediatorPayloadsLib);
        console2.log("  n + 5 token factory", planned.factory);
        console2.log("  n + 6 token mediator", planned.mediator);
        console2.log("  n + 7 delivery router", planned.router);
    }
}
