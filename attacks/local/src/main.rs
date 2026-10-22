//! Evidence builder for the red-team attacks on the local network.
//!
//! The attack scripts in `attacks/local/` send transactions with `cast`. This program builds the one thing that
//! `cast` cannot build: the calldata of `BridgeVault.withdraw` for a deposit that already sits in a source block.
//! It reads the chains and the destination light client, and it never sends a transaction and never holds a key.
//!
//! - `proof` prints the honest calldata for the log at `--log-index` of the receipt of `--tx`. It does not check
//!   that the log is a deposit of the bridge vault, so a log of another contract gives the proof that the vault
//!   must refuse.
//! - `variants` prints one line per attack: a name, a tab and the calldata. Some variants edit one field of the
//!   honest proof. Others forge a receipt and rebuild the receipts trie and the block header around the forgery, so
//!   only the link between the header and the beacon block can still catch them.
//!
//! The program is for development only. It needs the cargo feature `dev-source`.

use alloy_primitives::{hex, Address, Bytes, B256, U256};
use clap::{Parser, Subcommand};
use lc_core::abi::WithdrawalProof;
use lc_core::json::{execution_header_from_json, receipts_from_json};
use lc_core::receipts::{build_receipts_trie, encode_execution_header, header_hash};
use serde_json::Value;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use zk_bridge_prover::beacon::dev::DevBeaconSource;
use zk_bridge_prover::beacon::{BeaconSource, DepositBlock};
use zk_bridge_prover::chain::ChainClient;
use zk_bridge_prover::config::{Config, RouteName};
use alloy_sol_types::SolCall;
use zk_bridge_prover::contracts::{
    head_updated_topic, BlockHashEvidence, BlockRootsEvidence, VaultContract,
};
use zk_bridge_prover::error::{Error, Result};
use zk_bridge_prover::light_client::{
    assemble_withdrawal_proof, build_execution_evidence, to_layout_header, withdrawal_calldata,
    ExecutionEvidence,
};
use zk_bridge_prover::route::read_light_client_state_of;
use zk_bridge_prover::rpc::{parse_quantity, HttpRpc};

/// The slot of the phase that holds the anchor state of a block in the development beacon chain.
const ANCHOR_PHASE: u64 = 3;
/// The pause between two tries of `proof --wait-seconds`.
const POLL_PAUSE: Duration = Duration::from_millis(150);

/// Builds withdrawal evidence for the red-team attacks.
#[derive(Debug, Parser)]
#[command(name = "attack-evidence", version, about)]
struct Cli {
    /// The prover configuration (`prover.toml`). Only the chain sections are read.
    #[arg(long)]
    config: PathBuf,
    /// The route of the deposit: `a_to_b` or `b_to_a`.
    #[arg(long)]
    route: String,
    /// The hash of the transaction on the source chain.
    #[arg(long)]
    tx: String,
    /// The index of the log inside the receipt of that transaction.
    #[arg(long)]
    log_index: u64,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Print the honest calldata of `withdraw`.
    Proof {
        /// Keep trying for this long while the light client has no anchor for the block.
        #[arg(long, default_value_t = 0)]
        wait_seconds: u64,
        /// Build the proof for the anchor that the prover will store for this block, before it stores it. The
        /// vault accepts the proof only after the light client stores that anchor.
        #[arg(long)]
        assume_anchor: bool,
    },
    /// Print the slot of the anchor that the prover stores for the block of the transaction.
    AnchorSlot,
    /// Print `name<TAB>calldata` for every tampered variant.
    Variants,
    /// Print the calldata of the two calls that give a vault the layout rows for this deposit: first
    /// `addBlockRootsLayout`, then `addBlockHashLayout` for the deposit slot and for the anchor slot. Anyone may send them. The vault checks them itself.
    Layouts,
}

/// Both chains of one route, the beacon source and the destination light client.
struct Context {
    source: ChainClient,
    destination: ChainClient,
    beacon: DevBeaconSource,
    light_client: Address,
    destination_start_block: u64,
    log_block_range: u64,
}

/// What the evidence for one log is made of.
struct Parts {
    block_json: Value,
    receipts: Value,
    transaction_index: u64,
    block: DepositBlock,
}

fn route_of(text: &str) -> Result<RouteName> {
    match text {
        "a_to_b" => Ok(RouteName::AToB),
        "b_to_a" => Ok(RouteName::BToA),
        other => Err(Error::Usage(format!(
            "--route must be a_to_b or b_to_a, not {other}"
        ))),
    }
}

