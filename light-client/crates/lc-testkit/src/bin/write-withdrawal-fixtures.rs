//! Writes `tests/fixtures/gindices.json` and `tests/fixtures/withdrawal/*.json`.
//! Usage: `cargo run -p lc-testkit --bin write-withdrawal-fixtures`. The output is deterministic.

use lc_testkit::fixture_set::{gindices_json, withdrawal_fixtures};
use lc_testkit::json::fixtures_dir;

fn main() {
    let directory = fixtures_dir();
    let withdrawal_dir = directory.join("withdrawal");
    std::fs::create_dir_all(&withdrawal_dir).expect("create withdrawal directory");
    let write = |path: std::path::PathBuf, value: &serde_json::Value| {
        let mut text = serde_json::to_string_pretty(value).expect("json");
        text.push('\n');
        std::fs::write(&path, text).expect("write");
        println!("wrote {}", path.display());
    };
    write(directory.join("gindices.json"), &gindices_json());
    for (name, value) in withdrawal_fixtures() {
        write(withdrawal_dir.join(format!("{name}.json")), &value);
    }
}
