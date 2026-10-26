//! Parser and hasher for the Gloas `BeaconState` (`specs/gloas/beacon-chain.md`, "Modified containers", `BeaconState`).
//!
//! The Gloas state is a progressive container of 46 fields (`eip-7495.md`). Its root is
//! `hash(merkleize_progressive(field_roots), active_fields)`, and its big lists are progressive lists
//! (`eip-7916.md`): `hash(merkleize_progressive(chunks), length)`. The serialization is the one of a plain container, so the
//! offsets and the fixed part follow the same rules as in [`crate::ssz_state`].
//!
//! The checks of this file are the roots themselves: the computed state root must equal the `state_root` of the block header
//! that names the state. A wrong field list, a wrong list type or a wrong limit gives another root, and the caller stops.
//! The tests of `lc-testkit` hash a real Sepolia state this way.
//!
//! Limits and sizes are the mainnet preset: `SLOTS_PER_HISTORICAL_ROOT` 8192, `EPOCHS_PER_HISTORICAL_VECTOR` 65536,
//! `EPOCHS_PER_SLASHINGS_VECTOR` 8192, `PTC_SIZE` 512, `SLOTS_PER_EPOCH` 32.

use crate::error::Result;
use crate::layout::ContainerShape;
use crate::ssz::{
    byte_vector_root, hash_pair, merkleize, merkleize_progressive, mix_in_length, pack_bytes,
    progressive_container_root, u64_chunk,
};
use crate::ssz_state::{
    checkpoint_root, chunk32, eth1_data_root, fixed_list_roots, le_u64, list_root, malformed,
    pending_consolidation_root, pending_deposit_root, pending_partial_withdrawal_root, split_container,
    try_parse_sync_committee, validator_root, ForkData, Kind, ParsedState,
};
use crate::types::BeaconBlockHeader;
use alloy_primitives::B256;

/// The number of fields of the Gloas `BeaconState`.
pub const GLOAS_STATE_FIELD_COUNT: usize = 46;

/// The position of `latest_block_hash` among the Gloas `BeaconState` fields.
pub const GLOAS_FIELD_LATEST_BLOCK_HASH: usize = 24;

/// The limit used for progressive lists. A progressive list has no SSZ limit. The bytes of the input bound it in practice.
const PROGRESSIVE_LIMIT: u64 = 1 << 40;

/// `BuilderPendingPayment`: `weight` (8), `withdrawal` (36) and `proposer_index` (8).
const BUILDER_PENDING_PAYMENT_SIZE: usize = 52;
/// `BuilderPendingWithdrawal`: `fee_recipient` (20), `amount` (8) and `builder_index` (8).
const BUILDER_PENDING_WITHDRAWAL_SIZE: usize = 36;
/// `Builder`: `pubkey` (48), `version` (1), `execution_address` (20), `balance`, `deposit_epoch`, `withdrawable_epoch` (8 each).
const BUILDER_SIZE: usize = 93;
/// `Withdrawal`: `index` (8), `validator_index` (8), `address` (20), `amount` (8).
const WITHDRAWAL_SIZE: usize = 44;
/// `BuilderPendingPayments` holds `2 * SLOTS_PER_EPOCH` payments.
const BUILDER_PENDING_PAYMENTS: usize = 64;
/// `PayloadTimelinessCommitteeWindow` holds `(MIN_SEED_LOOKAHEAD + 2) * SLOTS_PER_EPOCH` committees of `PTC_SIZE` indices.
const PTC_WINDOW_COMMITTEES: usize = 96;
const PTC_SIZE: usize = 512;

