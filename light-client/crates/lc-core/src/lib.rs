//! Light-client and withdrawal verification for the hardened bridge.
//!
//! - [`update::verify_light_client_update`] is the body of the SP1 light-client guest program in `light-client/guests/`.
//! - [`withdrawal::verify_withdrawal`] is the Rust reference of the vault check. No zero-knowledge proof is involved:
//!   the vault verifies the withdrawal evidence directly.
//!
//! The modules [`ssz`], [`ancestry`], [`mpt`] and [`withdrawal`] stand alone and have no dependency on the light-client update code.

pub mod abi;
pub mod ancestry;
pub mod bls;
pub mod chain;
pub mod error;
pub mod era;
pub mod execution;
pub mod gate;
#[cfg(feature = "json")]
pub mod json;
pub mod layout;
pub mod mpt;
pub mod receipts;
pub mod ssz;
pub mod ssz_state;
pub mod types;
pub mod update;
pub mod wire;
pub mod withdrawal;

pub use error::{Error, Result};
