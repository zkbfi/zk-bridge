//! Sepolia (chain 11155111) and PulseChain testnet v4 (chain 943).
//!
//! The constants are compared with the raw beacon responses in `tests/fixtures/sepolia/` and
//! `tests/fixtures/pulsechain-testnet-v4/`. The updates are SYNTHETIC: generated committees signed for real, with the
//! test-only state builder.

use alloy_primitives::{hex, B256};
use lc_core::abi::LightClientOutput;
use lc_core::chain::{ChainSpec, ForkName, FAR_FUTURE_EPOCH, PULSECHAIN_TESTNET_V4, SEPOLIA};
use lc_core::types::sync_committee_domain;
use lc_core::update::{table_fork_version, verify_light_client_update, FoldStep};
use lc_core::wire::{decode_guest_input, encode_guest_input, run_light_client_guest, ChainSelector, GuestInput};
use lc_core::Error;
use lc_testkit::json::{hex_b256, load_response};
use lc_testkit::synthetic::{build_update, UpdateRecipe};

/// Checks one chain against the three fixtures of its directory. `genesis_time` and `seconds_per_slot` are written by hand.
fn check_against_fixtures(spec: &ChainSpec, directory: &str, config_name: &str, genesis_time: u64, seconds: u64) {
    let configuration = load_response(&format!("{directory}/chain_spec.json"));
    let genesis = load_response(&format!("{directory}/genesis.json"));
    let schedule = load_response(&format!("{directory}/fork_schedule.json"));
    let data = &configuration["data"];
    assert_eq!(data["CONFIG_NAME"].as_str(), Some(config_name));
    assert_eq!(spec.name, config_name);
    assert_eq!(hex_b256(&genesis["data"]["genesis_validators_root"]), spec.genesis_validators_root);
    assert_eq!(genesis["data"]["genesis_time"].as_str().unwrap().parse::<u64>().unwrap(), genesis_time);

    let number = |key: &str| -> u64 { data[key].as_str().unwrap().parse().unwrap() };
    assert_eq!(number("SECONDS_PER_SLOT"), seconds);
    assert_eq!(spec.seconds_per_slot, seconds);
    assert_eq!(number("SLOTS_PER_EPOCH"), spec.slots_per_epoch);
    assert_eq!(number("EPOCHS_PER_SYNC_COMMITTEE_PERIOD"), spec.epochs_per_sync_committee_period);
    assert_eq!(number("SYNC_COMMITTEE_SIZE"), 512);
    assert_eq!(number("SLOTS_PER_HISTORICAL_ROOT"), lc_core::layout::SLOTS_PER_HISTORICAL_ROOT);
    assert_eq!(number("HISTORICAL_ROOTS_LIMIT"), 1 << lc_core::layout::HISTORICAL_SUMMARIES_LIST_DEPTH);
    assert_eq!(data["DOMAIN_SYNC_COMMITTEE"].as_str().unwrap(), "0x07000000");

    // The configuration agrees with every entry of the table, and the table has no entry that the configuration lacks.
    let mut table_names = Vec::new();
    for entry in spec.fork_schedule {
        let name = format!("{:?}", entry.fork_name).to_uppercase();
        let version_key =
            if name == "PHASE0" { "GENESIS_FORK_VERSION".to_string() } else { format!("{name}_FORK_VERSION") };
        let version = format!("0x{}", hex::encode(entry.fork_version));
        assert_eq!(data[&version_key].as_str(), Some(version.as_str()), "{name} version");
        if name != "PHASE0" {
            assert_eq!(number(&format!("{name}_FORK_EPOCH")), entry.epoch, "{name} epoch");
        }
        table_names.push(name);
    }
    for key in data.as_object().unwrap().keys() {
        let Some(name) = key.strip_suffix("_FORK_EPOCH") else { continue };
        let known = table_names.iter().any(|known| known == name);
        let never = data[key].as_str() == Some("18446744073709551615");
        assert!(known || never, "{name} is scheduled in the configuration but missing from the table");
    }

    // The fork schedule endpoint lists every scheduled fork: current version and epoch, in order.
    let rows: Vec<(u64, String)> = schedule["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            (row["epoch"].as_str().unwrap().parse().unwrap(), row["current_version"].as_str().unwrap().to_string())
        })
        .collect();
    let scheduled: Vec<(u64, String)> = spec
        .fork_schedule
        .iter()
        .filter(|entry| entry.epoch != FAR_FUTURE_EPOCH)
        .map(|entry| (entry.epoch, format!("0x{}", hex::encode(entry.fork_version))))
        .collect();
    assert_eq!(rows, scheduled);
}

