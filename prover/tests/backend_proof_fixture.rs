//! Writes `test/hardened/fixtures/sp1-proof-sepolia-update.json`: a real Groth16 proof that the testnet backend made of
//! the current light-client program, and the statement it proves.
//!
//! The backend proves Sepolia updates for the light client on PulseChain testnet v4 every hour, on a GPU worker. It stores
//! the proof (program key, public values, proof bytes) but not the program input. A Groth16 proof binds the public values
//! only, so any input whose native run gives the same public values is a statement of the proof. This writer rebuilds such
//! an input with the prover's own beacon source, from the stored head of the proof to its new head:
//!
//! - the store at the head comes from the beacon state of the head (the backend's state store keeps it);
//! - the update is a finality update that the beacon node served while the new head of the proof was its finalized
//!   checkpoint (`ZKB_FIXTURE_FINALITY_UPDATE`, captured at the time), and the branch of `genesis_validators_root` comes
//!   from its attested state (captured with it, in the state directory). The prover cannot assemble a Gloas update from
//!   blocks, and a node serves a finality update only while its checkpoint is the newest, so the update must be captured
//!   while the backend proves.
//!
//! The writer then checks that the native public values equal the backend's public values byte for byte and that the
//! proof verifies under the program key, and only then writes the fixture.
//!
//! Run (ignored; it needs a Sepolia beacon node and execution node and a copy of the backend's beacon states):
//!
//! ```text
//! ZKB_FIXTURE_BEACON_URL=<sepolia beacon API> ZKB_FIXTURE_RPC_URL=<sepolia execution RPC> \
//! ZKB_FIXTURE_STATE_DIR=<dir holding 11155111/<slot>-<root>.ssz> ZKB_FIXTURE_PROOF=<archived proof record JSON> \
//! ZKB_FIXTURE_FINALITY_UPDATE=<the captured finality update JSON> \
//! cargo test --release --test backend_proof_fixture -- --ignored --nocapture
//! ```
//!
//! The archived proof record is a light-client proof record of the proof archive (`docs/proof-archive.md`): it carries
//! `programKey`, `publicValues`, `proof`, `startSlot`, `startRoot` and `newSlot`.

use alloy_primitives::{hex, B256};
use std::str::FromStr;
use std::sync::Arc;
use zk_bridge_prover::beacon::http::{HttpBeaconSource, RpcExecutionHeaders};
use zk_bridge_prover::beacon::state_store::DirectoryStateStore;
use zk_bridge_prover::beacon::StoredHead;
use zk_bridge_prover::light_client::{
    guest_input_bytes, public_values, verify_update_natively, ChainKind,
};
use zk_bridge_prover::rpc::{HttpClient, HttpGet, HttpResponse, HttpRpc};

/// A beacon client that serves the captured finality update, as the node did when the backend proved.
struct WithCapturedUpdate {
    inner: HttpClient,
    finality_update: Vec<u8>,
}

impl HttpGet for WithCapturedUpdate {
    fn get(&self, path: &str, accept: &str) -> zk_bridge_prover::error::Result<HttpResponse> {
        match path {
            "/eth/v1/beacon/light_client/finality_update" => Ok(HttpResponse {
                status: 200,
                body: self.finality_update.clone(),
            }),
            _ => self.inner.get(path, accept),
        }
    }
}

fn variable(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name}"))
}

#[test]
#[ignore = "writes the fixture: needs a Sepolia beacon node, an execution node and the backend's beacon states"]
fn write_the_backend_proof_fixture() {
    let record: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(variable("ZKB_FIXTURE_PROOF")).unwrap())
            .unwrap();
    let text = |name: &str| {
        record[name]
            .as_str()
            .unwrap_or_else(|| panic!("the record lacks {name}"))
            .to_string()
    };
    let program_key = B256::from_str(&text("programKey")).unwrap();
    let backend_values = hex::decode(text("publicValues")).unwrap();
    let proof = hex::decode(text("proof")).unwrap();
    let start_slot: u64 = text("startSlot").parse().unwrap();
    let new_slot: u64 = text("newSlot").parse().unwrap();
    // The fifth word of the public values is the next committee hash that the light client held at the start.
    let start_next_committee = B256::from_slice(&backend_values[4 * 32..5 * 32]);
    let head = StoredHead {
        slot: start_slot,
        root: B256::from_str(&text("startRoot")).unwrap(),
        next_committee_hash: start_next_committee,
    };

    let beacon_url = variable("ZKB_FIXTURE_BEACON_URL");
    let source = HttpBeaconSource::new(
        ChainKind::Sepolia,
        Box::new(WithCapturedUpdate {
            inner: HttpClient::new(&beacon_url),
            finality_update: std::fs::read(variable("ZKB_FIXTURE_FINALITY_UPDATE")).unwrap(),
        }),
    )
    .with_execution_headers(Box::new(RpcExecutionHeaders::new(Box::new(HttpRpc::new(
        &variable("ZKB_FIXTURE_RPC_URL"),
    )))))
    .with_state_store(Arc::new(DirectoryStateStore::new(
        variable("ZKB_FIXTURE_STATE_DIR"),
        11_155_111,
    )));

    let plan = source
        .plan_update(&head)
        .expect("the plan")
        .expect("the head is behind");
    assert_eq!(
        plan.latest_finalized_slot, new_slot,
        "the assembled update finalizes the new head of the proof"
    );
    let native =
        public_values(&verify_update_natively(&plan.input).expect("the program accepts the input"));
    assert_eq!(
        hex::encode(&native),
        hex::encode(&backend_values),
        "native public values equal the backend's"
    );
    zk_bridge_prover::remote::verify_groth16(program_key, &backend_values, &proof)
        .expect("the proof verifies");

    let fixture = serde_json::json!({
        "description": "A real Groth16 proof of the light-client program, made by the testnet backend on a GPU worker for \
            the Sepolia to PulseChain testnet v4 route, and an input whose native run gives its public values. The input \
            was rebuilt by prover/tests/backend_proof_fixture.rs from a Sepolia finality update captured while the backend \
            proved, its attested state, and the backend's stored state of the start head.",
        "chain": "sepolia",
        "startSlot": start_slot.to_string(),
        "newSlot": new_slot.to_string(),
        "postedChainId": record["postedChainId"],
        "postedTransactionHash": record["postedTransactionHash"],
        "programVKey": format!("{program_key:#x}"),
        "publicValues": hex::encode_prefixed(&backend_values),
        "proof": hex::encode_prefixed(&proof),
        "guestInput": hex::encode_prefixed(guest_input_bytes(&plan.input)),
    });
    let path = format!(
        "{}/../test/hardened/fixtures/sp1-proof-sepolia-update.json",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&fixture).unwrap() + "\n",
    )
    .unwrap();
    println!(
        "wrote the fixture: {} steps, {} input bytes",
        plan.input.steps.len(),
        guest_input_bytes(&plan.input).len()
    );
}
