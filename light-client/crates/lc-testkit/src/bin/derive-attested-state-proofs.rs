//! Derives the branch of `genesis_validators_root` for real updates, from their attested states.
//!
//! Usage: `derive-attested-state-proofs <chain> <output-file> <fetched-on> <state.ssz>...` where `<chain>` is `ethereum` or
//! `sepolia`. Each state file is a serialized `BeaconState` served by a beacon node (`GET /eth/v2/debug/beacon/states/<root>` with
//! `Accept: application/octet-stream`). It must be the ATTESTED state of an update: the one whose root is the `state_root`
//! of the attested header. The tool parses each state in the layout of its fork, checks that field 1 holds the
//! `genesis_validators_root` of the chain, and writes `{ "<state root>": [branch] }` in the fixture wrapper.

use lc_core::chain::{ChainSpec, ETHEREUM_MAINNET, SEPOLIA};
use lc_core::ssz_state::{state_slot, try_parse_state_for_fork};
use lc_testkit::derive_support::{hex_list, write_fixture};
use serde_json::{Map, Value};
use std::path::Path;

/// Field index of `genesis_validators_root` in every `BeaconState`.
const FIELD_GENESIS_VALIDATORS_ROOT: usize = 1;

fn chain_spec(name: &str) -> &'static ChainSpec {
    match name {
        "ethereum" => &ETHEREUM_MAINNET,
        "sepolia" => &SEPOLIA,
        other => panic!("unknown chain {other}: use ethereum or sepolia"),
    }
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    assert!(
        arguments.len() >= 5,
        "usage: derive-attested-state-proofs <chain> <output-file> <fetched-on> <state.ssz>..."
    );
    let spec = chain_spec(&arguments[1]);
    let output = Path::new(&arguments[2]);
    let mut entries = Map::new();
    for state_file in &arguments[4..] {
        let bytes = std::fs::read(state_file).unwrap_or_else(|error| panic!("{state_file}: {error}"));
        let slot = state_slot(&bytes).expect("a slot");
        let state = try_parse_state_for_fork(&bytes, spec.fork_at_slot(slot)).expect("the state parses");
        assert_eq!(
            state.field_roots[FIELD_GENESIS_VALIDATORS_ROOT], spec.genesis_validators_root,
            "{state_file}: field 1 is not the genesis validators root of the chain"
        );
        let branch = state.field_branch(FIELD_GENESIS_VALIDATORS_ROOT);
        entries.insert(format!("{:#x}", state.root()), hex_list(&branch));
        println!("{state_file}: slot {slot}, root {:#x}, branch of {} entries", state.root(), branch.len());
    }
    let directory = output.parent().expect("an output directory");
    let name = output.file_name().and_then(|name| name.to_str()).expect("an output file name");
    let source =
        format!("derived from serialized attested states (GET /eth/v2/debug/beacon/states/<root>) of {}", arguments[1]);
    write_fixture(directory, name, &source, &arguments[3], Value::Object(entries));
}
