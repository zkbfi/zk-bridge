//! `verify_fork_observation`: the body of the fork-observation guest program.
//!
//! Contract: `docs/hardened-build-contract.md`, section "Fork observation registry". The sync committee signs
//! `compute_signing_root(attested_header_root, domain)`, and the domain holds the fork version. So a bound committee
//! that signs under version V proves that the chain runs V. The program needs no fork table for V: the fork version is
//! a signed input. A version outside the fork table is therefore accepted, and that is the purpose.
//!
//! PulseChain has no EIP-4788, so the program also proves the SHAPE of the attested state. Two branches lead to the
//! attested header's `state_root`: one for `fork.current_version` (leaf: the observed version, left-aligned in a 32 byte
//! chunk) and one for `genesis_validators_root` (the genesis validators root branch, leaf: the chain's own root). The version branch length
//! gives the candidate shapes ([`crate::layout::observed_shape_candidates`]). The first candidate for which both branches
//! verify wins, and the output reports it as `shape` (5, 6, 7 or 255 for the progressive form).
//!
//! Rules:
//! - The fold steps (zero to 64) follow every rule of [`crate::update::verify_fold`], with the fork
//!   versions the steps carry.
//! - The signing committee is the current committee of the final store. It is the next committee of the final store only
//!   when the fold crossed into a new period and proved that next committee itself. A next-period signature without a
//!   crossing is refused (`SignatureInNextPeriodWithoutCrossing`), as for an update.
//! - The shape proof must verify for one candidate shape, else `InvalidForkShapeProof`.
//! - At least 342 of 512 members sign.
//! - The attested header is carried in full. Its slot is strictly greater than the slot of the final head, and
//!   `signature_slot` is strictly greater than the attested slot. The signed root is the hash of the header, so the
//!   attested slot is authenticated by the signature, and the output reports it as `observedAttestedSlot`.
//! - The output binds the starting store exactly like `LightClientOutput`. No head moves.
//!
//! `signature_slot` itself is not signed. It only selects the committee period, and a wrong choice fails the
//! signature check. It is not reported in the output. Reporting the unsigned slot would let a prover pair an old
//! signature with a fake high slot (see `observation_forged_attested_slot_is_rejected` in `lc-testkit`).

use crate::abi::ForkObservation;
use crate::chain::{ChainSpec, MIN_PARTICIPANTS};
use crate::error::{Error, Result};
use crate::layout::observed_shape_candidates;
use crate::ssz::is_valid_exact_branch;
use crate::types::{BeaconBlockHeader, LightClientStore, SyncAggregate};
use crate::update::{verify_fold, verify_sync_aggregate, FoldStep, MAX_FOLD_UPDATES};
use alloy_primitives::{FixedBytes, B256};

/// The signed claim of an observation: a sync aggregate over a header root, under a fork version the prover names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observation {
    /// The header the committee signed. The program hashes it to get the signed root, so its slot is authenticated.
    pub attested_header: BeaconBlockHeader,
    /// The slot of the block that carries the aggregate. It selects the committee period. It is not signed.
    pub signature_slot: u64,
    /// The participation bits and the aggregate signature.
    pub sync_aggregate: SyncAggregate,
    /// The fork version of the signing domain. The signature proves it.
    pub fork_version: [u8; 4],
    /// The branch of `fork.current_version` to `attested_header.state_root`. Its leaf is `fork_version`, left-aligned in a
    /// 32 byte chunk. It has 7 to 33 entries (plain depth 5 to 31, or the progressive form).
    pub current_version_branch: Vec<B256>,
    /// the genesis validators root branch: the branch of `genesis_validators_root` to `attested_header.state_root`, at the genesis validators root position
    /// of the same shape. It has 5, 6, 7 or 5 entries for the allowed shapes, and 8 to 31 entries for a disallowed plain depth.
    pub genesis_validators_root_branch: Vec<B256>,
}

/// The leaf of the version branch: the four bytes of the version, then 28 zero bytes (an SSZ `Bytes4` chunk).
pub fn fork_version_leaf(fork_version: [u8; 4]) -> B256 {
    let mut chunk = [0u8; 32];
    chunk[..4].copy_from_slice(&fork_version);
    B256::from(chunk)
}

