//! Every contract binding of the service, and every deposit call, in one place.
//!
//! The withdrawal calldata comes from `lc-core` (see `light_client.rs`). This module holds the rest: the light
//! client views and `update`, the vault views and layout calls, and the vault `deposit` call that tests use.
//!
//! The vault `deposit` call takes a last argument, `gateEvidence`. The deposit gate (`BeaconForkGate`) reads it. The
//! evidence builder is in `light_client.rs` and `gate.rs`; [`deposit_calldata`] only encodes the call.
//! Nothing in the service sends a deposit: only the tests do.

use alloy_primitives::{Address, Bytes, B256, U256};
use alloy_sol_types::{sol, SolCall};

sol! {
    /// The `BeaconLightClient` surface the service reads and writes.
    interface LightClientContract {
        function head() external view returns (uint64);
        function headers(uint64 slot) external view returns (bytes32);
        function syncCommittees(uint64 period) external view returns (bytes32);
        function periodOf(uint64 slot) external view returns (uint64);
        function genesisValidatorsRoot() external view returns (bytes32);
        function slotsPerPeriod() external view returns (uint64);
        function programVKey() external view returns (bytes32);
        function executionBlockHashes(uint64 slot) external view returns (bytes32);
        function executionBlockNumber(bytes32 blockHash) external view returns (uint64);
        function isFinalizedExecutionBlock(bytes32 blockHash) external view returns (bool);
        function update(bytes calldata proof, bytes calldata publicValues) external;

        event HeadUpdated(uint64 indexed slot, bytes32 indexed headerRoot, bytes32 indexed executionBlockHash);
    }

    /// A header as the vault takes it in layout evidence.
    struct LayoutHeader {
        uint64 slot;
        uint64 proposerIndex;
        bytes32 parentRoot;
        bytes32 stateRoot;
        bytes32 bodyRoot;
    }

    /// Evidence for a `block_roots` position.
    struct BlockRootsEvidence {
        LayoutHeader laterHeader;
        uint64 earlierSlotA;
        uint64 earlierSlotB;
        bytes32[] branchA;
        bytes32[] branchB;
    }

    /// Evidence for a block hash position.
    struct BlockHashEvidence {
        LayoutHeader header;
        bytes32[] branch;
    }

    /// A validated `block_roots` position.
    struct StateLayoutRow {
        uint256 blockRootsGindex;
        uint64 firstSlot;
        uint64 lastSlot;
    }

    /// A validated `historical_summaries` position.
    struct HistoricalLayoutRow {
        uint256 historicalSummariesGindex;
        uint64 firstSlot;
        uint64 lastSlot;
    }

    /// Evidence for a `historical_summaries` position.
    struct HistoricalSummariesEvidence {
        LayoutHeader anchorHeader;
        uint64 earlierSlot;
        bytes32[] branch;
    }

    /// A validated block hash position.
    struct BodyLayoutRow {
        uint256 blockHashGindex;
        uint64 firstSlot;
        uint64 lastSlot;
    }

    /// The `BridgeVault` surface the service reads and writes (the withdrawal call itself is in lc-core).
    interface VaultContract {
        function claimed(bytes32 depositNonce) external view returns (bool);
        function remoteVault() external view returns (address);
        function remoteChainId() external view returns (uint64);
        function localChainId() external view returns (uint64);
        function lightClient() external view returns (address);
        function remoteTokenOf(address localToken) external view returns (address);
        function localTokenOf(address remoteToken) external view returns (address);
        function stateLayouts() external view returns (StateLayoutRow[] memory);
        function bodyLayouts() external view returns (BodyLayoutRow[] memory);
        function historicalLayouts() external view returns (HistoricalLayoutRow[] memory);
        function capellaEra() external view returns (uint64);
        function depositGate() external view returns (address);
        function addHistoricalSummariesLayout(uint256 historicalSummariesGindex, HistoricalSummariesEvidence calldata evidence) external;
        function addBlockRootsLayout(uint256 blockRootsGindex, BlockRootsEvidence calldata evidence) external;
        function addBlockHashLayout(uint256 blockHashGindex, BlockHashEvidence calldata evidence) external;
        function deposit(address token, address recipient, uint256 amount, bytes calldata gateEvidence) external returns (bytes32 nonce);

        error AlreadyClaimed(bytes32 depositNonce);
    }

    /// A supported fork version of the deposit gate.
    struct GateSupportedVersion {
        bytes4 version;
        uint8 stateDepth;
    }

    /// Read-only views of `BeaconForkGate` that `route-health` needs besides the ones in `gate.rs`.
    interface GateVersionsContract {
        function supportedVersions() external view returns (GateSupportedVersion[] memory);
        function mode() external view returns (uint8);
    }

    /// A minimal token surface for the tests.
    interface TokenContract {
        function approve(address spender, uint256 amount) external returns (bool);
        function balanceOf(address account) external view returns (uint256);
        function mint(address to, uint256 amount) external;
    }
}