/// Claim: the Sepolia constants equal the raw responses of a Sepolia beacon node, including Gloas at epoch 353024. Heze
/// (version 0x90000077, never scheduled) is in the configuration and not in the table, and the check allows exactly that.
#[test]
fn sepolia_constants_match_the_fetched_configuration() {
    check_against_fixtures(&SEPOLIA, "sepolia", "sepolia", 1_655_733_600, 12);
    let configuration = load_response("sepolia/chain_spec.json");
    assert_eq!(configuration["data"]["HEZE_FORK_VERSION"].as_str(), Some("0x90000077"));
    assert_eq!(configuration["data"]["HEZE_FORK_EPOCH"].as_str(), Some("18446744073709551615"));
    assert_eq!(configuration["data"]["DEPOSIT_CHAIN_ID"].as_str(), Some("11155111"));
    // Control: a wrong constant is caught.
    let wrong = ChainSpec { genesis_validators_root: B256::repeat_byte(1), ..SEPOLIA };
    let caught = std::panic::catch_unwind(|| check_against_fixtures(&wrong, "sepolia", "sepolia", 1_655_733_600, 12));
    assert!(caught.is_err(), "the fixture check must fail for a wrong genesis validators root");
}

/// Claim: the PulseChain testnet v4 constants equal the raw responses, and Deneb is never scheduled.
#[test]
fn pulsechain_testnet_v4_constants_match_the_fetched_configuration() {
    check_against_fixtures(&PULSECHAIN_TESTNET_V4, "pulsechain-testnet-v4", "pulsechain-testnet-v4", 1_681_356_369, 10);
    let configuration = load_response("pulsechain-testnet-v4/chain_spec.json");
    assert_eq!(configuration["data"]["DENEB_FORK_EPOCH"].as_str(), Some("18446744073709551615"));
    assert_eq!(configuration["data"]["DENEB_FORK_VERSION"].as_str(), Some("0xffffffff"));
    assert_eq!(configuration["data"]["DEPOSIT_CHAIN_ID"].as_str(), Some("943"));
    let wrong = ChainSpec { seconds_per_slot: 12, ..PULSECHAIN_TESTNET_V4 };
    let caught = std::panic::catch_unwind(|| {
        check_against_fixtures(&wrong, "pulsechain-testnet-v4", "pulsechain-testnet-v4", 1_681_356_369, 10)
    });
    assert!(caught.is_err(), "the fixture check must fail for a wrong slot time");
}

fn all_selectors() -> [ChainSelector; 4] {
    [
        ChainSelector::EthereumMainnet,
        ChainSelector::Pulsechain,
        ChainSelector::Sepolia,
        ChainSelector::PulsechainTestnetV4,
    ]
}

/// Claim: the four chains have four different genesis validators roots and, for the same slot, four different signing
/// domains. Why it matters: this is what stops a signature of one chain from verifying on another.
#[test]
fn the_four_selectors_bind_four_different_chains() {
    let selectors = all_selectors();
    for (first, left) in selectors.iter().enumerate() {
        for right in &selectors[first + 1..] {
            assert_ne!(left.spec().genesis_validators_root, right.spec().genesis_validators_root, "{left:?} {right:?}");
            let slot = 9_000_000;
            assert_ne!(
                sync_committee_domain(left.spec(), slot),
                sync_committee_domain(right.spec(), slot),
                "{left:?} {right:?}"
            );
        }
    }
}

/// Claim: the wire tags are 1, 2, 3, 4 (the first two unchanged), each tag decodes to its own chain, and an unknown tag
/// is refused. The decoder test uses a real encoding with the tag byte replaced.
#[test]
fn wire_tags_round_trip_and_unknown_tags_are_refused() {
    assert_eq!(all_selectors().map(ChainSelector::wire_tag), [1, 2, 3, 4]);
    let scenario = build_update(
        &SEPOLIA,
        UpdateRecipe {
            store_slot: 8_800_000,
            finalized_slot: 8_801_000,
            attested_slot: 8_801_070,
            signature_slot: 8_801_071,
            participants: 342,
            include_next_committee: false,
            store_knows_next_committee: false,
        },
    );
    let step = FoldStep { update: scenario.update, fork_version: table_fork_version(&SEPOLIA, 8_801_071) };
    for chain in all_selectors() {
        let input = GuestInput { chain, store: scenario.store.clone(), steps: vec![step.clone()] };
        let bytes = encode_guest_input(&input);
        assert_eq!(bytes[0], chain.wire_tag());
        assert_eq!(decode_guest_input(&bytes), Ok(input));
    }
    let bytes =
        encode_guest_input(&GuestInput { chain: ChainSelector::Sepolia, store: scenario.store, steps: vec![step] });
    for tag in [0u8, 5, 0xff] {
        let mut tampered = bytes.clone();
        tampered[0] = tag;
        assert!(
            matches!(decode_guest_input(&tampered), Err(Error::HeaderDecode(reason)) if reason.contains("unknown chain selector"))
        );
    }
    // The mainnet bytes keep their meaning: tag 1 and tag 2 still decode to the first two chains.
    assert_eq!(ChainSelector::from_wire_tag(1), Some(ChainSelector::EthereumMainnet));
    assert_eq!(ChainSelector::from_wire_tag(2), Some(ChainSelector::Pulsechain));
}

