//! The `checkpoint` command against the synthetic signed beacon chain, wrapped to look like a public node.
//!
//! The wrapper adds what the synthetic node lacks (`config/spec` and the `finalized` header id) and can hide the
//! light-client routes, as the node of PulseChain testnet v4 does. A fake node that answers for Sepolia in a Gloas slot
//! checks the refusal.

mod common;

use alloy_primitives::B256;
use common::*;
use serde_json::{json, Value};
use std::sync::Mutex;
use zk_bridge_prover::checkpoint::{build_checkpoint, CheckpointSource};
use zk_bridge_prover::error::{Error, Result};
use zk_bridge_prover::light_client::{committee_hash, ChainKind, StateView};
use zk_bridge_prover::rpc::{HttpGet, HttpResponse};

/// How the wrapped node differs from the synthetic one.
#[derive(Clone, Copy, Default)]
struct Hide {
    light_client: bool,
    state: bool,
}

struct PublicNode<'a> {
    chain: &'a Chain,
    hide: Hide,
    requests: Mutex<Vec<String>>,
}

fn answer(status: u16, body: Value) -> Result<HttpResponse> {
    Ok(HttpResponse {
        status,
        body: body.to_string().into_bytes(),
    })
}

impl HttpGet for PublicNode<'_> {
    fn get(&self, path: &str, accept: &str) -> Result<HttpResponse> {
        self.requests.lock().unwrap().push(path.to_string());
        let spec = self.chain.kind.spec();
        if path == "/eth/v1/config/spec" {
            let capella = spec.capella_fork_slot().unwrap() / spec.slots_per_epoch;
            return answer(
                200,
                json!({"data": {
                    "SECONDS_PER_SLOT": spec.seconds_per_slot.to_string(),
                    "SLOTS_PER_EPOCH": spec.slots_per_epoch.to_string(),
                    "CAPELLA_FORK_EPOCH": capella.to_string(),
                }}),
            );
        }
        if self.hide.light_client && path.contains("/light_client/") {
            return answer(404, json!({"message": "not served"}));
        }
        if self.hide.state && path.contains("/debug/beacon/states/") {
            return answer(404, json!({"message": "not served"}));
        }
        if path == "/eth/v1/beacon/headers/finalized" {
            let head = self.chain.node.get("/eth/v1/beacon/headers/head", accept)?;
            let head: Value = serde_json::from_slice(&head.body).unwrap();
            let slot: u64 = head["data"]["header"]["message"]["slot"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap();
            return self
                .chain
                .node
                .get(&format!("/eth/v1/beacon/headers/{}", slot - 3), accept);
        }
        self.chain.node.get(path, accept)
    }
}

fn public_node(chain: &Chain, hide: Hide) -> PublicNode<'_> {
    PublicNode {
        chain,
        hide,
        requests: Mutex::new(Vec::new()),
    }
}

fn state_of_the_checkpoint(chain: &Chain, root: B256) -> StateView {
    let header = chain
        .node
        .get(
            &format!("/eth/v1/beacon/headers/{root:#x}"),
            "application/json",
        )
        .unwrap();
    let header: Value = serde_json::from_slice(&header.body).unwrap();
    let state_root = header["data"]["header"]["message"]["state_root"]
        .as_str()
        .unwrap();
    let bytes = chain
        .node
        .get(
            &format!("/eth/v2/debug/beacon/states/{state_root}"),
            "application/octet-stream",
        )
        .unwrap();
    StateView::parse(&bytes.body, chain.kind).unwrap()
}

