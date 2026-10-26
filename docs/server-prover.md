# Server prover

This document explains how to run the production proof producer on your own server. The producer proves with the SP1 library on the local processor. It does not use the Succinct prover network and needs no network key.

The producer is stateless. It makes a proof and hands it off (standard output or a webhook). It has no database and no wallet, and it sends no transaction. A stateful server of yours runs it, stores the proof and sends it to the chain. `prover/README.md` describes the commands and the result.

The proving code is `Sp1Prover` in `prover/src/prover.rs`. It is behind the cargo feature `sp1`, which is off by default. The server image uses the feature `sp1-native-gnark`, which adds the in-process Groth16 wrapper.

To prove on a rented GPU instead of a server of your own, see `docs/gpu-prover.md`.

## What the producer does

One run of `zk-bridge-prover prove` makes one proof.

1. It reads where the update starts: the head that the destination light client stores, or a head that you give.
2. It fetches the updates from that head to the newest final header, and builds the guest input. The input is a fold of up to 64 updates.
3. It runs the same program natively with `lc-core` and refuses the statement when the program rejects it.
4. It checks that the program key of the guest program file equals the key that the light client contract stores.
5. It proves in Groth16 mode and checks that the public values of the proof equal the native result.
6. It checks the proof again with the crate `sp1-verifier`, and hands off the result: the proof bytes (a four-byte selector, then 256 bytes of proof), the public values and the calldata of `BeaconLightClient.update`. These are the arguments of `verifyProof(programVKey, publicValues, proof)`.

The run exits with code 0 when it handed off a proof, with code 3 when the light client already holds the newest final header, and with code 1 on an error.

## Hardware

