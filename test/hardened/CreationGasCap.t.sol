// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";

/// @notice Every contract that the deploy scripts create stays under the per-transaction gas cap of EIP-7825 on Sepolia,
/// with room.
/// @dev Sepolia charges far more than the local EVM for new code. Measured: the receipts of the deployment of 2026-10-26
/// (`MessageBridge`, 22,465 bytes of runtime code, 35,555,393 gas: 1,583 gas per byte) and `eth_estimateGas` of the
/// creations of this build on Sepolia on 2026-11-07 (runtime code of 4,960 to 9,828 bytes: 1,580 to 1,601 gas per
/// byte, the higher figures for the smaller libraries, whose fixed cost weighs more). The model below takes 1,600 gas per
/// byte of runtime code, and 64 gas per byte of the rest of the creation code (the constructor and its arguments travel
/// as calldata), and requires each creation to stay under 90% of 16,777,216. It reads the sizes from the build output,
/// so a contract that grows past the budget fails here before a deployment does.
contract CreationGasCapTest is Test {
    /// @notice The per-transaction gas cap of EIP-7825.
    uint256 internal constant TRANSACTION_GAS_CAP = 16_777_216;
    /// @notice What Sepolia charges per byte of runtime code of a creation, rounded up from the measurements above.
    uint256 internal constant SEPOLIA_GAS_PER_RUNTIME_BYTE = 1_600;
    /// @notice What the rest of the creation code costs per byte, at most.
    uint256 internal constant GAS_PER_CONSTRUCTOR_BYTE = 64;
    /// @notice The share of the cap that one creation may use: the room is 10%.
    uint256 internal constant BUDGET_PERCENT = 90;
    /// @notice The base cost of a CREATE inside a creation (the router creates its `RouterCaller`).
    uint256 internal constant NESTED_CREATE_GAS = 32_000;

    /// Claim: each of the eight creations of `RedeployLayers` (layers mode), the gate that the `layers-and-gate` mode
    /// creates first (`BeaconForkGate`; its constructor also creates the opcode probe, about 60 bytes, inside the room),
    /// and each other contract of `DeployBridge` fits the cap with 10% room at Sepolia's price of code. Shows: the estimate of every contract, printed, is under
    /// the budget. Matters: a creation above the cap is refused by the node, and the bridges and the mediators name their
    /// twins by predicted address, so a refused creation in the middle of the run strands the plan.
    function test_everyCreationFitsTheGasCapWithRoom() public view {
        string[11] memory names = [
            "ReceiptProofLib",
            "OpeningProofLib",
            "BeaconLayoutLib",
            "MessageBridge",
            "MediatorPayloads",
            "TokenFactory",
            "TokenMediator",
            "DeliveryRouter",
            "BeaconLightClient",
            "ForkRegistry",
            "BeaconForkGate"
        ];
        uint256 budget = TRANSACTION_GAS_CAP * BUDGET_PERCENT / 100;
        for (uint256 i = 0; i < names.length; i++) {
            (uint256 runtime, uint256 creation) = _sizes(names[i]);
            uint256 estimate = runtime * SEPOLIA_GAS_PER_RUNTIME_BYTE + (creation - runtime) * GAS_PER_CONSTRUCTOR_BYTE;
            if (keccak256(bytes(names[i])) == keccak256("DeliveryRouter")) estimate += _nestedRouterCaller();
            console2.log(names[i], runtime, estimate);
            assertLe(estimate, budget, names[i]);
        }
    }

    /// Claim: the budget is a runtime size of about 9,400 bytes, and the unsplit bridge was far above it. Shows: the
    /// largest runtime under the budget, and that 22,465 bytes (the bridge of 2026-10-26) is over the cap itself.
    /// Matters: the reason for the split, pinned as numbers.
    function test_theBudgetIsAboutNineThousandFourHundredBytes() public pure {
        uint256 budget = TRANSACTION_GAS_CAP * BUDGET_PERCENT / 100;
        assertEq(budget / SEPOLIA_GAS_PER_RUNTIME_BYTE, 9437);
        assertGt(22_465 * SEPOLIA_GAS_PER_RUNTIME_BYTE, TRANSACTION_GAS_CAP);
    }

    /// Claim: the creation of the router, with the `RouterCaller` that its constructor creates, fits the budget.
    /// Shows: the router's estimate plus the caller's runtime code at Sepolia's price and the base of a CREATE, printed,
    /// is under the budget. Matters: the router creates its caller in the same transaction (code review, 2026-11-18,
    /// third round), so the caller's code is paid inside the router's creation; the creation code of the caller already
    /// counts in the router's constructor bytes.
    function test_theRouterWithItsCallerFitsTheGasCapWithRoom() public view {
        (uint256 runtime, uint256 creation) = _sizes("DeliveryRouter");
        uint256 estimate = runtime * SEPOLIA_GAS_PER_RUNTIME_BYTE + (creation - runtime) * GAS_PER_CONSTRUCTOR_BYTE
            + _nestedRouterCaller();
        uint256 budget = TRANSACTION_GAS_CAP * BUDGET_PERCENT / 100;
        console2.log("DeliveryRouter with its RouterCaller", estimate, budget - estimate);
        assertLe(estimate, budget);
    }

    /// @dev What the router's constructor adds when it creates its `RouterCaller`: the caller's runtime code at
    /// Sepolia's price and the base of a CREATE.
    function _nestedRouterCaller() private view returns (uint256) {
        (uint256 callerRuntime,) = _sizes("RouterCaller");
        return callerRuntime * SEPOLIA_GAS_PER_RUNTIME_BYTE + NESTED_CREATE_GAS;
    }

    /// @dev The runtime and the creation code sizes from the build output. A library placeholder is 40 hex digits, the
    /// size of the address that replaces it, so the sizes of unlinked code are the sizes of the deployed code.
    function _sizes(string memory name) private view returns (uint256 runtime, uint256 creation) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/out/", name, ".sol/", name, ".json"));
        runtime = (bytes(vm.parseJsonString(json, ".deployedBytecode.object")).length - 2) / 2;
        creation = (bytes(vm.parseJsonString(json, ".bytecode.object")).length - 2) / 2;
        assertGt(runtime, 0, name);
    }
}