/// Claim: on a node that does not serve the light-client routes, the command builds all four values from the finalized
/// state, and the committee hashes are those of that state. The root, the slot and the committees belong together.
/// Why it matters: the deploy writes the four values into one contract. Values from two different roots would make the
/// first update fail.
#[test]
fn a_node_without_light_client_routes_gives_the_values_of_the_finalized_state() {
    for kind in [ChainKind::PulsechainTestnetV4, ChainKind::Sepolia] {
        let chain = Chain::new(kind, BLOCKS_BEFORE_CHECKPOINT);
        let node = public_node(
            &chain,
            Hide {
                light_client: true,
                state: false,
            },
        );
        let report = build_checkpoint(&node, kind, None).expect("checkpoint");
        assert_eq!(report.source, CheckpointSource::DebugState);
        let state = state_of_the_checkpoint(&chain, report.initial_header_root);
        assert_eq!(report.initial_slot, state.slot());
        assert_eq!(
            report.initial_sync_committee_hash,
            committee_hash(state.current_committee()).unwrap()
        );
        assert_eq!(
            report.initial_next_sync_committee_hash,
            committee_hash(state.next_committee()).unwrap()
        );
        assert_ne!(
            report.initial_sync_committee_hash,
            report.initial_next_sync_committee_hash
        );
        assert!(report.next_committee_known);
        let json = report.to_json();
        assert_eq!(json["chain"], kind.name());
        assert_eq!(json["secondsPerSlot"], kind.seconds_per_slot());
        assert_eq!(
            json["genesisValidatorsRoot"],
            format!("{:#x}", kind.spec().genesis_validators_root)
        );
        assert_eq!(json["capellaEra"], kind.spec().capella_era().unwrap());
        assert_eq!(json["genesisTime"], report.genesis_time);
        assert_eq!(json["nextCommitteeKnown"], true);
    }
}

/// Claim: when the bootstrap route answers, its committee branch is checked and the values equal those of the state path.
/// A bootstrap whose committee is changed is refused. When the state is also missing, the next hash is zero and
/// `nextCommitteeKnown` is false.
#[test]
fn the_bootstrap_route_gives_the_same_values_and_its_branch_is_checked() {
    let kind = ChainKind::Ethereum;
    let chain = Chain::new(kind, BLOCKS_BEFORE_CHECKPOINT);
    let from_state = build_checkpoint(
        &public_node(
            &chain,
            Hide {
                light_client: true,
                state: false,
            },
        ),
        kind,
        None,
    )
    .expect("state path");
    let from_bootstrap = build_checkpoint(&public_node(&chain, Hide::default()), kind, None)
        .expect("bootstrap path");
    assert_eq!(from_bootstrap.source, CheckpointSource::Bootstrap);
    assert_eq!(
        (
            from_bootstrap.initial_slot,
            from_bootstrap.initial_header_root
        ),
        (from_state.initial_slot, from_state.initial_header_root)
    );
    assert_eq!(
        from_bootstrap.initial_sync_committee_hash,
        from_state.initial_sync_committee_hash
    );
    assert_eq!(
        from_bootstrap.initial_next_sync_committee_hash,
        from_state.initial_next_sync_committee_hash
    );

    let no_state = build_checkpoint(
        &public_node(
            &chain,
            Hide {
                light_client: false,
                state: true,
            },
        ),
        kind,
        None,
    )
    .expect("bootstrap without state");
    assert!(!no_state.next_committee_known);
    assert_eq!(no_state.initial_next_sync_committee_hash, B256::ZERO);
    assert_eq!(no_state.to_json()["nextCommitteeKnown"], false);
    assert_eq!(
        no_state.initial_sync_committee_hash,
        from_state.initial_sync_committee_hash
    );

    struct FlippedBranch<'a>(PublicNode<'a>);
    impl HttpGet for FlippedBranch<'_> {
        fn get(&self, path: &str, accept: &str) -> Result<HttpResponse> {
            let mut response = self.0.get(path, accept)?;
            if path.contains("/light_client/bootstrap/") {
                let mut body: Value = serde_json::from_slice(&response.body).unwrap();
                body["data"]["current_sync_committee_branch"][0] =
                    json!(format!("0x{}", "11".repeat(32)));
                response.body = body.to_string().into_bytes();
            }
            Ok(response)
        }
    }
    let error = build_checkpoint(
        &FlippedBranch(public_node(&chain, Hide::default())),
        kind,
        None,
    )
    .expect_err("a flipped branch");
    assert!(matches!(error, Error::VerificationRefused(_)), "{error}");
}

/// Claim: a root that the user names is used for every value, and a root that the node does not hold is refused.
#[test]
fn a_named_root_fixes_every_value() {
    let kind = ChainKind::PulsechainTestnetV4;
    let chain = Chain::new(kind, BLOCKS_BEFORE_CHECKPOINT);
    let node = public_node(
        &chain,
        Hide {
            light_client: true,
            state: false,
        },
    );
    let newest = build_checkpoint(&node, kind, None).expect("newest");
    let again = build_checkpoint(&node, kind, Some(newest.initial_header_root)).expect("named");
    assert_eq!(newest, again);
    assert!(build_checkpoint(&node, kind, Some(B256::repeat_byte(7))).is_err());
}