fn open(cli: &Cli) -> Result<Context> {
    let config = Config::load_file(&cli.config, &|_| None)?;
    let route = route_of(&cli.route)?;
    let (from, to) = (config.source_of(route), config.destination_of(route));
    let connect = |chain: &zk_bridge_prover::config::ChainConfig| {
        ChainClient::connect(
            &chain.name,
            chain.chain_id,
            Box::new(HttpRpc::new(&chain.rpc_url)),
            None,
        )
    };
    Ok(Context {
        source: connect(from)?,
        destination: connect(to)?,
        beacon: DevBeaconSource::new(
            from.chain_kind()?,
            from.beacon.finality_depth.unwrap_or(0),
            from.beacon.slot_offset.unwrap_or(1_024),
        ),
        light_client: to.light_client_address()?,
        destination_start_block: to.start_block,
        log_block_range: config.log_block_range,
    })
}

/// The slots of every head that the destination light client stored, from its `HeadUpdated` events.
fn stored_slots(context: &Context) -> Result<Vec<u64>> {
    let latest = zk_bridge_prover::chain::ExecutionReader::latest_block_number(&context.destination)?;
    let mut slots = Vec::new();
    let mut from = context.destination_start_block;
    while from <= latest {
        let to = latest.min(from.saturating_add(context.log_block_range - 1));
        for log in context
            .destination
            .logs(context.light_client, head_updated_topic(), from, to)?
        {
            let topic = log
                .topics
                .get(1)
                .ok_or_else(|| Error::Malformed("HeadUpdated without a slot topic".into()))?;
            slots.push(u64::from_be_bytes(topic[24..].try_into().expect("8 bytes")));
        }
        from = to + 1;
    }
    Ok(slots)
}

fn parts_of(context: &Context, transaction: B256) -> Result<Parts> {
    let receipt = context
        .source
        .transaction_receipt(transaction)?
        .ok_or_else(|| Error::Usage("the transaction is not mined on the source chain".into()))?;
    let number = parse_quantity(&receipt["blockNumber"])?;
    let block_json = context
        .source
        .block(number)?
        .ok_or_else(|| Error::Malformed(format!("block {number} is unknown")))?;
    let receipts = context.source.block_receipts(number, &block_json)?;
    let hash: B256 = block_json["hash"]
        .as_str()
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| Error::Malformed("block hash".into()))?;
    Ok(Parts {
        transaction_index: parse_quantity(&receipt["transactionIndex"])?,
        block: DepositBlock {
            number,
            hash,
            timestamp: parse_quantity(&block_json["timestamp"])?,
        },
        block_json,
        receipts,
    })
}

/// The slot of the anchor that the development beacon source uses for a block.
fn anchor_slot_of(context: &Context, block_number: u64) -> u64 {
    context.beacon.slot_of(block_number, ANCHOR_PHASE)
}

/// The stored slots that the beacon source sees. With `assumed_anchor`, every stored anchor at or after the deposit
/// block is hidden and the assumed slot is added, so the source builds its proof on that anchor. The light client
/// may not store it, and then the vault refuses the proof.
fn visible_slots(
    context: &Context,
    parts: &Parts,
    assumed_anchor: Option<u64>,
) -> Result<Vec<u64>> {
    let mut stored = stored_slots(context)?;
    let Some(assumed) = assumed_anchor else {
        return Ok(stored);
    };
    stored.retain(|slot| {
        context
            .beacon
            .block_and_phase(*slot)
            .is_none_or(|(number, phase)| phase != ANCHOR_PHASE || number < parts.block.number)
    });
    stored.push(assumed);
    Ok(stored)
}

/// The honest proof. See [`visible_slots`] for `assumed_anchor`.
fn proof_with(
    context: &Context,
    parts: &Parts,
    log_index: u64,
    assumed_anchor: Option<u64>,
) -> Result<WithdrawalProof> {
    let execution = build_execution_evidence(
        &parts.block_json,
        &parts.receipts,
        parts.transaction_index,
    )?;
    let state = read_light_client_state_of(&context.destination, context.light_client)?;
    let stored = visible_slots(context, parts, assumed_anchor)?;
    let path = context
        .beacon
        .withdrawal_path(&parts.block, &state, &stored, &context.source)?;
    Ok(assemble_withdrawal_proof(
        &path,
        &execution,
        parts.transaction_index,
        log_index,
    ))
}

