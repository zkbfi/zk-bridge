//! Writes `tests/fixtures/gindices.json` and `tests/fixtures/message/*.json`.
//! Usage: `cargo run -p lc-testkit --bin write-message-fixtures`. The output is deterministic.

use lc_testkit::fixture_set::{gindices_json, message_fixtures};
use lc_testkit::json::fixtures_dir;

fn main() {
    let directory = fixtures_dir();
    let message_dir = directory.join("message");
    std::fs::create_dir_all(&message_dir).expect("create message directory");
    let write = |path: std::path::PathBuf, value: &serde_json::Value| {
        let mut text = serde_json::to_string_pretty(value).expect("json");
        text.push('\n');
        std::fs::write(&path, text).expect("write");
        println!("wrote {}", path.display());
    };
    write(directory.join("gindices.json"), &gindices_json());
    for (name, value) in message_fixtures() {
        write(message_dir.join(format!("{name}.json")), &value);
    }
}
