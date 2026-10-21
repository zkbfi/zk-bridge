//! Solidity ABI types of the public values, and the deposit event.
//!
//! The struct field order is the order of the Solidity structs in `docs/hardened-build-contract.md`
//! (`LightClientOutput`, and `WithdrawalProof` from the section "Change: the vault verifies withdrawals directly").
//! `abi.encode` of a struct with only static fields is the concatenation of its fields, each padded to 32 bytes,
//! which `SolValue::abi_encode` produces. `WithdrawalProof` is dynamic: its calldata is the 4-byte selector of
//! `withdraw(WithdrawalProof)` followed by the encoding of the struct as the only argument.

use alloy_primitives::B256;
use alloy_sol_types::{sol, SolEvent};

sol! {
    /// Public values of the light-client program.
    #[derive(Debug, PartialEq, Eq)]
    struct LightClientOutput {
        bytes32 genesisValidatorsRoot;
        bytes32 previousHeaderRoot;
        uint64 previousHeadSlot;
        bytes32 previousSyncCommitteeHash;
        // Hash of the initial store's next committee, or zero when the store has none. Binds the private start.
        bytes32 startNextSyncCommitteeHash;
        bytes32 newHeaderRoot;
        uint64 newHeadSlot;
        bytes32 executionBlockHash;
        uint64 executionBlockNumber;
        bytes32 syncCommitteeHash;
        bytes32 nextSyncCommitteeHash;
    }

    /// Public values of the fork-observation program: 7 words, 224 bytes. The first five fields bind the starting store
    /// exactly like `LightClientOutput`. `observedVersion` is a `bytes4`, so it is left-aligned in its word.
    #[derive(Debug, PartialEq, Eq)]
    struct ForkObservation {
        bytes32 genesisValidatorsRoot;
        bytes32 previousHeaderRoot;
        uint64 previousHeadSlot;
        bytes32 previousSyncCommitteeHash;
        bytes32 startNextSyncCommitteeHash;
        bytes4 observedVersion;
        uint64 observedAttestedSlot;
    }

    /// A beacon block header, as the vault receives it in calldata.
    #[derive(Debug, PartialEq, Eq)]
    struct BeaconBlockHeader {
        uint64 slot;
        uint64 proposerIndex;
        bytes32 parentRoot;
        bytes32 stateRoot;
        bytes32 bodyRoot;
    }

    /// The evidence for one withdrawal: calldata of `withdraw(WithdrawalProof)`. No zero-knowledge proof is involved.
    #[derive(Debug, PartialEq, Eq)]
    struct WithdrawalProof {
        BeaconBlockHeader anchorHeader;
        BeaconBlockHeader depositHeader;
        bytes32[] ancestryBranch;
        bytes32[] blockHashBranch;
        bytes executionHeaderRlp;
        bytes[] receiptProof;
        uint256 transactionIndex;
        uint256 logIndex;
    }

    /// The vault entry point. Its selector and argument encoding make the calldata.
    function withdraw(WithdrawalProof calldata proof) external;

    /// The vault deposit event. The declaration is the single source of the topic: nothing is hardcoded.
    #[derive(Debug, PartialEq, Eq)]
    event DepositInitiated(
        address indexed token,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        bytes32 nonce,
        uint64 targetChainId
    );
}

