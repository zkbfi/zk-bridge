//! A signed local beacon chain for tests and for the end-to-end run with real proofs (`docs/end-to-end-real-proofs.md`).
//!
//! Anvil has no beacon chain, and a real SP1 proof needs one: the light-client program verifies a BLS signature of a sync
//! committee. This module builds a beacon chain over the blocks of an Anvil chain whose committee signs for real (BLS, the
//! Boneh-Lynn-Shacham signature scheme of the beacon chain), and serves
//! it over the standard beacon API. The producer then reads it with `HttpBeaconSource`, the code that reads a live node.
//!
//! - [`chain`]: the chain itself, a pure function of the execution blocks (headers, states, signed blocks, updates).
//! - [`api`]: the endpoints, answered from a chain.
//! - [`node`]: the HTTP server that follows an execution chain.
//! - [`checkpoint`]: reads the checkpoint of a light client contract from a node.
//!
//! The module is development only (cargo feature `signed-beacon`). The committees are made from a label, so their secret keys
//! are public.

pub mod api;
pub mod chain;
pub mod checkpoint;
pub mod node;
