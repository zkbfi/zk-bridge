// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {ForkRegistry} from "../../src/hardened/ForkRegistry.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {TokenMediator} from "../../src/hardened/mediator/TokenMediator.sol";
import {TokenFactory} from "../../src/hardened/mediator/TokenFactory.sol";
import {WETHOmnibridgeRouter} from "../../src/hardened/mediator/WETHOmnibridgeRouter.sol";
import {FeeRouter} from "../../src/hardened/mediator/FeeRouter.sol";
import {ITokenMediator} from "../../src/hardened/mediator/ITokenMediator.sol";
import {IWETH} from "../../src/hardened/mediator/IWETH.sol";

/// @title DeployBridge
/// @notice Deploys the hardened bridge on two chains with predicted cross-chain addresses.
/// @dev Run with `BRIDGE_CONFIG=<path> forge script script/hardened/DeployBridge.s.sol --account <keystore name>`.
/// Add `--broadcast` to send the transactions. Without it, nothing reaches a chain.
/// The script never reads a private key. The bridges start with no fork layouts. After deployment, anyone adds them
/// with `addBlockRootsLayout`, `addBlockHashLayout` and `addHistoricalSummariesLayout`, with evidence from the stored
/// light-client data. The light client on a chain tracks the OTHER chain's beacon chain. The deposit gate on a chain
/// reads the beacon chain of THAT chain, because it guards the sends made there. Each bridge also names the light
/// client of the OTHER chain (`remoteLightClient`), which it reads to open sends. Each bridge and each mediator names
/// its twin on the other chain at construction, so the script predicts every address from the deployer nonces of both
/// chains. Both bridges start locked: see "Launch sequence" in `docs/hardened-build-contract.md`.
///
/// The deployer sends one transaction for each contract below, in this order. `n` is `deployerNonce` of the chain.
/// A line in brackets is a contract that only some chains get.
///
/// | Contract                | Offset, no registry | Offset, registry gate | Condition                          |
/// |-------------------------|---------------------|-----------------------|------------------------------------|
/// | light client            | n                   | n                     | always                             |
/// | [own-chain light client]| -                   | n + 1                 | gate mode `DetectBeaconRootsAndRegistry` |
/// | [fork registry]         | -                   | n + 2                 | gate mode `DetectBeaconRootsAndRegistry` |
/// | deposit gate            | n + 1               | n + 3                 | always                             |
/// | message bridge          | n + 2               | n + 4                 | always                             |
/// | token mediator          | n + 3               | n + 5                 | always                             |
/// | [native coin router]    | n + 4               | n + 6                 | `wrappedNative` is not zero        |
/// | [fee router]            | next free offset    | next free offset      | `deployFeeRouter` is `true`        |
///
/// The mediator creates its token factory inside its constructor. The factory is the first contract of the mediator,
/// so it sits at `computeCreateAddress(mediator, 1)` and takes no deployer nonce. A chain without a wrapped native
/// token gets no native coin router, and the fee router (which needs that token) is then refused. The fee router takes
/// the next free offset, so the plan has no gap.
contract DeployBridge is Script {
    /// @notice Whether a router is deployed.
    enum RouterChoice {
        Skip,
        Deploy
    }

    /// @notice The settings of one chain. The `lightClient` fields describe the OTHER chain's beacon chain.
    /// @dev `depositCutoffTimestamp` is the `cutoffTimestamp` of `BridgeTerms`: sends stop from that time on. The key
    /// keeps its old name for the operators of the deploy configuration.
    struct ChainConfig {
        string rpcAlias;
        uint64 chainId;
        address verifier;
        bytes32 verifierCodeHash;
        uint256 deployerNonce;
        uint64 depositCutoffTimestamp;
        address wrappedNative;
        RouterChoice feeRouter;
        FeeConfig fee;
        address flowLimiter;
        LightClientConfig lightClient;
        GateConfig gate;
        ObservationConfig observation;
    }

    /// @notice The fee switch of the mediator on a chain. A zero `authority` removes the fee from the start: the
    /// fee and the ceiling must then be zero.
    struct FeeConfig {
        address authority;
        address recipient;
        uint16 basisPoints;
        uint16 ceilingBasisPoints;
    }

    /// @notice The own-chain light client and the fork registry of a chain whose gate mode is
    /// `DetectBeaconRootsAndRegistry`. It describes the beacon chain of THIS chain. All fields are zero in other modes.
    /// Both contracts use the verifier of the chain. The light client of this chain follows the same light-client
    /// program as the other light client, so `lightClientProgramVKey` is that key.
    struct ObservationConfig {
        bytes32 lightClientProgramVKey;
        bytes32 observationProgramVKey;
        bytes32 genesisValidatorsRoot;
        uint64 slotsPerPeriod;
        uint64 genesisTime;
        uint64 secondsPerSlot;
        uint64 initialSlot;
        bytes32 initialHeaderRoot;
        bytes32 initialSyncCommitteeHash;
        bytes32 initialNextSyncCommitteeHash;
    }

    /// @notice The settings of the deposit gate on a chain. They describe the beacon chain of THIS chain.
    struct GateConfig {
        BeaconForkGate.GateMode mode;
        uint64 genesisTime;
        uint64 secondsPerSlot;
        uint64 slotsPerEpoch;
        BeaconForkGate.SupportedVersion[] supportedVersions;
        uint8[] sealDepths;
    }

    /// @notice The checkpoint and the program of the light client on a chain. They describe the OTHER chain's beacon chain.
    /// The Capella fields belong to the bridge on this chain: it proves messages of the OTHER chain.
    struct LightClientConfig {
        bytes32 programVKey;
        bytes32 genesisValidatorsRoot;
        uint64 slotsPerPeriod;
        uint64 genesisTime;
        uint64 secondsPerSlot;
        uint64 slotsPerEpoch;
        uint64 capellaForkEpoch;
        uint64 capellaEra;
        uint64 initialSlot;
        bytes32 initialHeaderRoot;
        bytes32 initialSyncCommitteeHash;
        bytes32 initialNextSyncCommitteeHash;
    }

    /// @notice The whole configuration.
    struct BridgeConfig {
        address deployer;
        ChainConfig chainA;
        ChainConfig chainB;
    }

    /// @notice The addresses of the contracts of one chain. A contract that the chain does not get is the zero address.
    struct ChainAddresses {
        address lightClient;
        address observedLightClient;
        address registry;
        address gate;
        address bridge;
        address mediator;
        address factory;
        address wrappedRouter;
        address feeRouter;
    }

    /// @notice The predicted addresses on both chains.
    struct Plan {
        ChainAddresses chainA;
        ChainAddresses chainB;
    }

    /// @notice Everything that deploys one chain. `plan` holds the predicted addresses on THIS chain.
    struct ChainDeployment {
        ChainConfig chain;
        address deployer;
        ChainAddresses plan;
        uint64 remoteChainId;
        address remoteBridge;
        address remoteMediator;
        address remoteLightClient;
    }

    /// @notice A configuration value still holds a placeholder.
    error PlaceholderValue(string key);
    /// @notice A configuration value is zero.
    error ZeroConfigValue(string key);
    /// @notice The two chains share one chain identifier.
    error SameChainIdentifier(uint64 chainId);
    /// @notice The connected chain is not the configured chain.
    error ChainIdMismatch(uint64 configured, uint256 actual);
    /// @notice The deployer nonce on the chain differs from the configuration.
    error DeployerNonceMismatch(uint64 chainId, uint256 configured, uint256 actual);
    /// @notice The verifier address holds no code on its chain.
    error VerifierHasNoCode(uint64 chainId, address verifier);
    /// @notice The code hash of the verifier differs from the pinned code hash.
    error VerifierCodeHashMismatch(uint64 chainId, address verifier, bytes32 expected, bytes32 actual);
    /// @notice The configured flow limiter holds no code on its chain.
    error FlowLimiterHasNoCode(uint64 chainId, address flowLimiter);
    /// @notice The configured wrapped native token holds no code on its chain.
    error WrappedNativeHasNoCode(uint64 chainId, address wrappedNative);
    /// @notice The fee router needs a wrapped native token, and the chain has none in the configuration.
    error FeeRouterNeedsWrappedNative(uint64 chainId);
    /// @notice The `deployFeeRouter` setting is not `true` or `false`.
    error UnknownFeeRouterSetting(string value);
    /// @notice The signer of the script is not the configured deployer.
    error DeployerMismatch(address configured, address actual);
    /// @notice An observation setting does not match the other chain's settings or the light-client key.
    error ObservationMismatch(string field);
    /// @notice The clock of a light client differs from the clock of the gate of the chain that it tracks.
    error ClockMismatch(string field);
    /// @notice The gate mode is not one of the three names.
    error UnknownGateMode(string mode);
    /// @notice A list in the configuration is empty.
    error EmptyConfigList(string key);
    /// @notice A fork version in the configuration is not four bytes long.
    error ForkVersionLengthInvalid(string key, uint256 length);
    /// @notice The configured Capella era differs from the era of the Capella fork epoch.
    error CapellaEraMismatch(uint64 chainId, uint64 configured, uint64 derived);
    /// @notice A gate in `Enforcing` mode needs the beacon roots contract, and it holds no code on its chain.
    error BeaconRootsHaveNoCode(uint64 chainId, address beaconRoots);
    /// @notice A deployed contract is not at its predicted address.
    error AddressNotAsPredicted(string name, address predicted, address actual);
    /// @notice A value read back from a deployed contract differs from the configuration.
    error DeploymentMismatch(string field);

    /// @notice The beacon roots contract of EIP-4788. The gates read the beacon block roots from it.
    address public constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;
    /// @notice The slots of one era of `historical_summaries`. The bridge fixes this number.
    uint256 public constant SLOTS_PER_ERA = 8192;

    // ------------------------------------------------------------------ entry point

    /// @notice Reads the configuration, checks both chains, and deploys on both.
    function run() external {
        BridgeConfig memory config = parseConfig(vm.readFile(vm.envString("BRIDGE_CONFIG")));
        Plan memory plan = predictAddresses(config);

        vm.startBroadcast();
        (, address signer,) = vm.readCallers();
        vm.stopBroadcast();
        if (signer != config.deployer) revert DeployerMismatch(config.deployer, signer);

        uint256 forkA = _inspectChain(config.chainA, config.deployer);
        uint256 forkB = _inspectChain(config.chainB, config.deployer);
        logPlan(config, plan);

        (ChainDeployment memory deploymentA, ChainDeployment memory deploymentB) = buildDeployments(config, plan);

        vm.selectFork(forkA);
        deployChain(deploymentA);
        vm.selectFork(forkB);
        deployChain(deploymentB);
    }

    // ------------------------------------------------------------------ configuration

    /// @notice Parses and validates the configuration. It refuses placeholders and zero values.
    /// @param json The configuration text. Every value is a string.
    function parseConfig(string memory json) public view returns (BridgeConfig memory config) {
        config.deployer = _readAddress(json, ".deployer");
        config.chainA = _readChain(json, ".chainA");
        config.chainB = _readChain(json, ".chainB");
        if (config.chainA.chainId == config.chainB.chainId) revert SameChainIdentifier(config.chainA.chainId);
        _requireLightClientClockMatchesOtherGate(config.chainA, config.chainB);
        _requireLightClientClockMatchesOtherGate(config.chainB, config.chainA);
        _requireObservationMatchesOtherChain(config.chainA, config.chainB);
        _requireObservationMatchesOtherChain(config.chainB, config.chainA);
    }

    /// @notice Predicts every address from the deployer nonces. Nothing deploys here.
    /// @param config The validated configuration.
    function predictAddresses(BridgeConfig memory config) public pure returns (Plan memory plan) {
        plan.chainA = _predictChain(config.deployer, config.chainA);
        plan.chainB = _predictChain(config.deployer, config.chainB);
    }

    /// @notice Prints the plan. A chain without a native coin router gets a loud warning.
    /// @param config The validated configuration.
    /// @param plan The predicted addresses.
    function logPlan(BridgeConfig memory config, Plan memory plan) public pure {
        console2.log("deployer", config.deployer);
        _logChain("chain A", config.chainA, plan.chainA);
        _logChain("chain B", config.chainB, plan.chainB);
    }

    /// @notice Joins the configuration and the plan into the deployment of each chain. Each side names the bridge, the
    /// mediator and the light client of the other side.
    /// @param config The validated configuration.
    /// @param plan The predicted addresses.
    function buildDeployments(BridgeConfig memory config, Plan memory plan)
        public
        pure
        returns (ChainDeployment memory deploymentA, ChainDeployment memory deploymentB)
    {
        deploymentA = ChainDeployment({
            chain: config.chainA,
            deployer: config.deployer,
            plan: plan.chainA,
            remoteChainId: config.chainB.chainId,
            remoteBridge: plan.chainB.bridge,
            remoteMediator: plan.chainB.mediator,
            remoteLightClient: plan.chainB.lightClient
        });
        deploymentB = ChainDeployment({
            chain: config.chainB,
            deployer: config.deployer,
            plan: plan.chainB,
            remoteChainId: config.chainA.chainId,
            remoteBridge: plan.chainA.bridge,
            remoteMediator: plan.chainA.mediator,
            remoteLightClient: plan.chainA.lightClient
        });
    }

    // ------------------------------------------------------------------ chain checks

    /// @notice Refuses to continue when the connected chain, the deployer nonce, the verifier or its pinned code hash,
    /// the beacon roots contract of an enforcing gate, the wrapped native token, or a non-zero flow limiter is wrong.
    /// It runs before any broadcast.
    /// @param chain The settings of the connected chain.
    /// @param deployer The deployer.
    function assertChainEnvironment(ChainConfig memory chain, address deployer) public view {
        if (block.chainid != chain.chainId) revert ChainIdMismatch(chain.chainId, block.chainid);
        uint256 nonce = vm.getNonce(deployer);
        if (nonce != chain.deployerNonce) revert DeployerNonceMismatch(chain.chainId, chain.deployerNonce, nonce);
        _requireVerifierPin(chain);
        if (chain.gate.mode == BeaconForkGate.GateMode.Enforcing && BEACON_ROOTS.code.length == 0) {
            revert BeaconRootsHaveNoCode(chain.chainId, BEACON_ROOTS);
        }
        if (chain.flowLimiter != address(0) && chain.flowLimiter.code.length == 0) {
            revert FlowLimiterHasNoCode(chain.chainId, chain.flowLimiter);
        }
        if (chain.wrappedNative != address(0) && chain.wrappedNative.code.length == 0) {
            revert WrappedNativeHasNoCode(chain.chainId, chain.wrappedNative);
        }
    }

    // ------------------------------------------------------------------ deployment

    /// @notice Deploys every contract of one chain from the deployer in the order of the table above, then reads
    /// everything back.
    /// @dev The caller selects the right fork first.
    /// @param deployment The deployment of one chain.
    /// @return deployed The addresses of the deployed contracts. The mediator creates the factory, and the script reads
    /// its address from the mediator.
    function deployChain(ChainDeployment memory deployment) public returns (ChainAddresses memory deployed) {
        assertChainEnvironment(deployment.chain, deployment.deployer);
        ChainConfig memory chain = deployment.chain;

        vm.startBroadcast(deployment.deployer);
        deployed.lightClient = _deployLightClient(chain);
        if (_hasRegistry(chain)) {
            deployed.observedLightClient = _deployObservedLightClient(chain);
            deployed.registry = _deployRegistry(chain, deployed.observedLightClient);
        }
        deployed.gate = _deployGate(chain.gate, deployed.registry);
        deployed.bridge = _deployBridge(deployment, deployed.lightClient, deployed.gate);
        deployed.mediator = _deployMediator(deployment, deployed.bridge);
        deployed.factory = address(TokenMediator(deployed.mediator).tokenFactory());
        if (chain.wrappedNative != address(0)) {
            deployed.wrappedRouter = _deployWrappedRouter(deployed.mediator, chain.wrappedNative);
        }
        if (chain.feeRouter == RouterChoice.Deploy) {
            deployed.feeRouter = _deployFeeRouter(deployed.mediator, chain.wrappedNative);
        }
        vm.stopBroadcast();

        verifyDeployment(deployment, deployed);
        verifyRegistry(deployment, deployed.gate);
    }

    /// @notice Reads every immutable back and compares it with the configuration and the prediction.
    /// @param deployment The deployment of one chain.
    /// @param deployed The deployed addresses.
    function verifyDeployment(ChainDeployment memory deployment, ChainAddresses memory deployed) public view {
        ChainAddresses memory plan = deployment.plan;
        _requireAsPredicted("lightClient", plan.lightClient, deployed.lightClient);
        _requireAsPredicted("gate", plan.gate, deployed.gate);
        _requireAsPredicted("bridge", plan.bridge, deployed.bridge);
        _requireAsPredicted("mediator", plan.mediator, deployed.mediator);
        _requireAsPredicted("factory", plan.factory, deployed.factory);
        _requireAsPredicted("wrappedRouter", plan.wrappedRouter, deployed.wrappedRouter);
        _requireAsPredicted("feeRouter", plan.feeRouter, deployed.feeRouter);
        _requireVerifierPin(deployment.chain);
        _verifyLightClient(deployment.chain, deployed.lightClient);
        _verifyGate(deployment.chain.gate, deployed.gate);
        _verifyBridge(deployment, deployed);
        _verifyMediator(deployment, deployed);
        _verifyRouters(deployment.chain, deployed);
    }

    /// @notice Reads back the fork registry and the own-chain light client behind the gate. In other modes it checks
    /// that the gate has no registry. Every address is compared with the prediction.
    /// @param deployment The deployment of one chain.
    /// @param gate The deployed deposit gate.
    function verifyRegistry(ChainDeployment memory deployment, address gate) public view {
        address registry = address(BeaconForkGate(gate).forkRegistry());
        if (deployment.chain.gate.mode != BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry) {
            if (registry != address(0)) revert DeploymentMismatch("gate.forkRegistry must be empty");
            return;
        }
        ObservationConfig memory own = deployment.chain.observation;
        _requireAsPredicted("forkRegistry", deployment.plan.registry, registry);
        ForkRegistry deployedRegistry = ForkRegistry(registry);
        address client = address(deployedRegistry.lightClient());
        _requireAsPredicted("observedLightClient", deployment.plan.observedLightClient, client);
        if (address(deployedRegistry.verifier()) != deployment.chain.verifier) {
            revert DeploymentMismatch("registry.verifier");
        }
        if (deployedRegistry.observationProgramVKey() != own.observationProgramVKey) {
            revert DeploymentMismatch("registry.observationProgramVKey");
        }
        BeaconLightClient observed = BeaconLightClient(client);
        if (address(observed.verifier()) != deployment.chain.verifier) revert DeploymentMismatch("observed.verifier");
        if (observed.programVKey() != own.lightClientProgramVKey) revert DeploymentMismatch("observed.programVKey");
        if (observed.programVKey() == own.observationProgramVKey) revert DeploymentMismatch("observed.keysMustDiffer");
        if (observed.genesisValidatorsRoot() != own.genesisValidatorsRoot) {
            revert DeploymentMismatch("observed.genesisValidatorsRoot");
        }
        if (observed.slotsPerPeriod() != own.slotsPerPeriod) revert DeploymentMismatch("observed.slotsPerPeriod");
        if (observed.genesisTime() != own.genesisTime) revert DeploymentMismatch("observed.genesisTime");
        if (observed.secondsPerSlot() != own.secondsPerSlot) revert DeploymentMismatch("observed.secondsPerSlot");
        if (observed.head() != own.initialSlot) revert DeploymentMismatch("observed.head");
        if (observed.headers(own.initialSlot) != own.initialHeaderRoot) revert DeploymentMismatch("observed.headerRoot");
        uint64 period = observed.periodOf(own.initialSlot);
        if (observed.syncCommittees(period) != own.initialSyncCommitteeHash) {
            revert DeploymentMismatch("observed.syncCommittee");
        }
        if (observed.syncCommittees(period + 1) != own.initialNextSyncCommitteeHash) {
            revert DeploymentMismatch("observed.nextSyncCommittee");
        }
    }

    // ------------------------------------------------------------------ internals

    /// @dev Follows the table in the contract comment. The factory takes no deployer nonce: the mediator creates it.
    /// A router that the chain does not get stays zero and takes no nonce.
    function _predictChain(address deployer, ChainConfig memory chain) private pure returns (ChainAddresses memory plan) {
        uint256 nonce = chain.deployerNonce;
        plan.lightClient = vm.computeCreateAddress(deployer, nonce++);
        if (_hasRegistry(chain)) {
            plan.observedLightClient = vm.computeCreateAddress(deployer, nonce++);
            plan.registry = vm.computeCreateAddress(deployer, nonce++);
        }
        plan.gate = vm.computeCreateAddress(deployer, nonce++);
        plan.bridge = vm.computeCreateAddress(deployer, nonce++);
        plan.mediator = vm.computeCreateAddress(deployer, nonce++);
        plan.factory = vm.computeCreateAddress(plan.mediator, 1);
        if (chain.wrappedNative != address(0)) plan.wrappedRouter = vm.computeCreateAddress(deployer, nonce++);
        if (chain.feeRouter == RouterChoice.Deploy) plan.feeRouter = vm.computeCreateAddress(deployer, nonce);
    }

    /// @dev A chain whose gate runs in `DetectBeaconRootsAndRegistry` mode gets an own-chain light client and a registry.
    function _hasRegistry(ChainConfig memory chain) private pure returns (bool) {
        return chain.gate.mode == BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry;
    }

    function _logChain(string memory label, ChainConfig memory chain, ChainAddresses memory plan) private pure {
        console2.log(label, chain.chainId, chain.rpcAlias);
        console2.log("  nonce", chain.deployerNonce);
        console2.log("  light client", plan.lightClient);
        console2.log("  own-chain light client", plan.observedLightClient);
        console2.log("  fork registry", plan.registry);
        console2.log("  deposit gate", plan.gate);
        console2.log("  message bridge", plan.bridge);
        console2.log("  token mediator", plan.mediator);
        console2.log("  token factory", plan.factory);
        console2.log("  native coin router", plan.wrappedRouter);
        console2.log("  fee router", plan.feeRouter);
        if (chain.wrappedNative != address(0)) return;
        console2.log("  WARNING: no wrapped native token is configured. This chain gets no native coin router.");
    }

    function _requireAsPredicted(string memory name, address predicted, address actual) private pure {
        if (predicted != actual) revert AddressNotAsPredicted(name, predicted, actual);
    }

    /// @dev The verifier must hold code, and the code must be the pinned code.
    function _requireVerifierPin(ChainConfig memory chain) private view {
        if (chain.verifier.code.length == 0) revert VerifierHasNoCode(chain.chainId, chain.verifier);
        if (chain.verifier.codehash != chain.verifierCodeHash) {
            revert VerifierCodeHashMismatch(chain.chainId, chain.verifier, chain.verifierCodeHash, chain.verifier.codehash);
        }
    }

    function _deployLightClient(ChainConfig memory chain) private returns (address) {
        return address(
            new BeaconLightClient(
                chain.verifier,
                chain.lightClient.programVKey,
                chain.lightClient.genesisValidatorsRoot,
                chain.lightClient.slotsPerPeriod,
                chain.lightClient.genesisTime,
                chain.lightClient.secondsPerSlot,
                chain.lightClient.initialSlot,
                chain.lightClient.initialHeaderRoot,
                chain.lightClient.initialSyncCommitteeHash,
                chain.lightClient.initialNextSyncCommitteeHash
            )
        );
    }

    function _deployObservedLightClient(ChainConfig memory chain) private returns (address) {
        ObservationConfig memory own = chain.observation;
        return address(
            new BeaconLightClient(
                chain.verifier,
                own.lightClientProgramVKey,
                own.genesisValidatorsRoot,
                own.slotsPerPeriod,
                own.genesisTime,
                own.secondsPerSlot,
                own.initialSlot,
                own.initialHeaderRoot,
                own.initialSyncCommitteeHash,
                own.initialNextSyncCommitteeHash
            )
        );
    }

    function _deployRegistry(ChainConfig memory chain, address observedLightClient) private returns (address) {
        return address(new ForkRegistry(observedLightClient, chain.verifier, chain.observation.observationProgramVKey));
    }

    function _deployGate(GateConfig memory gate, address registry) private returns (address) {
        return address(
            new BeaconForkGate(
                BEACON_ROOTS,
                gate.mode,
                gate.genesisTime,
                gate.secondsPerSlot,
                gate.slotsPerEpoch,
                gate.supportedVersions,
                gate.sealDepths,
                registry
            )
        );
    }

    function _deployBridge(ChainDeployment memory deployment, address lightClient, address gate)
        private
        returns (address)
    {
        ChainConfig memory chain = deployment.chain;
        return address(
            new MessageBridge(
                lightClient,
                chain.chainId,
                deployment.remoteChainId,
                deployment.remoteBridge,
                MessageBridge.BridgeTerms({
                    cutoffTimestamp: chain.depositCutoffTimestamp, remoteLightClient: deployment.remoteLightClient
                }),
                chain.lightClient.capellaEra,
                gate
            )
        );
    }

    function _deployMediator(ChainDeployment memory deployment, address bridge) private returns (address) {
        ChainConfig memory chain = deployment.chain;
        return address(
            new TokenMediator(
                TokenMediator.MediatorTerms({
                    bridge: bridge,
                    remoteMediator: deployment.remoteMediator,
                    remoteChainId: deployment.remoteChainId,
                    feeAuthority: chain.fee.authority,
                    feeRecipient: chain.fee.recipient,
                    feeBasisPoints: chain.fee.basisPoints,
                    feeCeilingBasisPoints: chain.fee.ceilingBasisPoints,
                    flowLimiter: chain.flowLimiter
                })
            )
        );
    }

    function _deployWrappedRouter(address mediator, address wrappedNative) private returns (address) {
        return address(new WETHOmnibridgeRouter(ITokenMediator(mediator), IWETH(wrappedNative)));
    }

    function _deployFeeRouter(address mediator, address wrappedNative) private returns (address) {
        return address(new FeeRouter(ITokenMediator(mediator), IWETH(wrappedNative)));
    }

    function _verifyLightClient(ChainConfig memory chain, address lightClient) private view {
        BeaconLightClient client = BeaconLightClient(lightClient);
        if (address(client.verifier()) != chain.verifier) revert DeploymentMismatch("lightClient.verifier");
        if (client.programVKey() != chain.lightClient.programVKey) revert DeploymentMismatch("lightClient.programVKey");
        if (client.genesisValidatorsRoot() != chain.lightClient.genesisValidatorsRoot) {
            revert DeploymentMismatch("lightClient.genesisValidatorsRoot");
        }
        if (client.slotsPerPeriod() != chain.lightClient.slotsPerPeriod) revert DeploymentMismatch("lightClient.slotsPerPeriod");
        if (client.genesisTime() != chain.lightClient.genesisTime) revert DeploymentMismatch("lightClient.genesisTime");
        if (client.secondsPerSlot() != chain.lightClient.secondsPerSlot) {
            revert DeploymentMismatch("lightClient.secondsPerSlot");
        }
        if (client.head() != chain.lightClient.initialSlot) revert DeploymentMismatch("lightClient.head");
        if (client.headers(chain.lightClient.initialSlot) != chain.lightClient.initialHeaderRoot) {
            revert DeploymentMismatch("lightClient.initialHeaderRoot");
        }
        uint64 period = client.periodOf(chain.lightClient.initialSlot);
        if (client.syncCommittees(period) != chain.lightClient.initialSyncCommitteeHash) {
            revert DeploymentMismatch("lightClient.syncCommittee");
        }
        if (client.syncCommittees(period + 1) != chain.lightClient.initialNextSyncCommitteeHash) {
            revert DeploymentMismatch("lightClient.nextSyncCommittee");
        }
    }

    function _verifyGate(GateConfig memory expected, address gate) private view {
        BeaconForkGate deployed = BeaconForkGate(gate);
        if (deployed.beaconRoots() != BEACON_ROOTS) revert DeploymentMismatch("gate.beaconRoots");
        if (deployed.mode() != expected.mode) revert DeploymentMismatch("gate.mode");
        if (deployed.enforcing() != (expected.mode == BeaconForkGate.GateMode.Enforcing)) {
            revert DeploymentMismatch("gate.enforcing");
        }
        if (deployed.isSealed()) revert DeploymentMismatch("gate.isSealed");
        if (deployed.genesisTime() != expected.genesisTime) revert DeploymentMismatch("gate.genesisTime");
        if (deployed.secondsPerSlot() != expected.secondsPerSlot) revert DeploymentMismatch("gate.secondsPerSlot");
        if (deployed.slotsPerEpoch() != expected.slotsPerEpoch) revert DeploymentMismatch("gate.slotsPerEpoch");

        BeaconForkGate.SupportedVersion[] memory versions = deployed.supportedVersions();
        if (versions.length != expected.supportedVersions.length) revert DeploymentMismatch("gate.supportedVersions");
        for (uint256 i = 0; i < versions.length; i++) {
            if (versions[i].version != expected.supportedVersions[i].version) {
                revert DeploymentMismatch("gate.supportedVersions.version");
            }
            if (versions[i].stateDepth != expected.supportedVersions[i].stateDepth) {
                revert DeploymentMismatch("gate.supportedVersions.stateDepth");
            }
        }

        uint8[] memory depths = deployed.sealDepths();
        if (depths.length != expected.sealDepths.length) revert DeploymentMismatch("gate.sealDepths");
        for (uint256 i = 0; i < depths.length; i++) {
            if (depths[i] != expected.sealDepths[i]) revert DeploymentMismatch("gate.sealDepths");
        }
    }

    function _verifyBridge(ChainDeployment memory deployment, ChainAddresses memory deployed) private view {
        ChainConfig memory chain = deployment.chain;
        MessageBridge bridge = MessageBridge(deployed.bridge);
        if (address(bridge.lightClient()) != deployed.lightClient) revert DeploymentMismatch("bridge.lightClient");
        if (bridge.localChainId() != chain.chainId) revert DeploymentMismatch("bridge.localChainId");
        if (bridge.remoteChainId() != deployment.remoteChainId) revert DeploymentMismatch("bridge.remoteChainId");
        if (bridge.remoteBridge() != deployment.remoteBridge) revert DeploymentMismatch("bridge.remoteBridge");
        if (bridge.remoteLightClient() != deployment.remoteLightClient) {
            revert DeploymentMismatch("bridge.remoteLightClient");
        }
        if (bridge.depositsOpen()) revert DeploymentMismatch("bridge.depositsOpen must start false");
        if (bridge.sendCutoffTimestamp() != chain.depositCutoffTimestamp) {
            revert DeploymentMismatch("bridge.sendCutoffTimestamp");
        }
        if (bridge.capellaEra() != chain.lightClient.capellaEra) revert DeploymentMismatch("bridge.capellaEra");
        if (address(bridge.depositGate()) != deployed.gate) revert DeploymentMismatch("bridge.depositGate");
        if (
            bridge.stateLayouts().length != 0 || bridge.bodyLayouts().length != 0
                || bridge.historicalLayouts().length != 0
        ) {
            revert DeploymentMismatch("bridge.layouts must start empty");
        }
    }

    function _verifyMediator(ChainDeployment memory deployment, ChainAddresses memory deployed) private view {
        ChainConfig memory chain = deployment.chain;
        TokenMediator mediator = TokenMediator(deployed.mediator);
        if (address(mediator.bridgeContract()) != deployed.bridge) revert DeploymentMismatch("mediator.bridgeContract");
        if (mediator.mediatorContractOnOtherSide() != deployment.remoteMediator) {
            revert DeploymentMismatch("mediator.mediatorContractOnOtherSide");
        }
        if (mediator.remoteChainId() != deployment.remoteChainId) revert DeploymentMismatch("mediator.remoteChainId");
        if (address(mediator.tokenFactory()) != deployed.factory) revert DeploymentMismatch("mediator.tokenFactory");
        if (TokenFactory(deployed.factory).mediator() != deployed.mediator) {
            revert DeploymentMismatch("factory.mediator");
        }
        if (mediator.feeAuthority() != chain.fee.authority) revert DeploymentMismatch("mediator.feeAuthority");
        if (mediator.feeRecipient() != chain.fee.recipient) revert DeploymentMismatch("mediator.feeRecipient");
        if (mediator.feeBasisPoints() != chain.fee.basisPoints) revert DeploymentMismatch("mediator.feeBasisPoints");
        if (mediator.feeCeilingBasisPoints() != chain.fee.ceilingBasisPoints) {
            revert DeploymentMismatch("mediator.feeCeilingBasisPoints");
        }
        if (address(mediator.flowLimiter()) != chain.flowLimiter) revert DeploymentMismatch("mediator.flowLimiter");
    }

    /// @dev A router that the chain does not get has the zero address, and the prediction check has compared that.
    function _verifyRouters(ChainConfig memory chain, ChainAddresses memory deployed) private view {
        if (deployed.wrappedRouter != address(0)) {
            WETHOmnibridgeRouter router = WETHOmnibridgeRouter(payable(deployed.wrappedRouter));
            if (address(router.bridge()) != deployed.mediator) revert DeploymentMismatch("wrappedRouter.mediator");
            if (address(router.WETH()) != chain.wrappedNative) revert DeploymentMismatch("wrappedRouter.wrappedNative");
        }
        if (deployed.feeRouter != address(0)) {
            FeeRouter router = FeeRouter(payable(deployed.feeRouter));
            if (address(router.bridge()) != deployed.mediator) revert DeploymentMismatch("feeRouter.mediator");
            if (address(router.wNative()) != chain.wrappedNative) revert DeploymentMismatch("feeRouter.wrappedNative");
        }
    }

    /// @dev Connects to the chain and runs the checks.
    function _inspectChain(ChainConfig memory chain, address deployer) private returns (uint256 forkId) {
        forkId = vm.createSelectFork(chain.rpcAlias);
        assertChainEnvironment(chain, deployer);
    }

    function _readChain(string memory json, string memory prefix) private view returns (ChainConfig memory chain) {
        chain.rpcAlias = _readText(json, string.concat(prefix, ".rpcAlias"));
        chain.chainId = uint64(_readNonZeroUint(json, string.concat(prefix, ".chainId")));
        chain.verifier = _readAddress(json, string.concat(prefix, ".verifier"));
        chain.verifierCodeHash = _readBytes32(json, string.concat(prefix, ".verifierCodeHash"));
        chain.deployerNonce = _readUint(json, string.concat(prefix, ".deployerNonce"));
        chain.depositCutoffTimestamp = uint64(_readUint(json, string.concat(prefix, ".depositCutoffTimestamp")));
        chain.fee = _readFee(json, string.concat(prefix, ".fee"));
        chain.flowLimiter = vm.parseAddress(_readText(json, string.concat(prefix, ".flowLimiter")));
        chain.wrappedNative = _readOptionalAddress(json, string.concat(prefix, ".wrappedNative"));
        chain.feeRouter = _readRouterChoice(json, string.concat(prefix, ".deployFeeRouter"));
        if (chain.feeRouter == RouterChoice.Deploy && chain.wrappedNative == address(0)) {
            revert FeeRouterNeedsWrappedNative(chain.chainId);
        }
        string memory client = string.concat(prefix, ".lightClient");
        chain.lightClient.programVKey = _readBytes32(json, string.concat(client, ".programVKey"));
        chain.lightClient.genesisValidatorsRoot = _readBytes32(json, string.concat(client, ".genesisValidatorsRoot"));
        chain.lightClient.slotsPerPeriod = uint64(_readNonZeroUint(json, string.concat(client, ".slotsPerPeriod")));
        chain.lightClient.genesisTime = uint64(_readNonZeroUint(json, string.concat(client, ".genesisTime")));
        chain.lightClient.secondsPerSlot = uint64(_readNonZeroUint(json, string.concat(client, ".secondsPerSlot")));
        chain.lightClient.slotsPerEpoch = uint64(_readNonZeroUint(json, string.concat(client, ".slotsPerEpoch")));
        chain.lightClient.capellaForkEpoch = uint64(_readNonZeroUint(json, string.concat(client, ".capellaForkEpoch")));
        chain.lightClient.capellaEra = uint64(_readUint(json, string.concat(client, ".capellaEra")));
        chain.lightClient.initialSlot = uint64(_readNonZeroUint(json, string.concat(client, ".initialSlot")));
        chain.lightClient.initialHeaderRoot = _readBytes32(json, string.concat(client, ".initialHeaderRoot"));
        chain.lightClient.initialSyncCommitteeHash = _readBytes32(json, string.concat(client, ".initialSyncCommitteeHash"));
        chain.lightClient.initialNextSyncCommitteeHash = _readBytes32(json, string.concat(client, ".initialNextSyncCommitteeHash"));
        _requireCapellaEra(chain);
        chain.gate = _readGate(json, string.concat(prefix, ".gate"));
        if (chain.gate.mode == BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry) {
            chain.observation = _readObservation(json, string.concat(prefix, ".observation"));
        }
    }

    /// @dev The fee switch of one vault. The authority and the recipient may be the zero address: a zero authority
    /// is a fee removed from the start. The vault constructor checks the rest.
    function _readFee(string memory json, string memory prefix) private pure returns (FeeConfig memory fee) {
        fee.authority = vm.parseAddress(_readText(json, string.concat(prefix, ".authority")));
        fee.recipient = vm.parseAddress(_readText(json, string.concat(prefix, ".recipient")));
        fee.basisPoints = uint16(_readUint(json, string.concat(prefix, ".basisPoints")));
        fee.ceilingBasisPoints = uint16(_readUint(json, string.concat(prefix, ".ceilingBasisPoints")));
    }

    function _readObservation(string memory json, string memory prefix)
        private
        pure
        returns (ObservationConfig memory own)
    {
        own.lightClientProgramVKey = _readBytes32(json, string.concat(prefix, ".lightClientProgramVKey"));
        own.observationProgramVKey = _readBytes32(json, string.concat(prefix, ".observationProgramVKey"));
        own.genesisValidatorsRoot = _readBytes32(json, string.concat(prefix, ".genesisValidatorsRoot"));
        own.slotsPerPeriod = uint64(_readNonZeroUint(json, string.concat(prefix, ".slotsPerPeriod")));
        own.genesisTime = uint64(_readNonZeroUint(json, string.concat(prefix, ".genesisTime")));
        own.secondsPerSlot = uint64(_readNonZeroUint(json, string.concat(prefix, ".secondsPerSlot")));
        own.initialSlot = uint64(_readNonZeroUint(json, string.concat(prefix, ".initialSlot")));
        own.initialHeaderRoot = _readBytes32(json, string.concat(prefix, ".initialHeaderRoot"));
        own.initialSyncCommitteeHash = _readBytes32(json, string.concat(prefix, ".initialSyncCommitteeHash"));
        own.initialNextSyncCommitteeHash = _readBytes32(json, string.concat(prefix, ".initialNextSyncCommitteeHash"));
        if (own.observationProgramVKey == own.lightClientProgramVKey) {
            revert ObservationMismatch("observationProgramVKey equals lightClientProgramVKey");
        }
    }

    /// @dev The own-chain settings of a registry chain must describe the beacon chain that the OTHER chain's light
    /// client tracks: the same genesis validators root and period length. The relationship is asserted, not assumed.
    function _requireObservationMatchesOtherChain(ChainConfig memory chain, ChainConfig memory other) private pure {
        if (chain.gate.mode != BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry) return;
        if (chain.observation.genesisValidatorsRoot != other.lightClient.genesisValidatorsRoot) {
            revert ObservationMismatch("genesisValidatorsRoot differs from the other chain's light client");
        }
        if (chain.observation.slotsPerPeriod != other.lightClient.slotsPerPeriod) {
            revert ObservationMismatch("slotsPerPeriod differs from the other chain's light client");
        }
        if (chain.observation.genesisTime != other.lightClient.genesisTime) {
            revert ObservationMismatch("genesisTime differs from the other chain's light client");
        }
        if (chain.observation.secondsPerSlot != other.lightClient.secondsPerSlot) {
            revert ObservationMismatch("secondsPerSlot differs from the other chain's light client");
        }
        if (chain.observation.observationProgramVKey == chain.lightClient.programVKey) {
            revert ObservationMismatch("observationProgramVKey equals the light client key");
        }
    }

    /// @dev The light client of a chain tracks the OTHER chain's beacon chain, so its clock must be the clock of the
    /// gate of the other chain. A clock that differs would refuse honest heads or accept heads from the future.
    function _requireLightClientClockMatchesOtherGate(ChainConfig memory chain, ChainConfig memory other) private pure {
        if (chain.lightClient.genesisTime != other.gate.genesisTime) {
            revert ClockMismatch("lightClient.genesisTime differs from the gate of the other chain");
        }
        if (chain.lightClient.secondsPerSlot != other.gate.secondsPerSlot) {
            revert ClockMismatch("lightClient.secondsPerSlot differs from the gate of the other chain");
        }
    }

    /// @dev The era of the Capella fork slot is `capellaForkEpoch * slotsPerEpoch / SLOTS_PER_ERA`, rounded down.
    function _requireCapellaEra(ChainConfig memory chain) private pure {
        uint256 forkSlot = uint256(chain.lightClient.capellaForkEpoch) * chain.lightClient.slotsPerEpoch;
        uint64 derived = uint64(forkSlot / SLOTS_PER_ERA);
        if (derived != chain.lightClient.capellaEra) {
            revert CapellaEraMismatch(chain.chainId, chain.lightClient.capellaEra, derived);
        }
    }

    function _readGate(string memory json, string memory prefix) private view returns (GateConfig memory gate) {
        gate.mode = _readGateMode(_readText(json, string.concat(prefix, ".mode")));
        gate.genesisTime = uint64(_readNonZeroUint(json, string.concat(prefix, ".genesisTime")));
        gate.secondsPerSlot = uint64(_readNonZeroUint(json, string.concat(prefix, ".secondsPerSlot")));
        gate.slotsPerEpoch = uint64(_readNonZeroUint(json, string.concat(prefix, ".slotsPerEpoch")));

        string memory versionsKey = string.concat(prefix, ".supportedVersions");
        uint256 versionCount = _arrayLength(json, versionsKey);
        if (versionCount == 0) revert EmptyConfigList(versionsKey);
        gate.supportedVersions = new BeaconForkGate.SupportedVersion[](versionCount);
        for (uint256 i = 0; i < versionCount; i++) {
            string memory entry = string.concat(versionsKey, "[", vm.toString(i), "]");
            gate.supportedVersions[i] = BeaconForkGate.SupportedVersion({
                version: _readForkVersion(json, string.concat(entry, ".version")),
                stateDepth: uint8(_readNonZeroUint(json, string.concat(entry, ".stateDepth")))
            });
        }

        string memory depthsKey = string.concat(prefix, ".sealDepths");
        uint256 depthCount = _arrayLength(json, depthsKey);
        if (depthCount == 0) revert EmptyConfigList(depthsKey);
        gate.sealDepths = new uint8[](depthCount);
        for (uint256 i = 0; i < depthCount; i++) {
            gate.sealDepths[i] = uint8(_readNonZeroUint(json, string.concat(depthsKey, "[", vm.toString(i), "]")));
        }
    }

    function _readGateMode(string memory text) private pure returns (BeaconForkGate.GateMode) {
        if (keccak256(bytes(text)) == keccak256("Enforcing")) return BeaconForkGate.GateMode.Enforcing;
        if (keccak256(bytes(text)) == keccak256("DetectBeaconRoots")) return BeaconForkGate.GateMode.DetectBeaconRoots;
        if (keccak256(bytes(text)) == keccak256("DetectBeaconRootsAndRegistry")) {
            return BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry;
        }
        revert UnknownGateMode(text);
    }

    function _readForkVersion(string memory json, string memory key) private pure returns (bytes4) {
        bytes memory raw = vm.parseBytes(_readText(json, key));
        if (raw.length != 4) revert ForkVersionLengthInvalid(key, raw.length);
        bytes4 version = bytes4(raw);
        if (version == bytes4(0)) revert ZeroConfigValue(key);
        return version;
    }

    /// @dev The number of elements of a JSON array: the first index that does not exist.
    function _arrayLength(string memory json, string memory path) private view returns (uint256 count) {
        while (vm.keyExistsJson(json, string.concat(path, "[", vm.toString(count), "]"))) {
            count++;
        }
    }

    function _readText(string memory json, string memory key) private pure returns (string memory text) {
        text = vm.parseJsonString(json, key);
        if (_isPlaceholder(text)) revert PlaceholderValue(key);
    }

    function _readAddress(string memory json, string memory key) private pure returns (address) {
        return _toAddress(_readText(json, key), key);
    }

    function _toAddress(string memory text, string memory key) private pure returns (address value) {
        if (_isPlaceholder(text)) revert PlaceholderValue(key);
        value = vm.parseAddress(text);
        if (value == address(0)) revert ZeroConfigValue(key);
    }

    /// @dev A key that is absent or zero means the chain has none. A placeholder is still refused.
    function _readOptionalAddress(string memory json, string memory key) private view returns (address) {
        if (!vm.keyExistsJson(json, key)) return address(0);
        return vm.parseAddress(_readText(json, key));
    }

    /// @dev The setting is the text `true` or `false`, like every value of the configuration. An absent key means
    /// `false`.
    function _readRouterChoice(string memory json, string memory key) private view returns (RouterChoice) {
        if (!vm.keyExistsJson(json, key)) return RouterChoice.Skip;
        string memory text = _readText(json, key);
        if (keccak256(bytes(text)) == keccak256("true")) return RouterChoice.Deploy;
        if (keccak256(bytes(text)) == keccak256("false")) return RouterChoice.Skip;
        revert UnknownFeeRouterSetting(text);
    }

    function _readBytes32(string memory json, string memory key) private pure returns (bytes32 value) {
        value = vm.parseBytes32(_readText(json, key));
        if (value == bytes32(0)) revert ZeroConfigValue(key);
    }

    function _readUint(string memory json, string memory key) private pure returns (uint256) {
        return vm.parseUint(_readText(json, key));
    }

    function _readNonZeroUint(string memory json, string memory key) private pure returns (uint256 value) {
        value = _readUint(json, key);
        if (value == 0) revert ZeroConfigValue(key);
    }

    /// @dev A value is a placeholder when it is empty or starts with `REPLACE`.
    function _isPlaceholder(string memory text) private pure returns (bool) {
        bytes memory raw = bytes(text);
        if (raw.length == 0) return true;
        return raw.length >= 7 && keccak256(_slice(raw, 7)) == keccak256("REPLACE");
    }

    function _slice(bytes memory raw, uint256 length) private pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = raw[i];
        }
    }
}
