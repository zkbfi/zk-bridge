// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {ForkRegistry} from "../../src/hardened/ForkRegistry.sol";

/// @title DeployBridge
/// @notice Deploys the hardened bridge on two chains with predicted cross-chain addresses.
/// @dev Run with `BRIDGE_CONFIG=<path> forge script script/hardened/DeployBridge.s.sol --account <keystore name>`.
/// Add `--broadcast` to send the transactions. Without it, nothing reaches a chain.
/// The script never reads a private key. The vaults start with no fork layouts. After deployment, anyone adds them
/// with `addBlockRootsLayout`, `addBlockHashLayout` and `addHistoricalSummariesLayout`, with evidence from the stored
/// light-client data. Each chain gets a light client at the deployer nonce `n`, a deposit gate at `n + 1` and a vault
/// at `n + 2`. A chain whose gate runs in `DetectBeaconRootsAndRegistry` mode (PulseChain) also gets a light client of
/// its OWN beacon chain and a fork registry, so its layout is: light client `n`, own light client `n + 1`, registry
/// `n + 2`, gate `n + 3`, vault `n + 4`. The light client on a chain tracks the OTHER chain's beacon chain. The deposit gate on a chain reads the
/// beacon chain of THAT chain, because it guards the deposits made there.
contract DeployBridge is Script {
    /// @notice The settings of one chain. The `lightClient` fields describe the OTHER chain's beacon chain.
    struct ChainConfig {
        string rpcAlias;
        uint64 chainId;
        address verifier;
        bytes32 verifierCodeHash;
        uint256 deployerNonce;
        uint64 depositCutoffTimestamp;
        FeeConfig fee;
        LightClientConfig lightClient;
        GateConfig gate;
        ObservationConfig observation;
    }

    /// @notice The deposit fee switch of the vault on a chain. A zero `authority` removes the fee from the start: the
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
    /// The Capella fields belong to the vault on this chain: it proves deposits of the OTHER chain.
    struct LightClientConfig {
        bytes32 programVKey;
        bytes32 genesisValidatorsRoot;
        uint64 slotsPerPeriod;
        uint64 slotsPerEpoch;
        uint64 capellaForkEpoch;
        uint64 capellaEra;
        uint64 initialSlot;
        bytes32 initialHeaderRoot;
        bytes32 initialSyncCommitteeHash;
        bytes32 initialNextSyncCommitteeHash;
    }

    /// @notice The whole configuration. `tokensA[i]` and `tokensB[i]` are the same asset on the two chains.
    struct BridgeConfig {
        address deployer;
        ChainConfig chainA;
        ChainConfig chainB;
        address[] tokensA;
        address[] tokensB;
    }

    /// @notice The predicted addresses on both chains.
    struct Plan {
        address lightClientA;
        address observedLightClientA;
        address registryA;
        address gateA;
        address vaultA;
        address lightClientB;
        address observedLightClientB;
        address registryB;
        address gateB;
        address vaultB;
    }

    /// @notice Everything that deploys one chain.
    struct ChainDeployment {
        ChainConfig chain;
        address deployer;
        address predictedLightClient;
        address predictedObservedLightClient;
        address predictedRegistry;
        address predictedGate;
        address predictedVault;
        uint64 remoteChainId;
        address remoteVault;
        BridgeVault.TokenPair[] pairs;
    }

    /// @notice A configuration value still holds a placeholder.
    error PlaceholderValue(string key);
    /// @notice A configuration value is zero.
    error ZeroConfigValue(string key);
    /// @notice The two chains share one chain identifier.
    error SameChainIdentifier(uint64 chainId);
    /// @notice The configuration has no token pairs.
    error NoTokenPairsConfigured();
    /// @notice The two token lists differ in length.
    error TokenPairLengthMismatch(uint256 tokensA, uint256 tokensB);
    /// @notice The connected chain is not the configured chain.
    error ChainIdMismatch(uint64 configured, uint256 actual);
    /// @notice The deployer nonce on the chain differs from the configuration.
    error DeployerNonceMismatch(uint64 chainId, uint256 configured, uint256 actual);
    /// @notice The verifier address holds no code on its chain.
    error VerifierHasNoCode(uint64 chainId, address verifier);
    /// @notice The code hash of the verifier differs from the pinned code hash.
    error VerifierCodeHashMismatch(uint64 chainId, address verifier, bytes32 expected, bytes32 actual);
    /// @notice A token address holds no code on its chain.
    error TokenHasNoCode(uint64 chainId, address token);
    /// @notice The signer of the script is not the configured deployer.
    error DeployerMismatch(address configured, address actual);
    /// @notice An observation setting does not match the other chain's settings or the light-client key.
    error ObservationMismatch(string field);
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
    /// @notice The slots of one era of `historical_summaries`. The vault fixes this number.
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

        (uint256 forkA, uint8[] memory decimalsA) = _inspectChain(config.chainA, config.deployer, config.tokensA);
        (uint256 forkB, uint8[] memory decimalsB) = _inspectChain(config.chainB, config.deployer, config.tokensB);
        logPlan(config, plan);

        ChainDeployment memory deploymentA = withPairs(
            baseDeployment(
                config.chainA, config.chainB.chainId, config.deployer, plan.lightClientA, plan.gateA, plan.vaultA, plan.vaultB
            ),
            config.tokensA,
            config.tokensB,
            decimalsB
        );
        deploymentA = withRegistry(deploymentA, plan.observedLightClientA, plan.registryA);
        ChainDeployment memory deploymentB = withPairs(
            baseDeployment(
                config.chainB, config.chainA.chainId, config.deployer, plan.lightClientB, plan.gateB, plan.vaultB, plan.vaultA
            ),
            config.tokensB,
            config.tokensA,
            decimalsA
        );
        deploymentB = withRegistry(deploymentB, plan.observedLightClientB, plan.registryB);

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
        _requireObservationMatchesOtherChain(config.chainA, config.chainB);
        _requireObservationMatchesOtherChain(config.chainB, config.chainA);

        uint256 pairCount = _arrayLength(json, ".tokenPairs");
        if (pairCount == 0) revert NoTokenPairsConfigured();
        config.tokensA = new address[](pairCount);
        config.tokensB = new address[](pairCount);
        for (uint256 i = 0; i < pairCount; i++) {
            string memory pair = string.concat(".tokenPairs[", vm.toString(i), "]");
            config.tokensA[i] = _toAddress(_readText(json, string.concat(pair, ".chainA")), ".tokenPairs.chainA");
            config.tokensB[i] = _toAddress(_readText(json, string.concat(pair, ".chainB")), ".tokenPairs.chainB");
        }
    }

    /// @notice Predicts every address from the deployer nonces. Nothing deploys here.
    /// @param config The validated configuration.
    function predictAddresses(BridgeConfig memory config) public pure returns (Plan memory plan) {
        (plan.lightClientA, plan.observedLightClientA, plan.registryA, plan.gateA, plan.vaultA) =
            _predictChain(config.deployer, config.chainA);
        (plan.lightClientB, plan.observedLightClientB, plan.registryB, plan.gateB, plan.vaultB) =
            _predictChain(config.deployer, config.chainB);
    }

    /// @notice Prints the plan.
    /// @param config The validated configuration.
    /// @param plan The predicted addresses.
    function logPlan(BridgeConfig memory config, Plan memory plan) public pure {
        console2.log("deployer", config.deployer);
        console2.log("chain A", config.chainA.chainId, config.chainA.rpcAlias);
        console2.log("  nonce", config.chainA.deployerNonce);
        console2.log("  light client", plan.lightClientA);
        console2.log("  own-chain light client", plan.observedLightClientA);
        console2.log("  fork registry", plan.registryA);
        console2.log("  deposit gate", plan.gateA);
        console2.log("  vault", plan.vaultA);
        console2.log("chain B", config.chainB.chainId, config.chainB.rpcAlias);
        console2.log("  nonce", config.chainB.deployerNonce);
        console2.log("  light client", plan.lightClientB);
        console2.log("  own-chain light client", plan.observedLightClientB);
        console2.log("  fork registry", plan.registryB);
        console2.log("  deposit gate", plan.gateB);
        console2.log("  vault", plan.vaultB);
        console2.log("token pairs", config.tokensA.length);
    }

    /// @notice Joins the configuration of one chain with the plan. The token pairs stay empty.
    /// @param chain The settings of the chain.
    /// @param remoteChainId The identifier of the other chain.
    /// @param deployer The deployer.
    /// @param lightClient The predicted light client address on this chain.
    /// @param gate The predicted deposit gate address on this chain.
    /// @param vault The predicted vault address on this chain.
    /// @param remoteVault The predicted vault address on the other chain.
    /// @dev The predicted own-chain light client and registry are zero here. Set them with `withRegistry`.
    function baseDeployment(
        ChainConfig memory chain,
        uint64 remoteChainId,
        address deployer,
        address lightClient,
        address gate,
        address vault,
        address remoteVault
    ) public pure returns (ChainDeployment memory deployment) {
        deployment.chain = chain;
        deployment.deployer = deployer;
        deployment.predictedLightClient = lightClient;
        deployment.predictedGate = gate;
        deployment.predictedVault = vault;
        deployment.remoteChainId = remoteChainId;
        deployment.remoteVault = remoteVault;
        deployment.pairs = new BridgeVault.TokenPair[](0);
    }

    /// @notice Adds the predicted own-chain light client and registry to a deployment.
    /// @param deployment The deployment.
    /// @param observedLightClient The predicted own-chain light client, or zero.
    /// @param registry The predicted fork registry, or zero.
    function withRegistry(ChainDeployment memory deployment, address observedLightClient, address registry)
        public
        pure
        returns (ChainDeployment memory)
    {
        deployment.predictedObservedLightClient = observedLightClient;
        deployment.predictedRegistry = registry;
        return deployment;
    }

    /// @notice Adds the token pairs to a deployment.
    /// @param deployment The deployment without pairs.
    /// @param localTokens The tokens on this chain.
    /// @param remoteTokens The same assets on the other chain.
    /// @param remoteDecimals The decimals of the remote tokens, read from the other chain.
    function withPairs(
        ChainDeployment memory deployment,
        address[] memory localTokens,
        address[] memory remoteTokens,
        uint8[] memory remoteDecimals
    ) public pure returns (ChainDeployment memory) {
        deployment.pairs = new BridgeVault.TokenPair[](localTokens.length);
        for (uint256 i = 0; i < localTokens.length; i++) {
            deployment.pairs[i] = BridgeVault.TokenPair({
                localToken: localTokens[i],
                remoteToken: remoteTokens[i],
                remoteDecimals: remoteDecimals[i]
            });
        }
        return deployment;
    }

    // ------------------------------------------------------------------ chain checks

    /// @notice Refuses to continue when the connected chain, the deployer nonce, the verifier or its pinned code hash,
    /// or the beacon roots contract of an enforcing gate is wrong. It runs before any broadcast.
    /// @param chain The settings of the connected chain.
    /// @param deployer The deployer.
    function assertChainEnvironment(ChainConfig memory chain, address deployer) public view {
        if (block.chainid != chain.chainId) revert ChainIdMismatch(chain.chainId, block.chainid);
        uint256 nonce = vm.getNonce(deployer);
        if (nonce != chain.deployerNonce) revert DeployerNonceMismatch(chain.chainId, chain.deployerNonce, nonce);
        if (chain.verifier.code.length == 0) revert VerifierHasNoCode(chain.chainId, chain.verifier);
        if (chain.verifier.codehash != chain.verifierCodeHash) {
            revert VerifierCodeHashMismatch(chain.chainId, chain.verifier, chain.verifierCodeHash, chain.verifier.codehash);
        }
        if (chain.gate.mode == BeaconForkGate.GateMode.Enforcing && BEACON_ROOTS.code.length == 0) {
            revert BeaconRootsHaveNoCode(chain.chainId, BEACON_ROOTS);
        }
    }

    // ------------------------------------------------------------------ deployment

    /// @notice Deploys the light client, the deposit gate and the vault from the deployer, then reads everything back.
    /// @dev The caller selects the right fork first. The light client takes nonce `n`, the gate `n + 1`, the vault `n + 2`.
    /// @param deployment The deployment of one chain.
    /// @return lightClient The deployed light client.
    /// @return gate The deployed deposit gate.
    /// @return vault The deployed vault.
    function deployChain(ChainDeployment memory deployment)
        public
        returns (address lightClient, address gate, address vault)
    {
        assertChainEnvironment(deployment.chain, deployment.deployer);

        vm.startBroadcast(deployment.deployer);
        lightClient = _deployLightClient(deployment.chain);
        address registry;
        address observedLightClient;
        if (deployment.chain.gate.mode == BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry) {
            observedLightClient = _deployObservedLightClient(deployment.chain);
            registry = _deployRegistry(deployment.chain, observedLightClient);
        }
        gate = _deployGate(deployment.chain.gate, registry);
        vault = _deployVault(deployment, lightClient, gate);
        vm.stopBroadcast();

        verifyDeployment(deployment, lightClient, gate, vault);
        verifyRegistry(deployment, gate);
    }

    /// @notice Reads every immutable back and compares it with the configuration and the prediction.
    /// @param deployment The deployment of one chain.
    /// @param lightClient The deployed light client.
    /// @param gate The deployed deposit gate.
    /// @param vault The deployed vault.
    function verifyDeployment(ChainDeployment memory deployment, address lightClient, address gate, address vault)
        public
        view
    {
        if (lightClient != deployment.predictedLightClient) {
            revert AddressNotAsPredicted("lightClient", deployment.predictedLightClient, lightClient);
        }
        if (gate != deployment.predictedGate) revert AddressNotAsPredicted("gate", deployment.predictedGate, gate);
        if (vault != deployment.predictedVault) revert AddressNotAsPredicted("vault", deployment.predictedVault, vault);
        _verifyLightClient(deployment.chain, lightClient);
        _verifyGate(deployment.chain.gate, gate);
        _verifyVault(deployment, lightClient, gate, vault);
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
        if (registry != deployment.predictedRegistry) {
            revert AddressNotAsPredicted("forkRegistry", deployment.predictedRegistry, registry);
        }
        ForkRegistry deployedRegistry = ForkRegistry(registry);
        address client = address(deployedRegistry.lightClient());
        if (client != deployment.predictedObservedLightClient) {
            revert AddressNotAsPredicted("observedLightClient", deployment.predictedObservedLightClient, client);
        }
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

    /// @dev Light client at `n`; with a registry: own light client `n + 1`, registry `n + 2`; then gate and vault.
    function _predictChain(address deployer, ChainConfig memory chain)
        private
        pure
        returns (address lightClient, address observedLightClient, address registry, address gate, address vault)
    {
        uint256 nonce = chain.deployerNonce;
        lightClient = vm.computeCreateAddress(deployer, nonce++);
        if (chain.gate.mode == BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry) {
            observedLightClient = vm.computeCreateAddress(deployer, nonce++);
            registry = vm.computeCreateAddress(deployer, nonce++);
        }
        gate = vm.computeCreateAddress(deployer, nonce++);
        vault = vm.computeCreateAddress(deployer, nonce);
    }

    function _deployLightClient(ChainConfig memory chain) private returns (address) {
        return address(
            new BeaconLightClient(
                chain.verifier,
                chain.lightClient.programVKey,
                chain.lightClient.genesisValidatorsRoot,
                chain.lightClient.slotsPerPeriod,
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

    function _deployVault(ChainDeployment memory deployment, address lightClient, address gate)
        private
        returns (address)
    {
        ChainConfig memory chain = deployment.chain;
        return address(
            new BridgeVault(
                lightClient,
                chain.chainId,
                deployment.remoteChainId,
                deployment.remoteVault,
                deployment.pairs,
                BridgeVault.DepositTerms({
                    cutoffTimestamp: chain.depositCutoffTimestamp,
                    feeAuthority: chain.fee.authority,
                    feeRecipient: chain.fee.recipient,
                    feeBasisPoints: chain.fee.basisPoints,
                    feeCeilingBasisPoints: chain.fee.ceilingBasisPoints
                }),
                chain.lightClient.capellaEra,
                gate
            )
        );
    }

    function _verifyLightClient(ChainConfig memory chain, address lightClient) private view {

        BeaconLightClient client = BeaconLightClient(lightClient);
        if (address(client.verifier()) != chain.verifier) revert DeploymentMismatch("lightClient.verifier");
        if (client.programVKey() != chain.lightClient.programVKey) revert DeploymentMismatch("lightClient.programVKey");
        if (client.genesisValidatorsRoot() != chain.lightClient.genesisValidatorsRoot) {
            revert DeploymentMismatch("lightClient.genesisValidatorsRoot");
        }
        if (client.slotsPerPeriod() != chain.lightClient.slotsPerPeriod) revert DeploymentMismatch("lightClient.slotsPerPeriod");
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

    function _verifyVault(ChainDeployment memory deployment, address lightClient, address gate, address vault)
        private
        view
    {
        ChainConfig memory chain = deployment.chain;
        BridgeVault bridgeVault = BridgeVault(vault);
        if (address(bridgeVault.lightClient()) != lightClient) revert DeploymentMismatch("vault.lightClient");
        if (bridgeVault.localChainId() != chain.chainId) revert DeploymentMismatch("vault.localChainId");
        if (bridgeVault.remoteChainId() != deployment.remoteChainId) revert DeploymentMismatch("vault.remoteChainId");
        if (bridgeVault.remoteVault() != deployment.remoteVault) revert DeploymentMismatch("vault.remoteVault");
        if (bridgeVault.depositCutoffTimestamp() != chain.depositCutoffTimestamp) {
            revert DeploymentMismatch("vault.depositCutoffTimestamp");
        }
        if (bridgeVault.capellaEra() != chain.lightClient.capellaEra) revert DeploymentMismatch("vault.capellaEra");
        if (address(bridgeVault.depositGate()) != gate) revert DeploymentMismatch("vault.depositGate");
        if (bridgeVault.feeAuthority() != chain.fee.authority) revert DeploymentMismatch("vault.feeAuthority");
        if (bridgeVault.feeRecipient() != chain.fee.recipient) revert DeploymentMismatch("vault.feeRecipient");
        if (bridgeVault.feeBasisPoints() != chain.fee.basisPoints) revert DeploymentMismatch("vault.feeBasisPoints");
        if (bridgeVault.feeCeilingBasisPoints() != chain.fee.ceilingBasisPoints) {
            revert DeploymentMismatch("vault.feeCeilingBasisPoints");
        }
        if (
            bridgeVault.stateLayouts().length != 0 || bridgeVault.bodyLayouts().length != 0
                || bridgeVault.historicalLayouts().length != 0
        ) {
            revert DeploymentMismatch("vault.layouts must start empty");
        }
        for (uint256 i = 0; i < deployment.pairs.length; i++) {
            BridgeVault.TokenPair memory pair = deployment.pairs[i];
            if (bridgeVault.remoteTokenOf(pair.localToken) != pair.remoteToken) revert DeploymentMismatch("vault.remoteTokenOf");
            if (bridgeVault.localTokenOf(pair.remoteToken) != pair.localToken) revert DeploymentMismatch("vault.localTokenOf");
        }
    }

    /// @dev Connects to the chain, runs the checks, and reads the decimals of the tokens on that chain.
    function _inspectChain(ChainConfig memory chain, address deployer, address[] memory tokens)
        private
        returns (uint256 forkId, uint8[] memory decimals)
    {
        forkId = vm.createSelectFork(chain.rpcAlias);
        assertChainEnvironment(chain, deployer);
        decimals = new uint8[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i].code.length == 0) revert TokenHasNoCode(chain.chainId, tokens[i]);
            decimals[i] = IERC20Metadata(tokens[i]).decimals();
        }
    }

    function _readChain(string memory json, string memory prefix) private view returns (ChainConfig memory chain) {
        chain.rpcAlias = _readText(json, string.concat(prefix, ".rpcAlias"));
        chain.chainId = uint64(_readNonZeroUint(json, string.concat(prefix, ".chainId")));
        chain.verifier = _readAddress(json, string.concat(prefix, ".verifier"));
        chain.verifierCodeHash = _readBytes32(json, string.concat(prefix, ".verifierCodeHash"));
        chain.deployerNonce = _readUint(json, string.concat(prefix, ".deployerNonce"));
        chain.depositCutoffTimestamp = uint64(_readUint(json, string.concat(prefix, ".depositCutoffTimestamp")));
        chain.fee = _readFee(json, string.concat(prefix, ".fee"));
        string memory client = string.concat(prefix, ".lightClient");
        chain.lightClient.programVKey = _readBytes32(json, string.concat(client, ".programVKey"));
        chain.lightClient.genesisValidatorsRoot = _readBytes32(json, string.concat(client, ".genesisValidatorsRoot"));
        chain.lightClient.slotsPerPeriod = uint64(_readNonZeroUint(json, string.concat(client, ".slotsPerPeriod")));
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
        if (chain.observation.observationProgramVKey == chain.lightClient.programVKey) {
            revert ObservationMismatch("observationProgramVKey equals the light client key");
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
