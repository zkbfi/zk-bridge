//! The SSZ block parser on a synthetic Capella block, and its agreement with an independent hash of the payload.
//!
//! The test builds the bytes of a block with `lc_testkit::block_bytes`, parses them with `lc_core::ssz_state`, and compares
//! every value that the bridge reads. The expected payload root comes from `ExecutionPayloadHeader`, a second code path
//! that shares no builder code with the block writer.

use alloy_primitives::{Address, B256, U256};
use lc_core::layout::ExecutionHeaderForm;
use lc_core::ssz::{mix_in_length, sha256, zero_hash};
use lc_core::ssz_state::try_parse_signed_block;
use lc_core::types::{ExecutionPayloadHeader, SyncAggregate};
use lc_testkit::block_bytes::{BlockBytes, PayloadFields};

fn block() -> BlockBytes {
    BlockBytes {
        slot: 6_225_984,
        proposer_index: 321,
        parent_root: sha256(b"block parent"),
        state_root: sha256(b"block state"),
        sync_aggregate: SyncAggregate { sync_committee_bits: [0xa5; 64], sync_committee_signature: [0x5a; 96] },
        payload: PayloadFields {
            parent_hash: sha256(b"payload parent"),
            fee_recipient: Address::repeat_byte(0x0f),
            state_root: sha256(b"payload state"),
            receipts_root: sha256(b"payload receipts"),
            logs_bloom: (0..256u32).map(|index| (index % 251) as u8).collect(),
            prev_randao: sha256(b"payload randao"),
            block_number: 77,
            gas_limit: 30_000_000,
            gas_used: 123_456,
            timestamp: 1_800_000_012,
            extra_data: b"synthetic".to_vec(),
            base_fee_per_gas: U256::from(7_654_321u64),
            block_hash: sha256(b"payload block hash"),
        },
    }
}

/// The root of an empty SSZ list: the zero hash of the depth of its limit, mixed with the length zero.
fn empty_list_root(limit_depth: u32) -> B256 {
    mix_in_length(&zero_hash(limit_depth), 0)
}

/// Claim: the parser reads the header fields and the payload of a written block, and the payload hashes to the root that
/// `ExecutionPayloadHeader` computes from the same values, with the roots of two empty lists.
/// Why it matters: the prover serves these blocks as a beacon node would. A shifted field would give a block hash branch
/// that the bridge rejects, or a header root that no state holds.
#[test]
fn the_parser_reads_what_the_builder_wrote() {
    let written = block();
    let parsed = try_parse_signed_block(&written.to_ssz()).expect("the synthetic block parses");
    assert_eq!(parsed.header.slot, written.slot);
    assert_eq!(parsed.header.proposer_index, written.proposer_index);
    assert_eq!(parsed.header.parent_root, written.parent_root);
    assert_eq!(parsed.header.state_root, written.state_root);

    let payload = &written.payload;
    let expected = ExecutionPayloadHeader {
        parent_hash: payload.parent_hash,
        fee_recipient: payload.fee_recipient,
        state_root: payload.state_root,
        receipts_root: payload.receipts_root,
        logs_bloom: payload.logs_bloom.clone(),
        prev_randao: payload.prev_randao,
        block_number: payload.block_number,
        gas_limit: payload.gas_limit,
        gas_used: payload.gas_used,
        timestamp: payload.timestamp,
        extra_data: payload.extra_data.clone(),
        base_fee_per_gas: payload.base_fee_per_gas,
        block_hash: payload.block_hash,
        // MAX_TRANSACTIONS_PER_PAYLOAD = 2^20 and MAX_WITHDRAWALS_PER_PAYLOAD = 16.
        transactions_root: empty_list_root(20),
        withdrawals_root: empty_list_root(4),
        blob_gas: None,
    };
    assert_eq!(parsed.payload, expected);
    assert_eq!(parsed.body_field_roots[9], expected.hash_tree_root(ExecutionHeaderForm::Capella).unwrap());
}

/// Claim: a changed payload field moves the body root, and a changed header field moves the header root.
/// Why it matters: this is the control of the test above. A parser that ignored the payload would pass it too.
#[test]
fn a_changed_field_changes_the_roots() {
    let original = try_parse_signed_block(&block().to_ssz()).unwrap();
    let mut other = block();
    other.payload.block_hash = sha256(b"another block hash");
    let changed = try_parse_signed_block(&other.to_ssz()).unwrap();
    assert_ne!(changed.header.body_root, original.header.body_root);
    assert_eq!(changed.payload.block_hash, other.payload.block_hash);
    let mut later = block();
    later.slot += 1;
    let moved = try_parse_signed_block(&later.to_ssz()).unwrap();
    assert_ne!(moved.header.hash_tree_root(), original.header.hash_tree_root());
    assert_eq!(moved.header.body_root, original.header.body_root);
}
