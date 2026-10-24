//! Tools for the local two-chain network in `docker/`. They are for development only.
//!
//! The whole module is behind the cargo feature `dev-source`, like the development beacon source, and nothing in the
//! production `run` path calls it. A build with `--no-default-features` leaves it out.
//!
//! - [`deployment`]: reads the JSON file that the deploy step writes.
//! - [`synthetic_fork`]: gate evidence for a local chain that has no beacon node.
//! - [`traffic`]: bots that deposit tokens in both directions and watch the withdrawals.
//! - [`beacon_stub`]: a small HTTP server that answers the three beacon requests that `route-health` makes.
//! - [`signed_beacon`]: a beacon chain over the Anvil blocks with real sync committee signatures, for runs with real proofs.

pub mod beacon_stub;
pub mod deployment;
pub mod signed_beacon;
pub mod synthetic_fork;
pub mod traffic;
