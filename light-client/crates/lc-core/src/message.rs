//! `verify_message`: the Rust reference of what `MessageBridge.executeMessage` checks, and the trie proof helpers.
//!
//! No zero-knowledge proof is involved. The bridge verifies the evidence directly (build contract, section "Message
//! layer and token mediator"). This function does the same checks in the same order, so a Rust test and a Solidity test
//! can run the same fixtures and must agree.
//!
//! Order: the receipt index equals the transaction index; beacon path (anchor stored, ancestry branch, fork proof of the
//! source state, block hash branch); header decode; receipt proof; transaction proof; EIP-2718 receipt decode with a success check; log lookup;
//! emitter and topics; event data; message decode; identifier, version, source chain, destination chain and data type.
//! The delivery state (a message executes once) and the gas guard are bridge state and outside this function.
//!
//! The message encoding is the one of the OmniBridge Arbitrary Message Bridge, byte for byte (`AmbMessageCodec.sol`).

use crate::abi::{MessageProof, USER_REQUEST_TOPIC};
use crate::ancestry::{source_shape, verify_beacon_path};
use crate::chain::ChainSpec;
use crate::error::{Error, Result};
use crate::execution::{decode_execution_anchor_fields, decode_execution_header, decode_receipt, Log};
use crate::layout::SHAPE_PROGRESSIVE;
use crate::mpt::extract_proven_value;
use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_trie::proof::verify_proof;
use alloy_trie::Nibbles;

/// The message format version in the top 4 bytes of every message identifier (`MESSAGE_PACKING_VERSION`).
pub const MESSAGE_PACKING_VERSION: [u8; 4] = [0x00, 0x05, 0x00, 0x00];

/// The data type of a message that `requireToPassMessage` sends.
pub const DATA_TYPE_PASS: u8 = 0x00;

/// The data type of a message that `requireToConfirmMessage` sends.
pub const DATA_TYPE_CONFIRM: u8 = 0x80;

/// The fixed part of a message header: 32 + 20 + 20 + 4 + 1 + 1 + 1 bytes.
const FIXED_HEADER_LENGTH: usize = 79;

/// The bytes 4 to 23 of the hash of (chain identifier, bridge) stand in the message identifier.
const BRIDGE_ID_RANGE: core::ops::Range<usize> = 4..24;

/// What the bridge knows when it verifies a message proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MessageContext {
    /// The address of the bridge on the source chain (`remoteBridge`).
    pub remote_bridge: Address,
    /// The chain identifier of the verifying chain (`localChainId`).
    pub local_chain_id: u64,
    /// The chain identifier of the source chain (`remoteChainId`).
    pub remote_chain_id: u64,
    /// What `lightClient.headers(anchorHeader.slot)` returns. Zero means not stored.
    pub stored_anchor_root: B256,
}

/// The fields of a message, without the call data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MessageHeader {
    /// The message identifier.
    pub message_id: B256,
    /// The contract that sent the message on the source chain.
    pub sender: Address,
    /// The target contract on the destination chain.
    pub executor: Address,
    /// The gas that the target gets.
    pub gas_limit: u32,
    /// `DATA_TYPE_PASS` or `DATA_TYPE_CONFIRM`.
    pub data_type: u8,
    /// The source chain identifier.
    pub source_chain_id: U256,
    /// The destination chain identifier.
    pub destination_chain_id: U256,
}

/// The message that a verified proof proves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedMessage {
    /// The fields of the message.
    pub header: MessageHeader,
    /// The call data for the target.
    pub data: Bytes,
    /// Execution block hash of the source block.
    pub source_block_hash: B256,
    /// The hash of the source transaction: the keccak256 of the transaction at the index of the receipt.
    pub source_transaction_hash: B256,
}

/// The trie key of a transaction index: the RLP of the index, as nibbles. Receipts and transactions share it.
pub fn trie_key(transaction_index: u64) -> Nibbles {
    Nibbles::unpack(alloy_rlp::encode(transaction_index))
}

