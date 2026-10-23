//! The signer key of a sync aggregate is the committee aggregate key minus the keys of the members who did not sign
//! (`lc_core::bls::verify_aggregate_by_subtraction`). These tests cover the edges of that rule: every member signs,
//! the least number sign, a key that cannot be decompressed, and a committee whose aggregate key is not the sum of its keys.

use alloy_primitives::B256;
use bls12_381::{G1Affine, G1Projective, Scalar};
use lc_core::bls::AGGREGATE_KEY_INDEX;
use lc_core::chain::{ChainSpec, DOMAIN_SYNC_COMMITTEE, MIN_PARTICIPANTS, PULSECHAIN, SYNC_COMMITTEE_SIZE};
use lc_core::types::{compute_domain, compute_signing_root, BlsPublicKey, SyncAggregate, SyncCommittee};
use lc_core::update::{verify_light_client_update, verify_sync_aggregate};
use lc_core::Error;
use lc_testkit::synthetic::{aggregate_sign, build_update, committee_for, TestCommittee, UpdateRecipe};

const FORK_VERSION: [u8; 4] = [0, 0, 3, 0x6d];

fn spec() -> &'static ChainSpec {
    &PULSECHAIN
}

fn committee() -> std::sync::Arc<TestCommittee> {
    committee_for(spec(), 1)
}

fn signed_root() -> B256 {
    B256::repeat_byte(0x5a)
}

fn signing_root() -> B256 {
    let domain = compute_domain(DOMAIN_SYNC_COMMITTEE, FORK_VERSION, &spec().genesis_validators_root);
    compute_signing_root(&signed_root(), &domain)
}

/// The aggregate of the members at `signers`: their bits and the signature that only they produce.
fn aggregate_of(committee: &TestCommittee, signers: &[usize]) -> SyncAggregate {
    let mut bits = [0u8; SYNC_COMMITTEE_SIZE / 8];
    for index in signers {
        bits[index / 8] |= 1 << (index % 8);
    }
    let secrets: Vec<Scalar> = signers.iter().map(|index| committee.secrets[*index]).collect();
    SyncAggregate { sync_committee_bits: bits, sync_committee_signature: aggregate_sign(&secrets, &signing_root()) }
}

fn verify(committee: &SyncCommittee, aggregate: &SyncAggregate) -> lc_core::Result<()> {
    verify_sync_aggregate(spec(), committee, aggregate, &signed_root(), FORK_VERSION)
}

fn decode(key: &BlsPublicKey) -> G1Projective {
    G1Projective::from(G1Affine::from_compressed(&key.0).unwrap())
}

fn encode(point: G1Projective) -> BlsPublicKey {
    BlsPublicKey::from(G1Affine::from(point).to_compressed())
}

fn all_members() -> Vec<usize> {
    (0..SYNC_COMMITTEE_SIZE).collect()
}

/// Claim: when all 512 members sign, nothing is subtracted and the signature verifies against the aggregate key alone.
#[test]
fn all_512_members_signing_verify() {
    let test_committee = committee();
    let aggregate = aggregate_of(&test_committee, &all_members());
    assert_eq!(aggregate.participant_count(), SYNC_COMMITTEE_SIZE);
    assert_eq!(verify(&test_committee.committee, &aggregate), Ok(()));
}

/// Claim: with exactly 342 signers (the least the bridge accepts) the 170 absent members are scattered over the
/// committee and the check still verifies, at the signature check and through the full update rules.
/// Why it matters: the subtraction must remove the right keys, whatever their positions.
#[test]
fn exactly_342_members_signing_verify() {
    let test_committee = committee();
    let signers: Vec<usize> = (0..SYNC_COMMITTEE_SIZE).filter(|index| index % 3 != 0 || *index >= 510).collect();
    assert_eq!(signers.len(), MIN_PARTICIPANTS, "the pattern has 342 signers");
    let aggregate = aggregate_of(&test_committee, &signers);
    assert_eq!(verify(&test_committee.committee, &aggregate), Ok(()));

    let recipe = UpdateRecipe {
        store_slot: 10_871_000,
        finalized_slot: 10_872_000,
        attested_slot: 10_872_070,
        signature_slot: 10_872_071,
        participants: MIN_PARTICIPANTS,
        include_next_committee: true,
        store_knows_next_committee: false,
    };
    let scenario = build_update(spec(), recipe);
    assert!(verify_light_client_update(&scenario.store, &scenario.update, scenario.spec).is_ok());
}

/// Claim: a bit set for a member who did not sign is refused, and so is a signature without the bit of its signer.
/// Why it matters: the bits decide which keys leave the aggregate, so a wrong bit must break the equation.
#[test]
fn a_wrong_participation_bit_is_refused() {
    let test_committee = committee();
    let signers: Vec<usize> = (0..400).collect();
    let honest = aggregate_of(&test_committee, &signers);
    assert_eq!(verify(&test_committee.committee, &honest), Ok(()));

    let mut claims_a_missing_signer = honest.clone();
    claims_a_missing_signer.sync_committee_bits[450 / 8] |= 1 << (450 % 8);
    assert_eq!(verify(&test_committee.committee, &claims_a_missing_signer), Err(Error::SignatureVerificationFailed));

    let mut hides_a_signer = honest;
    hides_a_signer.sync_committee_bits[0] &= !1;
    assert_eq!(verify(&test_committee.committee, &hides_a_signer), Err(Error::SignatureVerificationFailed));
}