fn flip_hash(value: B256) -> B256 {
    let mut bytes = value.0;
    bytes[0] ^= 0x01;
    B256::from(bytes)
}

fn flip_byte(value: &Bytes, index: usize) -> Bytes {
    let mut bytes = value.to_vec();
    if let Some(byte) = bytes.get_mut(index) {
        *byte ^= 0x01;
    }
    Bytes::from(bytes)
}

fn address_word(address: Address) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address.as_slice());
    word
}

/// One named change of one field of a proof.
fn variant(
    honest: &WithdrawalProof,
    name: &str,
    edit: impl FnOnce(&mut WithdrawalProof),
) -> (String, WithdrawalProof) {
    let mut proof = honest.clone();
    edit(&mut proof);
    (name.to_string(), proof)
}

/// Variants that change one field of the evidence and leave the rest alone.
fn field_variants(honest: &WithdrawalProof) -> Vec<(String, WithdrawalProof)> {
    let mut all = vec![
        variant(honest, "anchor_slot_plus_one", |p| p.anchorHeader.slot += 1),
        variant(honest, "anchor_proposer_plus_one", |p| {
            p.anchorHeader.proposerIndex += 1
        }),
        variant(honest, "anchor_parent_root_flipped", |p| {
            p.anchorHeader.parentRoot = flip_hash(p.anchorHeader.parentRoot)
        }),
        variant(honest, "anchor_state_root_flipped", |p| {
            p.anchorHeader.stateRoot = flip_hash(p.anchorHeader.stateRoot)
        }),
        variant(honest, "anchor_body_root_flipped", |p| {
            p.anchorHeader.bodyRoot = flip_hash(p.anchorHeader.bodyRoot)
        }),
        variant(honest, "deposit_header_slot_plus_one", |p| {
            p.depositHeader.slot += 1
        }),
        variant(honest, "deposit_header_state_root_flipped", |p| {
            p.depositHeader.stateRoot = flip_hash(p.depositHeader.stateRoot)
        }),
        variant(honest, "deposit_header_body_root_flipped", |p| {
            p.depositHeader.bodyRoot = flip_hash(p.depositHeader.bodyRoot)
        }),
        variant(honest, "deposit_header_swapped_with_anchor", |p| {
            std::mem::swap(&mut p.depositHeader, &mut p.anchorHeader)
        }),
        variant(honest, "ancestry_branch_first_flipped", |p| {
            if let Some(node) = p.ancestryBranch.first_mut() {
                *node = flip_hash(*node)
            }
        }),
        variant(honest, "ancestry_branch_last_dropped", |p| {
            p.ancestryBranch.pop();
        }),
        variant(honest, "ancestry_branch_extended", |p| {
            p.ancestryBranch.push(B256::ZERO)
        }),
        variant(honest, "ancestry_branch_empty", |p| p.ancestryBranch.clear()),
        variant(honest, "block_hash_branch_first_flipped", |p| {
            if let Some(node) = p.blockHashBranch.first_mut() {
                *node = flip_hash(*node)
            }
        }),
        variant(honest, "block_hash_branch_last_dropped", |p| {
            p.blockHashBranch.pop();
        }),
        variant(honest, "block_hash_branch_empty", |p| {
            p.blockHashBranch.clear()
        }),
        variant(honest, "execution_header_first_byte_flipped", |p| {
            p.executionHeaderRlp = flip_byte(&p.executionHeaderRlp, 0)
        }),
        variant(honest, "execution_header_middle_byte_flipped", |p| {
            p.executionHeaderRlp = flip_byte(&p.executionHeaderRlp, p.executionHeaderRlp.len() / 2)
        }),
        variant(honest, "execution_header_truncated", |p| {
            let kept = p.executionHeaderRlp.len() / 2;
            p.executionHeaderRlp = Bytes::from(p.executionHeaderRlp[..kept].to_vec())
        }),
        variant(honest, "execution_header_empty", |p| {
            p.executionHeaderRlp = Bytes::new()
        }),
        variant(honest, "receipt_proof_first_node_flipped", |p| {
            if let Some(node) = p.receiptProof.first_mut() {
                *node = flip_byte(node, 5)
            }
        }),
        variant(honest, "receipt_proof_last_node_flipped", |p| {
            if let Some(node) = p.receiptProof.last_mut() {
                *node = flip_byte(node, 5)
            }
        }),
        variant(honest, "receipt_proof_last_node_dropped", |p| {
            p.receiptProof.pop();
        }),
        variant(honest, "receipt_proof_reversed", |p| {
            p.receiptProof.reverse()
        }),
        variant(honest, "receipt_proof_empty", |p| p.receiptProof.clear()),
        variant(honest, "transaction_index_plus_one", |p| {
            p.transactionIndex += U256::from(1)
        }),
        variant(honest, "transaction_index_huge", |p| {
            p.transactionIndex = U256::MAX
        }),
        variant(honest, "log_index_plus_one", |p| p.logIndex += U256::from(1)),
        variant(honest, "log_index_out_of_range", |p| {
            p.logIndex = U256::from(9_999)
        }),
        variant(honest, "log_index_huge", |p| p.logIndex = U256::MAX),
    ];
    all.retain(|(_, proof)| proof != honest);
    all
}

