//! Every contract binding of the service, and every deposit call, in one place.
//!
//! The withdrawal calldata comes from `lc-core` (see `light_client.rs`). This module holds the rest: the light
//! client views and `update`, the vault views and layout calls, the vault `openDeposits` call, and the vault `deposit`
//! call that tests use.
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

    /// The evidence of `BridgeVault.openDeposits`: a block of the remote chain whose hash the vault light client stored,
    /// the state proof of the remote light client in that block, and the storage proof of one of its stored heads.
    struct OpeningProof {
        uint64 remoteSlot;
        bytes remoteHeaderRlp;
        bytes[] accountProof;
        uint64 storedSlot;
        bytes[] storageProof;
    }

    /// The `BridgeVault` surface the service reads and writes (the withdrawal call itself is in lc-core).
    interface VaultContract {
        function claimed(bytes32 depositNonce) external view returns (bool);
        function remoteVault() external view returns (address);
        function remoteChainId() external view returns (uint64);
        function localChainId() external view returns (uint64);
        function lightClient() external view returns (address);
        function remoteLightClient() external view returns (address);
        function depositsOpen() external view returns (bool);
        function openDeposits(OpeningProof calldata proof) external;
        function remoteTokenOf(address localToken) external view returns (address);
        function localTokenOf(address remoteToken) external view returns (address);
        function stateLayouts() external view returns (StateLayoutRow[] memory);
        function bodyLayouts() external view returns (BodyLayoutRow[] memory);
        function historicalLayouts() external view returns (HistoricalLayoutRow[] memory);
        function capellaEra() external view returns (uint64);
        function depositGate() external view returns (address);
        function flowLimiter() external view returns (address);
        function feeAuthority() external view returns (address);
        function feeRecipient() external view returns (address);
        function feeBasisPoints() external view returns (uint16);
        function feeCeilingBasisPoints() external view returns (uint16);
        function accruedFees(address localToken) external view returns (uint256);
        function collectFees(address token) external;
        function addHistoricalSummariesLayout(uint256 historicalSummariesGindex, HistoricalSummariesEvidence calldata evidence) external;
        function addBlockRootsLayout(uint256 blockRootsGindex, BlockRootsEvidence calldata evidence) external;
        function addBlockHashLayout(uint256 blockHashGindex, BlockHashEvidence calldata evidence) external;
        function deposit(address token, address recipient, uint256 amount, uint16 maxFeeBasisPoints, bytes calldata gateEvidence) external returns (bytes32 nonce);

        error AlreadyClaimed(bytes32 depositNonce);
        error DepositsNotOpen();
        error OpeningSlotNotStored(uint64 slot);
        error OpeningHeaderMismatch(bytes32 expected, bytes32 actual);
        error OpeningProofMalformed();
        error OpeningEntryEmpty(uint64 storedSlot);

        event DepositsOpened(uint64 indexed remoteSlot, bytes32 indexed remoteBlockHash, uint64 storedSlot);
    }

    interface FlowLimiterContract {
        function checkWithdrawal(address token, address recipient, uint256 amount, bytes32 nonce) external;
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
        function forkRegistry() external view returns (address);
    }

    /// The `ForkRegistry` surface: the latest observed fork version for `route-health`, and `observe` for the
    /// keeper that submits fork observations.
    interface ForkRegistryContract {
        function latestObserved() external view returns (bytes4 version, uint64 slot);
        function observe(bytes calldata proof, bytes calldata publicValues) external;
        function lightClient() external view returns (address);

        event ForkObserved(bytes4 indexed version, uint64 slot);
    }

    /// A minimal token surface for the tests.
    interface TokenContract {
        function approve(address spender, uint256 amount) external returns (bool);
        function balanceOf(address account) external view returns (uint256);
        function mint(address to, uint256 amount) external;
    }
}

/// The selector of `AlreadyClaimed(bytes32)`.
pub const ALREADY_CLAIMED_SELECTOR: [u8; 4] =
    <VaultContract::AlreadyClaimed as alloy_sol_types::SolError>::SELECTOR;

/// Whether revert data is the `AlreadyClaimed` error of the vault, for any nonce.
pub fn is_already_claimed(revert_data: &[u8]) -> bool {
    revert_data.len() >= 4 && revert_data[..4] == ALREADY_CLAIMED_SELECTOR
}

/// The calldata of `BridgeVault.deposit`. The only place that builds it.
///
/// `max_fee_basis_points` is the highest deposit fee the caller accepts; the vault reverts with `FeeAboveLimit` above it.
/// `gate_evidence` is empty when the gate needs none (see `gate::gate_evidence_for_deposit`).
pub fn deposit_calldata(
    token: Address,
    recipient: Address,
    amount: U256,
    max_fee_basis_points: u16,
    gate_evidence: &[u8],
) -> Bytes {
    Bytes::from(
        VaultContract::depositCall {
            token,
            recipient,
            amount,
            maxFeeBasisPoints: max_fee_basis_points,
            gateEvidence: gate_evidence.to_vec().into(),
        }
        .abi_encode(),
    )
}

/// The calldata of `BridgeVault.openDeposits`. The only place that builds it.
pub fn open_deposits_calldata(proof: OpeningProof) -> Bytes {
    Bytes::from(VaultContract::openDepositsCall { proof }.abi_encode())
}

