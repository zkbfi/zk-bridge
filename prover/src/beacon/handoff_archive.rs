//! The handoff archive: one complete committee handoff update per sync committee period of a source chain.
//!
//! A light client that missed a period border can only move again with the handoff update of each period it missed (see
//! the module documentation of [`super::http`], "Catching up"). A PulseChain beacon node serves no light-client routes
//! and prunes the states that the prover assembles those updates from, and an Ethereum node serves updates but prunes
//! the states their `genesis_validators_root` branch and the Gloas anchor come from. So the backend asks this prover for
//! the update of each period as soon as the period ends (`handoff-update`), and keeps the record for good, exported and
//! published with the proof archive (docs/proof-archive.md). A later prover reads it back at
//! `<base>/<chain id>/<period>.json`.
//!
//! The record is complete: the update in the JSON shape of the beacon API, plus the fields a node does not serve (the
//! `genesis_validators_root` branch, and for a compact header the RLP of its execution header). Nothing in it is trusted:
//! the program verifies the committee signature over the attested header with the committee the light client stores,
//! and every branch against its root. A wrong record can only fail a proof.

use crate::error::{Error, Result};
use crate::light_client::{committee_hash, update_from_json, ChainKind, LightClientUpdate};
use crate::rpc::HttpGet;
use alloy_primitives::{hex, B256};
use lc_core::types::{
    BeaconBlockHeader, ExecutionPayloadHeader, HeaderForm, LightClientHeader, SyncCommittee,
};
use serde_json::{json, Map, Value};

/// The `format` field of a record.
pub const RECORD_FORMAT: &str = "zkb-handoff-update/1";

fn hex_text(bytes: &[u8]) -> Value {
    Value::String(hex::encode_prefixed(bytes))
}

fn decimal(value: u64) -> Value {
    Value::String(value.to_string())
}

fn branch_json(branch: &[B256]) -> Value {
    Value::Array(
        branch
            .iter()
            .map(|node| hex_text(node.as_slice()))
            .collect(),
    )
}

fn beacon_json(header: &BeaconBlockHeader) -> Value {
    json!({
        "slot": decimal(header.slot),
        "proposer_index": decimal(header.proposer_index),
        "parent_root": hex_text(header.parent_root.as_slice()),
        "state_root": hex_text(header.state_root.as_slice()),
        "body_root": hex_text(header.body_root.as_slice()),
    })
}

fn execution_json(header: &ExecutionPayloadHeader) -> Value {
    let mut object = json!({
        "parent_hash": hex_text(header.parent_hash.as_slice()),
        "fee_recipient": hex_text(header.fee_recipient.as_slice()),
        "state_root": hex_text(header.state_root.as_slice()),
        "receipts_root": hex_text(header.receipts_root.as_slice()),
        "logs_bloom": hex_text(&header.logs_bloom),
        "prev_randao": hex_text(header.prev_randao.as_slice()),
        "block_number": decimal(header.block_number),
        "gas_limit": decimal(header.gas_limit),
        "gas_used": decimal(header.gas_used),
        "timestamp": decimal(header.timestamp),
        "extra_data": hex_text(&header.extra_data),
        "base_fee_per_gas": Value::String(header.base_fee_per_gas.to_string()),
        "block_hash": hex_text(header.block_hash.as_slice()),
        "transactions_root": hex_text(header.transactions_root.as_slice()),
        "withdrawals_root": hex_text(header.withdrawals_root.as_slice()),
    });
    if let (Some(blob), Some(map)) = (header.blob_gas, object.as_object_mut()) {
        map.insert("blob_gas_used".into(), decimal(blob.blob_gas_used));
        map.insert("excess_blob_gas".into(), decimal(blob.excess_blob_gas));
    }
    object
}

fn header_json(header: &LightClientHeader) -> Value {
    let mut map = Map::new();
    map.insert("beacon".into(), beacon_json(&header.beacon));
    map.insert(
        "execution_branch".into(),
        branch_json(&header.execution_branch),
    );
    match header.form {
        HeaderForm::Full => {
            map.insert("execution".into(), execution_json(&header.execution));
        }
        HeaderForm::Compact => {
            map.insert(
                "execution_block_hash".into(),
                hex_text(header.execution.block_hash.as_slice()),
            );
            // Not a beacon API field: the RLP of the execution header, which the prover attaches.
            map.insert(
                "execution_header_rlp".into(),
                hex_text(&header.execution_header_rlp),
            );
        }
    }
    Value::Object(map)
}

