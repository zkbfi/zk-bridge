// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";

/// @title DeployBridge
/// @notice Deploys the hardened bridge on two chains with predicted cross-chain addresses.
/// @dev Run with `BRIDGE_CONFIG=<path> forge script script/hardened/DeployBridge.s.sol --account <keystore name>`.
/// Add `--broadcast` to send the transactions. Without it, nothing reaches a chain.
/// The script never reads a private key. The vaults start with no fork layouts. After deployment, anyone adds them
/// with `addBlockRootsLayout` and `addBlockHashLayout`, with evidence from the stored light-client data. Each chain gets a light client at the deployer nonce `n`
/// and a vault at `n + 1`. The light client on a chain tracks the OTHER chain's beacon chain.
contract DeployBridge is Script {
    /// @notice The settings of one chain. The `lightClient` fields describe the OTHER chain's beacon chain.
    struct ChainConfig {
        string rpcAlias;
        uint64 chainId;
        address verifier;
        uint256 deployerNonce;
        uint64 depositCutoffTimestamp;
        LightClientConfig lightClient;
    }

    /// @notice The checkpoint and the program of the light client on a chain. They describe the OTHER chain's beacon chain.
    struct LightClientConfig {
        bytes32 programVKey;
        bytes32 genesisValidatorsRoot;
        uint64 slotsPerPeriod;
        uint64 slotsPerHistoricalRoot;
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
        address vaultA;
        address lightClientB;
        address vaultB;
    }

    /// @notice Everything that deploys one chain.
    struct ChainDeployment {
        ChainConfig chain;
        address deployer;
        address predictedLightClient;
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
    /// @notice A token address holds no code on its chain.
    error TokenHasNoCode(uint64 chainId, address token);
    /// @notice The signer of the script is not the configured deployer.
    error DeployerMismatch(address configured, address actual);
    /// @notice A deployed contract is not at its predicted address.
    error AddressNotAsPredicted(string name, address predicted, address actual);
    /// @notice A value read back from a deployed contract differs from the configuration.
    error DeploymentMismatch(string field);

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
            baseDeployment(config.chainA, config.chainB.chainId, config.deployer, plan.lightClientA, plan.vaultA, plan.vaultB),
            config.tokensA,
            config.tokensB,
            decimalsB
        );
        ChainDeployment memory deploymentB = withPairs(
            baseDeployment(config.chainB, config.chainA.chainId, config.deployer, plan.lightClientB, plan.vaultB, plan.vaultA),
            config.tokensB,
            config.tokensA,
            decimalsA
        );

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
        plan.lightClientA = vm.computeCreateAddress(config.deployer, config.chainA.deployerNonce);
        plan.vaultA = vm.computeCreateAddress(config.deployer, config.chainA.deployerNonce + 1);
        plan.lightClientB = vm.computeCreateAddress(config.deployer, config.chainB.deployerNonce);
        plan.vaultB = vm.computeCreateAddress(config.deployer, config.chainB.deployerNonce + 1);
    }

    /// @notice Prints the plan.
    /// @param config The validated configuration.
    /// @param plan The predicted addresses.
    function logPlan(BridgeConfig memory config, Plan memory plan) public pure {
        console2.log("deployer", config.deployer);
        console2.log("chain A", config.chainA.chainId, config.chainA.rpcAlias);
        console2.log("  nonce", config.chainA.deployerNonce);
        console2.log("  light client", plan.lightClientA);
        console2.log("  vault", plan.vaultA);
        console2.log("chain B", config.chainB.chainId, config.chainB.rpcAlias);
        console2.log("  nonce", config.chainB.deployerNonce);
        console2.log("  light client", plan.lightClientB);
        console2.log("  vault", plan.vaultB);
        console2.log("token pairs", config.tokensA.length);
    }

    /// @notice Joins the configuration of one chain with the plan. The token pairs stay empty.
    /// @param chain The settings of the chain.
    /// @param remoteChainId The identifier of the other chain.
    /// @param deployer The deployer.
    /// @param lightClient The predicted light client address on this chain.
    /// @param vault The predicted vault address on this chain.
    /// @param remoteVault The predicted vault address on the other chain.
    function baseDeployment(
        ChainConfig memory chain,
        uint64 remoteChainId,
        address deployer,
        address lightClient,
        address vault,
        address remoteVault
    ) public pure returns (ChainDeployment memory deployment) {
        deployment.chain = chain;
        deployment.deployer = deployer;
        deployment.predictedLightClient = lightClient;
        deployment.predictedVault = vault;
        deployment.remoteChainId = remoteChainId;
        deployment.remoteVault = remoteVault;
        deployment.pairs = new BridgeVault.TokenPair[](0);
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

    /// @notice Refuses to continue when the connected chain, the deployer nonce, or the verifier is wrong.
    /// @param chain The settings of the connected chain.
    /// @param deployer The deployer.
    function assertChainEnvironment(ChainConfig memory chain, address deployer) public view {
        if (block.chainid != chain.chainId) revert ChainIdMismatch(chain.chainId, block.chainid);
        uint256 nonce = vm.getNonce(deployer);
        if (nonce != chain.deployerNonce) revert DeployerNonceMismatch(chain.chainId, chain.deployerNonce, nonce);
        if (chain.verifier.code.length == 0) revert VerifierHasNoCode(chain.chainId, chain.verifier);
    }

    // ------------------------------------------------------------------ deployment

    /// @notice Deploys the light client and the vault from the deployer, then reads everything back.
    /// @dev The caller selects the right fork first. The light client takes nonce `n`, the vault `n + 1`.
    /// @param deployment The deployment of one chain.
    /// @return lightClient The deployed light client.
    /// @return vault The deployed vault.
    function deployChain(ChainDeployment memory deployment) public returns (address lightClient, address vault) {
        assertChainEnvironment(deployment.chain, deployment.deployer);
        ChainConfig memory chain = deployment.chain;

        vm.startBroadcast(deployment.deployer);
        lightClient = address(
            new BeaconLightClient(
                chain.verifier,
                chain.lightClient.programVKey,
                chain.lightClient.genesisValidatorsRoot,
                chain.lightClient.slotsPerPeriod,
                chain.lightClient.initialSlot,
                chain.lightClient.initialHeaderRoot,
                chain.lightClient.initialSyncCommitteeHash,
                chain.lightClient.initialNextSyncCommitteeHash,
                chain.lightClient.slotsPerHistoricalRoot
            )
        );
        vault = address(
            new BridgeVault(
                lightClient,
                chain.chainId,
                deployment.remoteChainId,
                deployment.remoteVault,
                deployment.pairs,
                chain.depositCutoffTimestamp
            )
        );
        vm.stopBroadcast();

        verifyDeployment(deployment, lightClient, vault);
    }

    /// @notice Reads every immutable back and compares it with the configuration and the prediction.
    /// @param deployment The deployment of one chain.
    /// @param lightClient The deployed light client.
    /// @param vault The deployed vault.
    function verifyDeployment(ChainDeployment memory deployment, address lightClient, address vault) public view {
        ChainConfig memory chain = deployment.chain;
        if (lightClient != deployment.predictedLightClient) {
            revert AddressNotAsPredicted("lightClient", deployment.predictedLightClient, lightClient);
        }
        if (vault != deployment.predictedVault) revert AddressNotAsPredicted("vault", deployment.predictedVault, vault);

        BeaconLightClient client = BeaconLightClient(lightClient);
        if (address(client.verifier()) != chain.verifier) revert DeploymentMismatch("lightClient.verifier");
        if (client.programVKey() != chain.lightClient.programVKey) revert DeploymentMismatch("lightClient.programVKey");
        if (client.genesisValidatorsRoot() != chain.lightClient.genesisValidatorsRoot) {
            revert DeploymentMismatch("lightClient.genesisValidatorsRoot");
        }
        if (client.slotsPerPeriod() != chain.lightClient.slotsPerPeriod) revert DeploymentMismatch("lightClient.slotsPerPeriod");
        if (client.slotsPerHistoricalRoot() != chain.lightClient.slotsPerHistoricalRoot) {
            revert DeploymentMismatch("lightClient.slotsPerHistoricalRoot");
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

        BridgeVault bridgeVault = BridgeVault(vault);
        if (address(bridgeVault.lightClient()) != lightClient) revert DeploymentMismatch("vault.lightClient");
        if (bridgeVault.localChainId() != chain.chainId) revert DeploymentMismatch("vault.localChainId");
        if (bridgeVault.remoteChainId() != deployment.remoteChainId) revert DeploymentMismatch("vault.remoteChainId");
        if (bridgeVault.remoteVault() != deployment.remoteVault) revert DeploymentMismatch("vault.remoteVault");
        if (bridgeVault.depositCutoffTimestamp() != chain.depositCutoffTimestamp) {
            revert DeploymentMismatch("vault.depositCutoffTimestamp");
        }
        if (bridgeVault.stateLayouts().length != 0 || bridgeVault.bodyLayouts().length != 0) {
            revert DeploymentMismatch("vault.layouts must start empty");
        }
        for (uint256 i = 0; i < deployment.pairs.length; i++) {
            BridgeVault.TokenPair memory pair = deployment.pairs[i];
            if (bridgeVault.remoteTokenOf(pair.localToken) != pair.remoteToken) revert DeploymentMismatch("vault.remoteTokenOf");
            if (bridgeVault.localTokenOf(pair.remoteToken) != pair.localToken) revert DeploymentMismatch("vault.localTokenOf");
        }
    }

    // ------------------------------------------------------------------ internals

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
        chain.deployerNonce = _readUint(json, string.concat(prefix, ".deployerNonce"));
        chain.depositCutoffTimestamp = uint64(_readUint(json, string.concat(prefix, ".depositCutoffTimestamp")));
        string memory client = string.concat(prefix, ".lightClient");
        chain.lightClient.programVKey = _readBytes32(json, string.concat(client, ".programVKey"));
        chain.lightClient.genesisValidatorsRoot = _readBytes32(json, string.concat(client, ".genesisValidatorsRoot"));
        chain.lightClient.slotsPerPeriod = uint64(_readNonZeroUint(json, string.concat(client, ".slotsPerPeriod")));
        chain.lightClient.slotsPerHistoricalRoot = uint64(_readNonZeroUint(json, string.concat(client, ".slotsPerHistoricalRoot")));
        chain.lightClient.initialSlot = uint64(_readNonZeroUint(json, string.concat(client, ".initialSlot")));
        chain.lightClient.initialHeaderRoot = _readBytes32(json, string.concat(client, ".initialHeaderRoot"));
        chain.lightClient.initialSyncCommitteeHash = _readBytes32(json, string.concat(client, ".initialSyncCommitteeHash"));
        chain.lightClient.initialNextSyncCommitteeHash = _readBytes32(json, string.concat(client, ".initialNextSyncCommitteeHash"));
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
