//! Message proof verification of the hardened bridge, with the fork proof of the source state.
//!
//! - [`message::verify_message`] is the Rust reference of the check in `MessageBridge.executeMessage`. No zero-knowledge
//!   proof is involved: the bridge verifies the message evidence directly.
//! - [`ancestry::verify_beacon_path`] is its beacon stage: anchor, ancestry, fork proof of the source state, block hash.
//! - [`abi::MessageProof`] is the calldata struct, with `sourceFork`.
//!
//! The message helpers that the fork proof does not touch (message encoding, receipt and transaction proofs, the log
//! decoders, the ancestry indices) stay in `lc_core::message` and `lc_core::ancestry`, and this crate calls them.
//! `lc_core::abi::MessageProof`, `lc_core::message::verify_message` and `lc_core::ancestry::verify_beacon_path` are the
//! earlier form without the fork proof. They stay in `lc-core` unchanged only because every byte of `lc-core` is an input
//! of the program keys of the guest programs; the bridge no longer accepts that form.
//!
//! These files are also compiled as the module `lc_testkit::lc_message`, so they name each other with `super::`.

pub mod abi;
pub mod ancestry;
pub mod message;
