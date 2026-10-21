//! Witness generator for the revision 2 circuit probe.
//! Usage: `witness <scenario> <output file>`. It builds a real block header, a real receipts trie, a real
//! Merkle-Patricia proof, and writes the blobs that the stub `sp1_zkvm` reads. Run `circuit < output file`.

use alloy_consensus::{Eip658Value, Header, Receipt, ReceiptWithBloom};
use alloy_primitives::{Address, B256, Bytes, Log, U256, b256, keccak256, logs_bloom};
use alloy_rlp::Encodable;
use alloy_sol_types::{SolValue, sol};
use alloy_trie::{HashBuilder, Nibbles, proof::ProofRetainer};
use sp1_zkvm::wire::{encode_list, push_blob};

sol! {
    struct BridgePublicInputs {
        uint64 source_chain_id;
        uint64 target_chain_id;
        address source_vault;
        address token_address;
        address recipient;
        uint256 amount;
        bytes32 deposit_nonce;
        bytes32 confirmed_block_root;
    }
}

/// The topic that the specification's circuit hardcodes (R2-02).
const SPEC_TOPIC: B256 = b256!("2df93605658e38812f86230cb85b0d0c35583b27b9c9769f36b6fbfda3d8c1ee");
const VAULT: Address = Address::repeat_byte(0xaa);
const TOKEN: Address = Address::repeat_byte(0x11);
const SENDER: Address = Address::repeat_byte(0x22);
const RECIPIENT: Address = Address::repeat_byte(0x33);

/// One deposit log as `ZKBridgeVault` emits it after the R2-01 repair (three indexed, data = amount, nonce, target).
fn deposit_log(topic0: B256, amount: u64, nonce: B256) -> Log {
    let topics = vec![topic0, TOKEN.into_word(), SENDER.into_word(), RECIPIENT.into_word()];
    let mut data = Vec::new();
    data.extend_from_slice(&U256::from(amount).to_be_bytes::<32>());
    data.extend_from_slice(nonce.as_slice());
    data.extend_from_slice(&U256::from(369u64).to_be_bytes::<32>());
    Log::new_unchecked(VAULT, topics, Bytes::from(data))
}

/// Bare RLP list receipt: `rlp([status, cumulativeGasUsed, bloom, logs])`, the legacy (type 0) layout.
fn legacy_receipt_bytes(logs: Vec<Log>) -> Vec<u8> {
    let logs_bloom = logs_bloom(logs.iter());
    let receipt = Receipt { status: Eip658Value::Eip658(true), cumulative_gas_used: 100_000, logs };
    let mut out = Vec::new();
    ReceiptWithBloom { receipt, logs_bloom }.encode(&mut out);
    out
}

/// Receipts trie of `values` (index 0 first). Returns the root and the proof nodes for `target`.
fn receipts_trie(values: &[Vec<u8>], target: usize) -> (B256, Vec<Vec<u8>>) {
    let mut items: Vec<(Nibbles, &Vec<u8>)> =
        values.iter().enumerate().map(|(index, value)| (Nibbles::unpack(alloy_rlp::encode(index)), value)).collect();
    items.sort_by(|a, b| a.0.cmp(&b.0));
    let target_key = Nibbles::unpack(alloy_rlp::encode(target));
    let mut builder = HashBuilder::default().with_proof_retainer(ProofRetainer::new(vec![target_key]));
    for (key, value) in items {
        builder.add_leaf(key, value);
    }
    let root = builder.root();
    let nodes = builder.take_proof_nodes();
    let proof = nodes.matching_nodes_sorted(&target_key).into_iter().map(|(_, node)| node.to_vec()).collect();
    (root, proof)
}

struct Case {
    receipt_bytes_in_trie: Vec<u8>,
    proven_nonce: B256,
    signature_length: usize,
    pubkey_count: usize,
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    let (scenario, output) = (arguments[1].as_str(), arguments[2].as_str());
    let real_topic = keccak256("DepositInitiated(address,address,address,uint256,bytes32,uint64)");
    let nonce_one = keccak256("nonce one");
    let nonce_two = keccak256("nonce two");

