# SP1 guest wrappers (source only)

This directory holds the SP1 guest program for the light-client proof. It is **not** part of the cargo workspace and
has **not** been compiled on this machine, because the machine has no SP1 toolchain and the rules forbid installing it with
`sp1up` or any `curl | bash` installer. Do not install `@succinctlabs/sp1-sdk` either.

| Program | Source | Status |
|---|---|---|
| Light client | `light-client/src/main.rs` | Wrapper only. The body is `lc_core::wire::run_light_client_guest`, tested natively. |
| Fork observation | `fork-observation/src/main.rs` | Wrapper only. The body is `lc_core::wire::run_fork_observation_guest`, tested natively. Own verification key. Output: `ForkObservation`, 7 words, 224 bytes. |
| Withdrawal | none | Removed by the user decision: the vault verifies withdrawals directly, with no proof. |

## What the guest does

1. `sp1_zkvm::io::read_vec()` reads the input bytes. The format is `lc_core::wire` (documented in that module).
   The input holds the chain selector, the store and a list of 1 to 64 steps. Each step is a fork version and an update.
2. `run_light_client_guest` decodes, runs `verify_light_client_fold_with_fork_versions` (every step applies
   `verify_with_layout` and carries the store), and returns `abi.encode(LightClientOutput)`: 11 words, 352 bytes.
3. `commit_slice` writes those bytes as the public values. The contract decodes them with `abi.decode`.

The fork version is an input for every step. That is safe: the sync committee signed the domain that contains it, so a wrong version gives
no valid signature (`real_update_verifies_only_with_the_correct_fork_version` shows this on real data).
The chain selector picks the genesis validators root. The root is part of the public values, so the contract binds the proof to
its chain.

## How to build it on a machine that has the official toolchain

1. Install the official SP1 toolchain from the Succinct documentation (`https://docs.succinct.xyz`), using the method that
   page describes, on a machine where installing it is allowed.
2. Check that the three patch tags in `light-client/Cargo.toml` exist in the `sp1-patches` repositories. The pattern comes
   from the "Patched Crates" table of the SP1 documentation (read 2026-10-20). If a tag name differs, use the one in the table
   for the same crate version.
3. `cd light-client && cargo prove build` builds the ELF. `cargo prove vkey --elf <elf>` prints the verification key that
   goes into `BeaconLightClient` as `programVKey`.
4. A host program (not included) builds the input with `lc_core::wire::encode_guest_input` and calls the SP1 prover. The
   Solidity side checks the proof with the gateway `ISP1Verifier.verifyProof(programVKey, publicValues, proof)`.
5. Commit `Cargo.lock` for the guest after the first build. Check every crate in it against the 28 day rule with
   `scripts/check-crate-ages.sh` (it reads the `Cargo.lock` of the workspace; copy it for the guest lock file).

## Crates chosen because SP1 patches them

| Crate | Version | Why |
|---|---|---|
| `bls12_381` | 0.8.0 | Patched for SP1 (`patch-0.8.0-sp1-6.0.0`, the crates.io line). Pairing and group arithmetic use precompiles. Hash-to-curve comes from the `experimental` feature. |
| `sha2` | 0.9.9 | Patched (SHA-256 precompile). 0.9 is required by `bls12_381` 0.8.0 `experimental` (it uses `digest` 0.9). SSZ hashing uses the same crate, so there is one SHA-256 implementation. |
| `alloy-primitives` keccak | 1.7.3 uses `sha3` 0.11.0 | Patched (`patch-sha3-0.11.0-sp1-6.0.0`). |
| `alloy-sol-types`, `alloy-rlp`, `alloy-trie` | 1.7.3, 0.3.16, 0.9.5 | Pure Rust. Not patched; they do no heavy cryptography in the light-client guest. |

No crate in the dependency tree of `lc-core` compiles C code. See `light-client/README.md` for the check.
