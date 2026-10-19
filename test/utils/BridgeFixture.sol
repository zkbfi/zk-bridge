// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {LightClientSync} from "../../src/LightClientSync.sol";
import {ZKBridgeVault} from "../../src/ZKBridgeVault.sol";
import {MockSP1Verifier} from "../../src/mocks/MockSP1Verifier.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {Committee} from "./Committee.sol";

/// @title BridgeFixture
/// @notice Shared deployment and helpers. One Foundry chain plays both roles:
/// `vaultA` has chain id 1 (source of deposits) and `vaultB` has chain id 369 (pays withdrawals).
/// `vaultB` reads block roots from `lightClient`, which tracks the "chainA" committee.
abstract contract BridgeFixture is Test {
    using Committee for Committee.Set;

    uint64 internal constant CHAIN_A = 1;
    uint64 internal constant CHAIN_B = 369;
    uint32 internal constant INITIAL_PERIOD = 1;
    bytes32 internal constant PROGRAM_VKEY = keccak256("zk-bridge-program");
    uint256 internal constant ORACLE_KEY = uint256(keccak256("reference-prover-oracle"));
    uint256 internal constant LIQUIDITY = 10_000e18;

    address internal oracle;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");

    Committee.Set internal honest;
    LightClientSync internal lightClient;
    MockSP1Verifier internal verifier;
    MockERC20 internal token;
    ZKBridgeVault internal vaultA;
    ZKBridgeVault internal vaultB;

    function setUp() public virtual {
        oracle = vm.addr(ORACLE_KEY);
        honest = Committee.build("chainA");
        lightClient = new LightClientSync(honest.root, INITIAL_PERIOD);
        verifier = new MockSP1Verifier(oracle);
        token = new MockERC20("Mock", "MCK");
        vaultA = new ZKBridgeVault(address(verifier), PROGRAM_VKEY, CHAIN_A, address(lightClient));
        vaultB = new ZKBridgeVault(address(verifier), PROGRAM_VKEY, CHAIN_B, address(lightClient));
        // Pre-seeded liquidity: the specification has no other way to fund the paying vault.
        token.mint(address(vaultB), LIQUIDITY);
    }

    // ---------------------------------------------------------------- light client

    /// @notice Honest relayer: 342 signatures from the current committee, committee kept unchanged.
    function _honestUpdate(bytes32 header, uint32 period) internal {
        Committee.Signed memory signed = honest.attest(header, period, Committee.THRESHOLD);
        lightClient.updateSyncState(period, header, signed.signatures, signed.proofs, honest.root);
    }

    // ---------------------------------------------------------------- vault

    /// @notice Deposits `amount` of `depositToken` into `vault` as `user` and returns the emitted nonce.
    function _deposit(
        ZKBridgeVault vault,
        address depositToken,
        address user,
        address recipient,
        uint256 amount,
        uint64 target
    ) internal returns (bytes32 nonce) {
        vm.recordLogs();
        vm.startPrank(user);
        (bool approved,) =
            depositToken.call(abi.encodeWithSignature("approve(address,uint256)", address(vault), amount));
        require(approved, "approve failed");
        vault.deposit(depositToken, recipient, amount, target);
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == ZKBridgeVault.DepositInitiated.selector) {
                (, nonce,) = abi.decode(logs[i].data, (uint256, bytes32, uint64));
            }
        }
    }

    /// @notice Builds the public inputs for a chain A to chain B transfer.
    function _inputs(address bridgedToken, address recipient, uint256 amount, bytes32 nonce, bytes32 blockRoot)
        internal
        pure
        returns (ZKBridgeVault.BridgeInputs memory)
    {
        return ZKBridgeVault.BridgeInputs({
            sourceChainId: CHAIN_A,
            targetChainId: CHAIN_B,
            tokenAddress: bridgedToken,
            recipient: recipient,
            amount: amount,
            depositNonce: nonce,
            confirmedBlockRoot: blockRoot
        });
    }

    /// @notice The reference prover: signs the statement as `MockSP1Verifier` expects.
    function _prove(bytes memory publicInputsBytes) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked(PROGRAM_VKEY, keccak256(publicInputsBytes)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORACLE_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Proves the statement with the oracle and withdraws on `vault`.
    function _withdraw(ZKBridgeVault vault, ZKBridgeVault.BridgeInputs memory inputs) internal {
        bytes memory publicInputsBytes = abi.encode(inputs);
        vault.withdraw(_prove(publicInputsBytes), publicInputsBytes);
    }
}