/// Topic 0 of `DepositInitiated(address,address,address,uint256,bytes32,uint64)`.
///
/// Derived from the declaration above: `keccak256` of the canonical signature.
pub const DEPOSIT_EVENT_TOPIC: B256 = <DepositInitiated as SolEvent>::SIGNATURE_HASH;

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{b256, hex};
    use alloy_sol_types::SolValue;

    /// Claim: the topic is the real keccak256 of the event signature (revision 1 constant `0x9bab...eaf5`) and is
    /// NOT the revision 2 constant `0x2df9...c1ee` that the revision 2 circuit hardcodes (defect R2-02).
    /// Why it matters: with the wrong topic no deposit can ever be proven.
    #[test]
    fn deposit_topic_is_the_real_signature_hash_and_not_the_revision_two_constant() {
        let expected = b256!("9babffc98c2690dda697fdc26b5b3ea9b3806a6525a7b6da2cdeb372a48beaf5");
        let revision_two = b256!("2df93605658e38812f86230cb85b0d0c35583b27b9c9769f36b6fbfda3d8c1ee");
        assert_eq!(DEPOSIT_EVENT_TOPIC, expected);
        assert_ne!(DEPOSIT_EVENT_TOPIC, revision_two);
        assert_eq!(DepositInitiated::SIGNATURE, "DepositInitiated(address,address,address,uint256,bytes32,uint64)");
    }

    fn sample_light_client_output() -> LightClientOutput {
        LightClientOutput {
            genesisValidatorsRoot: B256::repeat_byte(0x11),
            previousHeaderRoot: B256::repeat_byte(0x22),
            previousHeadSlot: 100,
            previousSyncCommitteeHash: B256::repeat_byte(0x33),
            startNextSyncCommitteeHash: B256::repeat_byte(0x88),
            newHeaderRoot: B256::repeat_byte(0x44),
            newHeadSlot: 200,
            executionBlockHash: B256::repeat_byte(0x55),
            executionBlockNumber: 300,
            syncCommitteeHash: B256::repeat_byte(0x66),
            nextSyncCommitteeHash: B256::repeat_byte(0x77),
        }
    }

    /// Claim: the encoding of `LightClientOutput` equals the bytes of
    /// `cast abi-encode "f((bytes32,bytes32,uint64,bytes32,bytes32,bytes32,uint64,bytes32,uint64,bytes32,bytes32))" ...`,
    /// produced by Foundry `cast` 1.6.0 on 2026-10-20 (the cast tool is a separate, Solidity-ABI implementation).
    /// The output has 11 words of 32 bytes: 352 bytes (it had 10 words, 320 bytes, before `startNextSyncCommitteeHash`).
    /// Why it matters: the contract decodes these exact bytes with `abi.decode`.
    #[test]
    fn light_client_output_encoding_matches_cast() {
        let expected = hex!(
            "1111111111111111111111111111111111111111111111111111111111111111"
            "2222222222222222222222222222222222222222222222222222222222222222"
            "0000000000000000000000000000000000000000000000000000000000000064"
            "3333333333333333333333333333333333333333333333333333333333333333"
            "8888888888888888888888888888888888888888888888888888888888888888"
            "4444444444444444444444444444444444444444444444444444444444444444"
            "00000000000000000000000000000000000000000000000000000000000000c8"
            "5555555555555555555555555555555555555555555555555555555555555555"
            "000000000000000000000000000000000000000000000000000000000000012c"
            "6666666666666666666666666666666666666666666666666666666666666666"
            "7777777777777777777777777777777777777777777777777777777777777777"
        );
        assert_eq!(sample_light_client_output().abi_encode(), expected.to_vec());
        assert_eq!(expected.len(), 11 * 32);
        assert_eq!(expected.len(), 352);
    }

    /// Claim: the encoding of `ForkObservation` equals the bytes of
    /// `cast abi-encode "f((bytes32,bytes32,uint64,bytes32,bytes32,bytes4,uint64))" ...` (Foundry `cast`, 2026-10-21).
    /// It has 7 words of 32 bytes: 224 bytes. The `bytes4` version `0x0000036d` is LEFT-aligned in its word, as Solidity
    /// `abi.encode` of a `bytes4` does, and not right-aligned like an integer.
    /// Why it matters: the contract decodes these exact bytes, and 224 differs from the 352 of `LightClientOutput`.
    #[test]
    fn fork_observation_encoding_matches_cast() {
        let output = ForkObservation {
            genesisValidatorsRoot: B256::repeat_byte(0x11),
            previousHeaderRoot: B256::repeat_byte(0x22),
            previousHeadSlot: 100,
            previousSyncCommitteeHash: B256::repeat_byte(0x33),
            startNextSyncCommitteeHash: B256::repeat_byte(0x88),
            observedVersion: alloy_primitives::FixedBytes::from([0, 0, 0x03, 0x6d]),
            observedAttestedSlot: 200,
        };
        let expected = hex!(
            "1111111111111111111111111111111111111111111111111111111111111111"
            "2222222222222222222222222222222222222222222222222222222222222222"
            "0000000000000000000000000000000000000000000000000000000000000064"
            "3333333333333333333333333333333333333333333333333333333333333333"
            "8888888888888888888888888888888888888888888888888888888888888888"
            "0000036d00000000000000000000000000000000000000000000000000000000"
            "00000000000000000000000000000000000000000000000000000000000000c8"
        );
        assert_eq!(output.abi_encode(), expected.to_vec());
        assert_eq!(expected.len(), 7 * 32);
        assert_eq!(expected.len(), 224);
        assert_eq!(ForkObservation::abi_decode(&expected).expect("decode"), output);
    }

    /// Claim: decoding the encoded bytes gives back the same struct, so the layout is symmetric.
    #[test]
    fn light_client_output_roundtrip() {
        let output = sample_light_client_output();
        let decoded = LightClientOutput::abi_decode(&output.abi_encode()).expect("decode");
        assert_eq!(decoded, output);
    }

    /// Claim: the calldata of `withdraw(WithdrawalProof)` equals the output of
    /// `cast calldata "withdraw(((uint64,uint64,bytes32,bytes32,bytes32),(uint64,uint64,bytes32,bytes32,bytes32),bytes32[],bytes32[],bytes,bytes[],uint256,uint256))" ...`
    /// (Foundry, 2026-10-20) for a sample proof with two branches, a header blob and two receipt nodes.
    /// Why it matters: the vault decodes these exact bytes, and the fixtures hold them.
    #[test]
    fn withdrawal_calldata_matches_cast() {
        use alloy_sol_types::SolCall;
        let header = |first: u64, second: u64, byte: u8| BeaconBlockHeader {
            slot: first,
            proposerIndex: second,
            parentRoot: B256::repeat_byte(byte),
            stateRoot: B256::repeat_byte(byte + 0x11),
            bodyRoot: B256::repeat_byte(byte + 0x22),
        };
        let proof = WithdrawalProof {
            anchorHeader: header(1, 2, 0x11),
            depositHeader: header(4, 5, 0x44),
            ancestryBranch: vec![B256::repeat_byte(0x77)],
            blockHashBranch: vec![B256::repeat_byte(0x88), B256::repeat_byte(0x99)],
            executionHeaderRlp: hex!("deadbeef").into(),
            receiptProof: vec![hex!("aabb").into(), hex!("ccddeeff00").into()],
            transactionIndex: alloy_primitives::U256::from(7u64),
            logIndex: alloy_primitives::U256::from(8u64),
        };
        let expected = hex!(
            "30568d8300000000000000000000000000000000000000000000000000000000"
            "0000002000000000000000000000000000000000000000000000000000000000"
            "0000000100000000000000000000000000000000000000000000000000000000"
            "0000000211111111111111111111111111111111111111111111111111111111"
            "1111111122222222222222222222222222222222222222222222222222222222"
            "2222222233333333333333333333333333333333333333333333333333333333"
            "3333333300000000000000000000000000000000000000000000000000000000"
            "0000000400000000000000000000000000000000000000000000000000000000"
            "0000000544444444444444444444444444444444444444444444444444444444"
            "4444444455555555555555555555555555555555555555555555555555555555"
            "5555555566666666666666666666666666666666666666666666666666666666"
            "6666666600000000000000000000000000000000000000000000000000000000"
            "0000020000000000000000000000000000000000000000000000000000000000"
            "0000024000000000000000000000000000000000000000000000000000000000"
            "000002a000000000000000000000000000000000000000000000000000000000"
            "000002e000000000000000000000000000000000000000000000000000000000"
            "0000000700000000000000000000000000000000000000000000000000000000"
            "0000000800000000000000000000000000000000000000000000000000000000"
            "0000000177777777777777777777777777777777777777777777777777777777"
            "7777777700000000000000000000000000000000000000000000000000000000"
            "0000000288888888888888888888888888888888888888888888888888888888"
            "8888888899999999999999999999999999999999999999999999999999999999"
            "9999999900000000000000000000000000000000000000000000000000000000"
            "00000004deadbeef000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000"
            "0000000200000000000000000000000000000000000000000000000000000000"
            "0000004000000000000000000000000000000000000000000000000000000000"
            "0000008000000000000000000000000000000000000000000000000000000000"
            "00000002aabb0000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000"
            "00000005ccddeeff000000000000000000000000000000000000000000000000"
            "00000000"
        );
        assert_eq!(withdrawCall { proof }.abi_encode(), expected.to_vec());
        assert_eq!(withdrawCall::SELECTOR, hex!("30568d83"));
    }
}