    let honest = |topic0: B256| legacy_receipt_bytes(vec![deposit_log(topic0, 100, nonce_one)]);
    let case = match scenario {
        // Control: the circuit's own constant as topic 0, a bare list receipt, a 96 byte signature, 342 keys.
        "control-pass" => Case { receipt_bytes_in_trie: honest(SPEC_TOPIC), proven_nonce: nonce_one, signature_length: 96, pubkey_count: 342 },
        // R2-02: the vault's real event topic. The circuit never matches it.
        "real-topic" => Case { receipt_bytes_in_trie: honest(real_topic), proven_nonce: nonce_one, signature_length: 96, pubkey_count: 342 },
        // R2-05: same receipt as the control, wrapped as a type 2 transaction receipt (0x02 || rlp).
        "typed-receipt" => {
            let mut typed = vec![0x02];
            typed.extend(honest(SPEC_TOPIC));
            Case { receipt_bytes_in_trie: typed, proven_nonce: nonce_one, signature_length: 96, pubkey_count: 342 }
        }
        // R2-06: two deposits in one transaction. The first one is proven (control).
        "two-deposits-prove-first" | "two-deposits-prove-second" => {
            let receipt = legacy_receipt_bytes(vec![deposit_log(SPEC_TOPIC, 100, nonce_one), deposit_log(SPEC_TOPIC, 100, nonce_two)]);
            let proven_nonce = if scenario.ends_with("first") { nonce_one } else { nonce_two };
            Case { receipt_bytes_in_trie: receipt, proven_nonce, signature_length: 96, pubkey_count: 342 }
        }
        // R2-03: a signature of zeros and keys of zeros pass. Controls: a short signature, too few keys.
        "bls-zeros" => Case { receipt_bytes_in_trie: honest(SPEC_TOPIC), proven_nonce: nonce_one, signature_length: 96, pubkey_count: 342 },
        "bls-short-signature" => Case { receipt_bytes_in_trie: honest(SPEC_TOPIC), proven_nonce: nonce_one, signature_length: 95, pubkey_count: 342 },
        "bls-few-keys" => Case { receipt_bytes_in_trie: honest(SPEC_TOPIC), proven_nonce: nonce_one, signature_length: 96, pubkey_count: 341 },
        other => panic!("unknown scenario {other}"),
    };

    // Receipt index 1 in a block of three transactions; the others are empty receipts.
    let filler = legacy_receipt_bytes(vec![]);
    let values = vec![filler.clone(), case.receipt_bytes_in_trie.clone(), filler];
    let (receipts_root, proof) = receipts_trie(&values, 1);
    let header = Header { receipts_root, number: 1, ..Default::default() };
    let mut header_rlp = Vec::new();
    header.encode(&mut header_rlp);
    let block_hash = keccak256(&header_rlp);

    let public_inputs = BridgePublicInputs {
        source_chain_id: 1,
        target_chain_id: 369,
        source_vault: VAULT,
        token_address: TOKEN,
        recipient: RECIPIENT,
        amount: U256::from(100u64),
        deposit_nonce: case.proven_nonce,
        confirmed_block_root: block_hash,
    }
    .abi_encode();

    let mut out = Vec::new();
    push_blob(&mut out, &public_inputs);
    push_blob(&mut out, &header_rlp);
    push_blob(&mut out, &vec![0u8; case.signature_length]);
    push_blob(&mut out, &encode_list(&vec![vec![0u8; 48]; case.pubkey_count]));
    push_blob(&mut out, &encode_list(&proof));
    push_blob(&mut out, &alloy_rlp::encode(1usize));
    push_blob(&mut out, &case.receipt_bytes_in_trie);
    std::fs::write(output, out).expect("write witness");
}
