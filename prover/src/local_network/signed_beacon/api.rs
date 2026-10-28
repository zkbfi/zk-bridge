//! The beacon API of the synthetic chain: the requests that `HttpBeaconSource` and the checkpoint tool
//! make, answered from a [`SyntheticBeaconChain`].
//!
//! | Path | Answer |
//! |---|---|
//! | `/eth/v1/beacon/genesis` | genesis time and genesis validators root |
//! | `/eth/v1/config/fork_schedule` | the fork schedule of the chain specification |
//! | `/eth/v1/beacon/headers/<id>` | a header by slot, by root or `head` |
//! | `/eth/v1/beacon/blocks/<slot>/root` | the root of the block at a slot |
//! | `/eth/v2/beacon/blocks/<id>` | the SSZ (Simple Serialize) bytes of a signed block (`Accept: application/octet-stream`) |
//! | `/eth/v2/debug/beacon/states/<id>` | the SSZ bytes of a state by state root, slot or `head` |
//! | `/eth/v1/beacon/light_client/finality_update` | the update at the tip |
//! | `/eth/v1/beacon/light_client/updates` | the handoff updates of the periods that have ended |
//! | `/eth/v1/beacon/light_client/bootstrap/<root>` | the bootstrap of a header |
//!
//! Every other path answers 404, which the callers read as "the node does not serve it". The blocks as JSON are not
//! served: the prover reads them only when a node has no light-client endpoints.

use super::chain::SyntheticBeaconChain;
use crate::error::{Error, Result};
use crate::fork_schedule::answers_from_table;
use alloy_primitives::B256;
use lc_testkit::json::{beacon_header_json, light_client_update_json};
use serde_json::{json, Value};

const JSON: &str = "application/json";
const SSZ: &str = "application/octet-stream";

/// The answer to one request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    /// The HTTP status.
    pub status: u16,
    /// The `Content-Type`.
    pub content_type: &'static str,
    /// The body.
    pub body: Vec<u8>,
}

impl Answer {
    fn json(value: &Value) -> Self {
        Self {
            status: 200,
            content_type: JSON,
            body: value.to_string().into_bytes(),
        }
    }

    fn ssz(body: Vec<u8>) -> Self {
        Self {
            status: 200,
            content_type: SSZ,
            body,
        }
    }

    fn with_status(status: u16, message: &str) -> Self {
        Self {
            status,
            content_type: JSON,
            body: json!({ "code": status, "message": message })
                .to_string()
                .into_bytes(),
        }
    }

    /// A 404 answer.
    pub fn missing(message: &str) -> Self {
        Self::with_status(404, message)
    }

    /// A 503 answer: the node cannot answer now.
    pub fn unavailable(error: &Error) -> Self {
        Self::with_status(503, &error.to_string())
    }
}

/// Answers a request for `target` (path and query) with the given `Accept` header.
pub fn answer(chain: &SyntheticBeaconChain, target: &str, accept: &str) -> Answer {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    route(chain, path, query, accept).unwrap_or_else(|error| Answer::unavailable(&error))
}

fn route(chain: &SyntheticBeaconChain, path: &str, query: &str, accept: &str) -> Result<Answer> {
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match segments.as_slice() {
        ["eth", "v1", "beacon", "genesis"] => Ok(genesis(chain)),
        ["eth", "v1", "config", "fork_schedule"] => Ok(fork_schedule(chain)),
        ["eth", "v1", "config", "spec"] => Ok(chain_specification(chain)),
        ["eth", "v1", "beacon", "headers", id] => Ok(header(chain, id)),
        ["eth", "v1", "beacon", "blocks", id, "root"] => Ok(block_root(chain, id)),
        ["eth", "v2", "beacon", "blocks", id] => Ok(block(chain, id, accept)),
        ["eth", "v2", "debug", "beacon", "states", id] => state(chain, id, accept),
        ["eth", "v1", "beacon", "light_client", "finality_update"] => finality_update(chain),
        ["eth", "v1", "beacon", "light_client", "updates"] => updates(chain, query),
        ["eth", "v1", "beacon", "light_client", "bootstrap", root] => bootstrap(chain, root),
        _ => Ok(Answer::missing(
            "the synthetic beacon node does not serve this path",
        )),
    }
}

/// The slot that an identifier names: `head`, a decimal slot, or the root of a header. `None` when the chain holds no such
/// block.
fn slot_of_block_id(chain: &SyntheticBeaconChain, id: &str) -> Option<u64> {
    if id == "head" {
        return chain.tip_slot();
    }
    if let Some(root) = id.strip_prefix("0x") {
        let root: B256 = format!("0x{root}").parse().ok()?;
        return chain.slot_of_header_root(&root);
    }
    let slot: u64 = id.parse().ok()?;
    chain.header_at(slot).map(|_| slot)
}

