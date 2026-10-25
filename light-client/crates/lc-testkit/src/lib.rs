//! Test support for `lc-core`: fixture loaders, synthetic builders, a receipts trie builder and a parser for real
//! PulseChain beacon data. The integration tests of the light-client crate live in `tests/`.

pub mod block_bytes;
pub mod derive_support;
pub mod fixture_set;
pub mod fork_observation_scenarios;
pub mod json;
pub mod message_blocks;
pub mod pulsechain;
pub mod receipts;
pub mod ssz_state;
pub mod state_bytes;
pub mod synthetic;
