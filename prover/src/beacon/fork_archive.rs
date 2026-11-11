//! Fork proofs of source states, saved while a node still serves the state.
//!
//! Every message proof carries `MessageProof.sourceFork`: `fork.current_version` and `genesis_validators_root` proven
//! under the state root of its source header (see `lc_core::ancestry::source_shape`). The prover builds it from the state
//! of the source block. PulseChain beacon nodes prune old states, and an Ethereum mainnet state is hundreds of MB, so a message left
//! unproven for long could become unprovable once no reachable node keeps that state. Owner, 2026-11-10: "yes, and save
//! fork proofs in the watcher too".
//!
//! So the backend asks the prover for the fork proof of each source block that carries a message as soon as the block
//! is final (`zk-bridge-prover fork-proof`), keeps the record (`explorer/backend/src/archive/fork-proofs.ts`), and the
//! proof archive of the indexer keeps it for good and publishes it (docs/proof-archive.md). A later prover reads it back
//! at `<base>/<chain id>/<state root>.json` (`source.fork_proof_archive_urls`) when no node serves the state.
//!
//! Nothing in a record is trusted. Before the prover uses one it checks the two branches against the state root of the
//! source header with the genesis validators root of its own chain, by the rule of `ForkShape.judge`. The bridge checks
//! the same on chain. A wrong record can only fail a delivery, never prove a false message.
//!
//! The cheap way to get a fork proof from a node is the compact multiproof route of Lodestar
//! (`/eth/v0/beacon/proof/state/<state id>?format=<descriptor>`), about 1 KB, against hundreds of MB for a whole Ethereum mainnet
//! state. The functions here decode its answer; [`super::http::HttpBeaconSource::source_fork`] asks it first.

use super::handoff_archive::ArchiveClient;
use super::SourceBlock;
use crate::error::{Error, Result};
use crate::light_client::{header_root, BeaconHeader};
use alloy_primitives::{hex, FixedBytes, B256};
use lc_core::abi::ForkProof;
use lc_core::layout::ObservedShape;
use lc_core::ssz::hash_pair;
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// The `format` field of a record.
pub const RECORD_FORMAT: &str = "zkb-fork-proof/1";

/// The shapes in the order the multiproof route is asked for them: the progressive state first (Gloas), then the plain
/// depths in the order of their use. The same order as `SHAPE_REQUEST_ORDER` of the gate evidence in `@zkb/data`.
pub const SHAPE_REQUEST_ORDER: [ObservedShape; 4] = [
    lc_core::layout::OBSERVED_SHAPE_PROGRESSIVE,
    lc_core::layout::OBSERVED_SHAPE_PLAIN_DEPTH_SIX,
    lc_core::layout::OBSERVED_SHAPE_PLAIN_DEPTH_FIVE,
    lc_core::layout::OBSERVED_SHAPE_PLAIN_DEPTH_SEVEN,
];

/// The shape that `fork` proves under `state_root` with `genesis_validators_root`, by the rule of `ForkShape.judge`.
///
/// # Errors
/// `Error::Beacon` naming the state root when no allowed shape has both branches valid.
pub fn verified_shape(
    fork: &ForkProof,
    state_root: &B256,
    genesis_validators_root: &B256,
) -> Result<u8> {
    lc_core::ancestry::source_shape(fork, state_root, genesis_validators_root).map_err(|_| {
        Error::Beacon(format!(
            "the fork proof does not prove an allowed shape under the state root {state_root:#x}"
        ))
    })
}

fn hash_text(hash: &B256) -> Value {
    Value::String(format!("{hash:#x}"))
}

fn branch_json(branch: &[B256]) -> Value {
    Value::Array(branch.iter().map(hash_text).collect())
}

/// The record of the fork proof of the state of `header`, the source header of the messages of `source`. The keys are
/// sorted (`serde_json` keeps a sorted map), so one proof always gives the same bytes.
pub fn record_json(
    chain_id: u64,
    header: &BeaconHeader,
    source: &SourceBlock,
    fork: &ForkProof,
    shape: u8,
    genesis_validators_root: &B256,
) -> Value {
    json!({
        "format": RECORD_FORMAT,
        "chainId": chain_id,
        "slot": header.slot,
        "blockRoot": hash_text(&header_root(header)),
        "stateRoot": hash_text(&header.state_root),
        "executionBlockNumber": source.number,
        "executionBlockHash": hash_text(&source.hash),
        "shape": shape,
        "version": Value::String(hex::encode_prefixed(fork.version.as_slice())),
        "versionBranch": branch_json(&fork.versionBranch),
        "genesisValidatorsRoot": hash_text(genesis_validators_root),
        "genesisValidatorsRootBranch": branch_json(&fork.genesisValidatorsRootBranch),
    })
}