/// Walks an indexed trie proof and returns the value at `index`. `invalid` builds the error for a failed proof.
///
/// The result is also checked with `alloy_trie::proof::verify_proof`, a second implementation.
fn extract_indexed(root: B256, index: u64, proof: &[Bytes], invalid: fn(String) -> Error) -> Result<Vec<u8>> {
    let key = trie_key(index);
    let nibbles: Vec<u8> = key.to_vec();
    let value = extract_proven_value(root, &nibbles, proof).map_err(|error| match error {
        Error::ReceiptProofInvalid(reason) => invalid(reason),
        other => other,
    })?;
    verify_proof(root, key, Some(value.clone()), proof).map_err(|error| invalid(error.to_string()))?;
    Ok(value)
}

/// Walks a receipt proof and returns the receipt bytes at `transaction_index`.
///
/// # Errors
/// `ReceiptProofInvalid` when the proof does not match.
pub fn extract_receipt(receipts_root: B256, transaction_index: u64, proof: &[Bytes]) -> Result<Vec<u8>> {
    extract_indexed(receipts_root, transaction_index, proof, Error::ReceiptProofInvalid)
}

/// Walks a transaction proof and returns the transaction bytes at `transaction_index`.
///
/// # Errors
/// `TransactionProofInvalid` when the proof does not match.
pub fn extract_transaction(transactions_root: B256, transaction_index: u64, proof: &[Bytes]) -> Result<Vec<u8>> {
    extract_indexed(transactions_root, transaction_index, proof, Error::TransactionProofInvalid)
}

fn index_to_u64(value: U256) -> Result<u64> {
    u64::try_from(value).map_err(|_| Error::ReceiptProofInvalid("index does not fit in 64 bits".to_string()))
}

/// Reads the event data, which is `abi.encode(bytes)`: the offset 32, the length, the bytes padded to a word.
/// Any other layout is refused, so one message has one encoding. Like the contract, it does not check the padding bytes.
///
/// # Errors
/// `MalformedEventData`.
pub fn decode_event_data(data: &[u8]) -> Result<Bytes> {
    if data.len() < 64 {
        return Err(Error::MalformedEventData);
    }
    let offset = U256::from_be_slice(&data[..32]);
    let length = U256::from_be_slice(&data[32..64]);
    if offset != U256::from(32u64) {
        return Err(Error::MalformedEventData);
    }
    let length = usize::try_from(length).map_err(|_| Error::MalformedEventData)?;
    if length > data.len() || data.len() != 64 + length.div_ceil(32) * 32 {
        return Err(Error::MalformedEventData);
    }
    Ok(Bytes::copy_from_slice(&data[64..64 + length]))
}

/// Writes the log event data of an encoded message: `abi.encode(bytes)`.
pub fn encode_event_data(encoded_message: &[u8]) -> Bytes {
    let mut data = Vec::with_capacity(64 + encoded_message.len().div_ceil(32) * 32);
    data.extend_from_slice(&U256::from(32u64).to_be_bytes::<32>());
    data.extend_from_slice(&U256::from(encoded_message.len()).to_be_bytes::<32>());
    data.extend_from_slice(encoded_message);
    data.resize(64 + encoded_message.len().div_ceil(32) * 32, 0);
    Bytes::from(data)
}

/// The fewest bytes that hold a chain identifier: 1 to 32. An identifier of zero takes one byte.
fn chain_id_length(chain_id: U256) -> usize {
    chain_id.byte_len().max(1)
}

/// Writes a message as the Arbitrary Message Bridge does.
///
/// Layout, in bytes: identifier 32, sender 20, executor 20, gas limit 4, source length 1, destination length 1, data type
/// 1, source chain identifier, destination chain identifier, call data. A chain identifier takes the fewest bytes.
pub fn encode_message(header: &MessageHeader, data: &[u8]) -> Bytes {
    let source_length = chain_id_length(header.source_chain_id);
    let destination_length = chain_id_length(header.destination_chain_id);
    let mut encoded = Vec::with_capacity(FIXED_HEADER_LENGTH + source_length + destination_length + data.len());
    encoded.extend_from_slice(header.message_id.as_slice());
    encoded.extend_from_slice(header.sender.as_slice());
    encoded.extend_from_slice(header.executor.as_slice());
    encoded.extend_from_slice(&header.gas_limit.to_be_bytes());
    encoded.push(source_length as u8);
    encoded.push(destination_length as u8);
    encoded.push(header.data_type);
    encoded.extend_from_slice(&header.source_chain_id.to_be_bytes::<32>()[32 - source_length..]);
    encoded.extend_from_slice(&header.destination_chain_id.to_be_bytes::<32>()[32 - destination_length..]);
    encoded.extend_from_slice(data);
    Bytes::from(encoded)
}

