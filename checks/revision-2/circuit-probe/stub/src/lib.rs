//! Local stand-in for `sp1_zkvm`. It exists so the specification's `main.rs` can be compiled and run as a
//! native program without the SP1 toolchain. It has the three functions and the macro that `main.rs` uses.
//! Input format on stdin: a series of blobs, each `u64` little-endian length then the bytes.
//! A `Vec<Vec<u8>>` blob holds a `u64` count, then each element as length plus bytes.

use std::io::Read;
use std::sync::{Mutex, OnceLock};

/// The real macro registers the guest entry point. Natively the binary has its own `main`, so it expands to nothing.
#[macro_export]
macro_rules! entrypoint {
    ($function:ident) => {};
}

/// Encoding helpers shared with the witness generator.
pub mod wire {
    /// Appends one blob: length prefix then bytes.
    pub fn push_blob(out: &mut Vec<u8>, bytes: &[u8]) {
        out.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
        out.extend_from_slice(bytes);
    }

    /// Encodes a list of byte vectors as the payload of one blob.
    pub fn encode_list(items: &[Vec<u8>]) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.extend_from_slice(&(items.len() as u64).to_le_bytes());
        for item in items {
            push_blob(&mut payload, item);
        }
        payload
    }

    fn take_u64(bytes: &[u8], at: &mut usize) -> u64 {
        let value = u64::from_le_bytes(bytes[*at..*at + 8].try_into().unwrap());
        *at += 8;
        value
    }

    /// Decodes the payload that `encode_list` made.
    pub fn decode_list(payload: &[u8]) -> Vec<Vec<u8>> {
        let mut at = 0;
        let count = take_u64(payload, &mut at);
        let mut items = Vec::new();
        for _ in 0..count {
            let length = take_u64(payload, &mut at) as usize;
            items.push(payload[at..at + length].to_vec());
            at += length;
        }
        items
    }
}

/// Types that `io::read` can produce. Only the two shapes that `main.rs` reads.
pub trait Wire {
    fn from_payload(payload: &[u8]) -> Self;
}

impl Wire for Vec<u8> {
    fn from_payload(payload: &[u8]) -> Self {
        payload.to_vec()
    }
}

impl Wire for Vec<Vec<u8>> {
    fn from_payload(payload: &[u8]) -> Self {
        wire::decode_list(payload)
    }
}

static INPUT: OnceLock<Mutex<(Vec<u8>, usize)>> = OnceLock::new();

fn next_blob() -> Vec<u8> {
    let state = INPUT.get_or_init(|| {
        let mut all = Vec::new();
        std::io::stdin().read_to_end(&mut all).expect("stdin");
        Mutex::new((all, 0))
    });
    let mut guard = state.lock().unwrap();
    let (all, at) = &mut *guard;
    let length = u64::from_le_bytes(all[*at..*at + 8].try_into().expect("input ended")) as usize;
    let blob = all[*at + 8..*at + 8 + length].to_vec();
    *at += 8 + length;
    blob
}

/// Input and output functions with the same names as the real library.
pub mod io {
    use super::{Wire, next_blob};

    /// Reads the next blob as raw bytes.
    pub fn read_vec() -> Vec<u8> {
        next_blob()
    }

    /// Reads the next blob as `T`.
    pub fn read<T: Wire>() -> T {
        T::from_payload(&next_blob())
    }

    /// Prints the committed public values as hex on one line.
    pub fn commit_slice(bytes: &[u8]) {
        let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        println!("COMMIT:{hex}");
    }
}
