//! Writes `tests/fixtures/fork-observation/*.json`.
//! Usage: `cargo run -p lc-testkit --bin write-fork-observation-fixtures`. The output is deterministic.

use lc_testkit::fork_observation_scenarios::fork_observation_fixtures;
use lc_testkit::json::fixtures_dir;

fn main() {
    let directory = fixtures_dir().join("fork-observation");
    std::fs::create_dir_all(&directory).expect("create fork-observation directory");
    for (name, value) in fork_observation_fixtures() {
        let path = directory.join(format!("{name}.json"));
        let mut text = serde_json::to_string_pretty(&value).expect("json");
        text.push('\n');
        std::fs::write(&path, text).expect("write");
        println!("wrote {}", path.display());
    }
}
