// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {LightClientSync} from "../../src/revision-2/LightClientSync.sol";
import {ZKBridgeVault} from "../../src/revision-2/ZKBridgeVault.sol";
import {RealShapeOracleVerifier} from "../../src/revision-2/mocks/RealShapeOracleVerifier.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {Committee} from "../utils/Committee.sol";

/// @title Revision2Fixture
/// @notice Shared deployment for the revision 2 red team. One Foundry chain plays both roles:
/// `vaultA` has chain id 1, `vaultB` has chain id 369. Each vault names the other as its expected
/// source vault, with the address predicted by `vm.computeCreateAddress` (the workable path for R2-08).
abstract contract Revision2Fixture is Test {
    using Committee for Committee.Set;

    uint64 internal constant CHAIN_A = 1;
    uint64 internal constant CHAIN_B = 369;
    uint32 internal constant INITIAL_PERIOD = 1;
    bytes32 internal constant PROGRAM_VKEY = keccak256("zk-bridge-program-revision-2");
    uint256 internal constant ORACLE_KEY = uint256(keccak256("reference-prover-oracle"));
    uint256 internal constant LIQUIDITY = 10_000e18;

    address internal oracle;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");

    Committee.Set internal honest;
    LightClientSync internal lightClient;
    RealShapeOracleVerifier internal verifier;
    MockERC20 internal tokenA;
    MockERC20 internal tokenB;
    ZKBridgeVault internal vaultA;
    ZKBridgeVault internal vaultB;

    function setUp() public virtual {
        oracle = vm.addr(ORACLE_KEY);
        honest = Committee.build("chainA");
        lightClient = new LightClientSync(honest.root, INITIAL_PERIOD);
        verifier = new RealShapeOracleVerifier(oracle);
        tokenA = new MockERC20("Token on A", "TKA");
        tokenB = new MockERC20("Token on B", "TKB");
        (vaultA, vaultB) = _deployPair(address(tokenA), address(tokenB));
        tokenB.mint(address(vaultB), LIQUIDITY);
    }

    // ------------------------------------------------------------ deployment

    /// @notice Deploys vault A then vault B, each naming the other with a predicted address.
    /// @param localA the token that vault A locks and pays
    /// @param localB the token that vault B locks and pays
    function _deployPair(address localA, address localB) internal returns (ZKBridgeVault a, ZKBridgeVault b) {
        uint256 nonceBefore = vm.getNonce(address(this));
        address predictedA = vm.computeCreateAddress(address(this), nonceBefore);
        address predictedB = vm.computeCreateAddress(address(this), nonceBefore + 1);
        a = _newVault(CHAIN_A, CHAIN_B, localA, localB, predictedB);
        b = _newVault(CHAIN_B, CHAIN_A, localB, localA, predictedA);
        require(address(a) == predictedA && address(b) == predictedB, "prediction failed");
    }

    /// @notice Deploys one vault. `remoteToken` is the other chain's token that maps to `localToken`.
    function _newVault(uint64 chainId, uint64 remoteChain, address localToken, address remoteToken, address remoteVault)
        internal
        returns (ZKBridgeVault)
    {
        return new ZKBridgeVault(
            address(verifier),
            PROGRAM_VKEY,
            chainId,
            address(lightClient),
            _chains(remoteChain),
            _addresses(localToken),
            _addresses(remoteToken),
            _addresses(localToken),
            remoteChain,
            remoteVault
        );
    }

    /// @notice One-element chain list.
    function _chains(uint64 chain) internal pure returns (uint64[] memory list) {
        list = new uint64[](1);
        list[0] = chain;
    }

    /// @notice One-element address list.
    function _addresses(address single) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = single;
    }

    // ------------------------------------------------------------ light client

    /// @notice The digest that the revision 2 committee signs.
    function _digest(bytes32 header, uint32 period, bytes32 nextRoot) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(header, period, nextRoot));
    }

    /// @notice Signs the revision 2 digest with the first `count` members of `set`.
    function _sign(Committee.Set memory set, bytes32 header, uint32 period, bytes32 nextRoot, uint256 count)
        internal
        pure
        returns (Committee.Signed memory)
    {
        return Committee.sign(set, _digest(header, period, nextRoot), count);
    }

    /// @notice Honest update: 342 signatures, same period, no rotation.
    function _attest(bytes32 header) internal {
        Committee.Signed memory signed = _sign(honest, header, INITIAL_PERIOD, bytes32(0), Committee.THRESHOLD);
        lightClient.updateSyncState(INITIAL_PERIOD, header, signed.signatures, signed.proofs, bytes32(0));
    }

    // ------------------------------------------------------------ vault

    /// @notice Deposits as `user` and returns the nonce and the amount that the event reports.
    function _deposit(ZKBridgeVault vault, address token, address user, address recipient, uint256 amount, uint64 target)
        internal
        returns (bytes32 nonce, uint256 reportedAmount)
    {
        vm.recordLogs();
        vm.startPrank(user);
        (bool approved,) = token.call(abi.encodeWithSignature("approve(address,uint256)", address(vault), amount));
        require(approved, "approve failed");
        vault.deposit(token, recipient, amount, target);
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == ZKBridgeVault.DepositInitiated.selector) {
                (reportedAmount, nonce,) = abi.decode(logs[i].data, (uint256, bytes32, uint64));
            }
        }
    }

    /// @notice Public values for a chain A to chain B transfer, in the layout the vault decodes.
    function _publicValues(
        address sourceVault,
        address sourceToken,
        address recipient,
        uint256 amount,
        bytes32 nonce,
        bytes32 blockRoot
    ) internal pure returns (bytes memory) {
        return abi.encode(CHAIN_A, CHAIN_B, sourceVault, sourceToken, recipient, amount, nonce, blockRoot);
    }

    /// @notice The reference prover: signs the statement as `RealShapeOracleVerifier` expects.
    function _prove(bytes memory publicValues) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked(PROGRAM_VKEY, sha256(publicValues)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORACLE_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Proves the statement with the oracle and withdraws on `vault`.
    function _claim(ZKBridgeVault vault, bytes memory publicValues) internal {
        vault.withdraw(_prove(publicValues), publicValues);
    }
}
