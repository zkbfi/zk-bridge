//! The branch of `genesis_validators_root` for real updates whose attested state is on file.
//!
//! A beacon node does not serve the branch of `genesis_validators_root` (state field 1). It comes from the attested state
//! itself. The attested state of the real PulseChain update is on file, and `pulsechain/light_client_update.json` carries
//! its branch. For the real Ethereum and Sepolia updates only the FINALIZED state is on file (Sepolia) or no state at all
//! (Ethereum), and a branch of field 1 is a branch under ONE state root, so no branch can be computed offline.
//!
//! The files `ethereum/state_proofs.json` and `sepolia/state_proofs.json` hold such branches once someone fetches the
//! attested states and runs `derive-attested-state-proofs`. Each file maps an attested state root to the branch. This
//! module attaches a branch when the file holds one for the update, and says so. A test then runs the whole check. When no
//! branch is on file, [`assert_stops_at_the_missing_branch`] pins what the program does instead, so the real update still
//! proves that every check before the genesis validators root branch passes on real data.

use crate::json::{branch, fixtures_dir};
use alloy_primitives::B256;
use lc_core::chain::ChainSpec;
use lc_core::types::{LightClientStore, LightClientUpdate};
use lc_core::update::verify_light_client_update_with_fork_version;
use lc_core::Error;

/// The files that hold fetched branches, relative to the fixture directory.
pub const STATE_PROOF_FILES: [&str; 2] = ["ethereum/state_proofs.json", "sepolia/state_proofs.json"];

/// The branch of `genesis_validators_root` under `attested_state_root`, when a state proof file holds one.
pub fn known_genesis_validators_root_branch(attested_state_root: &B256) -> Option<Vec<B256>> {
    let key = format!("{attested_state_root:#x}");
    STATE_PROOF_FILES.iter().find_map(|file| {
        let text = std::fs::read_to_string(fixtures_dir().join(file)).ok()?;
        let wrapper: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|error| panic!("{file}: {error}"));
        let entry = wrapper["response"].get(&key)?;
        Some(branch(entry))
    })
}

/// The update with the known branch attached. An update without a known branch is returned unchanged, with an empty branch.
pub fn with_known_branch(update: LightClientUpdate) -> LightClientUpdate {
    match known_genesis_validators_root_branch(&update.attested_header.beacon.state_root) {
        Some(branch) => update.with_genesis_validators_root_branch(branch),
        None => update,
    }
}

/// Whether the update carries a branch of `genesis_validators_root`.
pub fn has_branch(update: &LightClientUpdate) -> bool {
    !update.genesis_validators_root_branch.is_empty()
}

/// Pins the program behaviour for a real update that has no branch of `genesis_validators_root`: the finality branch, the
/// next committee branch, the header checks and the participation rule all pass, and the program stops with
/// `InvalidGenesisValidatorsRootBranch` before it reads the signature. Returns nothing. The caller then stops its own
/// checks, because the rest of the update is out of reach without the branch.
///
/// # Panics
/// Panics when the update has a branch (the caller must run the full check then) or when the result is another error.
pub fn assert_stops_at_the_missing_branch(
    store: &LightClientStore,
    update: &LightClientUpdate,
    spec: &ChainSpec,
    fork_version: [u8; 4],
) {
    assert!(!has_branch(update), "the update has a branch: run the full check");
    assert_eq!(
        verify_light_client_update_with_fork_version(store, update, spec, fork_version),
        Err(Error::InvalidGenesisValidatorsRootBranch),
        "a real update without the branch of genesis_validators_root passes every earlier check and stops here"
    );
}