/// The SSZ field kinds of the Gloas `BeaconState`, in field order.
fn kinds() -> Vec<Kind> {
    use Kind::{Fixed, Variable};
    vec![
        Fixed(8),                                                       // 0 genesis_time
        Fixed(32),                                                      // 1 genesis_validators_root
        Fixed(8),                                                       // 2 slot
        Fixed(16),                                                      // 3 fork
        Fixed(112),                                                     // 4 latest_block_header
        Fixed(8192 * 32),                                               // 5 block_roots
        Fixed(8192 * 32),                                               // 6 state_roots
        Variable,                                                       // 7 historical_roots
        Fixed(72),                                                      // 8 eth1_data
        Variable,                                                       // 9 eth1_data_votes
        Fixed(8),                                                       // 10 eth1_deposit_index
        Variable,                                                       // 11 validators
        Variable,                                                       // 12 balances
        Fixed(65536 * 32),                                              // 13 randao_mixes
        Fixed(8192 * 8),                                                // 14 slashings
        Variable,                                                       // 15 previous_epoch_participation
        Variable,                                                       // 16 current_epoch_participation
        Fixed(1),                                                       // 17 justification_bits
        Fixed(40),                                                      // 18 previous_justified_checkpoint
        Fixed(40),                                                      // 19 current_justified_checkpoint
        Fixed(40),                                                      // 20 finalized_checkpoint
        Variable,                                                       // 21 inactivity_scores
        Fixed(24624),                                                   // 22 current_sync_committee
        Fixed(24624),                                                   // 23 next_sync_committee
        Fixed(32),                                                      // 24 latest_block_hash
        Fixed(8),                                                       // 25 next_withdrawal_index
        Fixed(8),                                                       // 26 next_withdrawal_validator_index
        Variable,                                                       // 27 historical_summaries
        Fixed(8),                                                       // 28 deposit_requests_start_index
        Fixed(8),                                                       // 29 deposit_balance_to_consume
        Fixed(8),                                                       // 30 exit_balance_to_consume
        Fixed(8),                                                       // 31 earliest_exit_epoch
        Fixed(8),                                                       // 32 consolidation_balance_to_consume
        Fixed(8),                                                       // 33 earliest_consolidation_epoch
        Variable,                                                       // 34 pending_deposits
        Variable,                                                       // 35 pending_partial_withdrawals
        Variable,                                                       // 36 pending_consolidations
        Fixed(64 * 8),                                                  // 37 proposer_lookahead
        Variable,                                                       // 38 builders
        Fixed(8),                                                       // 39 next_withdrawal_builder_index
        Fixed(8192 / 8),                                                // 40 execution_payload_availability
        Fixed(BUILDER_PENDING_PAYMENTS * BUILDER_PENDING_PAYMENT_SIZE), // 41 builder_pending_payments
        Variable,                                                       // 42 builder_pending_withdrawals
        Variable,                                                       // 43 latest_execution_payload_bid
        Variable,                                                       // 44 payload_expected_withdrawals
        Fixed(PTC_WINDOW_COMMITTEES * PTC_SIZE * 8),                    // 45 ptc_window
    ]
}

/// The root of a progressive list whose elements hash to `element_roots`.
fn progressive_list_root(element_roots: &[B256]) -> B256 {
    mix_in_length(&merkleize_progressive(element_roots), element_roots.len() as u64)
}

/// The root of a progressive list of basic values: `bytes` packs into chunks, `length` counts the values.
fn progressive_packed_root(bytes: &[u8], length: u64) -> B256 {
    mix_in_length(&merkleize_progressive(&pack_bytes(bytes)), length)
}

/// A 20 byte address as a chunk: right-padded with zeros.
fn address_chunk(bytes: &[u8]) -> B256 {
    B256::right_padding_from(bytes)
}

/// `Builder`: six fields.
fn builder_root(bytes: &[u8]) -> B256 {
    let mut version = [0u8; 32];
    version[0] = bytes[48];
    merkleize(&[
        byte_vector_root(&bytes[0..48]),
        B256::from(version),
        address_chunk(&bytes[49..69]),
        u64_chunk(le_u64(&bytes[69..77])),
        u64_chunk(le_u64(&bytes[77..85])),
        u64_chunk(le_u64(&bytes[85..93])),
    ])
}

/// `BuilderPendingWithdrawal`: `fee_recipient`, `amount`, `builder_index`.
fn builder_pending_withdrawal_root(bytes: &[u8]) -> B256 {
    merkleize(&[address_chunk(&bytes[0..20]), u64_chunk(le_u64(&bytes[20..28])), u64_chunk(le_u64(&bytes[28..36]))])
}

