//! The contract bindings of the crate: the light client views, the message bridge views and the calldata that the
//! producer and the evidence builder create.
//!
//! The `executeMessage` calldata comes from `lc-core` (see `light_client.rs`). This module holds the rest: the light
//! client views and `update`, the bridge views, `openDeposits` and the three layout calls. The crate sends none of these
//! calls. It builds the calldata and a stateful server sends it.

use alloy_primitives::{Bytes, B256};
use alloy_sol_types::{sol, SolCall};

sol! {
    /// The `BeaconLightClient` surface the crate reads, and `update`, which it only encodes.
    interface LightClientContract {
        function head() external view returns (uint64);
        function headers(uint64 slot) external view returns (bytes32);
        function executionBlockHashes(uint64 slot) external view returns (bytes32);
        function syncCommittees(uint64 period) external view returns (bytes32);
        function genesisValidatorsRoot() external view returns (bytes32);
        function slotsPerPeriod() external view returns (uint64);
        function programVKey() external view returns (bytes32);
        function update(bytes calldata proof, bytes calldata publicValues) external;

        event HeadUpdated(uint64 indexed slot, bytes32 indexed headerRoot, bytes32 indexed executionBlockHash);
    }

    /// A header as the bridge takes it in calldata.
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

    /// The evidence for one message: the struct of `MessageBridge.executeMessage`. `lc-core` builds the calldata with its
    /// own copy of this struct. A test compares the two selectors.
    struct MessageProof {
        LayoutHeader anchorHeader;
        LayoutHeader sourceHeader;
        bytes32[] ancestryBranch;
        bytes32[] blockHashBranch;
        bytes executionHeaderRlp;
        bytes[] receiptProof;
        uint256 receiptIndex;
        bytes[] transactionProof;
        uint256 transactionIndex;
        uint256 logIndex;
    }

    /// The evidence for `openDeposits`.
    struct OpeningProof {
        uint64 remoteSlot;
        bytes remoteHeaderRlp;
        bytes[] accountProof;
        uint64 storedSlot;
        bytes[] storageProof;
    }

    /// The `MessageBridge` surface the crate reads, and the calls that it only encodes: the layout calls, `openDeposits`
    /// and `executeMessage`.
    interface MessageBridgeContract {
        function executeMessage(MessageProof calldata proof) external;
        function openDeposits(OpeningProof calldata proof) external;
        function depositsOpen() external view returns (bool);
        function remoteBridge() external view returns (address);
        function remoteChainId() external view returns (uint64);
        function localChainId() external view returns (uint64);
        function lightClient() external view returns (address);
        function remoteLightClient() external view returns (address);
        function gloasForkSlot() external view returns (uint64);
        function messageCallStatus(bytes32 messageId) external view returns (bool);
        function failedMessageDataHash(bytes32 messageId) external view returns (bytes32);
        function stateLayouts() external view returns (StateLayoutRow[] memory);
        function bodyLayouts() external view returns (BodyLayoutRow[] memory);
        function historicalLayouts() external view returns (HistoricalLayoutRow[] memory);
        function addHistoricalSummariesLayout(uint256 historicalSummariesGindex, HistoricalSummariesEvidence calldata evidence) external;
        function addBlockRootsLayout(uint256 blockRootsGindex, BlockRootsEvidence calldata evidence) external;
        function addBlockHashLayout(uint256 blockHashGindex, BlockHashEvidence calldata evidence) external;
    }
}

sol! {
    /// The `ForkRegistry` surface the crate reads, and `observe`, which it only encodes. The registry records the fork
    /// versions that a sync committee signed under, and the shape of the attested state that carried each version.
    interface ForkRegistryContract {
        function observe(bytes calldata proof, bytes calldata publicValues) external;
        function latestObserved() external view returns (bytes4 version, uint8 shape, uint64 slot);
        function latestObservedVersion() external view returns (bytes4);
        function firstSeenSlot(bytes4 version) external view returns (uint64);
        function shapeOf(bytes4 version) external view returns (uint8);
        function lightClient() external view returns (address);
        function observationProgramVKey() external view returns (bytes32);

        event ForkObserved(bytes4 indexed version, uint8 shape, uint64 slot);
    }
}

