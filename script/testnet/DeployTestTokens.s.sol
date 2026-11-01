// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";

/// @title DeployTestTokens
/// @notice Deploys the two test tokens of the testnet on the chain of `--rpc-url`, mints a starting balance to the
/// traffic wallet, and writes the addresses into the test token file next to the testnet deployment.
/// @dev Run it once for each chain of the pair `sepolia-pls943` (docs/testnet-run.md, "Test tokens and traffic"):
///
///     TRAFFIC_WALLET=<address> forge script script/testnet/DeployTestTokens.s.sol --rpc-url sepolia \
///       --account "$KEYSTORE_NAME" --sender "$DEPLOYER" [--broadcast]
///
/// Without `--broadcast` nothing reaches a chain and no file is written. The script never reads a private key: the
/// signer is the Foundry keystore account (or `ETH_PRIVATE_KEY` style flags that the operator chooses), and the sender
/// becomes the minter of both tokens.
///
/// Environment:
///   TRAFFIC_WALLET          required. The account that receives the starting balance.
///   TUSD_MINT_WHOLE         whole tUSD to mint (6 decimals). Default 1,000,000.
///   TTKN_MINT_WHOLE         whole tTKN to mint (18 decimals). Default 1,000,000.
///   TEST_TOKENS_FILE        the file to write. Default deploy/deployments/sepolia-pls943.test-tokens.json.
///   TEST_TOKENS_REDEPLOY    true deploys again on a chain that the file lists already. Default false.
///
/// The file holds one section for each chain id, so the run on the second chain keeps the section of the first.
contract DeployTestTokens is Script {
    /// @notice The file that the testnet runbook uses.
    string public constant DEFAULT_FILE = "deploy/deployments/sepolia-pls943.test-tokens.json";

    /// @notice The dollar token: 6 decimals, like the dollar tokens people bridge.
    string public constant DOLLAR_NAME = "zkb Test Dollar";
    string public constant DOLLAR_SYMBOL = "tUSD";
    uint8 public constant DOLLAR_DECIMALS = 6;

    /// @notice The plain token: 18 decimals.
    string public constant TOKEN_NAME = "zkb Test Token";
    string public constant TOKEN_SYMBOL = "tTKN";
    uint8 public constant TOKEN_DECIMALS = 18;

    /// @notice What one run deployed.
    struct Deployed {
        TestToken dollar;
        TestToken token;
        address minter;
        address recipient;
    }

    function run() external returns (Deployed memory deployed) {
        address recipient = vm.envAddress("TRAFFIC_WALLET");
        require(recipient != address(0), "TRAFFIC_WALLET is the zero address");
        uint256 dollarWhole = vm.envOr("TUSD_MINT_WHOLE", uint256(1_000_000));
        uint256 tokenWhole = vm.envOr("TTKN_MINT_WHOLE", uint256(1_000_000));
        string memory file = vm.envOr("TEST_TOKENS_FILE", DEFAULT_FILE);
        bool redeploy = vm.envOr("TEST_TOKENS_REDEPLOY", false);

        string memory chainKey = vm.toString(block.chainid);
        string memory existing = vm.exists(file) ? vm.readFile(file) : "{}";
        require(
            redeploy || !vm.keyExistsJson(existing, string.concat(".", chainKey)),
            string.concat(file, " lists chain ", chainKey, " already. Set TEST_TOKENS_REDEPLOY=true to deploy again.")
        );

        vm.startBroadcast();
        (, address minter,) = vm.readCallers();
        TestToken dollar = new TestToken(DOLLAR_NAME, DOLLAR_SYMBOL, DOLLAR_DECIMALS, minter);
        TestToken token = new TestToken(TOKEN_NAME, TOKEN_SYMBOL, TOKEN_DECIMALS, minter);
        if (dollarWhole > 0) dollar.mint(recipient, dollarWhole * 10 ** DOLLAR_DECIMALS);
        if (tokenWhole > 0) token.mint(recipient, tokenWhole * 10 ** TOKEN_DECIMALS);
        vm.stopBroadcast();

        deployed = Deployed({dollar: dollar, token: token, minter: minter, recipient: recipient});
        console2.log("chain", block.chainid);
        console2.log("minter", minter);
        console2.log("traffic wallet", recipient);
        console2.log("tUSD", address(dollar), dollarWhole);
        console2.log("tTKN", address(token), tokenWhole);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            vm.writeJson(_merged(existing, chainKey, deployed), file);
            console2.log("wrote", file);
        } else {
            console2.log("dry run: no file written. Add --broadcast to deploy.");
        }
    }

    /// @dev The file with the section of this chain set, and every other section as it was.
    function _merged(string memory existing, string memory chainKey, Deployed memory deployed)
        private
        returns (string memory)
    {
        string memory root = "root";
        vm.serializeJson(root, existing);
        string memory section = string.concat("chain-", chainKey);
        vm.serializeUint(section, "chain_id", block.chainid);
        vm.serializeAddress(section, "minter", deployed.minter);
        vm.serializeAddress(section, "traffic_wallet", deployed.recipient);
        string memory tokens = string.concat("tokens-", chainKey);
        vm.serializeString(tokens, DOLLAR_SYMBOL, _tokenJson(deployed.dollar, chainKey));
        string memory tokensJson = vm.serializeString(tokens, TOKEN_SYMBOL, _tokenJson(deployed.token, chainKey));
        string memory sectionJson = vm.serializeString(section, "tokens", tokensJson);
        return vm.serializeString(root, chainKey, sectionJson);
    }

    function _tokenJson(TestToken token, string memory chainKey) private returns (string memory) {
        string memory key = string.concat(token.symbol(), "-", chainKey);
        vm.serializeString(key, "name", token.name());
        vm.serializeString(key, "symbol", token.symbol());
        vm.serializeUint(key, "decimals", token.decimals());
        return vm.serializeAddress(key, "address", address(token));
    }
}