/// `BuilderPendingPayment`: `weight`, `withdrawal`, `proposer_index`.
fn builder_pending_payment_root(bytes: &[u8]) -> B256 {
    merkleize(&[
        u64_chunk(le_u64(&bytes[0..8])),
        builder_pending_withdrawal_root(&bytes[8..44]),
        u64_chunk(le_u64(&bytes[44..52])),
    ])
}

/// `Withdrawal`: `index`, `validator_index`, `address`, `amount`.
fn withdrawal_root(bytes: &[u8]) -> B256 {
    merkleize(&[
        u64_chunk(le_u64(&bytes[0..8])),
        u64_chunk(le_u64(&bytes[8..16])),
        address_chunk(&bytes[16..36]),
        u64_chunk(le_u64(&bytes[36..44])),
    ])
}

/// `ExecutionPayloadBid`: a progressive container of 12 fields. `blob_kzg_commitments` is the only variable field.
fn execution_payload_bid_root(bytes: &[u8]) -> Result<B256> {
    use Kind::{Fixed, Variable};
    let f = split_container(
        bytes,
        &[
            Fixed(32),
            Fixed(32),
            Fixed(32),
            Fixed(32),
            Fixed(20),
            Fixed(8),
            Fixed(8),
            Fixed(8),
            Fixed(8),
            Fixed(8),
            Variable,
            Fixed(32),
        ],
    )?;
    if !f[10].len().is_multiple_of(48) {
        return malformed("blob_kzg_commitments is not a whole number of 48 byte commitments");
    }
    let commitments: Vec<B256> = f[10].chunks_exact(48).map(byte_vector_root).collect();
    Ok(progressive_container_root(&[
        chunk32(f[0]),
        chunk32(f[1]),
        chunk32(f[2]),
        chunk32(f[3]),
        address_chunk(f[4]),
        u64_chunk(le_u64(f[5])),
        u64_chunk(le_u64(f[6])),
        u64_chunk(le_u64(f[7])),
        u64_chunk(le_u64(f[8])),
        u64_chunk(le_u64(f[9])),
        progressive_list_root(&commitments),
        chunk32(f[11]),
    ]))
}

