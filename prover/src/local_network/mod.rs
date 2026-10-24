//! Test tools for runs with a beacon chain. They are for development only.
//!
//! The whole module is behind the cargo feature `signed-beacon`, and nothing in the production commands calls it. A build
//! with `--no-default-features` leaves it out.
//!
//! - [`signed_beacon`]: a beacon chain over local execution blocks with real sync committee signatures, for runs with real
//!   proofs.

pub mod signed_beacon;