fn genesis(chain: &SyntheticBeaconChain) -> Answer {
    let settings = chain.settings();
    Answer::json(&json!({ "data": {
        "genesis_time": settings.genesis_time.to_string(),
        "genesis_validators_root": format!("{:#x}", settings.kind.spec().genesis_validators_root),
        "genesis_fork_version": "0x00000000",
    }}))
}

/// `/eth/v1/config/fork_schedule`: the scheduled forks of the chain specification.
fn fork_schedule(chain: &SyntheticBeaconChain) -> Answer {
    Answer::json(&answers_from_table(chain.settings().kind.spec()).0)
}

/// `/eth/v1/config/spec`: the name, version and epoch of each fork. The prover joins it with the fork schedule.
fn chain_specification(chain: &SyntheticBeaconChain) -> Answer {
    Answer::json(&answers_from_table(chain.settings().kind.spec()).1)
}

fn header(chain: &SyntheticBeaconChain, id: &str) -> Answer {
    let Some(slot) = slot_of_block_id(chain, id) else {
        return Answer::missing("no header for this identifier");
    };
    let (Some(header), Some(root)) = (chain.header_at(slot), chain.header_root_at(slot)) else {
        return Answer::missing("no header for this identifier");
    };
    Answer::json(&json!({ "data": {
        "root": format!("{root:#x}"),
        "canonical": true,
        "header": { "message": beacon_header_json(&header), "signature": format!("0x{}", "00".repeat(96)) },
    }}))
}

fn block_root(chain: &SyntheticBeaconChain, id: &str) -> Answer {
    let root = id
        .parse::<u64>()
        .ok()
        .and_then(|slot| chain.header_root_at(slot));
    match root {
        Some(root) => Answer::json(&json!({ "data": { "root": format!("{root:#x}") } })),
        None => Answer::missing("no block at this slot"),
    }
}

fn block(chain: &SyntheticBeaconChain, id: &str, accept: &str) -> Answer {
    if !accept.contains(SSZ) {
        return Answer::missing("the synthetic beacon node serves blocks as SSZ only");
    }
    let bytes = slot_of_block_id(chain, id).and_then(|slot| chain.block_bytes(slot));
    match bytes {
        Some(bytes) => Answer::ssz(bytes.to_vec()),
        None => Answer::missing("no block for this identifier"),
    }
}

fn slot_of_state_id(chain: &SyntheticBeaconChain, id: &str) -> Option<u64> {
    if let Some(root) = id.strip_prefix("0x") {
        let root: B256 = format!("0x{root}").parse().ok()?;
        return chain.slot_of_state_root(&root);
    }
    slot_of_block_id(chain, id)
}

fn state(chain: &SyntheticBeaconChain, id: &str, accept: &str) -> Result<Answer> {
    if !accept.contains(SSZ) {
        return Ok(Answer::missing(
            "the synthetic beacon node serves states as SSZ only",
        ));
    }
    match slot_of_state_id(chain, id) {
        Some(slot) => chain.state_bytes(slot).map(Answer::ssz),
        None => Ok(Answer::missing("no state for this identifier")),
    }
}

fn finality_update(chain: &SyntheticBeaconChain) -> Result<Answer> {
    let update = chain.finality_update()?;
    Ok(Answer::json(
        &json!({ "data": light_client_update_json(&update) }),
    ))
}

/// The value of `name` in a query string, as a number.
fn query_number(query: &str, name: &str) -> Option<u64> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == name)
        .and_then(|(_, value)| value.parse().ok())
}

fn updates(chain: &SyntheticBeaconChain, query: &str) -> Result<Answer> {
    let (Some(start), Some(count)) = (
        query_number(query, "start_period"),
        query_number(query, "count"),
    ) else {
        return Ok(Answer::with_status(
            400,
            "start_period and count are required",
        ));
    };
    let mut entries = Vec::new();
    for period in start..start.saturating_add(count) {
        let Some(update) = chain.period_update(period)? else {
            continue;
        };
        entries.push(json!({ "data": light_client_update_json(&update) }));
    }
    Ok(Answer::json(&Value::Array(entries)))
}

fn bootstrap(chain: &SyntheticBeaconChain, root: &str) -> Result<Answer> {
    match slot_of_block_id(chain, root) {
        Some(slot) => chain
            .bootstrap_json(slot)
            .map(|data| Answer::json(&json!({ "data": data }))),
        None => Ok(Answer::missing("no header for this root")),
    }
}