fn hashes(value: &Value) -> Option<Vec<B256>> {
    value
        .as_array()?
        .iter()
        .map(|entry| entry.as_str().and_then(|text| text.parse::<B256>().ok()))
        .collect()
}

/// The fork proof of a record, after the checks: the format, the chain id, the state root, and the two branches against
/// that state root with `genesis_validators_root` (the root of the prover's chain, never the one the record names).
///
/// # Errors
/// `Error::Malformed` naming the first check that fails.
pub fn fork_from_record(
    record: &Value,
    chain_id: u64,
    state_root: &B256,
    genesis_validators_root: &B256,
) -> Result<ForkProof> {
    let refuse = |what: &str| {
        Error::Malformed(format!(
            "the fork proof record of the state {state_root:#x}: {what}"
        ))
    };
    if record["format"].as_str() != Some(RECORD_FORMAT) {
        return Err(refuse("unknown format"));
    }
    if record["chainId"].as_u64() != Some(chain_id) {
        return Err(refuse("it names another chain"));
    }
    if record["stateRoot"]
        .as_str()
        .and_then(|text| text.parse::<B256>().ok())
        != Some(*state_root)
    {
        return Err(refuse("it names another state root"));
    }
    let version = record["version"]
        .as_str()
        .and_then(|text| text.parse::<FixedBytes<4>>().ok())
        .ok_or_else(|| refuse("the version is not 4 bytes"))?;
    let (Some(version_branch), Some(root_branch)) = (
        hashes(&record["versionBranch"]),
        hashes(&record["genesisValidatorsRootBranch"]),
    ) else {
        return Err(refuse("a branch is not a list of hashes"));
    };
    let fork = ForkProof {
        version,
        versionBranch: version_branch,
        genesisValidatorsRootBranch: root_branch,
    };
    verified_shape(&fork, state_root, genesis_validators_root)
        .map_err(|_| refuse("its branches do not prove an allowed shape for this chain"))?;
    Ok(fork)
}

/// Asks one archive for the record of `state_root` at `/<chain id>/<state root>.json` and checks it.
///
/// # Errors
/// A few words on why this archive gave none, such as `answered 404` or `refused: ...`.
pub fn ask_fork_archive(
    archive: &ArchiveClient,
    chain_id: u64,
    state_root: &B256,
    genesis_validators_root: &B256,
) -> std::result::Result<ForkProof, String> {
    let path = format!("/{chain_id}/{state_root:#x}.json");
    let response = archive
        .client
        .get(&path, "application/json")
        .map_err(|error| format!("no answer ({error})"))?;
    if response.status != 200 {
        return Err(format!("answered {}", response.status));
    }
    let record: Value = serde_json::from_slice(&response.body)
        .map_err(|_| "answered something that is not JSON".to_string())?;
    fork_from_record(&record, chain_id, state_root, genesis_validators_root)
        .map_err(|error| format!("refused: {error}"))
}

/// The descriptor of a compact multiproof for some leaves: the nodes of the smallest tree that holds them, depth first
/// (left before right), 0 for a node whose children follow and 1 for a node that the proof gives, padded with zeros to
/// whole bytes. The format of the Lodestar route; the same as `compactMultiproofDescriptor` of `@zkb/core`.
pub fn multiproof_descriptor(gindices: &[u64]) -> Vec<u8> {
    let on_path = |node: u64| {
        gindices.iter().any(|leaf| {
            let mut at = *leaf;
            while at > node {
                at >>= 1;
            }
            at == node
        })
    };
    let mut bits = Vec::new();
    let mut stack = vec![1u64];
    while let Some(node) = stack.pop() {
        if gindices.contains(&node) || !on_path(node) {
            bits.push(1u8);
        } else {
            bits.push(0u8);
            stack.push(2 * node + 1);
            stack.push(2 * node);
        }
    }
    bits.resize(bits.len().div_ceil(8) * 8, 0);
    bits.chunks(8)
        .map(|byte| byte.iter().fold(0u8, |acc, bit| (acc << 1) | bit))
        .collect()
}

