// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {GateSupport} from "./utils/GateSupport.sol";
import {GateAlwaysAdmits} from "./utils/GateMocks.sol";

/// @notice Gas of a vault deposit with the fork gate. Each number is measured with `gasleft()` around the call, with
/// the touched accounts cooled first (`vm.cool`) so storage and account reads are cold, as in a fresh transaction.
/// The bounds are about 20 percent above the measurement, rounded up. The plain baseline is a deposit through a gate
/// that does nothing, so it already pays the cold external call into a gate (about 2,600 gas); the extra numbers are what
/// the real gate adds on top of that call. Since the execution canaries, a deposit before the switch also makes four
/// calls to probe contracts and one call to the BLS12-381 address; the numbers below cool those accounts too.
contract BeaconForkGateGasTest is GateSupport {
    function setUp() public override {
        super.setUp();
        _warpIntoEpoch(EPOCH_E, 3);
    }

    /// @dev Cost of one deposit call as `alice`, from a fresh (cold) state of the touched accounts.
    function _measuredDeposit(BridgeVault vault, address gateAddress, bytes memory evidence)
        internal
        returns (uint256 used)
    {
        tokenOnA.mint(alice, 1e18);
        vm.chainId(CHAIN_A);
        vm.prank(alice);
        tokenOnA.approve(address(vault), 1e18);
        vm.cool(address(vault));
        vm.cool(gateAddress);
        vm.cool(address(tokenOnA));
        vm.cool(BEACON_ROOTS);
        vm.prank(alice);
        uint256 before_ = gasleft();
        vault.deposit(address(tokenOnA), bob, 1e18, evidence);
        used = before_ - gasleft();
    }

    /// @dev Cools the probe contracts and the BLS address, which the detection modes call on every deposit.
    function _coolCanaries(BeaconForkGate target) internal {
        vm.cool(target.tstoreProbe());
        vm.cool(target.mcopyProbe());
        vm.cool(target.blobBaseFeeProbe());
        vm.cool(target.clzProbe());
        vm.cool(address(0x0b));
    }

    function _plainDepositGas() internal returns (uint256) {
        BridgeVault plain = _vaultWithGate(address(new GateAlwaysAdmits()));
        return _measuredDeposit(plain, address(plain.depositGate()), "");
    }

    /// Claim: before detection (detection mode, no beacon roots contract) a deposit costs the plain deposit plus the
    /// probe, about 2,600 gas by the design estimate. Shows: the numbers for plain, for the gate with no code at the
    /// address, and for the gate with the genuine code at the address and empty storage (which reverts inside the
    /// probe, so it costs more). Matters: PulseChain depositors pay this on every deposit until EIP-4788 arrives.
    function test_HB02_gas_depositBeforeDetection() public {
        uint256 plain = _plainDepositGas();
        vm.etch(BEACON_ROOTS, "");
        BeaconForkGate detecting = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
        _coolCanaries(detecting);
        uint256 withGate = _measuredDeposit(_vaultWithGate(address(detecting)), address(detecting), "");
        _etchGenuine();
        BeaconForkGate detectingGenuine = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
        _coolCanaries(detectingGenuine);
        uint256 withGenuine = _measuredDeposit(_vaultWithGate(address(detectingGenuine)), address(detectingGenuine), "");
        console2.log("plain deposit (always admit gate)", plain);
        console2.log("deposit before detection, no code at the address", withGate);
        console2.log("  extra over plain (probe plus the gate call)", withGate - plain);
        console2.log("deposit before detection, genuine code with empty storage", withGenuine);
        console2.log("  extra over plain", withGenuine - plain);
        // Before the canaries the probe cost under 1,000 gas. Each canary now adds a cold account access (2,600 gas) and
        // the 300 gas that an invalid opcode burns: about 15,000 gas more, bounded by the caps of the gate.
        assertLt(withGate - plain, 24_000, "the probes and canaries stay bounded");
        assertLt(withGenuine - plain, 24_000, "the same with a reverting beacon roots contract");
    }

    /// Claim: a deposit before the switch, with every canary account cold as in a fresh transaction, costs a bounded
    /// amount over the plain deposit. Shows: the gas through the gate of the fixture (`gateB`, built in `setUp`, so
    /// that `vm.cool` takes effect on its probes; a contract created inside the test stays warm). Matters: this is the
    /// real price a PulseChain depositor pays on every deposit until a canary fires: the beacon roots probe, four
    /// probe contracts and the BLS12-381 address, each a cold account access (2,600 gas).
    function test_HB02_gas_depositBeforeTheSwitchWithColdCanaries() public {
        vm.etch(BEACON_ROOTS, "");
        uint256 plain = _plainDepositGas();
        _coolCanaries(gateB);
        uint256 withGate = _measuredDeposit(_vaultWithGate(address(gateB)), address(gateB), "");
        console2.log("deposit before the switch, cold canaries", withGate);
        console2.log("  extra over plain", withGate - plain);
        assertGt(withGate - plain, 12_000, "control: the cold accesses are real");
        assertLt(withGate - plain, 24_000, "bound");
    }

    /// Claim: the admit call alone, before detection, costs a small fixed amount. Shows: the gas of
    /// `gate.admit("")` as an external call with a cold gate. Matters: it separates the gate from the vault work.
    function test_HB02_gas_admitOnlyBeforeDetection() public {
        vm.etch(BEACON_ROOTS, "");
        BeaconForkGate detecting = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
        vm.cool(address(detecting));
        vm.cool(BEACON_ROOTS);
        _coolCanaries(detecting);
        uint256 before_ = gasleft();
        detecting.admit("");
        uint256 used = before_ - gasleft();
        console2.log("admit only, before detection", used);
        assertLt(used, 24_000);
    }

    /// Claim: the second deposit in a confirmed epoch costs the plain deposit plus about 2,100 gas (one cold read of
    /// the packed state slot, plus the call). Shows: the numbers. Matters: this is the common case on Ethereum.
    function test_HB02_gas_depositInAConfirmedEpoch() public {
        _etchMock();
        BeaconForkGate gate = _newGate(BeaconForkGate.GateMode.Enforcing);
        BridgeVault vault = _vaultWithGate(address(gate));
        gate.confirm(_honestEvidence(block.timestamp, _slotIn(EPOCH_E, 2), 6, ELECTRA));
        uint256 plain = _plainDepositGas();
        uint256 used = _measuredDeposit(vault, address(gate), "");
        console2.log("deposit in a confirmed epoch", used);
        console2.log("  extra over plain", used - plain);
        assertLt(used - plain, 1_100);
    }

    /// Claim: the first deposit of an epoch with a proof costs the plain deposit plus 30,000 to 40,000 gas by the
    /// design estimate. Shows: the numbers for a depth 6 state (Electra) and a depth 5 state (Deneb). Matters: this is
    /// what the first depositor of each epoch pays.
    function test_HB02_gas_firstDepositWithProof() public {
        _etchMock();
        uint256 plain = _plainDepositGas();
        BeaconForkGate gateSix = _newGate(BeaconForkGate.GateMode.Enforcing);
        bytes memory six = _honestEvidence(block.timestamp, _slotIn(EPOCH_E, 2), 6, ELECTRA);
        uint256 usedSix = _measuredDeposit(_vaultWithGate(address(gateSix)), address(gateSix), six);
        BeaconForkGate gateFive = _newGate(BeaconForkGate.GateMode.Enforcing);
        bytes memory five = _honestEvidence(block.timestamp + 12, _slotIn(EPOCH_E, 2), 5, DENEB);
        uint256 usedFive = _measuredDeposit(_vaultWithGate(address(gateFive)), address(gateFive), five);
        console2.log("first deposit with proof, depth 6", usedSix);
        console2.log("  extra over plain", usedSix - plain);
        console2.log("first deposit with proof, depth 5", usedFive);
        console2.log("  extra over plain", usedFive - plain);
        assertLt(usedSix - plain, 37_000);
        assertLt(usedFive - plain, 35_000);
        assertGt(usedFive, plain + 20_000, "a proof costs far more than a read");
    }
}