/// Reads a message, as `AmbMessageCodec.decode` does.
///
/// # Errors
/// `MalformedMessage` when the message is shorter than its header says or a chain identifier length is not 1 to 32.
pub fn decode_message(encoded: &[u8]) -> Result<(MessageHeader, Bytes)> {
    if encoded.len() < FIXED_HEADER_LENGTH {
        return Err(Error::MalformedMessage);
    }
    let source_length = usize::from(encoded[76]);
    let destination_length = usize::from(encoded[77]);
    if !(1..=32).contains(&source_length) || !(1..=32).contains(&destination_length) {
        return Err(Error::MalformedMessage);
    }
    let destination_start = FIXED_HEADER_LENGTH + source_length;
    let data_start = destination_start + destination_length;
    if encoded.len() < data_start {
        return Err(Error::MalformedMessage);
    }
    let header = MessageHeader {
        message_id: B256::from_slice(&encoded[..32]),
        sender: Address::from_slice(&encoded[32..52]),
        executor: Address::from_slice(&encoded[52..72]),
        gas_limit: u32::from_be_bytes([encoded[72], encoded[73], encoded[74], encoded[75]]),
        data_type: encoded[78],
        source_chain_id: U256::from_be_slice(&encoded[FIXED_HEADER_LENGTH..destination_start]),
        destination_chain_id: U256::from_be_slice(&encoded[destination_start..data_start]),
    };
    Ok((header, Bytes::copy_from_slice(&encoded[data_start..])))
}

/// The identifier of the message with number `nonce` that the bridge at `bridge` on `source_chain_id` sends: the version,
/// bytes 4 to 23 of `keccak256(chain identifier as 32 bytes, bridge address)`, and the nonce in the lowest 8 bytes.
pub fn message_id_for(source_chain_id: u64, bridge: Address, nonce: u64) -> B256 {
    let mut preimage = Vec::with_capacity(52);
    preimage.extend_from_slice(&U256::from(source_chain_id).to_be_bytes::<32>());
    preimage.extend_from_slice(bridge.as_slice());
    let digest = keccak256(&preimage);
    let mut id = [0u8; 32];
    id[..4].copy_from_slice(&MESSAGE_PACKING_VERSION);
    id[BRIDGE_ID_RANGE].copy_from_slice(&digest[BRIDGE_ID_RANGE]);
    id[24..].copy_from_slice(&nonce.to_be_bytes());
    B256::from(id)
}

/// Checks the emitter and the topics of a log, then returns the identifier of its topic and the message of its data.
///
/// # Errors
/// `LogEmitterMismatch`, `LogTopicMismatch`, `LogMalformed`, `MalformedEventData`.
pub fn message_of_log(log: &Log, remote_bridge: Address) -> Result<(B256, Bytes)> {
    if log.address != remote_bridge {
        return Err(Error::LogEmitterMismatch);
    }
    if log.topics.first() != Some(&USER_REQUEST_TOPIC) {
        return Err(Error::LogTopicMismatch);
    }
    if log.topics.len() != 2 {
        return Err(Error::LogMalformed("the log does not have exactly two topics"));
    }
    Ok((log.topics[1], decode_event_data(&log.data)?))
}

/// Checks the message against the log and the bridge: the identifier of the topic, the format version, the source chain,
/// the destination chain and the data type.
///
/// # Errors
/// `MessageIdMismatch`, `MessageVersionInvalid`, `WrongSourceChain`, `WrongDestinationChain`, `UnknownDataType`.
pub fn require_acceptable_message(
    header: &MessageHeader,
    topic_message_id: B256,
    context: &MessageContext,
) -> Result<()> {
    if header.message_id != topic_message_id {
        return Err(Error::MessageIdMismatch { topic_message_id, encoded_message_id: header.message_id });
    }
    if header.message_id[..4] != MESSAGE_PACKING_VERSION {
        return Err(Error::MessageVersionInvalid { message_id: header.message_id });
    }
    if header.source_chain_id != U256::from(context.remote_chain_id) {
        return Err(Error::WrongSourceChain { expected: context.remote_chain_id, actual: header.source_chain_id });
    }
    if header.destination_chain_id != U256::from(context.local_chain_id) {
        return Err(Error::WrongDestinationChain {
            expected: context.local_chain_id,
            actual: header.destination_chain_id,
        });
    }
    if header.data_type != DATA_TYPE_PASS && header.data_type != DATA_TYPE_CONFIRM {
        return Err(Error::UnknownDataType { data_type: header.data_type });
    }
    Ok(())
}