/// One named change of one log of the receipt.
struct LogEdit {
    name: &'static str,
    edit: Box<dyn Fn(&mut Value)>,
}

fn set_data_word(log: &mut Value, index: usize, word: [u8; 32]) {
    let text = log["data"].as_str().unwrap_or("0x").to_string();
    let mut bytes = hex::decode(&text).unwrap_or_default();
    if bytes.len() >= 32 * (index + 1) {
        bytes[32 * index..32 * (index + 1)].copy_from_slice(&word);
    }
    log["data"] = Value::String(format!("0x{}", hex::encode(bytes)));
}

fn data_word(log: &Value, index: usize) -> [u8; 32] {
    let bytes = hex::decode(log["data"].as_str().unwrap_or("0x")).unwrap_or_default();
    let mut word = [0u8; 32];
    if bytes.len() >= 32 * (index + 1) {
        word.copy_from_slice(&bytes[32 * index..32 * (index + 1)]);
    }
    word
}

fn set_topic(log: &mut Value, index: usize, topic: B256) {
    log["topics"][index] = Value::String(format!("{topic:#x}"));
}

fn attacker_address() -> Address {
    Address::repeat_byte(0xaa)
}

/// The edits of a deposit log: each one forges a field of the event that the vault reads.
fn log_edits() -> Vec<LogEdit> {
    let edit = |name, edit: Box<dyn Fn(&mut Value)>| LogEdit { name, edit };
    vec![
        edit(
            "forged_amount_plus_one",
            Box::new(|log| {
                let amount = U256::from_be_bytes(data_word(log, 0)) + U256::from(1);
                set_data_word(log, 0, amount.to_be_bytes::<32>());
            }),
        ),
        edit(
            "forged_amount_maximum",
            Box::new(|log| set_data_word(log, 0, U256::MAX.to_be_bytes::<32>())),
        ),
        edit(
            "forged_nonce",
            Box::new(|log| {
                let nonce = B256::from(data_word(log, 1));
                set_data_word(log, 1, flip_hash(nonce).0);
            }),
        ),
        edit(
            "forged_target_chain",
            Box::new(|log| {
                let chain = U256::from_be_bytes(data_word(log, 2)) + U256::from(1);
                set_data_word(log, 2, chain.to_be_bytes::<32>());
            }),
        ),
        edit(
            "forged_destination_vault",
            Box::new(|log| set_data_word(log, 3, address_word(attacker_address()))),
        ),
        edit(
            "forged_destination_token",
            Box::new(|log| set_data_word(log, 4, address_word(attacker_address()))),
        ),
        edit(
            "forged_recipient",
            Box::new(|log| {
                set_topic(log, 3, B256::from(address_word(attacker_address())));
            }),
        ),
        edit(
            "forged_source_token",
            Box::new(|log| {
                set_topic(log, 1, B256::from(address_word(attacker_address())));
            }),
        ),
        edit(
            "forged_emitter",
            Box::new(|log| {
                log["address"] = Value::String(format!("{:#x}", attacker_address()));
            }),
        ),
        edit(
            "forged_event_topic",
            Box::new(|log| {
                let topic: B256 = log["topics"][0]
                    .as_str()
                    .and_then(|text| text.parse().ok())
                    .unwrap_or_default();
                set_topic(log, 0, flip_hash(topic));
            }),
        ),
    ]
}

