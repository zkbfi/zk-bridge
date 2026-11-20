// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {FaucetToken} from "../../src/testnet/FaucetToken.sol";

/// @title DeployFaucetToken
/// @notice Deploys the open-mint test token `tFAU` on the chain of `--rpc-url` and prints its address.
/// @dev Run it once for each chain of the pair `sepolia-pls943`:
///
///     forge script script/testnet/DeployFaucetToken.s.sol --rpc-url sepolia \
///       --account "$KEYSTORE_NAME" --sender "$DEPLOYER" [--broadcast]
///
/// Without `--broadcast` nothing reaches a chain. The script never reads a private key: the signer is the Foundry
/// keystore account (or the signer flags that the operator chooses). The token has no owner, so the deployer keeps no
/// privilege over it. The script writes no file; the address goes into the deployment record of the pair afterwards.
contract DeployFaucetToken is Script {
    function run() external returns (FaucetToken token) {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        token = new FaucetToken();
        vm.stopBroadcast();

        console2.log("chain", block.chainid);
        console2.log("deployer", deployer);
        console2.log("tFAU", address(token));
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) && !vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            console2.log("dry run: nothing sent. Add --broadcast to deploy.");
        }
    }
}