/// The receipts root and the transactions root of the execution header of the proof.
///
/// A source whose state the fork proof shows to be progressive (Gloas on) reads them with the tolerant decoder, because an
/// Amsterdam header has more items than the strict decoder knows. A plain source keeps the strict decoder, as before. The
/// rule follows the same proof as the block hash rule of [`verify_beacon_path`], never the fork schedule, so a Gloas source
/// on a chain whose schedule has no Gloas epoch yet is read as Gloas. The contract reads both items by position in every
/// case (`ReceiptProofLib.headerRoot`).
fn trie_roots(spec: &ChainSpec, proof: &MessageProof) -> Result<(B256, B256)> {
    let shape = source_shape(&proof.sourceFork, &proof.sourceHeader.stateRoot, &spec.genesis_validators_root)?;
    if shape == SHAPE_PROGRESSIVE {
        let fields = decode_execution_anchor_fields(&proof.executionHeaderRlp)?;
        return Ok((fields.receipts_root, fields.transactions_root));
    }
    let header = decode_execution_header(&proof.executionHeaderRlp)?;
    Ok((header.receipts_root, header.transactions_root))
}

/// Verifies a message proof and returns the message it proves.
///
/// # Errors
/// An [`Error`] naming the first failed rule. `Error::reason_code` gives the stable code used in fixtures.
pub fn verify_message(proof: &MessageProof, context: &MessageContext, spec: &ChainSpec) -> Result<VerifiedMessage> {
    if proof.receiptIndex != proof.transactionIndex {
        return Err(Error::IndexMismatch {
            receipt_index: proof.receiptIndex,
            transaction_index: proof.transactionIndex,
        });
    }
    let source_block_hash = verify_beacon_path(spec, proof, &context.stored_anchor_root)?;
    let (receipts_root, transactions_root) = trie_roots(spec, proof)?;

    let index = index_to_u64(proof.receiptIndex)?;
    let receipt_bytes = extract_receipt(receipts_root, index, &proof.receiptProof)?;
    let transaction_bytes = extract_transaction(transactions_root, index, &proof.transactionProof)?;
    let source_transaction_hash = keccak256(&transaction_bytes);

    let receipt = decode_receipt(&receipt_bytes)?;
    if !receipt.success {
        return Err(Error::ReceiptFailed);
    }
    let log_index = u64::try_from(proof.logIndex).unwrap_or(u64::MAX);
    let log = usize::try_from(log_index)
        .ok()
        .and_then(|position| receipt.logs.get(position))
        .ok_or(Error::LogIndexOutOfRange { index: log_index, logs: receipt.logs.len() })?;

    let (topic_message_id, encoded) = message_of_log(log, context.remote_bridge)?;
    let (message_header, data) = decode_message(&encoded)?;
    require_acceptable_message(&message_header, topic_message_id, context)?;
    Ok(VerifiedMessage { header: message_header, data, source_block_hash, source_transaction_hash })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{address, b256, hex};

    fn sample_header() -> MessageHeader {
        MessageHeader {
            message_id: b256!("0005000011223344556677889900aabbccddeeff00112233445566778899aabb"),
            sender: address!("00000000000000000000000000000000000000c3"),
            executor: address!("00000000000000000000000000000000000000d4"),
            gas_limit: 300_000,
            data_type: DATA_TYPE_PASS,
            source_chain_id: U256::from(369u64),
            destination_chain_id: U256::from(1u64),
        }
    }

    /// Claim: the message encoding equals the bytes of `cast abi-encode --packed` of the same fields (Foundry, 2026-10-24),
    /// which is `abi.encodePacked` as `AmbMessageCodec.encode` writes it. The source chain 369 takes 2 bytes, the
    /// destination chain 1 takes 1 byte, and the call data `0xdeadbeef` ends the message.
    /// Why it matters: the bridge decodes these exact bytes, and a different width would shift every later field.
    #[test]
    fn message_encoding_matches_cast() {
        let expected = hex!(
            "0005000011223344556677889900aabbccddeeff00112233445566778899aabb"
            "00000000000000000000000000000000000000c3"
            "00000000000000000000000000000000000000d4"
            "000493e0"
            "02" "01" "00"
            "0171" "01"
            "deadbeef"
        );
        let encoded = encode_message(&sample_header(), &hex!("deadbeef"));
        assert_eq!(encoded.to_vec(), expected.to_vec());
        assert_eq!(decode_message(&encoded), Ok((sample_header(), Bytes::from_static(&hex!("deadbeef")))));
    }

    /// Claim: the decoder refuses a message that is too short, a chain identifier length of 0 or above 32, and a header
    /// that runs past the end. The control: the honest message decodes.
    #[test]
    fn message_decoding_refuses_short_and_bad_lengths() {
        let honest = encode_message(&sample_header(), &[]);
        assert!(decode_message(&honest).is_ok(), "control");
        assert_eq!(decode_message(&honest[..78]), Err(Error::MalformedMessage));
        for (position, value) in [(76usize, 0u8), (76, 33), (77, 0), (77, 33)] {
            let mut broken = honest.to_vec();
            broken[position] = value;
            assert_eq!(decode_message(&broken), Err(Error::MalformedMessage), "byte {position} = {value}");
        }
        assert_eq!(
            decode_message(&honest[..honest.len() - 1]),
            Err(Error::MalformedMessage),
            "chain identifier cut off"
        );
    }

    /// Claim: the identifier equals `AmbMessageCodec.messageIdPrefix(369, bridge) | nonce`, with the hash computed by
    /// `cast keccak` over `abi.encodePacked(uint256(369), address(0xa1))`, which is `0x30c44c43465b...599a64` (Foundry, 2026-10-24).
    #[test]
    fn message_identifier_matches_cast() {
        let bridge = address!("00000000000000000000000000000000000000a1");
        let id = message_id_for(369, bridge, 5);
        assert_eq!(id[..4], MESSAGE_PACKING_VERSION);
        assert_eq!(id[24..], 5u64.to_be_bytes());
        assert_eq!(id[4..24], hex!("465b5b6641e6240941aee4b1fce2d9018254387f"), "bytes 4 to 23 of the cast hash");
        assert_ne!(id, message_id_for(1, bridge, 5), "the chain is part of the identifier");
    }

    /// Claim: the event data is `abi.encode(bytes)` and nothing else. A short blob, another offset, a length that does not
    /// match the padded size, trailing bytes and a missing pad word are refused; the control decodes.
    /// Why it matters: one message must have one encoding, so a proof cannot carry the same message in two forms.
    #[test]
    fn event_data_has_one_encoding() {
        let message = vec![7u8; 45];
        let honest = encode_event_data(&message);
        assert_eq!(honest.len(), 64 + 64);
        assert_eq!(decode_event_data(&honest).unwrap().to_vec(), message, "control");
        assert_eq!(decode_event_data(&[]), Err(Error::MalformedEventData));
        assert_eq!(decode_event_data(&honest[..63]), Err(Error::MalformedEventData));

        let mut other_offset = honest.to_vec();
        other_offset[31] = 64;
        assert_eq!(decode_event_data(&other_offset), Err(Error::MalformedEventData));

        let mut trailing = honest.to_vec();
        trailing.extend_from_slice(&[0u8; 32]);
        assert_eq!(decode_event_data(&trailing), Err(Error::MalformedEventData));
        assert_eq!(decode_event_data(&honest[..honest.len() - 32]), Err(Error::MalformedEventData));

        let mut huge_length = honest.to_vec();
        huge_length[32..64].copy_from_slice(&[0xff; 32]);
        assert_eq!(decode_event_data(&huge_length), Err(Error::MalformedEventData));
        assert_eq!(decode_event_data(&encode_event_data(&[])).unwrap().len(), 0, "an empty value is 64 bytes");
    }
}
