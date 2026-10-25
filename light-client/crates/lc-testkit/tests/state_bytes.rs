//! The SSZ state parser on synthetic Capella, Deneb, Electra and Fulu states, and its agreement with `lc_core::layout`.
//!
//! Each test builds the bytes of a state with `lc_testkit::state_bytes`, parses them with `lc_core::ssz_state`, and
//! checks Merkle branches at the generalized indices that `layout.rs` names for the fork. The builder writes the field
//! order of each fork from the consensus specification and shares no constant with the parser or the layout table.

use alloy_primitives::B256;
use lc_core::ancestry::{block_roots_leaf_gindex, historical_leaf_gindex};
use lc_core::chain::{ForkName, ETHEREUM_MAINNET};
use lc_core::era::{historical_ancestry_branch, recent_ancestry_branch};
use lc_core::layout::{state_layout_for_fork, CAPELLA_DENEB_STATE_LAYOUT, ELECTRA_STATE_LAYOUT};
use lc_core::ssz::{
    branch_for_leaf, hash_pair, is_valid_exact_branch, merkleize, merkleize_with_limit, mix_in_length, sha256,
    u64_chunk,
};
use lc_core::ssz_state::{state_slot, try_parse_state, try_parse_state_for_fork, ForkData, ParsedState, StateForm};
use lc_core::Error;
use lc_testkit::state_bytes::StateBytes;
use lc_testkit::synthetic::committee_for;

const FORKS: [ForkName; 4] = [ForkName::Capella, ForkName::Deneb, ForkName::Electra, ForkName::Fulu];

fn era_roots(era: u64) -> Vec<B256> {
    (0..8192u64).map(|offset| sha256(format!("era/{era}/{offset}").as_bytes())).collect()
}

/// A state with two different committees, a finalized checkpoint, one historical summary (era 2) and a fork.
fn state_of(fork: ForkName) -> (StateBytes, Vec<B256>) {
    let current = committee_for(&ETHEREUM_MAINNET, 1889).committee.clone();
    let next = committee_for(&ETHEREUM_MAINNET, 1890).committee.clone();
    let mut state = StateBytes::new(fork, 8192 * 5 + 100, current, next);
    state.fork_data = ForkData { previous_version: [4, 0, 0, 0], current_version: [5, 0, 0, 0], epoch: 269_568 };
    state.finalized_checkpoint = (12_345, sha256(b"finalized root"));
    let roots = era_roots(2);
    state.historical_summaries = vec![(merkleize(&roots), sha256(b"state summary"))];
    (state, roots)
}

fn parse(state: &StateBytes) -> ParsedState {
    try_parse_state_for_fork(&state.to_ssz(), state.fork).expect("the synthetic state parses")
}

/// Claim: the parser reads the committees, slot, fork, finalized checkpoint, block roots and historical summaries of a
/// state of each fork, and the state has the field count of its fork (28, 28, 37, 38).
/// Why it matters: the prover builds the store and the update from these values. A shifted field would give a
/// committee that is not the next committee.
#[test]
fn every_fork_parses_to_the_values_that_were_written() {
    for (fork, fields) in FORKS.into_iter().zip([28, 28, 37, 38]) {
        let (state, _) = state_of(fork);
        let parsed = parse(&state);
        assert_eq!(parsed.field_roots.len(), fields, "{fork:?}");
        assert_eq!(parsed.slot, state.slot, "{fork:?}");
        assert_eq!(parsed.fork, state.fork_data, "{fork:?}");
        assert_eq!(parsed.current_sync_committee, state.current_committee, "{fork:?}");
        assert_eq!(parsed.next_sync_committee, state.next_committee, "{fork:?}");
        assert_ne!(parsed.current_sync_committee, parsed.next_sync_committee, "{fork:?}: the control must differ");
        assert_eq!(parsed.finalized_checkpoint, state.finalized_checkpoint, "{fork:?}");
        assert_eq!(parsed.block_roots, state.block_roots, "{fork:?}");
        assert_eq!(parsed.historical_summaries, state.historical_summaries, "{fork:?}");
        assert_eq!(state_slot(&state.to_ssz()), Ok(state.slot), "{fork:?}");
    }
}