fn committee_json(committee: &SyncCommittee) -> Value {
    json!({
        "pubkeys": committee.pubkeys.iter().map(|key| hex_text(key.as_slice())).collect::<Vec<_>>(),
        "aggregate_pubkey": hex_text(committee.aggregate_pubkey.as_slice()),
    })
}

/// The update in the JSON shape of the beacon API (`data` of a `light_client/updates` entry), plus
/// `genesis_validators_root_branch` and, for a compact header, `execution_header_rlp`.
pub fn update_json(update: &LightClientUpdate) -> Value {
    let mut map = Map::new();
    map.insert(
        "attested_header".into(),
        header_json(&update.attested_header),
    );
    map.insert(
        "finalized_header".into(),
        header_json(&update.finalized_header),
    );
    map.insert(
        "finality_branch".into(),
        branch_json(&update.finality_branch),
    );
    map.insert(
        "sync_aggregate".into(),
        json!({
            "sync_committee_bits": hex_text(&update.sync_aggregate.sync_committee_bits),
            "sync_committee_signature": hex_text(&update.sync_aggregate.sync_committee_signature),
        }),
    );
    map.insert("signature_slot".into(), decimal(update.signature_slot));
    if let Some(next) = &update.next_sync_committee {
        map.insert(
            "next_sync_committee".into(),
            committee_json(&next.committee),
        );
        map.insert(
            "next_sync_committee_branch".into(),
            branch_json(&next.branch),
        );
    }
    map.insert(
        "genesis_validators_root_branch".into(),
        branch_json(&update.genesis_validators_root_branch),
    );
    Value::Object(map)
}

/// Parses [`update_json`] back. The beacon API parser of `lc-core` reads the served fields; the two extra fields are
/// read here.
///
/// # Errors
/// `Error::Malformed` for a shape the parser refuses.
pub fn update_from_record_json(data: &Value) -> Result<LightClientUpdate> {
    let mut update = update_from_json(data)?;
    update.genesis_validators_root_branch = hashes(&data["genesis_validators_root_branch"])?;
    for (header, value) in [
        (&mut update.attested_header, &data["attested_header"]),
        (&mut update.finalized_header, &data["finalized_header"]),
    ] {
        if header.form == HeaderForm::Compact {
            header.execution_header_rlp = match value["execution_header_rlp"].as_str() {
                Some(text) => hex::decode(text)
                    .map_err(|error| Error::Malformed(format!("execution_header_rlp: {error}")))?,
                None => Vec::new(),
            };
        }
    }
    Ok(update)
}

fn hashes(value: &Value) -> Result<Vec<B256>> {
    let Some(entries) = value.as_array() else {
        return Ok(Vec::new());
    };
    entries
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .and_then(|text| text.parse::<B256>().ok())
                .ok_or_else(|| Error::Malformed(format!("expected a 32 byte hash, got {entry}")))
        })
        .collect()
}

/// Whether `update` is the handoff update of `period`: attested and signed in `period`, and it proves the next
/// committee.
pub fn is_handoff_of(chain: ChainKind, period: u64, update: &LightClientUpdate) -> bool {
    let spec = chain.spec();
    update.next_sync_committee.is_some()
        && spec.period_at_slot(update.attested_header.beacon.slot) == period
        && spec.period_at_slot(update.signature_slot) == period
        && update.finalized_header.beacon.slot <= update.attested_header.beacon.slot
}

/// The record of the handoff update of `period`. The keys are sorted (`serde_json` keeps a sorted map), so one update
/// always gives the same bytes.
///
/// # Errors
/// `Error::Beacon` when the update is not the handoff of `period` ([`is_handoff_of`]). `Error::Malformed` when the next
/// committee does not hash.
pub fn record_json(
    chain: ChainKind,
    chain_id: u64,
    period: u64,
    update: &LightClientUpdate,
) -> Result<Value> {
    if !is_handoff_of(chain, period, update) {
        return Err(Error::Beacon(format!(
            "the update attested at slot {} and signed at slot {} is not the handoff update of sync committee period {period}",
            update.attested_header.beacon.slot, update.signature_slot
        )));
    }
    let next = update
        .next_sync_committee
        .as_ref()
        .expect("checked by is_handoff_of");
    Ok(json!({
        "format": RECORD_FORMAT,
        "chainId": chain_id,
        "period": period,
        "attestedSlot": update.attested_header.beacon.slot,
        "finalizedSlot": update.finalized_header.beacon.slot,
        "signatureSlot": update.signature_slot,
        "nextSyncCommitteeRoot": format!("{:#x}", committee_hash(&next.committee)?),
        "update": update_json(update),
    }))
}