#[cfg(test)]
mod tests {
    use super::super::chain::test_support::{chain_of, first_slot_of, settings};
    use super::*;
    use crate::light_client::{update_from_json, ChainKind};

    fn json_of(answer: &Answer) -> Value {
        assert_eq!(
            answer.status,
            200,
            "{}",
            String::from_utf8_lossy(&answer.body)
        );
        serde_json::from_slice(&answer.body).expect("JSON body")
    }

    /// Claim: genesis, the fork schedule and the head header come out in the shapes that a beacon client parses, with the
    /// genesis validators root and the fork versions of the chain specification.
    /// Why it matters: the checkpoint tool reads exactly these answers.
    #[test]
    fn the_chain_describes_itself_as_its_specification() {
        for kind in [ChainKind::Ethereum, ChainKind::Pulsechain] {
            let first_slot = first_slot_of(kind);
            let chain = chain_of(settings(kind, first_slot), 5);
            let genesis = json_of(&answer(&chain, "/eth/v1/beacon/genesis", JSON));
            assert_eq!(
                genesis["data"]["genesis_time"],
                chain.settings().genesis_time.to_string()
            );
            assert_eq!(
                genesis["data"]["genesis_validators_root"],
                format!("{:#x}", kind.spec().genesis_validators_root)
            );
            let schedule = json_of(&answer(&chain, "/eth/v1/config/fork_schedule", JSON));
            let entries = schedule["data"].as_array().unwrap();
            // Like a real node, the schedule lists the scheduled forks only. A fork at the far future epoch is left out.
            let scheduled = kind
                .spec()
                .fork_schedule
                .iter()
                .filter(|entry| entry.epoch != lc_core::chain::FAR_FUTURE_EPOCH)
                .count();
            assert_eq!(entries.len(), scheduled);
            assert_eq!(
                entries[3]["current_version"],
                format!(
                    "0x{}",
                    alloy_primitives::hex::encode(kind.spec().fork_schedule[3].fork_version)
                )
            );
            let head = json_of(&answer(&chain, "/eth/v1/beacon/headers/head", JSON));
            assert_eq!(
                head["data"]["header"]["message"]["slot"],
                (first_slot + 4).to_string()
            );
        }
    }

    /// Claim: `/eth/v1/config/spec` answers with the `*_FORK_VERSION` and `*_FORK_EPOCH` keys of the synthetic chain, and
    /// the prover joins it with the fork schedule of the same chain into the table of the chain specification.
    /// Why it matters: the prover reads the fork schedule from the node, and the local network is the node of the end to end
    /// tests. If it served no specification, those tests would not exercise the new code, or would not run at all.
    #[test]
    fn the_synthetic_beacon_api_serves_the_specification() {
        for kind in [ChainKind::Ethereum, ChainKind::Pulsechain] {
            let chain = chain_of(settings(kind, first_slot_of(kind)), 5);
            let specification = json_of(&answer(&chain, "/eth/v1/config/spec", JSON));
            let schedule = json_of(&answer(&chain, "/eth/v1/config/fork_schedule", JSON));
            let data = &specification["data"];
            for entry in kind.spec().fork_schedule.iter().skip(1) {
                let prefix = format!("{:?}", entry.fork_name).to_uppercase();
                assert_eq!(
                    data[format!("{prefix}_FORK_EPOCH")],
                    entry.epoch.to_string(),
                    "{kind:?} {prefix}"
                );
                assert_eq!(
                    data[format!("{prefix}_FORK_VERSION")],
                    format!("0x{}", alloy_primitives::hex::encode(entry.fork_version)),
                    "{kind:?} {prefix}"
                );
            }
            let joined = crate::fork_schedule::ForkSchedule::from_answers(
                &schedule,
                &specification,
                kind.spec().slots_per_epoch,
            )
            .expect("the two answers of one chain agree");
            assert_eq!(
                joined.signing_version(first_slot_of(kind) + 4),
                kind.spec()
                    .fork_version_at(kind.spec().epoch_at_slot(first_slot_of(kind) + 3))
            );
        }
    }

