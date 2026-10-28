//! The beacon API JSON of a synthetic update reads back to the same update.

use lc_core::chain::{ETHEREUM_MAINNET, PULSECHAIN};
use lc_testkit::json::{light_client_update, light_client_update_json};
use lc_testkit::synthetic::{build_update, UpdateRecipe};

/// Claim: the JSON that `light_client_update_json` writes parses back to the update it came from, with a next committee
/// (Deneb and later execution form on Ethereum, Capella form on PulseChain) and without one (a finality update).
/// The branch of `genesis_validators_root` is not part of the beacon API, so the JSON has no key for it and the parser
/// returns an empty branch. The prover adds it from the state.
/// Why it matters: tests serve this JSON from a fake beacon node. A writer that lost a field would make the prover read
/// another update than the test built, and the test would prove less than it claims.
#[test]
fn update_json_round_trips() {
    for (spec, start) in [(&ETHEREUM_MAINNET, 1889 * 8192), (&PULSECHAIN, 1326 * 8192)] {
        for include_next_committee in [true, false] {
            let recipe = UpdateRecipe {
                store_slot: start + 400,
                finalized_slot: start + 1000,
                attested_slot: start + 1070,
                signature_slot: start + 1071,
                participants: 342,
                include_next_committee,
                store_knows_next_committee: false,
            };
            let update = build_update(spec, recipe).update;
            let data = light_client_update_json(&update);
            assert_eq!(data.get("next_sync_committee").is_some(), include_next_committee, "{}", spec.name);
            assert!(!update.genesis_validators_root_branch.is_empty(), "{}: the scenario holds the branch", spec.name);
            let without_branch = update.clone().with_genesis_validators_root_branch(Vec::new());
            assert_eq!(light_client_update(&data), without_branch, "{}", spec.name);
        }
    }
}