/// Claim: on a state of each fork, the branches for the next committee, the current committee, the finalized root,
/// `block_roots` and `historical_summaries` verify at the generalized indices of `state_layout_for_fork`, and the
/// branch of another layout does not verify at them.
/// Why it matters: the light-client program and the bridge check these indices. If the table and the parser disagreed,
/// every Electra update would fail on chain, or worse, a branch would verify against the wrong field.
#[test]
fn branches_verify_at_the_layout_indices_of_each_fork() {
    for fork in FORKS {
        let layout = state_layout_for_fork(fork).expect("layout");
        let (state, roots) = state_of(fork);
        let parsed = parse(&state);
        let root = parsed.root();
        let field_branch = |index: usize| branch_for_leaf(&parsed.field_roots, index).1;

        let next_leaf = parsed.next_sync_committee.hash_tree_root().unwrap();
        assert!(
            is_valid_exact_branch(&next_leaf, &field_branch(23), layout.next_sync_committee_gindex, &root),
            "{fork:?} next"
        );
        let current_leaf = parsed.current_sync_committee.hash_tree_root().unwrap();
        assert!(
            is_valid_exact_branch(&current_leaf, &field_branch(22), layout.current_sync_committee_gindex, &root),
            "{fork:?} current"
        );

        let mut finality = vec![u64_chunk(parsed.finalized_checkpoint.0)];
        finality.extend(field_branch(20));
        assert!(
            is_valid_exact_branch(&parsed.finalized_checkpoint.1, &finality, layout.finalized_root_gindex, &root),
            "{fork:?} finality"
        );

        let slot = state.slot - 50;
        let recent = recent_ancestry_branch(&parsed, slot);
        let recent_gindex = block_roots_leaf_gindex(layout.block_roots_gindex, slot).unwrap();
        assert!(
            is_valid_exact_branch(&parsed.block_roots[(slot % 8192) as usize], &recent, recent_gindex, &root),
            "{fork:?} recent"
        );

        let historical_slot = 8192 * 2 + 77;
        let capella_era = 2;
        let historical =
            historical_ancestry_branch(&parsed, capella_era, historical_slot, &roots).expect("historical branch");
        let historical_gindex = historical_leaf_gindex(layout.historical_summaries_gindex, 0, historical_slot).unwrap();
        let leaf = roots[(historical_slot % 8192) as usize];
        assert!(is_valid_exact_branch(&leaf, &historical, historical_gindex, &root), "{fork:?} historical");

        let other = if layout == ELECTRA_STATE_LAYOUT { CAPELLA_DENEB_STATE_LAYOUT } else { ELECTRA_STATE_LAYOUT };
        assert!(
            !is_valid_exact_branch(&next_leaf, &field_branch(23), other.next_sync_committee_gindex, &root),
            "{fork:?}: the other layout must fail"
        );
        assert!(
            !is_valid_exact_branch(&parsed.finalized_checkpoint.1, &finality, other.finalized_root_gindex, &root),
            "{fork:?}: the other layout must fail"
        );
    }
}

/// The root of `PendingDeposit` written by hand: five leaves padded to eight.
fn hand_pending_deposit_root(bytes: &[u8; 192]) -> B256 {
    let chunk = |range: std::ops::Range<usize>| B256::right_padding_from(&bytes[range]);
    let public_key = hash_pair(&chunk(0..32), &chunk(32..48));
    let signature = hash_pair(&hash_pair(&chunk(88..120), &chunk(120..152)), &hash_pair(&chunk(152..184), &B256::ZERO));
    let left = hash_pair(&hash_pair(&public_key, &chunk(48..80)), &hash_pair(&chunk(80..88), &signature));
    let right = hash_pair(&hash_pair(&chunk(184..192), &B256::ZERO), &hash_pair(&B256::ZERO, &B256::ZERO));
    hash_pair(&left, &right)
}

/// Claim: the nine Electra fields hash as the specification says: six counters as `uint64` chunks, then three lists
/// with limits 2^27, 2^27 and 2^18, mixed with their length. The expected roots are written by hand from the container
/// definitions, so the test fails when the parser swaps two fields, uses a wrong limit or a wrong element size.
/// Why it matters: the state root covers these fields. One error and no Electra state hashes to its header.
#[test]
fn electra_fields_hash_by_the_specification() {
    let (mut state, _) = state_of(ForkName::Electra);
    state.electra_counters = [11, 22, 33, 44, 55, 66];
    state.pending_deposits = (0..3u8).map(|index| [index + 1; 192]).collect();
    state.pending_partial_withdrawals = vec![[9; 24], [10; 24]];
    state.pending_consolidations = vec![[7; 16]];
    let parsed = parse(&state);
    for (offset, value) in [11u64, 22, 33, 44, 55, 66].into_iter().enumerate() {
        assert_eq!(parsed.field_roots[28 + offset], u64_chunk(value), "counter {offset}");
    }
    let deposits: Vec<B256> = state.pending_deposits.iter().map(hand_pending_deposit_root).collect();
    assert_eq!(parsed.field_roots[34], mix_in_length(&merkleize_with_limit(&deposits, 1 << 27), 3));
    let withdrawal = |bytes: &[u8; 24]| {
        let leaf = |range: std::ops::Range<usize>| u64_chunk(u64::from_le_bytes(bytes[range].try_into().unwrap()));
        hash_pair(&hash_pair(&leaf(0..8), &leaf(8..16)), &hash_pair(&leaf(16..24), &B256::ZERO))
    };
    let withdrawals: Vec<B256> = state.pending_partial_withdrawals.iter().map(withdrawal).collect();
    assert_eq!(parsed.field_roots[35], mix_in_length(&merkleize_with_limit(&withdrawals, 1 << 27), 2));
    let consolidation = hash_pair(&u64_chunk(u64::from_le_bytes([7; 8])), &u64_chunk(u64::from_le_bytes([7; 8])));
    assert_eq!(parsed.field_roots[36], mix_in_length(&merkleize_with_limit(&[consolidation], 1 << 18), 1));
    assert_eq!(parsed.root(), merkleize(&parsed.field_roots));
}

