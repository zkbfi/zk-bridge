# Server prover

This document explains how to run the production prover on your own server. The prover proves with the SP1 library on the local processor. It does not use the Succinct prover network and needs no network key.

The proving code is `Sp1Prover` in `prover/src/prover.rs`. It is behind the cargo feature `sp1`, which is off by default. The server image uses the feature `sp1-native-gnark`, which adds the in-process Groth16 wrapper.

## What the prover does

1. It builds the guest input for a statement. A statement is a light-client update (or a fold of up to 64 updates), or a fork observation.
2. It runs the same program natively with `lc-core` and refuses the statement when the program rejects it.
3. It checks that the program key of the guest program file equals the key in the request. The key comes from the contract.
4. It proves in Groth16 mode and checks that the public values of the proof equal the native result.
5. It returns the proof bytes (a four-byte selector, then 256 bytes of proof) and the public values. These are the arguments of `verifyProof(programVKey, publicValues, proof)`.

## Hardware

The SP1 documentation page "Hardware Requirements" (https://docs.succinct.xyz/docs/sp1/getting-started/hardware-requirements, read on 2026-10-22) gives these local minimums for Groth16 proofs:

| Item | Minimum for Groth16 |
|---|---|
| Processor cores | 16 or more. More cores make a proof faster. Single-core speed matters for execution. |
| Memory | 16 GB or more. The final wrapping step needs about 14 GB. |
| Disk | 10 GB or more, for the toolchain and the circuit files. |

The page also says that a Groth16 proof through Docker may need a higher Docker memory limit. The server image avoids this: the wrapper runs inside the process, so the container needs no Docker socket.

Our advice, which is our own margin and not a number from that page: use 16 cores and 32 GB of memory. The 14 GB of the wrapping step comes on top of the memory that the earlier proof steps use.

I did not measure proof time. The execution sizes that I measured on a laptop are: about 31 million instructions for one real Ethereum update, about 29 million for one real PulseChain update, about 91 million for a fold of three updates, and about 117 million for a fork observation with a fold of three updates. Prove a real update on the server first and record the time before you rely on the cadence of the service.

## Build

### Step 1. Build the guest programs reproducibly

On a machine with `cargo prove` (sp1-cli 6.8.1) and a Docker engine:

```
ELF_OUTPUT_DIR=light-client/elf light-client/scripts/program-keys.sh
```

The script rebuilds both guests in the pinned Succinct image and compares the result with `light-client/program-keys.json`. It exits with a non-zero code on a difference. With `ELF_OUTPUT_DIR` it also writes `light-client/elf/light-client.elf` and `light-client/elf/fork-observation.elf`. The directory is not tracked by git.

The image is for linux/amd64. On an arm64 machine it runs under emulation and takes about 6 minutes for the light client and about 16 minutes for fork observation. On an amd64 server it is faster.

### Step 2. Build the image

```
docker build --platform linux/amd64 --target prover-sp1 -t zk-bridge-prover-sp1 -f docker/Dockerfile .
```

The build needs about 8 GB of memory. Do not run it on the 2 GB local virtual machine. The build:

- compiles the prover with `--no-default-features --features sp1-native-gnark`, so it has no development beacon source and no test crate;
- needs Go for the Groth16 wrapper. The Dockerfile downloads Go 1.25.14 and checks its SHA-256 hash (Secure Hash Algorithm, 256 bits). The Go modules come from the Go module proxy and the `go.sum` file of the crate `sp1-recursion-gnark-ffi` pins their hashes;
- compares the SHA-256 hash of each guest program file with `light-client/program-keys.json` and fails when they differ.

Without Docker, on the server itself, with Rust 1.93.0 and Go 1.24 or later:

```
cd prover
cargo build --release --locked --no-default-features --features sp1-native-gnark --bin zk-bridge-prover
```

On a developer machine, `cargo check --features sp1` and `cargo test --features sp1 --test sp1_execute -- --test-threads=1` need no Go. The feature `sp1` alone uses a Docker container for the Groth16 wrapper.

## Configuration

Copy `prover/prover.example.toml` and change the `[prover]` section:

```toml
[prover]
backend = "sp1"
program_vkey = "0x00a2b556cd72b5d838b34c60b0367e1ffc9ab662d4e6aabca23e3682b0f5584b"   # key of the light-client program
sp1_elf_path = "/elf/light-client.elf"
sp1_observation_elf_path = "/elf/fork-observation.elf"       # needed only to prove fork observations
```

The value above is the current key from `light-client/program-keys.json`. Your deployed light client must store the same value as `programVKey`.

Each key also has an environment override, for example `ZK_BRIDGE_PROVER_PROVER_SP1_ELF_PATH`. Secrets stay in the Foundry keystore and the password file, as in `prover/README.md`.

Run the service with a volume on `/state`. The first Groth16 proof downloads the circuit files from Succinct and stores them in `/state/sp1-circuits` (set by `SP1_GROTH16_CIRCUIT_PATH`). Later proofs reuse them.

```
docker run -d --name zk-bridge-prover --restart unless-stopped \
  -v zk-bridge-state:/state \
  -v /srv/zk-bridge/prover.toml:/state/prover.toml:ro \
  -v /srv/zk-bridge/keys:/state/keys:ro \
  zk-bridge-prover-sp1
```

The default command is `--config /state/prover.toml run`. For one pass, add `once` after the image name.

## Check the program keys

There are four checks. The first three you can run by hand. The fourth runs by itself at startup.

1. Compare the files with the record. `light-client/scripts/program-keys.sh` prints the SHA-256 hash and the program key of each guest and compares them with `light-client/program-keys.json`.
2. Print the key of a guest program file: `cargo prove vkey --elf light-client/elf/light-client.elf`. A file from a native `cargo prove build` gives another key than the Docker build. Use only the Docker build for a deployment.
3. Read the key from the chain: `cast call <light client address> "programVKey()(bytes32)" --rpc-url <rpc>`. For the fork registry, call `observationProgramVKey()`.
4. Startup check. The service reads `programVKey()` from the destination light client. It stops with a configuration error when the program file has another key, or when `program_vkey` differs from the contract. The prover also refuses each single proof whose requested key differs from the key of its program file.

The verifier contract is the vendored SP1 Groth16 verifier of circuit version v6.1.0. See `docs/sp1-version-policy.md` for its release, its constants and its code hash.

## Point the prover at real endpoints

Use your own nodes where you can. Public endpoints are slow and often prune data that the prover needs. Never write real addresses or keys into files that you commit.

| Setting | What to give |
|---|---|
| `chain_a.rpc_url` | An execution RPC of Ethereum. Needs `eth_call`, `eth_getLogs`, `eth_getBlockByNumber`, `eth_getBlockReceipts`, `eth_estimateGas` and `eth_sendRawTransaction`. |
| `chain_a.beacon.url` | A beacon API of Ethereum. |
| `chain_b.rpc_url` | An execution RPC of PulseChain, with the same methods. |
| `chain_b.beacon.url` | A beacon API of PulseChain. |
| `chain_*.beacon.kind` | `http`. Never `dev` on a real chain. |
| `chain_*.beacon.chain` | `ethereum` or `pulsechain`. |

The beacon API must serve these paths: `/eth/v1/beacon/light_client/updates`, `/eth/v1/beacon/light_client/finality_update`, `/eth/v1/beacon/light_client/bootstrap/<root>`, `/eth/v1/beacon/headers/<id>`, `/eth/v1/beacon/blocks/<slot>/root`, `/eth/v2/beacon/blocks/<id>` and `/eth/v2/debug/beacon/states/<root>`. The debug path is often off by default; turn it on at your node. A node must keep light-client updates for every sync committee period that a light client lags behind. `route-health` warns when it cannot.

Before the service goes live, run:

```
zk-bridge-prover --config prover.toml route-health
```

It reads the fork schedule and the head of each light client and tells you whether each route can still deliver a deposit.

## Verifying a proof before you rely on the service

The test `full_groth16_proof_of_a_real_update` in `prover/tests/sp1_execute.rs` proves a real Ethereum update. It is ignored on a laptop. On the server run:

```
cd prover
cargo test --release --features sp1-native-gnark --test sp1_execute -- --ignored --test-threads=1 full_groth16
```

Then send the proof to a light client on a test network. No proof for circuit version v6.1.0 exists in the repository yet, so this run also produces the first accepting fixture for `test/hardened/SP1VerifierGroth16.t.sol`.

## What this setup does not give you

- One server is one point of failure for liveness. It is not a trust risk: a proof that the contract accepts is valid whoever made it.
- The circuit files come from Succinct storage on the first proof. The crate `sp1-sdk` carries the Groth16 verifying key inside its source, and the same key sits in the vendored verifier. A wrong circuit file therefore produces proofs that the verifier rejects. It does not produce false proofs that the verifier accepts.
- A soundness bug in SP1 cannot be patched in a deployed route. Read the rules in `docs/sp1-version-policy.md`.