/// A proof for a forged receipt. The receipts trie, the receipts root and the block header are rebuilt, so the
/// header is self-consistent. Only the beacon block, which commits to the real block hash, can still refuse it.
fn forged_proof(
    honest: &WithdrawalProof,
    parts: &Parts,
    log_index: u64,
    edit: &dyn Fn(&mut Value),
) -> Result<WithdrawalProof> {
    let mut receipts = parts.receipts.clone();
    let log = receipts[parts.transaction_index as usize]["logs"]
        .get_mut(log_index as usize)
        .ok_or_else(|| Error::Usage("the receipt has no log at --log-index".into()))?;
    edit(log);
    let trie = build_receipts_trie(&receipts_from_json(&receipts));
    let mut header = execution_header_from_json(&parts.block_json);
    header.receipts_root = trie.root;
    let header_rlp = encode_execution_header(&header);
    let forged = ExecutionEvidence {
        block_hash: header_hash(&header_rlp),
        header_rlp,
        receipt_proof: trie
            .proofs
            .get(parts.transaction_index as usize)
            .cloned()
            .ok_or_else(|| Error::Malformed("no proof for the transaction".into()))?,
    };
    let mut proof = honest.clone();
    proof.executionHeaderRlp = forged.header_rlp;
    proof.receiptProof = forged.receipt_proof;
    Ok(proof)
}

fn print_line(name: &str, proof: &WithdrawalProof) {
    println!("{name}\t0x{}", hex::encode(withdrawal_calldata(proof)));
}

fn variants(context: &Context, parts: &Parts, log_index: u64) -> Result<()> {
    let honest = proof_with(context, parts, log_index, None)?;
    for (name, proof) in field_variants(&honest) {
        print_line(&name, &proof);
    }
    for entry in log_edits() {
        let proof = forged_proof(&honest, parts, log_index, entry.edit.as_ref())?;
        print_line(entry.name, &proof);
    }
    // An anchor from the block after the deposit block. The light client stores no header for it, because the
    // prover updates the light client once per deposit block, so this models a withdrawal before coverage.
    let unstored_anchor = anchor_slot_of(context, parts.block.number + 1);
    match proof_with(context, parts, log_index, Some(unstored_anchor)) {
        Ok(proof) if proof != honest => print_line("anchor_not_stored_by_light_client", &proof),
        Ok(_) | Err(_) => eprintln!("note: no unstored anchor variant for this block"),
    }
    Ok(())
}

fn proof(
    context: &Context,
    parts: &Parts,
    log_index: u64,
    wait_seconds: u64,
    assume_anchor: bool,
) -> Result<()> {
    let started = Instant::now();
    let assumed = assume_anchor.then(|| anchor_slot_of(context, parts.block.number));
    loop {
        match proof_with(context, parts, log_index, assumed) {
            Ok(proof) => {
                println!("0x{}", hex::encode(withdrawal_calldata(&proof)));
                return Ok(());
            }
            Err(error) if started.elapsed() >= Duration::from_secs(wait_seconds) => {
                return Err(error)
            }
            Err(_) => std::thread::sleep(POLL_PAUSE),
        }
    }
}

fn layouts(context: &Context, parts: &Parts, log_index: u64) -> Result<()> {
    let honest = proof_with(context, parts, log_index, None)?;
    let stored = stored_slots(context)?;
    let anchor = lc_core::types::BeaconBlockHeader {
        slot: honest.anchorHeader.slot,
        proposer_index: honest.anchorHeader.proposerIndex,
        parent_root: honest.anchorHeader.parentRoot,
        state_root: honest.anchorHeader.stateRoot,
        body_root: honest.anchorHeader.bodyRoot,
    };
    let roots = context
        .beacon
        .roots_layout_evidence(&anchor, &stored, &context.source)?
        .ok_or_else(|| Error::Beacon("not enough stored headers for a block roots layout".into()))?;
    let roots_call = VaultContract::addBlockRootsLayoutCall {
        blockRootsGindex: U256::from(roots.gindex),
        evidence: BlockRootsEvidence {
            laterHeader: to_layout_header(&roots.later_header),
            earlierSlotA: roots.earlier_slot_a,
            earlierSlotB: roots.earlier_slot_b,
            branchA: roots.branch_a,
            branchB: roots.branch_b,
        },
    };
    println!("0x{}", hex::encode(roots_call.abi_encode()));
    // The prover asks for the deposit slot first, then for the anchor slot, until a validated range covers the deposit.
    for wanted in [honest.depositHeader.slot, honest.anchorHeader.slot] {
        let Some(hash) = context
            .beacon
            .hash_layout_evidence(wanted, &stored, &context.source)?
        else {
            continue;
        };
        let hash_call = VaultContract::addBlockHashLayoutCall {
            blockHashGindex: U256::from(hash.gindex),
            evidence: BlockHashEvidence {
                header: to_layout_header(&hash.header),
                branch: hash.branch,
            },
        };
        println!("0x{}", hex::encode(hash_call.abi_encode()));
    }
    Ok(())
}

