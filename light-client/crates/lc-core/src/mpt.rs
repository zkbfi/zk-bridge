//! Merkle-Patricia trie proof walker that returns the proven value.
//!
//! `alloy_trie::proof::verify_proof` needs the expected value as input. The vault gets no receipt bytes in its
//! calldata: the receipt is the value at the end of the proof. This walker follows the proof from the root hash,
//! checks the keccak256 link at every step, and returns the leaf value. It is the Rust twin of the Solidity walker.
//!
//! Strictness: every proof node must be used, in order, and an absent key is an error.

use crate::error::{Error, Result};
use alloy_primitives::{keccak256, Bytes, B256};
use alloy_rlp::Header as RlpHeader;

fn proof_error(reason: &str) -> Error {
    Error::ReceiptProofInvalid(reason.to_string())
}

/// One RLP item inside a trie node.
enum Item<'a> {
    /// A byte string (payload only).
    String(&'a [u8]),
    /// A nested list (the full encoding, header included): an inline child node.
    List(&'a [u8]),
}

/// Splits the payload of an RLP list into its items.
fn list_items(encoded: &[u8]) -> Result<Vec<Item<'_>>> {
    let mut buffer = encoded;
    let header = RlpHeader::decode(&mut buffer).map_err(|_| proof_error("node is not valid RLP"))?;
    if !header.list || header.payload_length != buffer.len() {
        return Err(proof_error("node is not one RLP list"));
    }
    let mut items = Vec::new();
    while !buffer.is_empty() {
        let before = buffer;
        let item_header = RlpHeader::decode(&mut buffer).map_err(|_| proof_error("bad RLP item in node"))?;
        if buffer.len() < item_header.payload_length {
            return Err(proof_error("RLP item runs past the node"));
        }
        let (payload, rest) = buffer.split_at(item_header.payload_length);
        let header_length = before.len() - buffer.len();
        items.push(if item_header.list {
            Item::List(&before[..header_length + item_header.payload_length])
        } else {
            Item::String(payload)
        });
        buffer = rest;
    }
    Ok(items)
}

/// Splits bytes into nibbles, high nibble first.
fn to_nibbles(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().flat_map(|byte| [byte >> 4, byte & 0x0f]).collect()
}

/// Decodes a hex-prefix path. Returns (is_leaf, nibbles).
fn decode_path(encoded: &[u8]) -> Result<(bool, Vec<u8>)> {
    let first = *encoded.first().ok_or_else(|| proof_error("empty path"))?;
    let flag = first >> 4;
    if flag > 3 {
        return Err(proof_error("bad path flag"));
    }
    let mut nibbles = Vec::new();
    if flag & 1 == 1 {
        nibbles.push(first & 0x0f);
    } else if first & 0x0f != 0 {
        return Err(proof_error("non-zero padding nibble in path"));
    }
    nibbles.extend(to_nibbles(&encoded[1..]));
    Ok((flag & 2 == 2, nibbles))
}

/// What a parent node holds in a child slot.
enum Reference<'a> {
    /// The keccak256 hash of a node that is the next proof entry.
    Hash(B256),
    /// A node of fewer than 32 bytes, embedded in its parent.
    Inline(&'a [u8]),
}

fn child_reference<'a>(item: &Item<'a>) -> Result<Reference<'a>> {
    match item {
        Item::String(hash) if hash.len() == 32 => Ok(Reference::Hash(B256::from_slice(hash))),
        Item::String([]) => Err(proof_error("key is absent: empty child")),
        Item::String(_) => Err(proof_error("child reference is neither a hash nor a node")),
        Item::List(raw) => Ok(Reference::Inline(raw)),
    }
}

/// Walks `proof` from `root` along `key` (as nibbles) and returns the value stored at the key.
///
/// # Errors
/// `ReceiptProofInvalid` for a hash mismatch, a malformed node, an absent key or unused proof nodes.
pub fn extract_proven_value(root: B256, key: &[u8], proof: &[Bytes]) -> Result<Vec<u8>> {
    let mut reference = Reference::Hash(root);
    let mut position = 0usize;
    let mut used = 0usize;
    loop {
        let node: &[u8] = match reference {
            Reference::Hash(expected) => {
                let node = proof.get(used).ok_or_else(|| proof_error("proof ends before the leaf"))?;
                used += 1;
                if keccak256(node) != expected {
                    return Err(proof_error("node hash does not match its parent reference"));
                }
                node.as_ref()
            }
            Reference::Inline(raw) => raw,
        };
        let items = list_items(node)?;
        match items.len() {
            17 => {
                if position == key.len() {
                    return finish(&items[16], used, proof.len());
                }
                reference = child_reference(&items[key[position] as usize])?;
                position += 1;
            }
            2 => {
                let Item::String(path) = &items[0] else { return Err(proof_error("path is not a string")) };
                let (is_leaf, nibbles) = decode_path(path)?;
                if key.len() - position < nibbles.len() || key[position..position + nibbles.len()] != nibbles[..] {
                    return Err(proof_error("key is absent: path mismatch"));
                }
                position += nibbles.len();
                if is_leaf {
                    if position != key.len() {
                        return Err(proof_error("key is absent: leaf ends early"));
                    }
                    return finish(&items[1], used, proof.len());
                }
                reference = child_reference(&items[1])?;
            }
            _ => return Err(proof_error("node has neither 2 nor 17 items")),
        }
    }
}

fn finish(item: &Item<'_>, used: usize, total: usize) -> Result<Vec<u8>> {
    if used != total {
        return Err(proof_error("unused proof nodes"));
    }
    match item {
        Item::String(value) if !value.is_empty() => Ok(value.to_vec()),
        _ => Err(proof_error("key is absent: no value")),
    }
}
