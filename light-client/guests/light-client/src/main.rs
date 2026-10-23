//! SP1 guest: verifies a fold of 1 to 64 Ethereum or PulseChain light-client updates and commits the ABI-encoded
//! `LightClientOutput` (352 bytes).
//!
//! The body is `lc_core::wire::run_light_client_guest`, which native tests in `lc-testkit` run on real updates
//! (`real_updates_run_through_the_guest_entry_point`) and on synthetic folds (`synthetic_guest_entry_point_runs_a_fold`). This wrapper only moves bytes in and out of the zkVM.
//! A failed check panics, so no proof exists for an invalid update.

#![no_main]
sp1_zkvm::entrypoint!(main);

pub fn main() {
    let input = sp1_zkvm::io::read_vec();
    // Profiling builds read a second buffer: the label of the section that runs twice (see `lc_core::profile`).
    #[cfg(feature = "section-profile")]
    lc_core::profile::repeat_section(String::from_utf8(sp1_zkvm::io::read_vec()).expect("the label is text"));
    let public_values = lc_core::wire::run_light_client_guest(&input).expect("light-client update must verify");
    sp1_zkvm::io::commit_slice(&public_values);
}
