//! Light-client and message verification for the hardened bridge.
//!
//! - [`update::verify_light_client_update`] is the body of the SP1 light-client guest program in `light-client/guests/`.
//! - [`message::verify_message`] is the Rust reference of the check in `MessageBridge.executeMessage`. No zero-knowledge
//!   proof is involved: the bridge verifies the message evidence directly.
//!
//! The modules [`ssz`], [`ancestry`], [`mpt`] and [`message`] stand alone and have no dependency on the light-client update code.

pub mod abi;
pub mod ancestry;
pub mod bls;
pub mod chain;
pub mod era;
pub mod error;
pub mod execution;
pub mod gate;
#[cfg(feature = "json")]
pub mod json;
pub mod layout;
pub mod message;
pub mod mpt;
pub mod observation;
pub mod profile;
pub mod receipts;
pub mod ssz;
pub mod ssz_state;
pub mod types;
pub mod update;
pub mod wire;

pub use error::{Error, Result};
