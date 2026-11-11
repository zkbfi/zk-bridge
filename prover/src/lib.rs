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
//! - [`fork_observation`]: one run of the fork observation producer, for the `ForkRegistry` of a chain.
//! - [`handoff`]: the proof package, and its delivery to standard output and a webhook.
//! - [`evidence`]: the message evidence builder: a message in, the calldata of `MessageBridge.executeMessage` out.
//! - [`stored`]: what the destination light client stores, read with view calls and logs.
//! - [`rpc`] and [`chain`]: a small JSON-RPC client and a read-only client for one chain.
//! - [`light_client`]: the only module that calls `lc-core`.
//! - [`prover`]: the proving backends. Only light-client updates (and fork observations, for a worker) are proven.
//! - [`remote`]: the backend that sends a proof job to a GPU worker and checks the answer.
//! - [`timing`]: the step timings that a proof run logs.
//! - [`worker`]: the HTTP server that such a worker runs (`docs/gpu-prover.md`).
//! - [`fork_schedule`]: the fork schedule and chain specification that the prover reads from the beacon node at run time.
//! - [`beacon`]: the beacon node source for updates and for the beacon part of a message proof.
//! - `local_network` (feature `signed-beacon`): a beacon chain over local blocks with real signatures, for tests.
//! - [`cli`]: the commands `prove` and `evidence`.

pub mod beacon;
pub mod chain;
pub mod checkpoint;
pub mod cli;
pub mod config;
pub mod contracts;
pub mod deployment;
pub mod error;
pub mod evidence;
pub mod fork_observation;
pub mod fork_schedule;
pub mod handoff;
pub mod light_client;
#[cfg(feature = "signed-beacon")]
pub mod local_network;
pub mod logging;
pub mod opening;
pub mod produce;
pub mod proof_cache;
pub mod prover;
pub mod remote;
pub mod rpc;
pub mod signer;
pub mod stored;
pub mod timing;
pub mod worker;
