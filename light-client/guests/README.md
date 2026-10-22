# SP1 guest wrappers

This directory holds the SP1 guest programs for the light-client proof and the fork-observation proof. It is **not** part of the cargo workspace.
Each guest is its own cargo root with its own committed `Cargo.lock`. The SP1 toolchain is installed on the build machine: `cargo prove` (sp1-cli 6.8.1) and the rustup toolchain `succinct`.
Do not install the toolchain with `sp1up` or a `curl | bash` installer. Do not install `@succinctlabs/sp1-sdk`.

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

## How to build

Native build, for a quick check:

```
cd light-client/guests/light-client      # or fork-observation
cargo prove build --locked
cargo prove vkey --elf target/elf-compilation/riscv64im-succinct-zkvm-elf/release/light-client-guest
```

The native ELF depends on the build machine, so its hash differs from the Docker ELF. Do not deploy a native key.

Reproducible build, the one that counts:

```
light-client/scripts/program-keys.sh
```

The script pulls the image `ghcr.io/succinctlabs/sp1:v6.8.1` by digest (linux/amd64 manifest). It builds both guests with `cargo prove build --docker`. It prints the ELF SHA-256 and the program key of each guest.
It exits with a non-zero code when a value differs from `light-client/program-keys.json`. Run it with `--write` to update that file after an intended change.
The image is amd64 only. On an arm64 machine it runs under emulation, so the build takes about 6 minutes for the light client and about 16 minutes for fork observation. The guests set `jobs = 1` in `.cargo/config.toml` so that the build fits in 2 GiB of memory.
The `--locked` flag makes cargo fail when `Cargo.lock` would change.

The host program is `Sp1Prover` in `prover/src/prover.rs` (feature `sp1`). It builds the input with `lc_core::wire::encode_guest_input` and proves on the local processor. `prover/tests/sp1_execute.rs` runs both guests in the SP1 executor and compares their output with `lc-core`. The
Solidity side checks the proof with the gateway `ISP1Verifier.verifyProof(programVKey, publicValues, proof)`.
The program keys go into the deploy configuration as `programVKey` and `observationProgramVKey`. See `docs/sp1-version-policy.md` for the current values.

## Dependency age rule

Every crate version in each `Cargo.lock` must be at least 28 days old. To check a guest lock file, copy it to a scratch directory as `Cargo.lock`
next to a `scripts/` copy of `check-crate-ages.sh`, then run the script with the cutoff date. To fix a violation, run `cargo update <crate>@<version> --precise <older version>`.

## Inside the zkVM, hash-to-curve uses sha2 0.10.9

The SP1 patch of `bls12_381` builds on `digest` 0.10 and takes the message as a list of chunks. The crates.io release builds on `digest` 0.9.
For that reason `lc-core` selects `sha2` 0.10.9 and the chunk form under `cfg(target_os = "zkvm")`, and `sha2` 0.9.9 elsewhere. Both `sha2` versions are patched in the guest `Cargo.toml` files.

## Crates chosen because SP1 patches them

| Crate | Version | Why |
|---|---|---|
| `bls12_381` | 0.8.0 | Patched for SP1 (`patch-0.8.0-sp1-6.0.0`, the crates.io line). Pairing and group arithmetic use precompiles. Hash-to-curve comes from the `experimental` feature. |
| `sha2` | 0.9.9 and 0.10.9 | Both patched (SHA-256 precompile). Native builds use 0.9.9, which `bls12_381` 0.8.0 `experimental` needs (it uses `digest` 0.9). SSZ hashing always uses 0.9.9. The zkVM uses 0.10.9 for hash-to-curve only. |
| `alloy-primitives` keccak | 1.7.3 uses `sha3` 0.11.0 | Patched (`patch-sha3-0.11.0-sp1-6.0.0`). |
| `alloy-sol-types`, `alloy-rlp`, `alloy-trie` | 1.7.3, 0.3.16, 0.9.5 | Pure Rust. Not patched; they do no heavy cryptography in the light-client guest. |

No crate in the dependency tree of `lc-core` compiles C code. See `light-client/README.md` for the check.
