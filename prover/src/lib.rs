//! The proof producer of the hardened bridge.
//!
//! The crate makes proofs and hands them to other servers. It keeps no state, holds no wallet and sends no transaction.
//! Anyone can run it: every proof is checked on chain, so a faulty or hostile producer can only fail to deliver, never
//! steal.
//!
//! The pieces:
//!
//! - [`config`]: TOML configuration, environment overrides, validation.
//! - [`produce`]: one run of the producer: fetch the updates, run the program natively, get the proof, check it.
//! - [`handoff`]: the proof package, and its delivery to standard output and a webhook.
//! - [`evidence`]: the withdrawal evidence builder: a deposit in, the calldata of `BridgeVault.withdraw` out.
//! - [`stored`]: what the destination light client stores, read with view calls and logs.
//! - [`rpc`] and [`chain`]: a small JSON-RPC client and a read-only client for one chain.
//! - [`light_client`]: the only module that calls `lc-core`.
//! - [`prover`]: the proving backends. Only light-client updates (and fork observations, for a worker) are proven.
//! - [`remote`]: the backend that sends a proof job to a GPU worker and checks the answer.
//! - [`worker`]: the HTTP server that such a worker runs (`docs/gpu-prover.md`).
//! - [`beacon`]: the beacon node source for updates and for the beacon part of a withdrawal.
//! - `local_network` (feature `signed-beacon`): a beacon chain over local blocks with real signatures, for tests.
//! - [`cli`]: the commands `prove` and `evidence`.

pub mod beacon;
pub mod chain;
pub mod cli;
pub mod config;
pub mod contracts;
pub mod error;
pub mod evidence;
pub mod handoff;
pub mod light_client;
#[cfg(feature = "signed-beacon")]
pub mod local_network;
pub mod logging;
pub mod produce;
pub mod prover;
pub mod remote;
pub mod rpc;
pub mod signer;
pub mod stored;
pub mod worker;