/// The length of the public values of the fork observation program: eight words (`ForkObservation`), the last one the
/// `uint8 shape`. The registry refuses any other length.
pub const FORK_OBSERVATION_PUBLIC_VALUES_LENGTH: usize = 256;

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

/// The topic 0 of the `HeadUpdated` event.
pub fn head_updated_topic() -> B256 {
    <LightClientContract::HeadUpdated as alloy_sol_types::SolEvent>::SIGNATURE_HASH
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::keccak256;

    /// Claim: `update` has the selector of the contract signature and carries the proof and the public values unchanged.
    /// Why it matters: the stateful server sends this calldata as it is. A wrong selector or a swapped argument makes the
    /// light client revert every update.
    #[test]
    fn update_calldata_carries_the_proof_and_the_public_values() {
        let calldata = update_calldata(&[1, 2, 3], &[4, 5]);
        assert_eq!(&calldata[..4], &keccak256("update(bytes,bytes)")[..4]);
        let decoded = LightClientContract::updateCall::abi_decode(&calldata).unwrap();
        assert_eq!(decoded.proof.as_ref(), &[1, 2, 3]);
        assert_eq!(decoded.publicValues.as_ref(), &[4, 5]);
    }

    /// Claim: `observe` and the views of `ForkRegistry` have the selectors of the contract signatures, and `latestObserved`
    /// returns the shape as its second value.
    /// Why it matters: the registry gained the `shape` word with the new observation output. A binding that kept the old
    /// two-value return would decode a wrong slot.
    #[test]
    fn fork_registry_calls_match_the_contract_signatures() {
        for (selector, signature) in [
            (
                ForkRegistryContract::observeCall::SELECTOR,
                "observe(bytes,bytes)",
            ),
            (
                ForkRegistryContract::latestObservedCall::SELECTOR,
                "latestObserved()",
            ),
            (
                ForkRegistryContract::latestObservedVersionCall::SELECTOR,
                "latestObservedVersion()",
            ),
            (
                ForkRegistryContract::firstSeenSlotCall::SELECTOR,
                "firstSeenSlot(bytes4)",
            ),
            (
                ForkRegistryContract::shapeOfCall::SELECTOR,
                "shapeOf(bytes4)",
            ),
            (
                ForkRegistryContract::lightClientCall::SELECTOR,
                "lightClient()",
            ),
            (
                ForkRegistryContract::observationProgramVKeyCall::SELECTOR,
                "observationProgramVKey()",
            ),
        ] {
            assert_eq!(&selector[..], &keccak256(signature)[..4], "{signature}");
        }
        let returned = ForkRegistryContract::latestObservedCall::abi_decode_returns(&{
            let mut word = [0u8; 96];
            word[..4].copy_from_slice(&[0, 0, 3, 0x6d]);
            word[63] = 255;
            word[95] = 7;
            word
        })
        .unwrap();
        assert_eq!((returned.shape, returned.slot), (255, 7));
        assert_eq!(
            <ForkRegistryContract::ForkObserved as alloy_sol_types::SolEvent>::SIGNATURE,
            "ForkObserved(bytes4,uint8,uint64)"
        );
    }

    /// Claim: the output of the fork observation program, encoded by `lc-core`, has the length that the registry demands
    /// (256 bytes), and `observe_calldata` carries the proof and the public values unchanged.
    /// Why it matters: the output grew from 224 to 256 bytes when the program began to prove the shape. A prover that
    /// still expected 224 would reject a good proof, and the registry rejects any other length.
    #[test]
    fn the_observation_output_is_the_length_the_registry_demands() {
        use alloy_sol_types::SolValue;
        let output = lc_core::abi::ForkObservation {
            genesisValidatorsRoot: B256::repeat_byte(1),
            previousHeaderRoot: B256::repeat_byte(2),
            previousHeadSlot: 3,
            previousSyncCommitteeHash: B256::repeat_byte(4),
            startNextSyncCommitteeHash: B256::ZERO,
            observedVersion: [0, 0, 3, 0x6d].into(),
            observedAttestedSlot: 9,
            shape: 6,
        };
        assert_eq!(
            output.abi_encode().len(),
            FORK_OBSERVATION_PUBLIC_VALUES_LENGTH
        );
        let calldata = observe_calldata(&[1], &output.abi_encode());
        let decoded = ForkRegistryContract::observeCall::abi_decode(&calldata).unwrap();
        assert_eq!(decoded.proof.as_ref(), &[1]);
        assert_eq!(
            decoded.publicValues.as_ref(),
            output.abi_encode().as_slice()
        );
    }

    /// Claim: the three layout calls have the selectors of their contract signatures.
    /// Why it matters: the evidence command prints this calldata for a server to send. A wrong struct shape changes the
    /// selector, and the bridge reverts on every layout row.
    #[test]
    fn layout_calls_match_the_contract_signatures() {
        let header = "(uint64,uint64,bytes32,bytes32,bytes32)";
        let expected = [
            (
                MessageBridgeContract::addBlockRootsLayoutCall::SELECTOR,
                format!(
                    "addBlockRootsLayout(uint256,({header},uint64,uint64,bytes32[],bytes32[]))"
                ),
            ),
            (
                MessageBridgeContract::addBlockHashLayoutCall::SELECTOR,
                format!("addBlockHashLayout(uint256,({header},bytes32[]))"),
            ),
            (
                MessageBridgeContract::addHistoricalSummariesLayoutCall::SELECTOR,
                format!("addHistoricalSummariesLayout(uint256,({header},uint64,bytes32[]))"),
            ),
        ];
        for (selector, signature) in expected {
            assert_eq!(&selector[..], &keccak256(&signature)[..4], "{signature}");
        }
    }

    /// Claim: the bindings of `executeMessage` and `openDeposits` have the selectors of the contract signatures, and the
    /// `executeMessage` selector equals the one of the copy in `lc-core` that builds the calldata.
    /// Why it matters: two definitions of one struct can drift. A drift changes the selector, and the bridge reverts every
    /// delivery.
    #[test]
    fn execute_and_opening_calls_match_the_contract_signatures() {
        let header = "(uint64,uint64,bytes32,bytes32,bytes32)";
        assert_eq!(
            &MessageBridgeContract::executeMessageCall::SELECTOR[..],
            &keccak256(format!(
                "executeMessage(({header},{header},bytes32[],bytes32[],bytes,bytes[],uint256,bytes[],uint256,uint256))"
            ))[..4]
        );
        assert_eq!(
            MessageBridgeContract::executeMessageCall::SELECTOR,
            lc_core::abi::executeMessageCall::SELECTOR
        );
        assert_eq!(
            &MessageBridgeContract::openDepositsCall::SELECTOR[..],
            &keccak256("openDeposits((uint64,bytes,bytes[],uint64,bytes[]))")[..4]
        );
    }

    /// Claim: the views that the evidence command reads have the selectors of the contract signatures.
    #[test]
    fn view_calls_match_the_contract_signatures() {
        for (selector, signature) in [
            (
                MessageBridgeContract::depositsOpenCall::SELECTOR,
                "depositsOpen()",
            ),
            (
                MessageBridgeContract::remoteBridgeCall::SELECTOR,
                "remoteBridge()",
            ),
            (
                MessageBridgeContract::remoteChainIdCall::SELECTOR,
                "remoteChainId()",
            ),
            (
                MessageBridgeContract::localChainIdCall::SELECTOR,
                "localChainId()",
            ),
            (
                MessageBridgeContract::lightClientCall::SELECTOR,
                "lightClient()",
            ),
            (
                MessageBridgeContract::remoteLightClientCall::SELECTOR,
                "remoteLightClient()",
            ),
            (
                LightClientContract::executionBlockHashesCall::SELECTOR,
                "executionBlockHashes(uint64)",
            ),
            (
                MessageBridgeContract::messageCallStatusCall::SELECTOR,
                "messageCallStatus(bytes32)",
            ),
            (
                MessageBridgeContract::failedMessageDataHashCall::SELECTOR,
                "failedMessageDataHash(bytes32)",
            ),
            (
                MessageBridgeContract::stateLayoutsCall::SELECTOR,
                "stateLayouts()",
            ),
            (
                MessageBridgeContract::bodyLayoutsCall::SELECTOR,
                "bodyLayouts()",
            ),
            (
                MessageBridgeContract::historicalLayoutsCall::SELECTOR,
                "historicalLayouts()",
            ),
        ] {
            assert_eq!(&selector[..], &keccak256(signature)[..4], "{signature}");
        }
    }
}
