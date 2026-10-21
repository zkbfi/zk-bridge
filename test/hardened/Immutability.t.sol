// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// @notice ABI checks: the contracts have no owner, no upgrade path, and no setter.
contract ImmutabilityTest is Test {
    /// @dev A query with one match returns a bare string, and a query with several returns an array.
    function _names(string memory artifact, string memory query) internal view returns (string[] memory names) {
        bytes memory raw = vm.parseJson(vm.readFile(artifact), query);
        try this.decodeNames(raw) returns (string[] memory many) {
            return many;
        } catch {
            names = new string[](1);
            names[0] = abi.decode(raw, (string));
        }
    }

    /// @dev External so that `_names` can catch a decoding failure.
    function decodeNames(bytes calldata raw) external pure returns (string[] memory) {
        return abi.decode(raw, (string[]));
    }

    function _mutatingFunctions(string memory artifact) internal view returns (string[] memory) {
        return _names(
            artifact, '$.abi[?(@.type=="function" && @.stateMutability!="view" && @.stateMutability!="pure")].name'
        );
    }

    function _assertOnly(string[] memory names, string[] memory allowed) internal pure {
        assertEq(names.length, allowed.length, "unexpected number of state-changing functions");
        for (uint256 i = 0; i < allowed.length; i++) {
            assertEq(names[i], allowed[i]);
        }
    }

    /// Claim: the light client has no owner, upgrade path, pause, or setter. Shows: the ABI lists exactly one
    /// state-changing function, `update`. Matters: H-04 and H-01 (nobody can swap the verifier, the program key, or
    /// the committee by a privileged call; the immutables have no setter).
    function test_H04_beaconLightClient_onlyUpdateChangesState() public view {
        string[] memory allowed = new string[](1);
        allowed[0] = "update";
        _assertOnly(_mutatingFunctions("out/BeaconLightClient.sol/BeaconLightClient.json"), allowed);
    }

    /// Claim: the vault has no owner, upgrade path, pause, or setter for the light client or anything else. Shows: the
    /// ABI lists exactly four state-changing functions: `deposit`, `withdraw`, and the two open layout functions, which
    /// only add positions that stored light-client data proves. Matters: H-04 (no key can redirect the vault).
    function test_H04_bridgeVault_onlyDepositWithdrawAndLayoutFunctionsChangeState() public view {
        string[] memory names = _mutatingFunctions("out/BridgeVault.sol/BridgeVault.json");
        assertEq(names.length, 4);
        uint256 matched;
        for (uint256 i = 0; i < names.length; i++) {
            bytes32 hashed = keccak256(bytes(names[i]));
            if (
                hashed == keccak256("deposit") || hashed == keccak256("withdraw")
                    || hashed == keccak256("addBlockRootsLayout") || hashed == keccak256("addBlockHashLayout")
            ) matched++;
        }
        assertEq(matched, 4, "no other state-changing function exists");
    }

    /// Claim: `update` never takes a period (or a slot of a period) from the caller. Shows: its only inputs are
    /// `bytes proof` and `bytes publicValues`, and no input name mentions a period. Matters: R2-14 (periods come only from
    /// `periodOf(slot)`, so a caller cannot name the period whose committee is replaced).
    function test_R2_14_updateTakesNoPeriodParameter() public view {
        string[] memory inputNames = _names("out/BeaconLightClient.sol/BeaconLightClient.json", '$.abi[?(@.name=="update")].inputs[*].name');
        string[] memory inputTypes = _names("out/BeaconLightClient.sol/BeaconLightClient.json", '$.abi[?(@.name=="update")].inputs[*].type');
        assertEq(inputNames.length, 2);
        assertEq(inputTypes.length, 2);
        assertEq(inputNames[0], "proof");
        assertEq(inputNames[1], "publicValues");
        assertEq(inputTypes[0], "bytes");
        assertEq(inputTypes[1], "bytes");
    }

    /// Claim: no ownership or upgrade function names exist in either ABI. Shows: none of the usual names appear.
    /// Matters: a second line of defense in case the first test is weakened by a future mutability change.
    function test_H04_noOwnershipOrUpgradeNamesInAbi() public view {
        string[2] memory artifacts =
            ["out/BeaconLightClient.sol/BeaconLightClient.json", "out/BridgeVault.sol/BridgeVault.json"];
        string[9] memory banned = [
            "owner", "transferOwnership", "renounceOwnership", "upgradeTo", "upgradeToAndCall", "setVerifier",
            "setProgramVKey", "setLightClient", "pause"
        ];
        for (uint256 i = 0; i < 2; i++) {
            string[] memory names = _names(artifacts[i], '$.abi[?(@.type=="function")].name');
            for (uint256 j = 0; j < names.length; j++) {
                for (uint256 k = 0; k < banned.length; k++) {
                    assertTrue(keccak256(bytes(names[j])) != keccak256(bytes(banned[k])), banned[k]);
                }
            }
        }
    }
}