/// Parses and hashes a Gloas `BeaconState`.
///
/// # Errors
/// `MalformedSsz` when the bytes break an SSZ rule. Nothing is allocated before the offsets are checked.
pub(crate) fn try_parse_gloas_state(bytes: &[u8]) -> Result<ParsedState> {
    let f = split_container(bytes, &kinds())?;
    let header = |slice: &[u8]| {
        BeaconBlockHeader {
            slot: le_u64(&slice[0..8]),
            proposer_index: le_u64(&slice[8..16]),
            parent_root: chunk32(&slice[16..48]),
            state_root: chunk32(&slice[48..80]),
            body_root: chunk32(&slice[80..112]),
        }
        .hash_tree_root()
    };
    let fork = ForkData::from_ssz(f[3]);
    let root_chunks = |slice: &[u8]| -> Vec<B256> { slice.chunks_exact(32).map(chunk32).collect() };
    let eth1_votes = fixed_list_roots(f[9], 72, 2048, eth1_data_root)?;
    let validators = fixed_list_roots(f[11], 121, PROGRESSIVE_LIMIT, validator_root)?;
    if !f[7].len().is_multiple_of(32) || (f[7].len() / 32) as u64 > 1 << 24 {
        return malformed("historical_roots is not a whole list of at most 2^24 roots");
    }
    let historical_roots = root_chunks(f[7]);
    let summaries =
        fixed_list_roots(f[27], 64, 1 << 24, |item| hash_pair(&chunk32(&item[0..32]), &chunk32(&item[32..64])))?;
    let pending_deposits = fixed_list_roots(f[34], 192, PROGRESSIVE_LIMIT, pending_deposit_root)?;
    let pending_partial_withdrawals = fixed_list_roots(f[35], 24, PROGRESSIVE_LIMIT, pending_partial_withdrawal_root)?;
    let pending_consolidations = fixed_list_roots(f[36], 16, PROGRESSIVE_LIMIT, pending_consolidation_root)?;
    let builders = fixed_list_roots(f[38], BUILDER_SIZE, PROGRESSIVE_LIMIT, builder_root)?;
    let builder_pending_payments = fixed_list_roots(
        f[41],
        BUILDER_PENDING_PAYMENT_SIZE,
        BUILDER_PENDING_PAYMENTS as u64,
        builder_pending_payment_root,
    )?;
    let builder_pending_withdrawals =
        fixed_list_roots(f[42], BUILDER_PENDING_WITHDRAWAL_SIZE, PROGRESSIVE_LIMIT, builder_pending_withdrawal_root)?;
    let payload_expected_withdrawals = fixed_list_roots(f[44], WITHDRAWAL_SIZE, PROGRESSIVE_LIMIT, withdrawal_root)?;
    let ptc_committees: Vec<B256> = f[45].chunks_exact(PTC_SIZE * 8).map(|item| merkleize(&pack_bytes(item))).collect();
    let mut justification = [0u8; 32];
    justification[0] = f[17][0];
    let committees = (try_parse_sync_committee(f[22])?, try_parse_sync_committee(f[23])?);
    let field_roots = vec![
        u64_chunk(le_u64(f[0])),
        chunk32(f[1]),
        u64_chunk(le_u64(f[2])),
        fork.hash_tree_root(),
        header(f[4]),
        merkleize(&root_chunks(f[5])),
        merkleize(&root_chunks(f[6])),
        list_root(&historical_roots, 1 << 24),
        eth1_data_root(f[8]),
        list_root(&eth1_votes, 2048),
        u64_chunk(le_u64(f[10])),
        progressive_list_root(&validators),
        progressive_packed_root(f[12], (f[12].len() / 8) as u64),
        merkleize(&root_chunks(f[13])),
        merkleize(&pack_bytes(f[14])),
        progressive_packed_root(f[15], f[15].len() as u64),
        progressive_packed_root(f[16], f[16].len() as u64),
        B256::from(justification),
        checkpoint_root(f[18]),
        checkpoint_root(f[19]),
        checkpoint_root(f[20]),
        progressive_packed_root(f[21], (f[21].len() / 8) as u64),
        committees.0.hash_tree_root()?,
        committees.1.hash_tree_root()?,
        chunk32(f[24]),
        u64_chunk(le_u64(f[25])),
        u64_chunk(le_u64(f[26])),
        list_root(&summaries, 1 << 24),
        u64_chunk(le_u64(f[28])),
        u64_chunk(le_u64(f[29])),
        u64_chunk(le_u64(f[30])),
        u64_chunk(le_u64(f[31])),
        u64_chunk(le_u64(f[32])),
        u64_chunk(le_u64(f[33])),
        progressive_list_root(&pending_deposits),
        progressive_list_root(&pending_partial_withdrawals),
        progressive_list_root(&pending_consolidations),
        merkleize(&pack_bytes(f[37])),
        progressive_list_root(&builders),
        u64_chunk(le_u64(f[39])),
        merkleize(&pack_bytes(f[40])),
        merkleize(&builder_pending_payments),
        progressive_list_root(&builder_pending_withdrawals),
        execution_payload_bid_root(f[43])?,
        progressive_list_root(&payload_expected_withdrawals),
        merkleize(&ptc_committees),
    ];
    debug_assert_eq!(field_roots.len(), GLOAS_STATE_FIELD_COUNT);
    Ok(ParsedState {
        field_roots,
        block_roots: root_chunks(f[5]),
        current_sync_committee: committees.0,
        next_sync_committee: committees.1,
        slot: le_u64(f[2]),
        fork,
        finalized_checkpoint: (le_u64(f[20]), chunk32(&f[20][8..40])),
        historical_summaries: f[27]
            .chunks_exact(64)
            .map(|item| (chunk32(&item[0..32]), chunk32(&item[32..64])))
            .collect(),
        shape: ContainerShape::Progressive { width: GLOAS_STATE_FIELD_COUNT },
    })
}