fn run(cli: &Cli) -> Result<()> {
    let transaction: B256 = cli
        .tx
        .parse()
        .map_err(|error| Error::Usage(format!("--tx: {error}")))?;
    let context = open(cli)?;
    let parts = parts_of(&context, transaction)?;
    match cli.command {
        Command::Proof {
            wait_seconds,
            assume_anchor,
        } => proof(&context, &parts, cli.log_index, wait_seconds, assume_anchor),
        Command::AnchorSlot => {
            println!("{}", anchor_slot_of(&context, parts.block.number));
            Ok(())
        }
        Command::Variants => variants(&context, &parts, cli.log_index),
        Command::Layouts => layouts(&context, &parts, cli.log_index),
    }
}

fn main() {
    if let Err(error) = run(&Cli::parse()) {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_proof() -> WithdrawalProof {
        let header = |slot: u64| lc_core::abi::BeaconBlockHeader {
            slot,
            proposerIndex: 1,
            parentRoot: B256::repeat_byte(1),
            stateRoot: B256::repeat_byte(2),
            bodyRoot: B256::repeat_byte(3),
        };
        WithdrawalProof {
            anchorHeader: header(10),
            depositHeader: header(5),
            ancestryBranch: vec![B256::repeat_byte(4)],
            blockHashBranch: vec![B256::repeat_byte(5)],
            executionHeaderRlp: Bytes::from(vec![1, 2, 3, 4]),
            receiptProof: vec![Bytes::from(vec![9, 9, 9, 9, 9, 9, 9])],
            transactionIndex: U256::from(2),
            logIndex: U256::from(1),
        }
    }

    /// Claim: every field variant differs from the honest proof.
    /// Why it matters: a variant that equals the honest proof would report BLOCKED for an attack that never
    /// happened, or SUCCEEDED for an honest withdrawal, and hide a real result.
    #[test]
    fn every_field_variant_changes_the_proof() {
        let honest = sample_proof();
        let all = field_variants(&honest);
        assert!(all.len() >= 25, "got {} variants", all.len());
        for (name, proof) in &all {
            assert_ne!(proof, &honest, "{name} equals the honest proof");
        }
        let names: std::collections::BTreeSet<_> = all.iter().map(|(name, _)| name).collect();
        assert_eq!(names.len(), all.len(), "variant names are unique");
    }

    /// Claim: each log edit changes the field of its name and leaves the others alone.
    /// Why it matters: the forged-receipt attacks are only as good as their edits. An edit of the wrong word
    /// would test another field than the report says.
    #[test]
    fn log_edits_change_only_their_own_field() {
        let log = json!({
            "address": "0x1111111111111111111111111111111111111111",
            "topics": [
                format!("{:#x}", B256::repeat_byte(7)),
                format!("{:#x}", B256::repeat_byte(8)),
                format!("{:#x}", B256::repeat_byte(9)),
                format!("{:#x}", B256::repeat_byte(10)),
            ],
            "data": format!("0x{}", hex::encode([1u8; 160])),
        });
        for entry in log_edits() {
            let mut edited = log.clone();
            (entry.edit)(&mut edited);
            let changed: Vec<&str> = ["address", "topics", "data"]
                .into_iter()
                .filter(|key| edited[*key] != log[*key])
                .collect();
            assert_eq!(changed.len(), 1, "{} changes {changed:?}", entry.name);
        }
        let mut amount = log.clone();
        (log_edits()[0].edit)(&mut amount);
        assert_ne!(data_word(&amount, 0), data_word(&log, 0));
        assert_eq!(data_word(&amount, 1), data_word(&log, 1));
        let mut recipient = log.clone();
        let recipient_edit = log_edits()
            .into_iter()
            .find(|entry| entry.name == "forged_recipient")
            .expect("edit");
        (recipient_edit.edit)(&mut recipient);
        assert_eq!(recipient["topics"][1], log["topics"][1]);
        assert_ne!(recipient["topics"][3], log["topics"][3]);
    }

    /// Claim: an unknown route name is refused.
    /// Why it matters: a typo would otherwise attack the wrong direction and report on it.
    #[test]
    fn an_unknown_route_is_refused() {
        assert!(route_of("a_to_b").is_ok());
        assert!(route_of("b_to_a").is_ok());
        assert!(route_of("a_to_c").is_err());
    }
}