    /// Claim: a header is found by slot and by root and the two answers agree; an unknown slot, an unknown root and a path
    /// that the node does not serve answer 404; a block is served as SSZ only, and the block root of a slot matches its header.
    #[test]
    fn headers_and_blocks_are_found_by_slot_and_by_root() {
        let kind = ChainKind::Ethereum;
        let first_slot = first_slot_of(kind);
        let chain = chain_of(settings(kind, first_slot), 6);
        let by_slot = json_of(&answer(
            &chain,
            &format!("/eth/v1/beacon/headers/{}", first_slot + 2),
            JSON,
        ));
        let root = by_slot["data"]["root"].as_str().unwrap().to_string();
        let by_root = json_of(&answer(
            &chain,
            &format!("/eth/v1/beacon/headers/{root}"),
            JSON,
        ));
        assert_eq!(by_slot, by_root);
        let block_root = json_of(&answer(
            &chain,
            &format!("/eth/v1/beacon/blocks/{}/root", first_slot + 2),
            JSON,
        ));
        assert_eq!(block_root["data"]["root"], root);

        let missing = |target: &str| answer(&chain, target, JSON).status;
        assert_eq!(missing("/eth/v1/beacon/headers/1"), 404);
        assert_eq!(
            missing(&format!(
                "/eth/v1/beacon/headers/{:#x}",
                B256::repeat_byte(9)
            )),
            404
        );
        assert_eq!(missing("/eth/v1/beacon/blocks/1/root"), 404);
        assert_eq!(missing("/eth/v1/node/version"), 404);
        assert_eq!(
            missing(&format!("/eth/v2/beacon/blocks/{}", first_slot + 2)),
            404,
            "JSON blocks are not served"
        );
        let ssz = answer(&chain, &format!("/eth/v2/beacon/blocks/{root}"), SSZ);
        assert_eq!(ssz.status, 200);
        assert_eq!(ssz.body, chain.block_bytes(first_slot + 2).unwrap());
    }

    /// Claim: the state is served by state root, slot and `head`, as SSZ only, and the bytes are those of the state at that slot.
    #[test]
    fn states_are_found_by_state_root() {
        let kind = ChainKind::Pulsechain;
        let first_slot = first_slot_of(kind);
        let chain = chain_of(settings(kind, first_slot), 4);
        let state_root = chain.header_at(first_slot + 1).unwrap().state_root;
        let served = answer(
            &chain,
            &format!("/eth/v2/debug/beacon/states/{state_root:#x}"),
            SSZ,
        );
        assert_eq!(served.status, 200);
        assert_eq!(served.body, chain.state_bytes(first_slot + 1).unwrap());
        let by_slot = answer(
            &chain,
            &format!("/eth/v2/debug/beacon/states/{}", first_slot + 1),
            SSZ,
        );
        assert_eq!(by_slot.body, served.body);
        assert_eq!(
            answer(&chain, "/eth/v2/debug/beacon/states/head", SSZ).status,
            200
        );
        assert_eq!(
            answer(
                &chain,
                &format!("/eth/v2/debug/beacon/states/{state_root:#x}"),
                JSON
            )
            .status,
            404
        );
        assert_eq!(
            answer(
                &chain,
                &format!("/eth/v2/debug/beacon/states/{:#x}", B256::repeat_byte(3)),
                SSZ
            )
            .status,
            404
        );
    }

    /// Claim: the finality update parses back to the update of the chain, the bootstrap answers for a stored header only,
    /// and the list of handoff updates holds the periods that ended and skips the others.
    #[test]
    fn light_client_endpoints_serve_the_updates_of_the_chain() {
        let kind = ChainKind::Ethereum;
        let first_slot = first_slot_of(kind);
        let chain = chain_of(settings(kind, first_slot), 10);
        let served = json_of(&answer(
            &chain,
            "/eth/v1/beacon/light_client/finality_update",
            JSON,
        ));
        assert_eq!(
            update_from_json(&served["data"]).unwrap(),
            chain.finality_update().unwrap()
        );

        let root = chain.header_root_at(first_slot + 3).unwrap();
        let bootstrap = json_of(&answer(
            &chain,
            &format!("/eth/v1/beacon/light_client/bootstrap/{root:#x}"),
            JSON,
        ));
        assert_eq!(
            bootstrap["data"]["header"]["beacon"]["slot"],
            (first_slot + 3).to_string()
        );
        let unknown = format!(
            "/eth/v1/beacon/light_client/bootstrap/{:#x}",
            B256::repeat_byte(5)
        );
        assert_eq!(answer(&chain, &unknown, JSON).status, 404);

        let period = kind.spec().period_at_slot(first_slot);
        let updates = json_of(&answer(
            &chain,
            &format!("/eth/v1/beacon/light_client/updates?start_period={period}&count=3"),
            JSON,
        ));
        assert!(
            updates.as_array().unwrap().is_empty(),
            "no period has ended yet"
        );
        assert_eq!(
            answer(&chain, "/eth/v1/beacon/light_client/updates", JSON).status,
            400
        );
    }
}
