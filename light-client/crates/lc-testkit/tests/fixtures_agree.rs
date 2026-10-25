//! The shared fixtures (`tests/fixtures/gindices.json`, `tests/fixtures/message/*.json`) are what the Solidity tests load.
//! These tests keep them honest: current, correct and independent of the code that wrote them.

use lc_testkit::fixture_set::{check_fixture_with_verifier, gindices_json, message_fixtures};
use lc_testkit::json::{fixtures_dir, load_fixture};

/// Claim: the files on disk equal what the generator produces now. A stale file (for example after a layout change) fails.
#[test]
fn fixture_files_on_disk_are_current() {
    assert_eq!(
        load_fixture("gindices.json"),
        gindices_json(),
        "run: cargo run -p lc-testkit --bin write-message-fixtures"
    );
    let generated = message_fixtures();
    for (name, value) in &generated {
        assert_eq!(&load_fixture(&format!("message/{name}.json")), value, "{name} is stale");
    }
    let on_disk = std::fs::read_dir(fixtures_dir().join("message")).expect("directory").count();
    assert_eq!(on_disk, generated.len(), "unexpected extra files in tests/fixtures/message");
    assert!(generated.len() >= 60);
}

/// Claim: reading each file back (decode the calldata, build the context from the file fields) gives the declared outcome in
/// the Rust verifier. This is the check the Solidity tests repeat on the same files.
#[test]
fn every_fixture_gives_its_declared_outcome() {
    let mut accepts = 0;
    let mut rejects = 0;
    for (name, _) in message_fixtures() {
        let fixture = load_fixture(&format!("message/{name}.json"));
        check_fixture_with_verifier(&fixture);
        if fixture["expected"]["result"] == "accept" {
            accepts += 1;
        } else {
            rejects += 1;
        }
    }
    assert!(accepts >= 10, "{accepts}");
    assert!(rejects >= 40, "{rejects}");
}

/// Claim: the generalized indices equal numbers computed by hand from the container field lists in consensus-specs,
/// not read from the code under test. Capella state: 28 fields (depth 5), block_roots field 5 -> 37 -> * 8192.
/// Electra state: 37 fields (depth 6) -> 64 + 5 = 69. ExecutionPayload: 15 fields (depth 4) in Capella, 17 (depth 5) from Deneb;
/// block_hash is field 12; execution_payload is body field 9 (index 25).
#[test]
fn gindices_equal_hand_computed_values() {
    let gindices = load_fixture("gindices.json");
    let forks = &gindices["forks"];
    let number = |value: &serde_json::Value| -> u64 { value.as_str().expect("string").parse().expect("number") };
    assert_eq!(number(&forks["capella"]["blockRootsFieldGindex"]), 32 + 5);
    assert_eq!(number(&forks["capella"]["blockRootsGindexBase"]), 37 * 8192);
    assert_eq!(forks["capella"]["blockRootsBranchLength"], 18);
    assert_eq!(number(&forks["capella"]["blockHashGindex"]), 25 * 16 + 12);
    assert_eq!(forks["capella"]["blockHashBranchLength"], 8);
    assert_eq!(number(&forks["deneb"]["blockRootsGindexBase"]), 37 * 8192);
    assert_eq!(number(&forks["deneb"]["blockHashGindex"]), 25 * 32 + 12);
    assert_eq!(forks["deneb"]["blockHashBranchLength"], 9);
    assert_eq!(number(&forks["electra"]["blockRootsFieldGindex"]), 64 + 5);
    assert_eq!(number(&forks["electra"]["blockRootsGindexBase"]), 69 * 8192);
    assert_eq!(forks["electra"]["blockRootsBranchLength"], 19);
    assert_eq!(number(&forks["electra"]["blockHashGindex"]), 812);
    assert_eq!(forks["fulu"], forks["electra"]);
    // Schedule rows: Ethereum has four supported forks, PulseChain one (Capella, epoch 3).
    assert_eq!(gindices["chains"]["ethereum"]["forkSchedule"].as_array().unwrap().len(), 4);
    let pulsechain = gindices["chains"]["pulsechain"]["forkSchedule"].as_array().unwrap();
    assert_eq!(pulsechain.len(), 1);
    assert_eq!(pulsechain[0]["activationEpoch"], "3");
}