/// The update of a record, after the checks that need no chain: the format, the chain id, the period, the slots the
/// record names against the update, and that the update is the handoff of the period.
///
/// # Errors
/// `Error::Malformed` naming the first check that fails.
pub fn update_from_record(
    chain: ChainKind,
    chain_id: u64,
    period: u64,
    record: &Value,
) -> Result<LightClientUpdate> {
    let refuse =
        |what: &str| Error::Malformed(format!("the handoff record of period {period}: {what}"));
    if record["format"].as_str() != Some(RECORD_FORMAT) {
        return Err(refuse("unknown format"));
    }
    if record["chainId"].as_u64() != Some(chain_id) || record["period"].as_u64() != Some(period) {
        return Err(refuse("it names another chain or period"));
    }
    let update =
        update_from_record_json(&record["update"]).map_err(|error| refuse(&error.to_string()))?;
    let named = (
        record["attestedSlot"].as_u64(),
        record["finalizedSlot"].as_u64(),
        record["signatureSlot"].as_u64(),
    );
    let actual = (
        Some(update.attested_header.beacon.slot),
        Some(update.finalized_header.beacon.slot),
        Some(update.signature_slot),
    );
    if named != actual {
        return Err(refuse("its slots do not match its update"));
    }
    if !is_handoff_of(chain, period, &update) {
        return Err(refuse("its update is not the handoff of the period"));
    }
    Ok(update)
}

/// One base URL of the archive: the backend's own table, the indexer's read route, or a published tree.
pub struct ArchiveClient {
    /// The host, for messages. Never the URL: it may carry a key.
    pub host: String,
    /// The client on the base URL.
    pub client: Box<dyn HttpGet>,
}

/// What one archive answered for one period.
#[derive(Debug)]
pub enum ArchiveAnswer {
    /// A record that passed [`update_from_record`].
    Found(Box<LightClientUpdate>),
    /// Why this archive gave none, in a few words, such as `answered 404`.
    Missing(String),
}

/// Asks one archive for the record of `period` at `/<chain id>/<period>.json` and checks it.
pub fn ask_archive(
    archive: &ArchiveClient,
    chain: ChainKind,
    chain_id: u64,
    period: u64,
) -> ArchiveAnswer {
    let path = format!("/{chain_id}/{period}.json");
    let response = match archive.client.get(&path, "application/json") {
        Ok(response) => response,
        Err(error) => return ArchiveAnswer::Missing(format!("no answer ({error})")),
    };
    if response.status != 200 {
        return ArchiveAnswer::Missing(format!("answered {}", response.status));
    }
    let record: Value = match serde_json::from_slice(&response.body) {
        Ok(value) => value,
        Err(_) => return ArchiveAnswer::Missing("answered something that is not JSON".into()),
    };
    match update_from_record(chain, chain_id, period, &record) {
        Ok(update) => ArchiveAnswer::Found(Box::new(update)),
        Err(error) => ArchiveAnswer::Missing(format!("refused: {error}")),
    }
}