/// Every node that a compact multiproof gives or implies, by generalized index, and its root.
///
/// # Errors
/// `Error::Malformed` when the descriptor and the leaves do not form one tree.
pub fn multiproof_nodes(descriptor: &[u8], leaves: &[B256]) -> Result<(B256, BTreeMap<u64, B256>)> {
    let bits: Vec<u8> = descriptor
        .iter()
        .flat_map(|byte| (0..8).rev().map(move |bit| (byte >> bit) & 1))
        .collect();
    let refuse = |what: &str| Error::Malformed(format!("the multiproof: {what}"));
    let mut nodes = BTreeMap::new();
    let mut bit = 0usize;
    let mut leaf = 0usize;
    // Depth first: each frame is a node and, once its left child is known, that child.
    enum Frame {
        Enter(u64),
        Combine(u64),
    }
    let mut stack = vec![Frame::Enter(1)];
    let mut values: Vec<B256> = Vec::new();
    while let Some(frame) = stack.pop() {
        match frame {
            Frame::Enter(gindex) => {
                if gindex >= 1 << 62 {
                    return Err(refuse("the tree is too deep"));
                }
                let flag = *bits
                    .get(bit)
                    .ok_or_else(|| refuse("the descriptor ends inside the tree"))?;
                bit += 1;
                if flag == 1 {
                    let given = *leaves
                        .get(leaf)
                        .ok_or_else(|| refuse("fewer leaves than the descriptor names"))?;
                    leaf += 1;
                    nodes.insert(gindex, given);
                    values.push(given);
                } else {
                    stack.push(Frame::Combine(gindex));
                    stack.push(Frame::Enter(2 * gindex + 1));
                    stack.push(Frame::Enter(2 * gindex));
                }
            }
            Frame::Combine(gindex) => {
                let right = values.pop().expect("two children were entered");
                let left = values.pop().expect("two children were entered");
                let node = hash_pair(&left, &right);
                nodes.insert(gindex, node);
                values.push(node);
            }
        }
    }
    if leaf != leaves.len() {
        return Err(refuse("more leaves than the descriptor names"));
    }
    if bits.len() - bit >= 8 || bits[bit..].contains(&1) {
        return Err(refuse("bits after the tree"));
    }
    Ok((values[0], nodes))
}

/// The leaf at `gindex` and its branch, deepest first.
fn branch_from_nodes(nodes: &BTreeMap<u64, B256>, gindex: u64) -> Option<(B256, Vec<B256>)> {
    let leaf = *nodes.get(&gindex)?;
    let mut branch = Vec::new();
    let mut at = gindex;
    while at > 1 {
        branch.push(*nodes.get(&(at ^ 1))?);
        at >>= 1;
    }
    Some((leaf, branch))
}

