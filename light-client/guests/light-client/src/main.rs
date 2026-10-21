//! SP1 guest: verifies one Ethereum or PulseChain light-client update and commits the ABI-encoded `LightClientOutput`.
//!
//! The body is `lc_core::wire::run_light_client_guest`, which native tests in `lc-testkit` run on real updates
//! (`real_updates_run_through_the_guest_entry_point`). This wrapper only moves bytes in and out of the zkVM.
//! A failed check panics, so no proof exists for an invalid update.

#![no_main]
sp1_zkvm::entrypoint!(main);

pub fn main() {
    let input = sp1_zkvm::io::read_vec();
    let public_values = lc_core::wire::run_light_client_guest(&input).expect("light-client update must verify");
    sp1_zkvm::io::commit_slice(&public_values);
}