/// The selector of `AlreadyClaimed(bytes32)`.
pub const ALREADY_CLAIMED_SELECTOR: [u8; 4] = <VaultContract::AlreadyClaimed as alloy_sol_types::SolError>::SELECTOR;

/// Whether revert data is the `AlreadyClaimed` error of the vault, for any nonce.
pub fn is_already_claimed(revert_data: &[u8]) -> bool {
    revert_data.len() >= 4 && revert_data[..4] == ALREADY_CLAIMED_SELECTOR
}

/// The calldata of `BridgeVault.deposit`. The only place that builds it.
///
/// `gate_evidence` is empty when the gate needs none (see `gate::gate_evidence_for_deposit`).
pub fn deposit_calldata(token: Address, recipient: Address, amount: U256, gate_evidence: &[u8]) -> Bytes {
    Bytes::from(
        VaultContract::depositCall { token, recipient, amount, gateEvidence: gate_evidence.to_vec().into() }
            .abi_encode(),
    )
}

/// The calldata of `BeaconLightClient.update`.
pub fn update_calldata(proof: &[u8], public_values: &[u8]) -> Bytes {
    Bytes::from(
        LightClientContract::updateCall { proof: proof.to_vec().into(), publicValues: public_values.to_vec().into() }
            .abi_encode(),
    )
}

/// The topic 0 of the `HeadUpdated` event.
pub fn head_updated_topic() -> B256 {
    <LightClientContract::HeadUpdated as alloy_sol_types::SolEvent>::SIGNATURE_HASH
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Claim: `deposit` takes four arguments and its selector is the one of the contract signature.
    /// Why it matters: the old three-argument selector reverts on the current vault.
    #[test]
    fn deposit_call_has_the_gate_evidence_argument() {
        let expected = &alloy_primitives::keccak256("deposit(address,address,uint256,bytes)")[..4];
        let calldata = deposit_calldata(Address::ZERO, Address::ZERO, U256::from(1), &[1, 2, 3]);
        assert_eq!(&calldata[..4], expected);
        let decoded = VaultContract::depositCall::abi_decode(&calldata).unwrap();
        assert_eq!(decoded.gateEvidence.as_ref(), &[1, 2, 3]);
    }

    /// Claim: `AlreadyClaimed(bytes32)` has the selector the vault reverts with.
    /// Why it matters: the service treats exactly this revert as success. A wrong selector would hide it.
    #[test]
    fn already_claimed_selector_is_the_signature_hash() {
        let expected = &alloy_primitives::keccak256("AlreadyClaimed(bytes32)")[..4];
        assert_eq!(&ALREADY_CLAIMED_SELECTOR[..], expected);
        let mut data = ALREADY_CLAIMED_SELECTOR.to_vec();
        data.extend_from_slice(&[0u8; 32]);
        assert!(is_already_claimed(&data));
        assert!(!is_already_claimed(&[1, 2, 3, 4]));
    }
}