/// Claim: nobody signing is refused.
#[test]
fn no_signer_is_refused() {
    let test_committee = committee();
    let aggregate = aggregate_of(&test_committee, &[]);
    assert_eq!(verify(&test_committee.committee, &aggregate), Err(Error::SignatureVerificationFailed));
}

/// Claim: a member who did not sign and whose key is not a valid point is refused, and the error names the member.
/// A signer with the same bad key is not noticed, because the signer keys are never decompressed. The committee hash
/// differs in both cases, so the contract refuses that committee.
/// Why it matters: this documents the exact reach of the check, so nobody reads it as full key validation.
#[test]
fn an_invalid_key_is_refused_for_an_absent_member_and_unnoticed_for_a_signer() {
    let test_committee = committee();
    let signers: Vec<usize> = (0..400).collect();
    let aggregate = aggregate_of(&test_committee, &signers);
    let not_a_point = BlsPublicKey::from([1u8; 48]);

    let mut absent_is_bad = test_committee.committee.clone();
    absent_is_bad.pubkeys[450] = not_a_point;
    assert_eq!(verify(&absent_is_bad, &aggregate), Err(Error::InvalidPublicKey { index: 450 }));

    let mut signer_is_bad = test_committee.committee.clone();
    signer_is_bad.pubkeys[7] = not_a_point;
    assert_eq!(verify(&signer_is_bad, &aggregate), Ok(()), "the program does not look at signer keys");
    let honest_hash = test_committee.committee.hash_tree_root().unwrap();
    assert_ne!(signer_is_bad.hash_tree_root().unwrap(), honest_hash, "the contract binds the keys through the hash");
    assert_ne!(absent_is_bad.hash_tree_root().unwrap(), honest_hash);
}

/// Claim: a committee whose `aggregate_pubkey` is not the sum of its keys changes what the program accepts, and its
/// hash differs from the honest hash. An honest chain never builds such a committee. The program does not check the
/// sum, so only the committee root, which the contract binds, stops it.
/// Here the attacker keeps the 512 keys and sets `aggregate_pubkey` to `secret * generator` plus the keys of the absent
/// members. The signer key then is `secret * generator`, and the attacker signs alone with `secret`.
#[test]
fn an_aggregate_key_that_is_not_the_sum_is_accepted_by_the_program_and_refused_by_the_hash() {
    let test_committee = committee();
    let signers: Vec<usize> = (0..400).collect();
    let honest_aggregate = aggregate_of(&test_committee, &signers);
    assert_eq!(verify(&test_committee.committee, &honest_aggregate), Ok(()), "control: the honest committee verifies");

    let attacker_secret = Scalar::from(0xbad_5eed_u64);
    let absent_sum = (400..SYNC_COMMITTEE_SIZE)
        .map(|index| decode(&test_committee.committee.pubkeys[index]))
        .fold(G1Projective::identity(), |sum, key| sum + key);
    let mut forged = test_committee.committee.clone();
    forged.aggregate_pubkey = encode(G1Projective::generator() * attacker_secret + absent_sum);

    assert_eq!(
        verify(&forged, &honest_aggregate),
        Err(Error::SignatureVerificationFailed),
        "the real signers cannot sign for the forged aggregate"
    );
    let attacker_signature = aggregate_sign(&[attacker_secret], &signing_root());
    let attacker_aggregate = SyncAggregate { sync_committee_signature: attacker_signature, ..honest_aggregate };
    assert_eq!(verify(&forged, &attacker_aggregate), Ok(()), "the program trusts the aggregate key");

    let honest_hash = test_committee.committee.hash_tree_root().unwrap();
    assert_ne!(forged.hash_tree_root().unwrap(), honest_hash, "the contract refuses the forged committee by its hash");
}

/// Claim: an aggregate key at infinity is refused as an invalid key, and a signer key that sums to infinity is refused
/// even with the signature that would satisfy the pairing equation for it (the point at infinity).
/// Why it matters: with a zero key, the equation `e(0, message) == e(generator, 0)` holds for any message.
#[test]
fn an_aggregate_key_at_infinity_and_a_zero_signer_key_are_refused() {
    let test_committee = committee();
    let signers: Vec<usize> = (0..400).collect();
    let honest = aggregate_of(&test_committee, &signers);
    let mut infinity = [0u8; 48];
    infinity[0] = 0xc0;
    let mut infinity_signature = [0u8; 96];
    infinity_signature[0] = 0xc0;
    let forged_aggregate = SyncAggregate { sync_committee_signature: infinity_signature, ..honest.clone() };

    let mut identity_aggregate = test_committee.committee.clone();
    identity_aggregate.aggregate_pubkey = BlsPublicKey::from(infinity);
    assert_eq!(
        verify(&identity_aggregate, &forged_aggregate),
        Err(Error::InvalidPublicKey { index: AGGREGATE_KEY_INDEX })
    );

    let absent_sum = (400..SYNC_COMMITTEE_SIZE)
        .map(|index| decode(&test_committee.committee.pubkeys[index]))
        .fold(G1Projective::identity(), |sum, key| sum + key);
    let mut zero_signer_key = test_committee.committee.clone();
    zero_signer_key.aggregate_pubkey = encode(absent_sum);
    assert_eq!(verify(&zero_signer_key, &forged_aggregate), Err(Error::SignatureVerificationFailed));
}
