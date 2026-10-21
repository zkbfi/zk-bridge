//! SP1 guest: verifies an optional fold of up to 64 light-client updates, then one fork observation (a sync aggregate
//! over a header root under a fork version that the prover names), and commits the ABI-encoded `ForkObservation`
//! (224 bytes).
//!
//! It is a separate program with its own verification key, so a `ForkObservation` proof can never pass as a
//! `LightClientOutput` proof, and the reverse. The body is `lc_core::wire::run_fork_observation_guest`, which native
//! tests in `lc-testkit` run. This wrapper only moves bytes in and out of the zkVM.
//! A failed check panics, so no proof exists for an invalid observation.

#![no_main]
sp1_zkvm::entrypoint!(main);

pub fn main() {
    let input = sp1_zkvm::io::read_vec();
    let public_values = lc_core::wire::run_fork_observation_guest(&input).expect("fork observation must verify");
    sp1_zkvm::io::commit_slice(&public_values);
}
