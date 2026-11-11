//! The test kit uses the message proof with the fork proof of the source state (`lc_testkit::lc_message`), never the
//! earlier form that `lc-core` keeps only for the guest program keys. Clippy enforces the same rule in the prover and
//! in `lc-message` (`disallowed-types`, `disallowed-methods`), but a clippy.toml for this crate would be an input of the
//! program keys (`scripts/program-keys.sh`), so this test scans the sources of the test kit instead.

use std::fs;
use std::path::{Path, PathBuf};

/// The stale items, by the `lc-core` module that holds them.
const STALE: [(&str, &[&str]); 4] = [
    ("lc_core::abi::", &["MessageProof", "executeMessageCall", "BeaconBlockHeader"]),
    ("lc_core::message::", &["verify_message"]),
    ("lc_core::ancestry::", &["verify_beacon_path"]),
    ("lc_core::layout::", &["message_block_hash_gindex_for_fork"]),
];

fn rust_files(directory: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).expect("read dir") {
        let path = entry.expect("entry").path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            out.push(path);
        }
    }
}

/// The names that follow each `module` path in `source`: one name, or every name of a `{ ... }` group (nested groups
/// included). Doc and line comments are skipped.
fn names_after(source: &str, module: &str) -> Vec<String> {
    let code: String = source
        .lines()
        .map(|line| match line.find("//") {
            Some(position) => &line[..position],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut names = Vec::new();
    for (position, _) in code.match_indices(module) {
        let rest = &code[position + module.len()..];
        let tail = if rest.starts_with('{') {
            let mut depth = 0;
            let end = rest
                .char_indices()
                .find(|(_, character)| {
                    match character {
                        '{' => depth += 1,
                        '}' => depth -= 1,
                        _ => {}
                    }
                    depth == 0
                })
                .map_or(rest.len(), |(index, _)| index);
            &rest[..end]
        } else {
            rest.split(|character: char| !(character.is_alphanumeric() || character == '_')).next().unwrap_or("")
        };
        names.extend(
            tail.split(|character: char| !(character.is_alphanumeric() || character == '_'))
                .filter(|name| !name.is_empty())
                .map(str::to_string),
        );
    }
    names
}

fn stale_uses(source: &str) -> Vec<String> {
    STALE
        .iter()
        .flat_map(|(module, items)| {
            names_after(source, module)
                .into_iter()
                .filter(|name| items.contains(&name.as_str()))
                .map(move |name| format!("{module}{name}"))
        })
        .collect()
}

/// Claim: no source file of the test kit (`src/`, `tests/`) names a stale message item of `lc-core`, as a single path or
/// inside a `use` group. Why it matters: the stale `verify_message` follows the fork schedule and has no fork proof, so a
/// fixture built or checked with it would no longer match the bridge.
#[test]
fn the_test_kit_uses_no_stale_message_api() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    rust_files(&root.join("src"), &mut files);
    rust_files(&root.join("tests"), &mut files);
    let this_file = root.join("tests/stale_message_api.rs");
    let found: Vec<String> = files
        .iter()
        .filter(|path| **path != this_file)
        .flat_map(|path| {
            let source = fs::read_to_string(path).expect("read");
            stale_uses(&source).into_iter().map(move |hit| format!("{}: {hit}", path.display()))
        })
        .collect();
    assert!(found.is_empty(), "stale lc-core message items: {found:#?}");
}

/// Claim: the scan finds a stale item as a full path, inside a nested `use` group, and not in a comment or under another
/// name. Why it matters: a scan that finds nothing proves nothing.
#[test]
fn the_scan_finds_stale_uses() {
    assert_eq!(
        stale_uses("let x = lc_core::message::verify_message(&p, &c, s);"),
        ["lc_core::message::verify_message"]
    );
    assert_eq!(
        stale_uses("use lc_core::abi::{\n    executeMessageCall,\n    LightClientOutput, MessageProof as Old};"),
        ["lc_core::abi::executeMessageCall", "lc_core::abi::MessageProof"]
    );
    assert_eq!(
        stale_uses("use lc_core::ancestry::{ancestry_leaf_gindex, verify_beacon_path};"),
        ["lc_core::ancestry::verify_beacon_path"]
    );
    assert!(stale_uses("// lc_core::message::verify_message is stale").is_empty());
    assert!(stale_uses("use lc_core::message::{message_of_log, MessageContext};").is_empty());
    assert!(stale_uses("use lc_core::abi::LightClientOutput;").is_empty());
}