/// Claim: a synthetic Fulu update on Sepolia (Electra layout, signed by a real aggregate) runs through the guest body and
/// reports the Sepolia genesis validators root. The same bytes under the mainnet tag fail the signature check.
#[test]
fn a_sepolia_fulu_update_verifies_only_under_the_sepolia_selector() {
    let recipe = UpdateRecipe {
        store_slot: 8_800_000,
        finalized_slot: 8_801_000,
        attested_slot: 8_801_070,
        signature_slot: 8_801_071,
        participants: 342,
        include_next_committee: false,
        store_knows_next_committee: false,
    };
    assert_eq!(SEPOLIA.fork_at_slot(recipe.attested_slot), ForkName::Fulu);
    let scenario = build_update(&SEPOLIA, recipe);
    let output = verify_light_client_update(&scenario.store, &scenario.update, &SEPOLIA).expect("sepolia update");
    assert_eq!(output.genesisValidatorsRoot, SEPOLIA.genesis_validators_root);
    assert_eq!(output.newHeadSlot, 8_801_000);

    let step = FoldStep { update: scenario.update.clone(), fork_version: table_fork_version(&SEPOLIA, 8_801_071) };
    let bytes = encode_guest_input(&GuestInput {
        chain: ChainSelector::Sepolia,
        store: scenario.store.clone(),
        steps: vec![step],
    });
    let public_values = run_light_client_guest(&bytes).expect("guest");
    assert_eq!(public_values.len(), 352);
    let mut other_chain = bytes.clone();
    other_chain[0] = ChainSelector::EthereumMainnet.wire_tag();
    // Epoch 275000 is Deneb on mainnet, so the mainnet table picks another layout and refuses even before the signature.
    assert!(run_light_client_guest(&other_chain).is_err());
    let wrong_version = {
        let mut changed = bytes.clone();
        let step_start = 1 + 32 + 8 + 4 + 512 * 48 + 48 + 1 + 4;
        changed[step_start] ^= 1;
        changed
    };
    assert_eq!(
        run_light_client_guest(&wrong_version),
        Err(Error::SignatureVerificationFailed),
        "the fork version is part of the signed domain"
    );

    // Control: one flipped byte in the signature.
    let mut flipped = scenario.update.clone();
    flipped.sync_aggregate.sync_committee_signature[5] ^= 1;
    assert!(verify_light_client_update(&scenario.store, &flipped, &SEPOLIA).is_err());
}

/// Claim: a synthetic Capella update on PulseChain testnet v4 verifies, the output names the testnet genesis validators
/// root, and the update does not verify under the PulseChain mainnet or the Sepolia configuration.
#[test]
fn a_pulsechain_testnet_v4_capella_update_verifies() {
    let recipe = UpdateRecipe {
        store_slot: 200_000,
        finalized_slot: 201_000,
        attested_slot: 201_070,
        signature_slot: 201_071,
        participants: 342,
        include_next_committee: true,
        store_knows_next_committee: false,
    };
    assert_eq!(PULSECHAIN_TESTNET_V4.fork_at_slot(recipe.attested_slot), ForkName::Capella);
    let scenario = build_update(&PULSECHAIN_TESTNET_V4, recipe);
    let output: LightClientOutput =
        verify_light_client_update(&scenario.store, &scenario.update, &PULSECHAIN_TESTNET_V4).expect("testnet update");
    assert_eq!(output.genesisValidatorsRoot, PULSECHAIN_TESTNET_V4.genesis_validators_root);
    assert_eq!(output.newHeadSlot, 201_000);
    assert_ne!(output.nextSyncCommitteeHash, B256::ZERO);
    assert_eq!(output.executionBlockNumber, 402_000, "the synthetic builder uses twice the slot");

    for other in [&lc_core::chain::PULSECHAIN, &SEPOLIA] {
        let result = verify_light_client_update(&scenario.store, &scenario.update, other);
        assert!(result.is_err(), "{} must refuse a testnet signature", other.name);
    }
    // Control: one flipped byte in the finality branch.
    let mut flipped = scenario.update.clone();
    flipped.finality_branch[0].0[0] ^= 1;
    assert_eq!(
        verify_light_client_update(&scenario.store, &flipped, &PULSECHAIN_TESTNET_V4).err(),
        Some(Error::InvalidFinalityBranch)
    );
}