/// Proves the shape of the attested state and returns it: 5, 6, 7, 255, or a disallowed plain depth from 8 to 31.
///
/// The version branch length picks the candidates. A candidate wins when both the version branch and the genesis validators root branch
/// verify at its positions, under `attested_header.state_root`. The branches are exact, so each branch length must also
/// match the candidate.
///
/// # Errors
/// `InvalidForkShapeProof` when the version branch length names no candidate, or no candidate verifies.
pub fn prove_observed_shape(observation: &Observation, spec: &ChainSpec) -> Result<u8> {
    let state_root = &observation.attested_header.state_root;
    let version_leaf = fork_version_leaf(observation.fork_version);
    observed_shape_candidates(observation.current_version_branch.len())
        .iter()
        .find(|candidate| {
            is_valid_exact_branch(
                &version_leaf,
                &observation.current_version_branch,
                candidate.current_version_gindex,
                state_root,
            ) && is_valid_exact_branch(
                &spec.genesis_validators_root,
                &observation.genesis_validators_root_branch,
                candidate.genesis_validators_root_gindex,
                state_root,
            )
        })
        .map(|candidate| candidate.shape)
        .ok_or(Error::InvalidForkShapeProof)
}

/// Verifies an observation after an optional fold, and returns the public output.
///
/// # Errors
/// `FoldLengthOutOfRange` for more than 64 steps. The first failed rule of a step. `InsufficientParticipation`,
/// `InvalidSlotOrder`, `PeriodOutOfRange`, `SignatureInNextPeriodWithoutCrossing`, `NextSyncCommitteeUnknown`,
/// `InvalidForkShapeProof` (checked before the signature), or a signature error from the BLS check.
pub fn verify_fork_observation(
    store: &LightClientStore,
    steps: &[FoldStep],
    observation: &Observation,
    spec: &ChainSpec,
) -> Result<ForkObservation> {
    if steps.len() > MAX_FOLD_UPDATES {
        return Err(Error::FoldLengthOutOfRange { count: steps.len() });
    }
    let (final_store, proven_next_hash) = fold_if_any(store, steps, spec)?;

    let participants = observation.sync_aggregate.participant_count();
    if participants < MIN_PARTICIPANTS {
        return Err(Error::InsufficientParticipation { participants });
    }
    let attested_slot = observation.attested_header.slot;
    if attested_slot <= final_store.header_slot {
        return Err(Error::InvalidSlotOrder("the observation attested slot must be after the final head"));
    }
    if observation.signature_slot <= attested_slot {
        return Err(Error::InvalidSlotOrder("the observation signature slot must be after the attested slot"));
    }

    let start_period = spec.period_at_slot(store.header_slot);
    let final_period = spec.period_at_slot(final_store.header_slot);
    let signature_period = spec.period_at_slot(observation.signature_slot);
    let crossed = final_period != start_period;
    if signature_period != final_period && signature_period != final_period + 1 {
        return Err(Error::PeriodOutOfRange("the observation signature is more than one period past the final head"));
    }
    if signature_period == final_period + 1 && !crossed {
        return Err(Error::SignatureInNextPeriodWithoutCrossing);
    }
    // After a crossing the next committee is public only if this fold proved it (proven_next_hash is non-zero).
    // The stored next committee of the start is bound too, but the crossing made it the current one.
    if signature_period == final_period + 1 && proven_next_hash == B256::ZERO {
        return Err(Error::NextSyncCommitteeUnknown);
    }
    let shape = prove_observed_shape(observation, spec)?;
    let signing_committee = if signature_period == final_period {
        &final_store.current_sync_committee
    } else {
        final_store.next_sync_committee.as_ref().ok_or(Error::NextSyncCommitteeUnknown)?
    };
    verify_sync_aggregate(
        spec,
        signing_committee,
        &observation.sync_aggregate,
        &observation.attested_header.hash_tree_root(),
        observation.fork_version,
    )?;

    let start_next_hash = match &store.next_sync_committee {
        Some(committee) => committee.hash_tree_root()?,
        None => B256::ZERO,
    };
    Ok(ForkObservation {
        genesisValidatorsRoot: spec.genesis_validators_root,
        previousHeaderRoot: store.header_root,
        previousHeadSlot: store.header_slot,
        previousSyncCommitteeHash: store.current_sync_committee.hash_tree_root()?,
        startNextSyncCommitteeHash: start_next_hash,
        observedVersion: FixedBytes::from(observation.fork_version),
        observedAttestedSlot: attested_slot,
        shape,
    })
}