/// Claim: empty Electra queues hash to the empty list roots, and a state that differs only in one queue entry has a
/// different root.
/// Why it matters: a parser that dropped the queues would still pass the empty case. The second half catches it.
#[test]
fn electra_queues_change_the_state_root() {
    let (empty, _) = state_of(ForkName::Electra);
    let (mut filled, _) = state_of(ForkName::Electra);
    filled.pending_consolidations = vec![[1; 16]];
    let empty_root = parse(&empty).root();
    assert_ne!(empty_root, parse(&filled).root());
    let parsed = parse(&empty);
    assert_eq!(parsed.field_roots[34], mix_in_length(&lc_core::ssz::zero_hash(27), 0));
    assert_eq!(parsed.field_roots[36], mix_in_length(&lc_core::ssz::zero_hash(18), 0));
}

/// Claim: the Fulu field `proposer_lookahead` (64 indices, 16 packed chunks) is field 37, and its root follows from
/// the packing of four `uint64` per chunk. The Electra fields before it keep their positions.
/// Why it matters: Ethereum runs Fulu. A parser without this field cannot hash a state of today.
#[test]
fn fulu_lookahead_is_field_thirty_seven() {
    let (mut state, _) = state_of(ForkName::Fulu);
    state.electra_counters = [1, 2, 3, 4, 5, 6];
    state.proposer_lookahead = std::array::from_fn(|index| 1000 + index as u64);
    let parsed = parse(&state);
    assert_eq!(parsed.field_roots.len(), 38);
    assert_eq!(parsed.field_roots[28], u64_chunk(1));
    let chunks: Vec<B256> = state
        .proposer_lookahead
        .chunks(4)
        .map(|four| B256::from_slice(&four.iter().flat_map(|index| index.to_le_bytes()).collect::<Vec<u8>>()))
        .collect();
    assert_eq!(chunks.len(), 16);
    assert_eq!(parsed.field_roots[37], merkleize(&chunks));
    let mut changed = state.proposer_lookahead;
    changed[63] += 1;
    state.proposer_lookahead = changed;
    assert_ne!(parse(&state).root(), parsed.root(), "the lookahead is part of the state root");
}

/// Claim: a parser of the wrong form refuses the bytes of a state. The Capella parser refuses Deneb and Electra
/// bytes, and the Electra parser refuses Capella and Fulu bytes. Forks without a parser are named in the error.
/// Why it matters: the prover picks the form from the slot. A wrong pick must fail loudly and not give a shifted state.
#[test]
fn a_wrong_form_is_refused() {
    for fork in [ForkName::Deneb, ForkName::Electra] {
        let (state, _) = state_of(fork);
        assert!(matches!(try_parse_state(&state.to_ssz()), Err(Error::MalformedSsz(_))), "{fork:?} as Capella");
    }
    let (capella, _) = state_of(ForkName::Capella);
    let result = try_parse_state_for_fork(&capella.to_ssz(), ForkName::Electra);
    assert!(matches!(result, Err(Error::MalformedSsz(_))), "Capella as Electra");
    let (fulu, _) = state_of(ForkName::Fulu);
    let result = try_parse_state_for_fork(&fulu.to_ssz(), ForkName::Electra);
    assert!(matches!(result, Err(Error::MalformedSsz(_))), "Fulu as Electra");
    for fork in [ForkName::Altair, ForkName::Gloas] {
        assert_eq!(try_parse_state_for_fork(&capella.to_ssz(), fork).err(), Some(Error::UnsupportedFork { fork }));
    }
    assert_eq!(StateForm::for_fork(ForkName::Electra), Ok(StateForm::Electra));
}
