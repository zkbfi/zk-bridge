//! Solidity ABI types of the public values, the message proof and the message event.
//!
//! The struct field order is the order of the Solidity structs in `docs/hardened-build-contract.md`
//! (`LightClientOutput`) and in `src/hardened/MessageBridge.sol` (`MessageProof`).
//! `abi.encode` of a struct with only static fields is the concatenation of its fields, each padded to 32 bytes,
//! which `SolValue::abi_encode` produces. `MessageProof` is dynamic: its calldata is the 4-byte selector of
//! `executeMessage(MessageProof)` followed by the encoding of the struct as the only argument.

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

    /// Public values of the fork-observation program: 8 words, 256 bytes. The first five fields bind the starting store
    /// exactly like `LightClientOutput`. `observedVersion` is a `bytes4`, so it is left-aligned in its word. `shape` is the
    /// state shape that the program proved for the attested state: 5, 6 or 7 for a plain state of that depth, 255 for the
    /// Gloas progressive state (see `layout::SHAPE_PROGRESSIVE`). It is a `uint8`, right-aligned in its word.
    #[derive(Debug, PartialEq, Eq)]
    struct ForkObservation {
        bytes32 genesisValidatorsRoot;
        bytes32 previousHeaderRoot;
        uint64 previousHeadSlot;
        bytes32 previousSyncCommitteeHash;
        bytes32 startNextSyncCommitteeHash;
        bytes4 observedVersion;
        uint64 observedAttestedSlot;
        uint8 shape;
    }

    /// A beacon block header, as the bridge receives it in calldata.
    #[derive(Debug, PartialEq, Eq)]
    struct BeaconBlockHeader {
        uint64 slot;
        uint64 proposerIndex;
        bytes32 parentRoot;
        bytes32 stateRoot;
        bytes32 bodyRoot;
    }

    /// The fork proof of one beacon state (`BeaconProofVerifier.ForkProof`): `fork.current_version` and
    /// `genesis_validators_root` under the same state root. The bridge judges it with `ForkShape.judge`; the Rust reference
    /// is `ancestry::source_shape`.
    #[derive(Debug, PartialEq, Eq)]
    struct ForkProof {
        bytes4 version;
        bytes32[] versionBranch;
        bytes32[] genesisValidatorsRootBranch;
    }

    /// The evidence for one message: calldata of `executeMessage(MessageProof)`. No zero-knowledge proof is involved.
    /// `receiptIndex` and `transactionIndex` must be equal: the receipt and the transaction sit at one index.
    /// `sourceFork` is the fork proof of the state of `sourceHeader`; its proven shape picks the block hash rule.
    #[derive(Debug, PartialEq, Eq)]
    struct MessageProof {
        BeaconBlockHeader anchorHeader;
        BeaconBlockHeader sourceHeader;
        bytes32[] ancestryBranch;
        bytes32[] blockHashBranch;
        ForkProof sourceFork;
        bytes executionHeaderRlp;
        bytes[] receiptProof;
        uint256 receiptIndex;
        bytes[] transactionProof;
        uint256 transactionIndex;
        uint256 logIndex;
    }

    /// The bridge entry point. Its selector and argument encoding make the calldata.
    function executeMessage(MessageProof calldata proof) external;

    /// The message event of the Arbitrary Message Bridge. The declaration is the single source of the topic.
    #[derive(Debug, PartialEq, Eq)]
    event UserRequestForAffirmation(bytes32 indexed messageId, bytes encodedData);
}