/// The name of the opening error that revert data carries, or `None` for any other data.
///
/// `openDeposits` and `deposit` revert with these errors. The name is what an operator needs to read.
pub fn opening_error_name(revert_data: &[u8]) -> Option<&'static str> {
    use alloy_sol_types::SolError;
    let selector = revert_data.get(..4)?;
    [
        (VaultContract::DepositsNotOpen::SELECTOR, "DepositsNotOpen"),
        (
            VaultContract::OpeningSlotNotStored::SELECTOR,
            "OpeningSlotNotStored",
        ),
        (
            VaultContract::OpeningHeaderMismatch::SELECTOR,
            "OpeningHeaderMismatch",
        ),
        (
            VaultContract::OpeningProofMalformed::SELECTOR,
            "OpeningProofMalformed",
        ),
        (
            VaultContract::OpeningEntryEmpty::SELECTOR,
            "OpeningEntryEmpty",
        ),
    ]
    .into_iter()
    .find_map(|(known, name)| (known == selector).then_some(name))
}

/// The calldata of `BeaconLightClient.update`.
pub fn update_calldata(proof: &[u8], public_values: &[u8]) -> Bytes {
    Bytes::from(
        LightClientContract::updateCall {
            proof: proof.to_vec().into(),
            publicValues: public_values.to_vec().into(),
        }
        .abi_encode(),
    )
}

/// The calldata of `ForkRegistry.observe`.
pub fn observe_calldata(proof: &[u8], public_values: &[u8]) -> Bytes {
    Bytes::from(
        ForkRegistryContract::observeCall {
            proof: proof.to_vec().into(),
            publicValues: public_values.to_vec().into(),
        }
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

    /// Claim: `deposit` takes the fee limit and the gate evidence, and its selector is the one of the contract signature.
    /// Why it matters: the older selectors revert on the current vault.
    #[test]
    fn deposit_call_has_the_fee_limit_and_the_gate_evidence_arguments() {
        let expected =
            &alloy_primitives::keccak256("deposit(address,address,uint256,uint16,bytes)")[..4];
        let calldata =
            deposit_calldata(Address::ZERO, Address::ZERO, U256::from(1), 25, &[1, 2, 3]);
        assert_eq!(&calldata[..4], expected);
        let decoded = VaultContract::depositCall::abi_decode(&calldata).unwrap();
        assert_eq!(decoded.maxFeeBasisPoints, 25);
        assert_eq!(decoded.gateEvidence.as_ref(), &[1, 2, 3]);
    }

    /// Claim: `openDeposits` takes the five fields of `OpeningProof` in the order of the contract, and its selector is the
    /// one of the contract signature.
    /// Why it matters: a wrong field order or type changes the selector, and the vault reverts on every opening.
    #[test]
    fn open_deposits_call_has_the_opening_proof_argument() {
        let expected =
            &alloy_primitives::keccak256("openDeposits((uint64,bytes,bytes[],uint64,bytes[]))")
                [..4];
        let calldata = open_deposits_calldata(OpeningProof {
            remoteSlot: 7,
            remoteHeaderRlp: vec![1].into(),
            accountProof: vec![vec![2].into()],
            storedSlot: 9,
            storageProof: vec![vec![3].into(), vec![4].into()],
        });
        assert_eq!(&calldata[..4], expected);
        let decoded = VaultContract::openDepositsCall::abi_decode(&calldata)
            .unwrap()
            .proof;
        assert_eq!((decoded.remoteSlot, decoded.storedSlot), (7, 9));
        assert_eq!(decoded.accountProof.len(), 1);
        assert_eq!(decoded.storageProof.len(), 2);
    }

    /// Claim: the new vault views and errors have the selectors of their signatures, and each opening error is named.
    /// Why it matters: the opening step reads `depositsOpen` and decodes the revert of a simulated `openDeposits`. A wrong
    /// selector would misreport a locked vault.
    #[test]
    fn opening_views_and_errors_match_their_signatures() {
        use alloy_primitives::keccak256;
        use alloy_sol_types::{SolError, SolEvent};
        assert_eq!(
            &VaultContract::depositsOpenCall::SELECTOR[..],
            &keccak256("depositsOpen()")[..4]
        );
        assert_eq!(
            &VaultContract::remoteLightClientCall::SELECTOR[..],
            &keccak256("remoteLightClient()")[..4]
        );
        let errors: [([u8; 4], &str, &str); 5] = [
            (
                VaultContract::DepositsNotOpen::SELECTOR,
                "DepositsNotOpen()",
                "DepositsNotOpen",
            ),
            (
                VaultContract::OpeningSlotNotStored::SELECTOR,
                "OpeningSlotNotStored(uint64)",
                "OpeningSlotNotStored",
            ),
            (
                VaultContract::OpeningHeaderMismatch::SELECTOR,
                "OpeningHeaderMismatch(bytes32,bytes32)",
                "OpeningHeaderMismatch",
            ),
            (
                VaultContract::OpeningProofMalformed::SELECTOR,
                "OpeningProofMalformed()",
                "OpeningProofMalformed",
            ),
            (
                VaultContract::OpeningEntryEmpty::SELECTOR,
                "OpeningEntryEmpty(uint64)",
                "OpeningEntryEmpty",
            ),
        ];
        for (selector, signature, name) in errors {
            assert_eq!(&selector[..], &keccak256(signature)[..4], "{signature}");
            assert_eq!(opening_error_name(&selector), Some(name));
        }
        assert_eq!(opening_error_name(&[1, 2, 3, 4]), None);
        assert_eq!(opening_error_name(&[1]), None);
        assert_eq!(
            VaultContract::DepositsOpened::SIGNATURE,
            "DepositsOpened(uint64,bytes32,uint64)"
        );
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
