# light-client

Rust workspace for the hardened bridge: light-client verification (the body of the SP1 guest), the Rust reference of the
vault's withdrawal check, and the test support and fixtures that the Solidity tests share.

| Path | Contents |
|---|---|
| `crates/lc-core` | The library. `update` (light-client update and fold of 1 to 64 updates), `withdrawal` and `ancestry` (vault reference, recent and historical path), `ssz`, `layout`, `chain` (with `capella_era`), `bls`, `mpt`, `execution`, `abi`, `wire`. |
| `crates/lc-testkit` | Fixture loaders, synthetic builders, a real SSZ state parser, the integration tests in `tests/`, and two tools in `src/bin/`. |
| `guests/` | SP1 guest source (not built here, see its README). |
| `scripts/` | `fetch-fixtures.sh`, `check-crate-ages.sh`, `downgrade-young-crates.sh`. |
| `tests/fixtures/` | Real and generated fixtures. See `tests/fixtures/README.md`. |

## Commands

```
cargo test
cargo clippy --all-targets -- -D warnings
scripts/check-crate-ages.sh                 # every crate in Cargo.lock is at least 28 days old (cutoff 2026-09-22)
scripts/fetch-fixtures.sh all               # refetch real data (needs network)
scripts/fetch-fixtures.sh historical        # real historical-path ancestry and the era formula check (PulseChain)
cargo run -p lc-testkit --bin write-withdrawal-fixtures
```

## Supply chain

Direct dependencies are pinned with `=` in `Cargo.toml`, each with its publish date. `Cargo.lock` pins the rest.
`scripts/check-crate-ages.sh` checks the date of every locked crate through the crates.io API. Some crates in the lock file are
for other platforms (for example `wasm-bindgen`) and are never compiled here; they pass the same date rule.
`scripts/downgrade-young-crates.sh` lowers young crates to the newest older version that Cargo accepts.

No crate in the build compiles C code. The build scripts that run are pure Rust (`proc-macro` crates and `build.rs` of
`libc`, `typenum`, `serde`, `zerocopy` and similar). `cc` appears in `Cargo.lock` only as an optional dependency of
`keccak-asm`, which is not enabled.