/// A node that answers for Sepolia in a Gloas slot with REAL data: the finalized header of a Sepolia beacon node and the
/// SSZ state of that header (`light-client/tests/fixtures/sepolia/`, fetched 2026-10-26). It serves no light-client
/// route, like the nodes of the testnets. It records every request.
struct GloasNode {
    requests: Mutex<Vec<String>>,
    header: Value,
    state: Vec<u8>,
}

fn light_client_fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../light-client/tests/fixtures/sepolia")
}

impl GloasNode {
    fn real() -> Self {
        let update: Value = serde_json::from_slice(
            &std::fs::read(light_client_fixtures().join("gloas_head_finality_update.json"))
                .unwrap(),
        )
        .unwrap();
        let state = std::fs::read(light_client_fixtures().join("gloas_head_state.ssz")).unwrap();
        Self {
            requests: Mutex::new(Vec::new()),
            header: update["response"]["data"]["finalized_header"]["beacon"].clone(),
            state,
        }
    }
}

impl HttpGet for GloasNode {
    fn get(&self, path: &str, _accept: &str) -> Result<HttpResponse> {
        self.requests.lock().unwrap().push(path.to_string());
        let spec = ChainKind::Sepolia.spec();
        match path {
            "/eth/v1/beacon/genesis" => answer(
                200,
                json!({"data": {
                    "genesis_time": "1655733600",
                    "genesis_validators_root": format!("{:#x}", spec.genesis_validators_root),
                }}),
            ),
            "/eth/v1/config/spec" => answer(
                200,
                json!({"data": {
                    "SECONDS_PER_SLOT": "12", "SLOTS_PER_EPOCH": "32", "CAPELLA_FORK_EPOCH": "56832",
                }}),
            ),
            "/eth/v1/beacon/headers/finalized" => answer(
                200,
                json!({"finalized": true, "data": {"header": {"message": self.header}}}),
            ),
            _ if path.starts_with("/eth/v1/beacon/light_client/") => {
                answer(404, json!({"message": "not served"}))
            }
            _ if path.starts_with("/eth/v2/debug/beacon/states/") => Ok(HttpResponse {
                status: 200,
                body: self.state.clone(),
            }),
            _ => panic!("unexpected request {path}"),
        }
    }
}

/// Claim: for Sepolia in a Gloas slot the command builds the checkpoint from the REAL finalized state, hashed in full
/// with the Gloas layout and compared with the state root of the header. The committee hashes are those of the
/// committees in that state, and the node was asked for the state of the header root and nothing else (no Capella
/// parse of a Gloas state). Control: a state with one flipped byte is refused because it does not hash to the header.
#[test]
fn sepolia_in_a_gloas_slot_builds_a_checkpoint_from_the_real_state() {
    let node = GloasNode::real();
    let report = build_checkpoint(&node, ChainKind::Sepolia, None).expect("a Gloas checkpoint");
    assert_eq!(report.source, CheckpointSource::DebugState);
    let state = StateView::parse(&node.state, ChainKind::Sepolia).expect("the real state");
    assert_eq!(report.initial_slot, state.slot());
    assert_eq!(
        report.initial_sync_committee_hash,
        committee_hash(state.current_committee()).unwrap()
    );
    assert_eq!(
        report.initial_next_sync_committee_hash,
        committee_hash(state.next_committee()).unwrap()
    );
    assert!(report.next_committee_known);
    assert_ne!(
        report.initial_sync_committee_hash,
        report.initial_next_sync_committee_hash
    );

    let mut broken = GloasNode::real();
    *broken.state.last_mut().unwrap() ^= 1;
    let error = build_checkpoint(&broken, ChainKind::Sepolia, None).expect_err("a broken state");
    assert!(error.to_string().contains("hashes to"), "{error}");
}

/// Claim: a node of another chain is refused by its genesis validators root.
#[test]
fn a_node_of_another_chain_is_refused() {
    let chain = Chain::new(ChainKind::Pulsechain, BLOCKS_BEFORE_CHECKPOINT);
    let node = public_node(&chain, Hide::default());
    let error = build_checkpoint(&node, ChainKind::PulsechainTestnetV4, None).expect_err("refused");
    assert!(
        error.to_string().contains("genesis validators root"),
        "{error}"
    );
}
