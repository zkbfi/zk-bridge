//! Test support for `lc-core`: fixture loaders, synthetic builders, a receipts trie builder and a parser for real
//! PulseChain beacon data. The integration tests of the light-client crate live in `tests/`.

pub mod block_bytes;
pub mod derive_support;
pub mod fixture_set;
pub mod fork_observation_scenarios;
pub mod json;
/// The sources of the `lc-message` crate (`light-client/lc-message`): the message proof with the fork proof of the source
/// state, and `verify_message`. The test kit compiles the files itself instead of depending on the crate, because a new
/// dependency would change `lc-testkit/Cargo.toml` and `Cargo.lock`, which are inputs of the guest program keys
/// (`scripts/program-keys.sh`). Its unit tests run here, in the light-client workspace.
#[path = "../../../lc-message/src/lib.rs"]
pub mod lc_message;
pub mod message_blocks;
pub mod pulsechain;
pub mod real_proofs;
pub mod receipts;
pub mod ssz_state;
pub mod state_bytes;
pub mod synthetic;
pub mod tree_model;
