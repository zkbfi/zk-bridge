//! The standard synthetic block of the message tests and the message fixtures: one block with four transactions, and a
//! receipt with one log for each rule that the reference check applies to a log.

use crate::synthetic::{message_log, MessageFields, ReceiptSpec};
use alloy_primitives::{address, Address, Bytes, B256};
use lc_core::chain::ChainSpec;
use lc_core::execution::Log;
use lc_core::message::{message_id_for, DATA_TYPE_CONFIRM, DATA_TYPE_PASS};

/// The bridge on the source chain.
pub const BRIDGE: Address = address!("00000000000000000000000000000000000000a1");
pub const ATTACKER: Address = address!("00000000000000000000000000000000000000ee");

/// The chain identifier of the source chain of a spec.
pub fn remote_chain_id(spec: &ChainSpec) -> u64 {
    match spec.name {
        "pulsechain" => 369,
        "sepolia" => 11_155_111,
        _ => 1,
    }
}

/// The honest fields of message number `nonce`, sent by the bridge for the verifying chain `local`.
pub fn honest_fields(spec: &ChainSpec, local: u64, nonce: u64) -> MessageFields {
    let remote = remote_chain_id(spec);
    MessageFields {
        message_id: message_id_for(remote, BRIDGE, nonce),
        sender: address!("00000000000000000000000000000000000000c3"),
        executor: address!("00000000000000000000000000000000000000d4"),
        gas_limit: 300_000,
        data_type: DATA_TYPE_PASS,
        source_chain_id: remote,
        destination_chain_id: local,
        data: Bytes::from(vec![0xab, 0xcd, nonce as u8]),
    }
}

pub fn unrelated_log() -> Log {
    Log {
        address: address!("0000000000000000000000000000000000000fff"),
        topics: vec![B256::repeat_byte(0x77)],
        data: Bytes::from_static(&[1, 2, 3]),
    }
}

/// Receipts of the synthetic block, one transaction each:
/// 0: type 2, success, one unrelated log.
/// 1: type 0 (legacy), success. Log 0 message A, log 1 unrelated, log 2 message B, then one log for each refusal:
///    3 emitter is an attacker, 4 another topic 0 from the bridge, 5 wrong source chain, 6 wrong destination chain,
///    7 malformed event data, 8 bad version, 9 bad data type, 10 the topic identifier differs from the message,
///    11 three topics, 12 a message with the data type of `requireToConfirmMessage`.
/// 2: type 2, FAILED, with a perfect message log.
/// 3: type 2, success, message C.
pub fn standard_receipts(spec: &ChainSpec, local: u64) -> Vec<ReceiptSpec> {
    let honest = |nonce: u64| honest_fields(spec, local, nonce);
    let remote = remote_chain_id(spec);
    let other_topic = Log { address: BRIDGE, topics: vec![B256::repeat_byte(0x99), B256::ZERO], data: Bytes::new() };
    let malformed_data = Log { data: Bytes::from_static(&[0u8; 40]), ..message_log(BRIDGE, &honest(7)) };
    let mut bad_version = honest(8);
    bad_version.message_id.0[1] = 0x06;
    let mut bad_data_type = honest(9);
    bad_data_type.data_type = 0x40;
    let mut other_identifier = message_log(BRIDGE, &honest(10));
    other_identifier.topics[1] = B256::repeat_byte(0x55);
    let mut three_topics = message_log(BRIDGE, &honest(11));
    three_topics.topics.push(B256::ZERO);
    let mut confirm = honest(12);
    confirm.data_type = DATA_TYPE_CONFIRM;
    let logs = vec![
        message_log(BRIDGE, &honest(1)),
        unrelated_log(),
        message_log(BRIDGE, &honest(2)),
        message_log(ATTACKER, &honest(3)),
        other_topic,
        message_log(BRIDGE, &MessageFields { source_chain_id: remote + 1, ..honest(5) }),
        message_log(BRIDGE, &MessageFields { destination_chain_id: local + 1, ..honest(6) }),
        malformed_data,
        message_log(BRIDGE, &bad_version),
        message_log(BRIDGE, &bad_data_type),
        other_identifier,
        three_topics,
        message_log(BRIDGE, &confirm),
    ];
    vec![
        ReceiptSpec { transaction_type: 2, success: true, logs: vec![unrelated_log()] },
        ReceiptSpec { transaction_type: 0, success: true, logs },
        ReceiptSpec { transaction_type: 2, success: false, logs: vec![message_log(BRIDGE, &honest(4))] },
        ReceiptSpec { transaction_type: 2, success: true, logs: vec![message_log(BRIDGE, &honest(13))] },
    ]
}
