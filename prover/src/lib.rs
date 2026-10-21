//! The prover service of the hardened bridge.
//!
//! The service holds no trusted role. Every transaction it sends is checked on chain, so a faulty or hostile
//! prover can only fail to deliver, never steal. Anyone can run one.
//!
//! The pieces:
//!
//! - [`config`]: TOML configuration, environment overrides, validation.
//! - [`signer`]: a Foundry keystore, or an environment variable for local Anvil, and transaction signing.
//! - [`rpc`] and [`chain`]: a small JSON-RPC client and a client for one chain.
//! - [`light_client`]: the only module that calls `lc-core` (and, for the development source only, `lc-testkit`).
//! - [`gate`]: evidence for the deposit gate of a vault.
//! - [`fork_observation`]: proves a fork observation and sends it to the `ForkRegistry`.
//! - [`prover`]: the proving backends. Only light-client updates are proven.
//! - [`beacon`]: where beacon data comes from (a beacon node, or a depth rule on Anvil).
//! - [`store`] and [`state`]: the SQLite file and the deposit state machine.
//! - [`route_health`]: decides whether a route still delivers a deposit made now (finding HB-02, window 2).
//! - `local_network` (feature `dev-source`): bots and a beacon stub for the local network in `docker/`.
//! - [`service`]: the loop that moves a deposit from its first sight to its withdrawal.

pub mod beacon;
pub mod chain;
pub mod cli;
pub mod config;
pub mod contracts;
pub mod error;
pub mod fork_observation;
pub mod gate;
pub mod light_client;
#[cfg(feature = "dev-source")]
pub mod local_network;
pub mod logging;
pub mod prover;
pub mod route;
pub mod route_health;
pub mod rpc;
pub mod service;
pub mod signer;
pub mod state;
pub mod store;
pub mod transaction;