The SP1 documentation page "Hardware Requirements" (https://docs.succinct.xyz/docs/sp1/getting-started/hardware-requirements, read on 2026-10-22) gives these local minimums for Groth16 proofs:

| Item | Minimum for Groth16 |
|---|---|
| Processor cores | 16 or more. More cores make a proof faster. Single-core speed matters for execution. |
| Memory | 16 GB or more. The final wrapping step needs about 14 GB. |
| Disk | 10 GB or more, for the toolchain and the circuit files. |

The page also says that a Groth16 proof through Docker may need a higher Docker memory limit. The server image avoids this: the wrapper runs inside the process, so the container needs no Docker socket.

Our advice, which is our own margin and not a number from that page: use 16 cores and 32 GB of memory. The 14 GB of the wrapping step comes on top of the memory that the earlier proof steps use.

I measured proof time on a server with 32 threads (see `docs/end-to-end-real-proofs.md`): a Groth16 proof of one update takes 284 to 322 seconds with the current program and peaks near 56 GiB. The prover keeps memory after a proof. The `prove` command makes one proof and exits, so run one proof for each process. The execution sizes that I measured on a laptop are: about 31 million instructions for one real Ethereum update, about 29 million for one real PulseChain update, about 91 million for a fold of three updates, and about 117 million for a fork observation with a fold of three updates. Prove a real update on the server first and record the time before you rely on the cadence of the service.

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

- compiles the producer with `--no-default-features --features sp1-native-gnark`, so it has no signed beacon chain and no test crate;
- needs Go for the Groth16 wrapper. The Dockerfile downloads Go 1.25.14 and checks its SHA-256 hash (Secure Hash Algorithm, 256 bits). The Go modules come from the Go module proxy and the `go.sum` file of the crate `sp1-recursion-gnark-ffi` pins their hashes;
- compares the SHA-256 hash of each guest program file with `light-client/program-keys.json` and fails when they differ.

Without Docker, on the server itself, with Rust 1.93.0 and Go 1.24 or later:

```
cd prover
cargo build --release --locked --no-default-features --features sp1-native-gnark --bin zk-bridge-prover
```

On a developer machine, `cargo check --features sp1` and `cargo test --features sp1 --test sp1_execute -- --test-threads=1` need no Go. The feature `sp1` alone uses a Docker container for the Groth16 wrapper.

## Configuration

Copy `prover/prover.example.toml` and change the `[prover]` section and the route:

```toml
[prover]
backend = "sp1"
sp1_elf_path = "/elf/light-client.elf"
sp1_observation_elf_path = "/elf/fork-observation.elf"       # needed only to prove fork observations

[handoff]
targets = ["stdout", "webhook"]
webhook_url = "https://REPLACE"
webhook_bearer_env = "PROOF_WEBHOOK_TOKEN"                   # the NAME of a variable; the token never enters the file

[routes.ethereum_to_pulsechain.source]
chain_id = 1
chain = "ethereum"
beacon_url = "https://REPLACE"

[routes.ethereum_to_pulsechain.destination]
chain_id = 369
rpc_url = "https://REPLACE"
light_client = "0x..."
```

The command reads the program key from the light client. Your deployed light client must store the same value as `programVKey`. The current key of the light-client program is in `light-client/program-keys.json`. You may also set `prover.program_vkey`. The command then refuses a light client that stores another key.

Each key of `[prover]` and `[handoff]` has an environment override, for example `ZK_BRIDGE_PROVER_PROVER_SP1_ELF_PATH`. The file holds no secret, as `prover/README.md` explains.

Run the producer with a volume on `/state`. The first Groth16 proof downloads the circuit files from Succinct and stores them in `/state/sp1-circuits` (set by `SP1_GROTH16_CIRCUIT_PATH`). Later proofs reuse them.

```
docker run --rm --name zk-bridge-prover \
  -v zk-bridge-state:/state \
  -v /srv/zk-bridge/prover.toml:/state/prover.toml:ro \
  -e PROOF_WEBHOOK_TOKEN \
  zk-bridge-prover-sp1
```

The default command is `--config /state/prover.toml prove`. Run the container once for each proof, from a scheduler or from the stateful server. The exit code tells the caller what happened (see above). Do not start the container in a loop that ignores code 3: it would restart at once and prove nothing.

## Check the program keys

There are four checks. The first three you can run by hand. The fourth runs by itself at startup.

1. Compare the files with the record. `light-client/scripts/program-keys.sh` prints the SHA-256 hash and the program key of each guest and compares them with `light-client/program-keys.json`.
2. Print the key of a guest program file: `cargo prove vkey --elf light-client/elf/light-client.elf`. A file from a native `cargo prove build` gives another key than the Docker build. Use only the Docker build for a deployment.
3. Read the key from the chain: `cast call <light client address> "programVKey()(bytes32)" --rpc-url <rpc>`. For the fork registry, call `observationProgramVKey()`.
4. Check before the proof. In route mode, `prove` reads `programVKey()` from the destination light client. It stops with a configuration error when the program file has another key, or when `program_vkey` differs from the contract. The prover also refuses each single proof whose requested key differs from the key of its program file.

The verifier contract is the vendored SP1 Groth16 verifier of circuit version v6.1.0. See `docs/sp1-version-policy.md` for its release, its constants and its code hash.

## Point the producer at real endpoints

Use your own nodes where you can. Public endpoints are slow and often prune data that the producer needs. Never write real addresses or keys into files that you commit.

| Setting | What to give |
|---|---|
| `routes.<name>.source.beacon_url` | A beacon API of the source chain. The URL may have a path prefix (`https://host/beacon-api`) or a key segment. Logs and errors never show the path. |
| `routes.<name>.source.chain` | `ethereum`, `pulsechain`, `sepolia` or `pulsechain-testnet-v4`: the chain specification of the source beacon chain. Sepolia runs the Gloas fork: the route also needs `source.rpc_url` for the execution header of `state.latest_block_hash`. See `prover/README.md`, section "Chains". |
| `routes.<name>.destination.rpc_url` | An execution RPC of the destination chain. `prove` needs `eth_chainId` and `eth_call` only. |
| `routes.<name>.destination.light_client` | The `BeaconLightClient` on the destination chain. |

The `evidence` command needs more: the execution RPC of the source chain with `eth_getTransactionReceipt`, `eth_getBlockByNumber` and `eth_getBlockReceipts`, `eth_getRawTransactionByHash` (the transactions trie needs the bytes of every transaction of the block), the two bridge addresses, and on the destination `eth_getLogs` and `eth_blockNumber`.

The beacon API must serve these paths: `/eth/v1/beacon/light_client/updates`, `/eth/v1/beacon/light_client/finality_update`, `/eth/v1/beacon/light_client/bootstrap/<root>`, `/eth/v1/beacon/headers/<id>`, `/eth/v1/beacon/blocks/<slot>/root`, `/eth/v2/beacon/blocks/<id>` and `/eth/v2/debug/beacon/states/<root>`. The debug path is often off by default; turn it on at your node. A node must keep light-client updates for every sync committee period that a light client lags behind. When it does not, `prove` stops with an error that names the missing period.

Before you rely on the setup, run `zk-bridge-prover --config prover.toml prove` against a route whose light client is current. It reads the light client, checks the program key and the beacon node, and exits with code 3 when nothing is left to prove.

## What the stateful servers do

The producer replaces the work of the old relayer that makes proofs. The rest belongs to your stateful servers. They post the updates, open the bridges and deliver the messages. The launch sequence in `docs/hardened-build-contract.md` lists the steps in order.

A new bridge is locked. It refuses every send with `DepositsNotOpen()` until a proof shows that the light client on the other chain stored a head. Without this lock, a message sent before the first update of the light client could never be delivered. A token relay is a send, so the lock covers it. After the deployment, a server runs `prove` for each route, sends `updateCalldata` to the light client, and repeats until a head is stored. Then it builds the opening proof (a state proof of the remote light client from `eth_getProof`) and calls `openDeposits` on each bridge. The key of the server pays for these transactions on both chains.

## Verifying a proof before you rely on the service

The test `full_groth16_proof_of_a_real_update` in `prover/tests/sp1_execute.rs` proves a real Ethereum update. It is ignored on a laptop. On the server run:

```
cd prover
cargo test --release --features sp1-native-gnark --test sp1_execute -- --ignored --test-threads=1 full_groth16
```

The proof of this test is the fixture `test/hardened/fixtures/sp1-proof-ethereum-update.json`, and `test/hardened/SP1VerifierGroth16.t.sol` checks it against the vendored verifier. `docs/end-to-end-real-proofs.md` sends proofs to light clients on two Anvil chains and pays deposits with them.

## What this setup does not give you

- One server is one point of failure for liveness. It is not a trust risk: a proof that the contract accepts is valid whoever made it.
- The circuit files come from Succinct storage on the first proof. The crate `sp1-sdk` carries the Groth16 verifying key inside its source, and the same key sits in the vendored verifier. A wrong circuit file therefore produces proofs that the verifier rejects. It does not produce false proofs that the verifier accepts.
- A soundness bug in SP1 cannot be patched in a deployed route. Read the rules in `docs/sp1-version-policy.md`.