/// Applies the steps when there are any. Returns the final store and the next committee hash the fold proved (or zero).
fn fold_if_any(store: &LightClientStore, steps: &[FoldStep], spec: &ChainSpec) -> Result<(LightClientStore, B256)> {
    if steps.is_empty() {
        return Ok((store.clone(), B256::ZERO));
    }
    let (output, final_store) = verify_fold(store, steps, spec)?;
    Ok((final_store, output.nextSyncCommitteeHash))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::{ETHEREUM_MAINNET, PULSECHAIN};
    use crate::layout::{FIRST_DISALLOWED_DEPTH, MAX_SEAL_DEPTH, MIN_SEAL_DEPTH};
    use crate::layout::{SHAPE_PLAIN_DEPTH_FIVE, SHAPE_PLAIN_DEPTH_SEVEN, SHAPE_PLAIN_DEPTH_SIX, SHAPE_PROGRESSIVE};
    use crate::ssz::{branch_for_leaf, branch_for_leaf_with_limit, progressive_container_branch, sha256};

    const VERSION: [u8; 4] = [0x90, 0x00, 0x00, 0x75];

    /// Which tree the test builds: a plain state of `fields` fields, or the progressive state of 46 chunks.
    #[derive(Clone, Copy)]
    enum Tree {
        Plain {
            fields: usize,
        },
        /// A plain state of a depth the light client refuses (8 to 32), with 130 fields in a tree of `2^depth` leaves.
        Deep {
            depth: u32,
        },
        Progressive,
    }

    /// The branch of leaf `index` of the state tree, for the shape of the tree.
    fn state_branch(tree: Tree, leaves: &[B256], index: usize) -> (B256, Vec<B256>) {
        match tree {
            Tree::Plain { .. } => branch_for_leaf(leaves, index),
            Tree::Deep { depth } => branch_for_leaf_with_limit(leaves, index, depth),
            Tree::Progressive => progressive_container_branch(leaves, index),
        }
    }

    /// An honest observation over a synthetic state: field 1 holds `genesis_validators_root`, field 3 holds a `Fork` whose
    /// current version is `VERSION`, and every other field is a distinct hash. Branches are built from the leaves.
    fn honest_observation(tree: Tree, genesis_validators_root: B256) -> Observation {
        let count = match tree {
            Tree::Plain { fields } => fields,
            Tree::Deep { .. } => 130,
            Tree::Progressive => 46,
        };
        let mut leaves: Vec<B256> = (0..count).map(|index| sha256(format!("field/{index}").as_bytes())).collect();
        leaves[1] = genesis_validators_root;
        let fork_leaves = [sha256(b"previous"), fork_version_leaf(VERSION), sha256(b"epoch")];
        let (fork_root, fork_branch) = branch_for_leaf(&fork_leaves, 1);
        leaves[3] = fork_root;
        let (root, outer_version_branch) = state_branch(tree, &leaves, 3);
        let (_, genesis_validators_root_branch) = state_branch(tree, &leaves, 1);
        Observation {
            attested_header: BeaconBlockHeader {
                slot: 100,
                proposer_index: 1,
                parent_root: B256::repeat_byte(1),
                state_root: root,
                body_root: B256::repeat_byte(2),
            },
            signature_slot: 101,
            sync_aggregate: SyncAggregate { sync_committee_bits: [0; 64], sync_committee_signature: [0; 96] },
            fork_version: VERSION,
            current_version_branch: [fork_branch, outer_version_branch].concat(),
            genesis_validators_root_branch,
        }
    }

    /// Claim: the four shapes prove and report 5, 6, 7 and 255, with version branches of 7, 8, 9 and 7 entries and genesis validators root
    /// branches of 5, 6, 7 and 5 entries.
    /// Why it matters: the shape is a public value that the gate judges. A swapped number would pass a seal for a good shape.
    #[test]
    fn each_shape_proves_and_reports_its_value() {
        let cases = [
            (Tree::Plain { fields: 28 }, SHAPE_PLAIN_DEPTH_FIVE, 7, 5),
            (Tree::Plain { fields: 37 }, SHAPE_PLAIN_DEPTH_SIX, 8, 6),
            (Tree::Plain { fields: 70 }, SHAPE_PLAIN_DEPTH_SEVEN, 9, 7),
            (Tree::Progressive, SHAPE_PROGRESSIVE, 7, 5),
        ];
        for (tree, shape, version_length, genesis_validators_root_length) in cases {
            let observation = honest_observation(tree, ETHEREUM_MAINNET.genesis_validators_root);
            assert_eq!(observation.current_version_branch.len(), version_length);
            assert_eq!(observation.genesis_validators_root_branch.len(), genesis_validators_root_length);
            assert_eq!(prove_observed_shape(&observation, &ETHEREUM_MAINNET), Ok(shape));
        }
    }

    /// Claim: the leaf of the version branch is the four version bytes followed by 28 zero bytes.
    #[test]
    fn the_version_leaf_is_left_aligned() {
        let leaf = fork_version_leaf([1, 2, 3, 4]);
        assert_eq!(&leaf[..4], &[1, 2, 3, 4]);
        assert!(leaf[4..].iter().all(|byte| *byte == 0));
    }

    /// Claim: a progressive state and a plain depth 5 state both give a 7 entry version branch. The program tries plain
    /// depth 5 first, and a progressive branch fails there, so the second candidate wins. A plain depth 5 branch wins at the
    /// first candidate.
    /// Why it matters: length 7 is ambiguous, and the winner must come from the evidence, not from the order alone.
    #[test]
    fn length_seven_is_decided_by_which_candidate_verifies() {
        let plain = honest_observation(Tree::Plain { fields: 28 }, PULSECHAIN.genesis_validators_root);
        let progressive = honest_observation(Tree::Progressive, PULSECHAIN.genesis_validators_root);
        assert_eq!(plain.current_version_branch.len(), progressive.current_version_branch.len());
        assert_eq!(prove_observed_shape(&plain, &PULSECHAIN), Ok(SHAPE_PLAIN_DEPTH_FIVE));
        assert_eq!(prove_observed_shape(&progressive, &PULSECHAIN), Ok(SHAPE_PROGRESSIVE));
    }

    /// Claim: both branches must verify under ONE candidate. The version branch of a progressive state with the genesis validators root branch of
    /// a plain depth 5 state (same lengths 7 and 5, other positions) gives `InvalidForkShapeProof`, and so does the reverse.
    /// Why it matters: if each branch picked its own shape, a prover could prove the version in one shape and the root in
    /// another.
    #[test]
    fn the_version_and_the_genesis_validators_root_must_agree_on_one_shape() {
        let root = ETHEREUM_MAINNET.genesis_validators_root;
        let plain = honest_observation(Tree::Plain { fields: 28 }, root);
        let progressive = honest_observation(Tree::Progressive, root);
        let progressive_version_plain_genesis_validators_root = Observation {
            current_version_branch: progressive.current_version_branch.clone(),
            genesis_validators_root_branch: plain.genesis_validators_root_branch.clone(),
            ..progressive.clone()
        };
        assert_eq!(
            prove_observed_shape(&progressive_version_plain_genesis_validators_root, &ETHEREUM_MAINNET),
            Err(Error::InvalidForkShapeProof)
        );
        let plain_version_progressive_genesis_validators_root = Observation {
            current_version_branch: plain.current_version_branch.clone(),
            genesis_validators_root_branch: progressive.genesis_validators_root_branch.clone(),
            ..plain.clone()
        };
        assert_eq!(
            prove_observed_shape(&plain_version_progressive_genesis_validators_root, &ETHEREUM_MAINNET),
            Err(Error::InvalidForkShapeProof)
        );
    }

    /// Claim: the genesis validators root leaf is the chain's own genesis validators root. A state built for another chain gives
    /// `InvalidForkShapeProof`, and the control (the same state with the right root) proves.
    /// Why it matters: the genesis validators root branch must tie the shape to the real state of this chain, not to any tree.
    #[test]
    fn the_genesis_validators_root_leaf_is_the_root_of_the_chain() {
        let foreign = honest_observation(Tree::Plain { fields: 37 }, B256::repeat_byte(0x77));
        assert_eq!(prove_observed_shape(&foreign, &ETHEREUM_MAINNET), Err(Error::InvalidForkShapeProof));
        let own = honest_observation(Tree::Plain { fields: 37 }, ETHEREUM_MAINNET.genesis_validators_root);
        assert_eq!(prove_observed_shape(&own, &ETHEREUM_MAINNET), Ok(SHAPE_PLAIN_DEPTH_SIX));
    }

    /// Claim: the observed version is the leaf of the version branch. A different version with the same branch gives
    /// `InvalidForkShapeProof`.
    /// Why it matters: the output reports the version that the committee signed. The state must say the same version.
    #[test]
    fn the_version_leaf_must_be_the_observed_version() {
        let honest = honest_observation(Tree::Plain { fields: 28 }, ETHEREUM_MAINNET.genesis_validators_root);
        let other = Observation { fork_version: [0x90, 0x00, 0x00, 0x76], ..honest.clone() };
        assert_eq!(prove_observed_shape(&honest, &ETHEREUM_MAINNET), Ok(SHAPE_PLAIN_DEPTH_FIVE));
        assert_eq!(prove_observed_shape(&other, &ETHEREUM_MAINNET), Err(Error::InvalidForkShapeProof));
    }

    /// Claim: a version branch of a length that no shape has (0 to 6, 34, 35, 64) gives `InvalidForkShapeProof`, and so
    /// does a zero-padded or cut branch of an honest observation.
    /// Why it matters: the branches are exact. A leading zero changes the length, and the length names the candidates.
    #[test]
    fn version_branches_of_other_lengths_are_refused() {
        let honest = honest_observation(Tree::Plain { fields: 37 }, ETHEREUM_MAINNET.genesis_validators_root);
        assert_eq!(honest.current_version_branch.len(), 8);
        for length in [0usize, 1, 6, 34, 35, 64] {
            let branch = honest.current_version_branch.iter().copied().cycle().take(length).collect();
            let observation = Observation { current_version_branch: branch, ..honest.clone() };
            assert_eq!(
                prove_observed_shape(&observation, &ETHEREUM_MAINNET),
                Err(Error::InvalidForkShapeProof),
                "length {length}"
            );
        }
        let padded = [vec![B256::ZERO], honest.current_version_branch.clone()].concat();
        let padded_observation = Observation { current_version_branch: padded, ..honest.clone() };
        assert_eq!(prove_observed_shape(&padded_observation, &ETHEREUM_MAINNET), Err(Error::InvalidForkShapeProof));
        let cut = Observation { current_version_branch: honest.current_version_branch[1..].to_vec(), ..honest.clone() };
        assert_eq!(prove_observed_shape(&cut, &ETHEREUM_MAINNET), Err(Error::InvalidForkShapeProof));
        let padded_genesis_validators_root_branch = Observation {
            genesis_validators_root_branch: [vec![B256::ZERO], honest.genesis_validators_root_branch.clone()].concat(),
            ..honest.clone()
        };
        assert_eq!(
            prove_observed_shape(&padded_genesis_validators_root_branch, &ETHEREUM_MAINNET),
            Err(Error::InvalidForkShapeProof)
        );
    }

    /// Claim: a plain state of depth 8 (129 fields) and of depth 9 (257 fields) prove and report shape 8 and 9, with version
    /// branches of 10 and 11 entries and genesis validators root branches of 8 and 9 entries. Depth 31, the deepest seal
    /// depth, proves too.
    /// Why it matters: the light client refuses these depths, so the registry must be able to record them. Otherwise a
    /// consensus-only fork to a deeper state leaves the gate open to deposits that nobody can deliver.
    #[test]
    fn a_disallowed_plain_depth_proves_and_reports_its_depth() {
        let real_fields = [(Tree::Plain { fields: 129 }, 8u8), (Tree::Plain { fields: 257 }, 9)];
        let sparse_depths =
            [(Tree::Deep { depth: 8 }, 8u8), (Tree::Deep { depth: 20 }, 20), (Tree::Deep { depth: 31 }, 31)];
        for (tree, depth) in real_fields.into_iter().chain(sparse_depths) {
            let observation = honest_observation(tree, ETHEREUM_MAINNET.genesis_validators_root);
            assert_eq!(observation.current_version_branch.len(), usize::from(depth) + 2);
            assert_eq!(observation.genesis_validators_root_branch.len(), usize::from(depth));
            assert_eq!(prove_observed_shape(&observation, &ETHEREUM_MAINNET), Ok(depth), "depth {depth}");
        }
    }

    /// Claim: a claim of depth 32 is refused with `InvalidForkShapeProof`, although both branches are honest for a tree of
    /// depth 32. The control is the same construction at depth 31, which proves.
    /// Why it matters: the bound is the seal bound of the gate. A shape past it must not appear in a public value.
    #[test]
    fn a_depth_thirty_two_claim_is_refused() {
        let control = honest_observation(Tree::Deep { depth: MAX_SEAL_DEPTH }, PULSECHAIN.genesis_validators_root);
        assert_eq!(prove_observed_shape(&control, &PULSECHAIN), Ok(31));
        let too_deep = honest_observation(Tree::Deep { depth: MAX_SEAL_DEPTH + 1 }, PULSECHAIN.genesis_validators_root);
        assert_eq!(too_deep.current_version_branch.len(), 34);
        assert_eq!(prove_observed_shape(&too_deep, &PULSECHAIN), Err(Error::InvalidForkShapeProof));
    }

    /// Claim: a deeper shape needs a genesis validators root branch that proves the root of the chain at the position of the
    /// SAME depth. A foreign root, a branch of another field, and a branch one level too short or too long each give
    /// `InvalidForkShapeProof`. The control is the honest depth 8 observation.
    /// Why it matters: without this branch any tree with a version-like leaf would pass for a deeper shape, and a
    /// stranger could seal the gate with it.
    #[test]
    fn a_deeper_shape_with_a_wrong_genesis_validators_root_branch_is_refused() {
        let root = PULSECHAIN.genesis_validators_root;
        let honest = honest_observation(Tree::Deep { depth: 8 }, root);
        assert_eq!(prove_observed_shape(&honest, &PULSECHAIN), Ok(8));
        let foreign = honest_observation(Tree::Deep { depth: 8 }, B256::repeat_byte(0x77));
        assert_eq!(prove_observed_shape(&foreign, &PULSECHAIN), Err(Error::InvalidForkShapeProof));
        let leaves: Vec<B256> = (0..130).map(|index| sha256(format!("field/{index}").as_bytes())).collect();
        let (_, other_field_branch) = branch_for_leaf_with_limit(&leaves, 2, 8);
        let other_field = Observation { genesis_validators_root_branch: other_field_branch, ..honest.clone() };
        assert_eq!(prove_observed_shape(&other_field, &PULSECHAIN), Err(Error::InvalidForkShapeProof));
        let too_short = honest.genesis_validators_root_branch[1..].to_vec();
        let too_long = [honest.genesis_validators_root_branch.clone(), vec![B256::ZERO]].concat();
        for branch in [too_short, too_long] {
            let wrong_length = Observation { genesis_validators_root_branch: branch, ..honest.clone() };
            assert_eq!(prove_observed_shape(&wrong_length, &PULSECHAIN), Err(Error::InvalidForkShapeProof));
        }
    }

    /// Claim: the depth bounds equal the seal bounds that `ForkShape.sol` declares, and the first disallowed depth is one past the
    /// deepest layout of the light client. The test reads the Solidity source.
    /// Why it matters: if the two bounds drift apart, the program could prove a depth that the gate ignores, or the gate
    /// could look for a depth that the program can never prove.
    #[test]
    fn the_depth_bounds_equal_the_solidity_seal_bounds() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../src/hardened/ForkShape.sol");
        let source = std::fs::read_to_string(path).expect("ForkShape.sol");
        let constant = |name: &str| -> u32 {
            let line = source.lines().find(|line| line.contains(&format!("{name} = "))).expect("the constant");
            let value = line.split('=').nth(1).expect("a value").trim().trim_end_matches(';');
            value.parse().expect("a number")
        };
        assert_eq!(constant("MIN_SEAL_DEPTH"), MIN_SEAL_DEPTH);
        assert_eq!(constant("MAX_SEAL_DEPTH"), MAX_SEAL_DEPTH);
        assert_eq!(FIRST_DISALLOWED_DEPTH, *crate::layout::STATE_DEPTHS.end() + 1);
    }
}