/// The fork proof of `shape` from the leaves of a compact multiproof of the two leaves of that shape, checked against
/// `state_root` and `genesis_validators_root`.
///
/// # Errors
/// `Error::Malformed` when the leaves do not form the tree of the descriptor, and `Error::Beacon` when they hash to
/// another root, the version leaf is not a padded 4 byte value, or the proof is not of an allowed shape.
pub fn fork_from_multiproof(
    shape: &ObservedShape,
    leaves: &[B256],
    state_root: &B256,
    genesis_validators_root: &B256,
) -> Result<ForkProof> {
    let gindices = [
        shape.current_version_gindex,
        shape.genesis_validators_root_gindex,
    ];
    let (root, nodes) = multiproof_nodes(&multiproof_descriptor(&gindices), leaves)?;
    if root != *state_root {
        return Err(Error::Beacon(format!(
            "the multiproof hashes to {root:#x}, not to the state root {state_root:#x}"
        )));
    }
    let (Some((version_leaf, version_branch)), Some((_, root_branch))) = (
        branch_from_nodes(&nodes, gindices[0]),
        branch_from_nodes(&nodes, gindices[1]),
    ) else {
        unreachable!("the descriptor of the two indices gives both leaves and their siblings");
    };
    if version_leaf[4..].iter().any(|byte| *byte != 0) {
        return Err(Error::Beacon(format!(
            "the leaf at {} is not a fork version",
            gindices[0]
        )));
    }
    let fork = ForkProof {
        version: FixedBytes::from_slice(&version_leaf[..4]),
        versionBranch: version_branch,
        genesisValidatorsRootBranch: root_branch,
    };
    verified_shape(&fork, state_root, genesis_validators_root)?;
    Ok(fork)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::rpc::{HttpGet, HttpResponse};
    use lc_core::ancestry::fork_proof_of_fields;
    use lc_core::layout::{OBSERVED_SHAPE_PLAIN_DEPTH_FIVE, OBSERVED_SHAPE_PLAIN_DEPTH_SIX};
    use lc_core::ssz_state::ForkData;

    /// The leaves of the compact multiproof of `gindices` over a tree known through the branches of those leaves. A test
    /// plays the Lodestar route with it.
    pub(crate) fn multiproof_leaves(proven: &[(u64, B256, Vec<B256>)]) -> Vec<B256> {
        let mut nodes = BTreeMap::new();
        for (gindex, leaf, branch) in proven {
            let mut at = *gindex;
            let mut node = *leaf;
            nodes.insert(at, node);
            for sibling in branch {
                nodes.insert(at ^ 1, *sibling);
                node = if at & 1 == 1 {
                    hash_pair(sibling, &node)
                } else {
                    hash_pair(&node, sibling)
                };
                at >>= 1;
                nodes.insert(at, node);
            }
        }
        let gindices: Vec<u64> = proven.iter().map(|(gindex, _, _)| *gindex).collect();
        let descriptor = multiproof_descriptor(&gindices);
        let bits: Vec<u8> = descriptor
            .iter()
            .flat_map(|byte| (0..8).rev().map(move |bit| (byte >> bit) & 1))
            .collect();
        let mut leaves = Vec::new();
        let mut bit = 0;
        let mut stack = vec![1u64];
        while let Some(node) = stack.pop() {
            let flag = bits[bit];
            bit += 1;
            if flag == 1 {
                leaves.push(nodes[&node]);
            } else {
                stack.push(2 * node + 1);
                stack.push(2 * node);
            }
        }
        leaves
    }

    /// The version leaf of a fork version: four bytes, right-padded.
    pub(crate) fn version_leaf(version: FixedBytes<4>) -> B256 {
        let mut leaf = [0u8; 32];
        leaf[..4].copy_from_slice(version.as_slice());
        B256::from(leaf)
    }

    /// The multiproof leaves of a fork proof of `shape`, as a Lodestar node answers them.
    pub(crate) fn leaves_of(fork: &ForkProof, shape: &ObservedShape, genesis: B256) -> Vec<B256> {
        multiproof_leaves(&[
            (
                shape.current_version_gindex,
                version_leaf(fork.version),
                fork.versionBranch.clone(),
            ),
            (
                shape.genesis_validators_root_gindex,
                genesis,
                fork.genesisValidatorsRootBranch.clone(),
            ),
        ])
    }

    /// A plain depth 6 state: 64 field roots with a genesis validators root and a fork. Returns the fork proof, the state
    /// root and the genesis validators root.
    pub(crate) fn plain_state() -> (ForkProof, B256, B256) {
        let genesis = B256::repeat_byte(0x11);
        let fork = ForkData {
            previous_version: [1, 0, 0, 0x74],
            current_version: [1, 0, 0, 0x75],
            epoch: 9,
        };
        let mut fields: Vec<B256> = (0..64u8).map(B256::repeat_byte).collect();
        fields[1] = genesis;
        fields[3] = fork.hash_tree_root();
        let proof = fork_proof_of_fields(&fields, false, &fork);
        (proof, lc_core::ssz::merkleize(&fields), genesis)
    }

    fn header(state_root: B256) -> BeaconHeader {
        BeaconHeader {
            slot: 77,
            proposer_index: 3,
            parent_root: B256::repeat_byte(4),
            state_root,
            body_root: B256::repeat_byte(5),
        }
    }

    fn source() -> SourceBlock {
        SourceBlock {
            number: 1234,
            hash: B256::repeat_byte(6),
            timestamp: 1_000,
        }
    }

    /// Claim: a record survives its JSON, carries every field with sorted keys, and gives back the same fork proof. Each
    /// field that the check reads, changed alone, is refused with its own words, and so is a record checked with the
    /// genesis validators root of another chain.
    /// Why it matters: the archive is untrusted. A record of another chain, state or shape must never reach a proof.
    #[test]
    fn a_record_round_trips_and_every_wrong_field_is_refused() {
        let (fork, state_root, genesis) = plain_state();
        let record = record_json(943, &header(state_root), &source(), &fork, 6, &genesis);
        let text = record.to_string();
        assert!(text.starts_with("{\"blockRoot\""), "{text}");
        assert_eq!(record["shape"], 6);
        assert_eq!(record["executionBlockNumber"], 1234);
        let back = fork_from_record(
            &serde_json::from_str(&text).unwrap(),
            943,
            &state_root,
            &genesis,
        )
        .unwrap();
        assert_eq!(back, fork);

        let refused = |change: &dyn Fn(&mut Value), chain_id: u64, genesis: &B256| {
            let mut changed = record.clone();
            change(&mut changed);
            fork_from_record(&changed, chain_id, &state_root, genesis)
                .expect_err("refused")
                .to_string()
        };
        let same = |_: &mut Value| {};
        assert!(
            refused(&|r| r["format"] = json!("zkb-fork-proof/2"), 943, &genesis)
                .contains("unknown format")
        );
        assert!(refused(&same, 369, &genesis).contains("another chain"));
        assert!(refused(
            &|r| r["stateRoot"] = hash_text(&B256::repeat_byte(9)),
            943,
            &genesis
        )
        .contains("another state root"));
        assert!(refused(&|r| r["version"] = json!("0x01"), 943, &genesis).contains("not 4 bytes"));
        assert!(
            refused(&|r| r["versionBranch"] = json!(["0x01"]), 943, &genesis)
                .contains("not a list of hashes")
        );
        assert!(refused(
            &|r| r["genesisValidatorsRootBranch"] = json!("x"),
            943,
            &genesis
        )
        .contains("not a list of hashes"));
        assert!(
            refused(&|r| r["version"] = json!("0x01000076"), 943, &genesis)
                .contains("do not prove")
        );
        assert!(refused(&same, 943, &B256::repeat_byte(0x22)).contains("do not prove"));
    }

    struct Answer(u16, Vec<u8>);

    impl HttpGet for Answer {
        fn get(&self, path_and_query: &str, _accept: &str) -> Result<HttpResponse> {
            assert!(path_and_query.starts_with("/943/0x"), "{path_and_query}");
            assert!(path_and_query.ends_with(".json"), "{path_and_query}");
            if self.0 == 0 {
                return Err(Error::Beacon("connection refused".into()));
            }
            Ok(HttpResponse {
                status: self.0,
                body: self.1.clone(),
            })
        }
    }

    fn archive(answer: Answer) -> ArchiveClient {
        ArchiveClient {
            host: "archive.example.org".into(),
            client: Box::new(answer),
        }
    }

    /// Claim: an archive that serves a good record gives its fork proof; one that fails, answers 404, answers no JSON or
    /// serves a record of another state gives the reason in a few words.
    /// Why it matters: the prover names every archive it tried when none had the record.
    #[test]
    fn an_archive_answer_is_checked_and_each_failure_is_named() {
        let (fork, state_root, genesis) = plain_state();
        let record = record_json(943, &header(state_root), &source(), &fork, 6, &genesis);
        let good = archive(Answer(200, record.to_string().into_bytes()));
        assert_eq!(
            ask_fork_archive(&good, 943, &state_root, &genesis).unwrap(),
            fork
        );
        let reason = |answer: Answer| {
            ask_fork_archive(&archive(answer), 943, &state_root, &genesis).unwrap_err()
        };
        assert!(reason(Answer(0, Vec::new())).starts_with("no answer"));
        assert_eq!(reason(Answer(404, Vec::new())), "answered 404");
        assert_eq!(
            reason(Answer(200, b"<html>".to_vec())),
            "answered something that is not JSON"
        );
        let other = record_json(
            943,
            &header(B256::repeat_byte(8)),
            &source(),
            &fork,
            6,
            &genesis,
        );
        assert!(reason(Answer(200, other.to_string().into_bytes())).starts_with("refused: "));
    }

    /// Claim: the descriptor of the two leaves of each shape equals the one `@zkb/core` computes (fixed vectors), and the
    /// leaves of a multiproof give back the fork proof, its root and both branches.
    /// Why it matters: the Lodestar route answers exactly the nodes that the descriptor names; one bit off and the answer is
    /// another tree.
    #[test]
    fn a_multiproof_gives_back_the_fork_proof() {
        // From `compactMultiproofDescriptor(forkProofGindices(shape))` of `@zkb/core`, in the request order.
        let vectors = ["231f80", "034fe0", "069f80", "01a7f8"];
        for (shape, vector) in SHAPE_REQUEST_ORDER.iter().zip(vectors) {
            let gindices = [
                shape.current_version_gindex,
                shape.genesis_validators_root_gindex,
            ];
            assert_eq!(
                hex::encode(multiproof_descriptor(&gindices)),
                vector,
                "shape {}",
                shape.shape
            );
        }
        let (fork, state_root, genesis) = plain_state();
        let shape = OBSERVED_SHAPE_PLAIN_DEPTH_SIX;
        let leaves = leaves_of(&fork, &shape, genesis);
        assert_eq!(
            fork_from_multiproof(&shape, &leaves, &state_root, &genesis).unwrap(),
            fork
        );
        // The leaves of depth 6 read as depth 5 form another tree.
        assert!(fork_from_multiproof(
            &OBSERVED_SHAPE_PLAIN_DEPTH_FIVE,
            &leaves,
            &state_root,
            &genesis
        )
        .is_err());
        let mut flipped = leaves.clone();
        flipped[0].0[31] ^= 1;
        let error = fork_from_multiproof(&shape, &flipped, &state_root, &genesis)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not to the state root"), "{error}");
        let error = fork_from_multiproof(&shape, &leaves, &state_root, &B256::repeat_byte(3))
            .unwrap_err()
            .to_string();
        assert!(error.contains("allowed shape"), "{error}");
    }

    /// Claim: a version leaf with bytes after the fourth is refused, though it hashes to the root.
    /// Why it matters: the bridge hashes `bytes32(version)`, so such a leaf is no fork version.
    #[test]
    fn a_version_leaf_with_more_than_four_bytes_is_refused() {
        let genesis = B256::repeat_byte(0x11);
        let mut fields: Vec<B256> = (0..64u8).map(B256::repeat_byte).collect();
        fields[1] = genesis;
        let fork = ForkData {
            previous_version: [1, 0, 0, 0x74],
            current_version: [1, 0, 0, 0x75],
            epoch: 9,
        };
        fields[3] = fork.hash_tree_root();
        let proof = fork_proof_of_fields(&fields, false, &fork);
        let shape = OBSERVED_SHAPE_PLAIN_DEPTH_SIX;
        // Swap the version leaf for the epoch chunk: build the tree with a long leaf at the version position.
        let mut long = version_leaf(proof.version);
        long[31] = 1;
        let mut nodes_leaves = leaves_of(&proof, &shape, genesis);
        // The version leaf is the first leaf the descriptor gives below the fork node; find and replace it.
        let at = nodes_leaves
            .iter()
            .position(|leaf| *leaf == version_leaf(proof.version))
            .unwrap();
        nodes_leaves[at] = long;
        let (root, _) =
            multiproof_nodes(&multiproof_descriptor(&[269, 65]), &nodes_leaves).unwrap();
        let error = fork_from_multiproof(&shape, &nodes_leaves, &root, &genesis)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not a fork version"), "{error}");
    }

    /// Claim: leaves that do not fill the descriptor, leaves left over, and a descriptor with bits after the tree are refused.
    /// Why it matters: a node answer of another form must fail cleanly, not panic.
    #[test]
    fn a_multiproof_of_another_form_is_refused() {
        let descriptor = multiproof_descriptor(&[269, 65]);
        let leaves = vec![B256::ZERO; 9];
        assert!(multiproof_nodes(&descriptor, &leaves[..3])
            .unwrap_err()
            .to_string()
            .contains("fewer leaves"));
        let too_many = vec![B256::ZERO; 20];
        assert!(multiproof_nodes(&descriptor, &too_many)
            .unwrap_err()
            .to_string()
            .contains("more leaves"));
        let mut trailing = descriptor.clone();
        trailing.push(0x80);
        let count = leaves_of(
            &plain_state().0,
            &OBSERVED_SHAPE_PLAIN_DEPTH_SIX,
            plain_state().2,
        )
        .len();
        assert!(multiproof_nodes(&trailing, &vec![B256::ZERO; count])
            .unwrap_err()
            .to_string()
            .contains("bits after"));
        assert!(multiproof_nodes(&[0x00], &[])
            .unwrap_err()
            .to_string()
            .contains("ends inside"));
        let deep = vec![0u8; 16];
        assert!(multiproof_nodes(&deep, &[])
            .unwrap_err()
            .to_string()
            .contains("too deep"));
    }
}