/// Topic 0 of `UserRequestForAffirmation(bytes32,bytes)`: `keccak256` of the canonical signature.
///
/// The log data is `abi.encode(bytes)` of the encoded message: the offset 32, the length, the padded bytes.
pub const USER_REQUEST_TOPIC: B256 = <UserRequestForAffirmation as SolEvent>::SIGNATURE_HASH;

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{b256, hex};
    use alloy_sol_types::SolValue;

    /// Claim: the topic is the real keccak256 of the event signature (verified with `cast keccak`, Foundry, 2026-10-24).
    /// Why it matters: with the wrong topic no message can ever be proven.
    #[test]
    fn message_topic_is_the_real_signature_hash() {
        let expected = b256!("482515ce3d9494a37ce83f18b72b363449458435fafdd7a53ddea7460fe01b58");
        assert_eq!(USER_REQUEST_TOPIC, expected);
        assert_eq!(UserRequestForAffirmation::SIGNATURE, "UserRequestForAffirmation(bytes32,bytes)");
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
    /// `cast abi-encode "f((bytes32,bytes32,uint64,bytes32,bytes32,bytes4,uint64,uint8))" ...` (Foundry `cast`, 2026-10-21,
    /// with the `uint8` word added 2026-10-27 by hand: a `uint8` is a right-aligned word like every integer).
    /// It has 8 words of 32 bytes: 256 bytes. The `bytes4` version `0x0000036d` is LEFT-aligned in its word, as Solidity
    /// `abi.encode` of a `bytes4` does, and not right-aligned like an integer. The shape 255 (progressive) is the last word.
    /// Why it matters: the contract decodes these exact bytes, and 256 differs from the 352 of `LightClientOutput`.
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
            shape: 255,
        };
        let expected = hex!(
            "1111111111111111111111111111111111111111111111111111111111111111"
            "2222222222222222222222222222222222222222222222222222222222222222"
            "0000000000000000000000000000000000000000000000000000000000000064"
            "3333333333333333333333333333333333333333333333333333333333333333"
            "8888888888888888888888888888888888888888888888888888888888888888"
            "0000036d00000000000000000000000000000000000000000000000000000000"
            "00000000000000000000000000000000000000000000000000000000000000c8"
            "00000000000000000000000000000000000000000000000000000000000000ff"
        );
        assert_eq!(output.abi_encode(), expected.to_vec());
        assert_eq!(expected.len(), 8 * 32);
        assert_eq!(expected.len(), 256);
        assert_eq!(ForkObservation::abi_decode(&expected).expect("decode"), output);
        let plain = ForkObservation { shape: 6, ..output };
        assert_eq!(
            plain.abi_encode()[7 * 32..],
            hex!("0000000000000000000000000000000000000000000000000000000000000006")
        );
    }

    /// Claim: decoding the encoded bytes gives back the same struct, so the layout is symmetric.
    #[test]
    fn light_client_output_roundtrip() {
        let output = sample_light_client_output();
        let decoded = LightClientOutput::abi_decode(&output.abi_encode()).expect("decode");
        assert_eq!(decoded, output);
    }

    /// Claim: the calldata of `executeMessage(MessageProof)` equals the output of
    /// `cast calldata "executeMessage(((uint64,uint64,bytes32,bytes32,bytes32),(uint64,uint64,bytes32,bytes32,bytes32),bytes32[],bytes32[],(bytes4,bytes32[],bytes32[]),bytes,bytes[],uint256,bytes[],uint256,uint256))" ...`
    /// (Foundry `cast` 1.8.5, 2026-11-10) for a sample proof with two branches, a fork proof (version `0x07000000`, one
    /// version branch entry, two genesis validators root branch entries), a header blob, two receipt nodes and two
    /// transaction nodes. The selector is `0x63f08d5e`. Why it matters: the bridge decodes these exact bytes, and the
    /// fixtures hold them.
    #[test]
    fn message_calldata_matches_cast() {
        use alloy_sol_types::SolCall;
        let header = |first: u64, second: u64, byte: u8| BeaconBlockHeader {
            slot: first,
            proposerIndex: second,
            parentRoot: B256::repeat_byte(byte),
            stateRoot: B256::repeat_byte(byte + 0x11),
            bodyRoot: B256::repeat_byte(byte + 0x22),
        };
        let proof = MessageProof {
            anchorHeader: header(1, 2, 0x11),
            sourceHeader: header(4, 5, 0x44),
            ancestryBranch: vec![B256::repeat_byte(0x77)],
            blockHashBranch: vec![B256::repeat_byte(0x88), B256::repeat_byte(0x99)],
            sourceFork: ForkProof {
                version: alloy_primitives::FixedBytes::from([0x07, 0, 0, 0]),
                versionBranch: vec![B256::repeat_byte(0xaa)],
                genesisValidatorsRootBranch: vec![B256::repeat_byte(0xbb), B256::repeat_byte(0xcc)],
            },
            executionHeaderRlp: hex!("deadbeef").into(),
            receiptProof: vec![hex!("aabb").into(), hex!("ccddeeff00").into()],
            receiptIndex: alloy_primitives::U256::from(7u64),
            transactionProof: vec![hex!("0102").into(), hex!("030405").into()],
            transactionIndex: alloy_primitives::U256::from(7u64),
            logIndex: alloy_primitives::U256::from(8u64),
        };
        let expected = hex!(
            "63f08d5e00000000000000000000000000000000000000000000000000000000"
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
            "0000026000000000000000000000000000000000000000000000000000000000"
            "000002a000000000000000000000000000000000000000000000000000000000"
            "0000030000000000000000000000000000000000000000000000000000000000"
            "0000040000000000000000000000000000000000000000000000000000000000"
            "0000044000000000000000000000000000000000000000000000000000000000"
            "0000000700000000000000000000000000000000000000000000000000000000"
            "0000052000000000000000000000000000000000000000000000000000000000"
            "0000000700000000000000000000000000000000000000000000000000000000"
            "0000000800000000000000000000000000000000000000000000000000000000"
            "0000000177777777777777777777777777777777777777777777777777777777"
            "7777777700000000000000000000000000000000000000000000000000000000"
            "0000000288888888888888888888888888888888888888888888888888888888"
            "8888888899999999999999999999999999999999999999999999999999999999"
            "9999999907000000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000"
            "0000006000000000000000000000000000000000000000000000000000000000"
            "000000a000000000000000000000000000000000000000000000000000000000"
            "00000001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            "aaaaaaaa00000000000000000000000000000000000000000000000000000000"
            "00000002bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            "bbbbbbbbcccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            "cccccccc00000000000000000000000000000000000000000000000000000000"
            "00000004deadbeef000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000"
            "0000000200000000000000000000000000000000000000000000000000000000"
            "0000004000000000000000000000000000000000000000000000000000000000"
            "0000008000000000000000000000000000000000000000000000000000000000"
            "00000002aabb0000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000"
            "00000005ccddeeff000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000"
            "0000000200000000000000000000000000000000000000000000000000000000"
            "0000004000000000000000000000000000000000000000000000000000000000"
            "0000008000000000000000000000000000000000000000000000000000000000"
            "0000000201020000000000000000000000000000000000000000000000000000"
            "0000000000000000000000000000000000000000000000000000000000000000"
            "0000000303040500000000000000000000000000000000000000000000000000"
            "00000000"
        );
        assert_eq!(executeMessageCall { proof }.abi_encode(), expected.to_vec());
        assert_eq!(executeMessageCall::SELECTOR, hex!("63f08d5e"));
    }
}