/// The host of a URL, for messages: `https://user:key@host:8080/path?q` gives `host:8080`.
pub fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::HttpResponse;
    use lc_core::types::{BlobGasFields, BlsPublicKey, NextSyncCommittee, SyncAggregate};

    const PERIOD: u64 = 5;
    const SLOTS: u64 = 8192;

    fn beacon(slot: u64) -> BeaconBlockHeader {
        BeaconBlockHeader {
            slot,
            proposer_index: 7,
            parent_root: B256::repeat_byte(1),
            state_root: B256::repeat_byte(2),
            body_root: B256::repeat_byte(3),
        }
    }

    fn full_header(slot: u64) -> LightClientHeader {
        let execution = ExecutionPayloadHeader {
            logs_bloom: vec![9; 256],
            block_number: 42,
            extra_data: vec![1, 2],
            block_hash: B256::repeat_byte(4),
            blob_gas: Some(BlobGasFields {
                blob_gas_used: 1,
                excess_blob_gas: 2,
            }),
            ..ExecutionPayloadHeader::default()
        };
        LightClientHeader::full(beacon(slot), execution, vec![B256::repeat_byte(5); 4])
    }

    fn committee() -> SyncCommittee {
        SyncCommittee {
            pubkeys: vec![BlsPublicKey::repeat_byte(6); 512],
            aggregate_pubkey: BlsPublicKey::repeat_byte(8),
        }
    }

    fn update(attested: u64, finalized: u64, signature: u64) -> LightClientUpdate {
        LightClientUpdate {
            attested_header: full_header(attested),
            next_sync_committee: Some(NextSyncCommittee {
                committee: committee(),
                branch: vec![B256::repeat_byte(10); 5],
            }),
            finalized_header: full_header(finalized),
            finality_branch: vec![B256::repeat_byte(11); 6],
            sync_aggregate: SyncAggregate {
                sync_committee_bits: [255; 64],
                sync_committee_signature: [12; 96],
            },
            signature_slot: signature,
            genesis_validators_root_branch: vec![B256::repeat_byte(13); 5],
        }
    }

    fn handoff() -> LightClientUpdate {
        update(
            PERIOD * SLOTS + 8000,
            PERIOD * SLOTS + 7900,
            PERIOD * SLOTS + 8001,
        )
    }

    #[test]
    fn a_full_update_survives_the_record() {
        let original = handoff();
        let record = record_json(ChainKind::Sepolia, 11155111, PERIOD, &original).unwrap();
        assert_eq!(record["format"], RECORD_FORMAT);
        assert_eq!(record["attestedSlot"], PERIOD * SLOTS + 8000);
        let text = record.to_string();
        assert!(
            text.starts_with("{\"attestedSlot\""),
            "keys are sorted: {}",
            &text[..40]
        );
        let back = update_from_record(
            ChainKind::Sepolia,
            11155111,
            PERIOD,
            &serde_json::from_str(&text).unwrap(),
        )
        .unwrap();
        assert_eq!(back, original);
    }

    #[test]
    fn a_compact_update_keeps_its_rlp() {
        let mut original = handoff();
        for header in [
            &mut original.attested_header,
            &mut original.finalized_header,
        ] {
            *header = LightClientHeader::compact(
                beacon(header.beacon.slot),
                B256::repeat_byte(4),
                vec![B256::repeat_byte(5); 6],
                vec![0xc0, 1, 2],
            );
        }
        let record = record_json(ChainKind::Sepolia, 11155111, PERIOD, &original).unwrap();
        let back = update_from_record(ChainKind::Sepolia, 11155111, PERIOD, &record).unwrap();
        assert_eq!(back, original);
        let mut without = record.clone();
        without["update"]["finalized_header"]
            .as_object_mut()
            .unwrap()
            .remove("execution_header_rlp");
        let parsed = update_from_record(ChainKind::Sepolia, 11155111, PERIOD, &without).unwrap();
        assert!(parsed.finalized_header.execution_header_rlp.is_empty());
        without["update"]["finalized_header"]["execution_header_rlp"] = json!("0xzz");
        assert!(update_from_record(ChainKind::Sepolia, 11155111, PERIOD, &without).is_err());
    }

    #[test]
    fn only_a_handoff_of_the_period_makes_a_record() {
        let mut no_committee = handoff();
        no_committee.next_sync_committee = None;
        assert!(record_json(ChainKind::Sepolia, 1, PERIOD, &no_committee).is_err());
        assert!(record_json(ChainKind::Sepolia, 1, PERIOD + 1, &handoff()).is_err());
        let signed_later = update(
            PERIOD * SLOTS + 8000,
            PERIOD * SLOTS + 7900,
            (PERIOD + 1) * SLOTS,
        );
        assert!(record_json(ChainKind::Sepolia, 1, PERIOD, &signed_later).is_err());
    }

    #[test]
    fn a_record_is_refused_for_each_wrong_field() {
        let good = record_json(ChainKind::Sepolia, 7, PERIOD, &handoff()).unwrap();
        let refused = |change: &dyn Fn(&mut Value), period: u64| {
            let mut record = good.clone();
            change(&mut record);
            update_from_record(ChainKind::Sepolia, 7, period, &record)
                .unwrap_err()
                .to_string()
        };
        assert!(refused(&|r| r["format"] = json!("other"), PERIOD).contains("unknown format"));
        assert!(refused(&|r| r["chainId"] = json!(8), PERIOD).contains("another chain"));
        assert!(refused(&|_| {}, PERIOD + 1).contains("another chain or period"));
        assert!(refused(&|r| r["attestedSlot"] = json!(1), PERIOD).contains("slots do not match"));
        assert!(refused(
            &|r| r["update"]["genesis_validators_root_branch"] = json!(["0x12"]),
            PERIOD
        )
        .contains("32 byte hash"));
        assert!(
            refused(&|r| r["update"]["attested_header"] = json!({}), PERIOD)
                .contains("handoff record")
        );
        let mut early = record_json(ChainKind::Sepolia, 7, PERIOD, &handoff()).unwrap();
        early["update"]["signature_slot"] = json!(((PERIOD + 1) * SLOTS).to_string());
        early["signatureSlot"] = json!((PERIOD + 1) * SLOTS);
        assert!(update_from_record(ChainKind::Sepolia, 7, PERIOD, &early)
            .unwrap_err()
            .to_string()
            .contains("not the handoff"));
        let mut no_branch = good.clone();
        no_branch["update"]
            .as_object_mut()
            .unwrap()
            .remove("genesis_validators_root_branch");
        assert!(
            update_from_record(ChainKind::Sepolia, 7, PERIOD, &no_branch)
                .unwrap()
                .genesis_validators_root_branch
                .is_empty()
        );
    }

    struct Fixed(std::result::Result<(u16, Vec<u8>), String>);

    impl HttpGet for Fixed {
        fn get(&self, _path: &str, _accept: &str) -> Result<HttpResponse> {
            match &self.0 {
                Ok((status, body)) => Ok(HttpResponse {
                    status: *status,
                    body: body.clone(),
                }),
                Err(error) => Err(Error::Http(error.clone())),
            }
        }
    }

    fn archive(answer: std::result::Result<(u16, Vec<u8>), String>) -> ArchiveClient {
        ArchiveClient {
            host: "archive.example".into(),
            client: Box::new(Fixed(answer)),
        }
    }

    #[test]
    fn an_archive_answers_found_or_why_not() {
        let record = record_json(ChainKind::Sepolia, 7, PERIOD, &handoff())
            .unwrap()
            .to_string()
            .into_bytes();
        let found = archive(Ok((200, record)));
        assert!(matches!(
            ask_archive(&found, ChainKind::Sepolia, 7, PERIOD),
            ArchiveAnswer::Found(_)
        ));
        let missing = |answer, expected: &str| match ask_archive(
            &archive(answer),
            ChainKind::Sepolia,
            7,
            PERIOD,
        ) {
            ArchiveAnswer::Missing(why) => assert!(why.contains(expected), "{why}"),
            ArchiveAnswer::Found(_) => panic!("found"),
        };
        missing(Ok((404, Vec::new())), "answered 404");
        missing(Ok((200, b"<html>".to_vec())), "not JSON");
        let other_chain = record_json(ChainKind::Sepolia, 8, PERIOD, &handoff())
            .unwrap()
            .to_string()
            .into_bytes();
        missing(Ok((200, other_chain)), "refused");
        missing(Err("timed out".into()), "no answer");
    }

    #[test]
    fn the_archive_path_names_the_chain_and_the_period() {
        struct Paths(std::sync::Arc<std::sync::Mutex<Vec<String>>>);
        impl HttpGet for Paths {
            fn get(&self, path: &str, _accept: &str) -> Result<HttpResponse> {
                self.0.lock().unwrap().push(path.to_string());
                Ok(HttpResponse {
                    status: 404,
                    body: Vec::new(),
                })
            }
        }
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let archive = ArchiveClient {
            host: "h".into(),
            client: Box::new(Paths(seen.clone())),
        };
        let _ = ask_archive(&archive, ChainKind::Sepolia, 943, 12);
        assert_eq!(*seen.lock().unwrap(), vec!["/943/12.json".to_string()]);
    }

    #[test]
    fn a_host_never_carries_the_path_or_a_key() {
        assert_eq!(
            host_of("https://user:key@archive.example:8080/api/proofs/handoffs?k=1"),
            "archive.example:8080"
        );
        assert_eq!(
            host_of("http://127.0.0.1:8787/archive/handoffs"),
            "127.0.0.1:8787"
        );
        assert_eq!(host_of("archive.example/x"), "archive.example");
    }
}
