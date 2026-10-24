# prover

The proof producer of the hardened bridge. It makes proofs and hands them to other servers. Those servers store the proofs and send them to the chains.

The producer keeps no state. It has no database, no wallet, no keystore and no transaction code. It holds no trusted role: the contracts check everything that a server sends. Anyone can run it.

The producer once was a full relayer. That version watched deposits, kept a database and sent every transaction. It lives on the branch `archive/full-relayer`. This crate is the part that makes proofs.

Build contract: `docs/hardened-build-contract.md`, section "Prover service".

```
cargo build --release --no-default-features    # production build: no test crate, no signed beacon chain
cargo build --release                           # adds the signed beacon chain that the tests use
zk-bridge-prover --config prover.toml prove                              # one proof, from the head that the light client stores
zk-bridge-prover --config prover.toml prove --route <name> --to webhook  # choose the route and the handoff target
zk-bridge-prover --config prover.toml evidence --tx <hash> --log-index <n>   # the evidence that withdraws one deposit
```

The command line never takes a key. A secret lives in an environment variable, and the configuration names the variable (see `prover.example.toml`).

## The `prove` command

One run makes at most one proof of one light-client update. The steps are these.

1. The command reads where the update starts. With a route, it reads the head, the committee hashes and the program key from the destination light client. With `--head-slot` and `--head-root`, it takes the head from the command line and reads nothing from the destination chain.
2. It fetches the updates from that head to the newest final header of the source beacon chain. One fold holds up to 64 updates. A light client that lags by more periods gets a fold that ends below the newest header. The next run continues from the new head.
3. It runs the light-client program natively with `lc-core`. A fold that the program refuses ends the run with an error.
4. It checks that the native run starts exactly at the starting head. It checks the slot, the header root and the next committee hash. With a route, it also checks the genesis validators root and the committee hash of the head period.
5. It asks the backend for the proof.
6. It checks the answer. The public values must equal the native public values. The proof must have the shape of its backend. A real proof must verify under the program key with the crate `sp1-verifier`, whatever backend made it.
7. It hands the result off.

### Input

| Input | Flags |
|---|---|
| A route of the configuration file | `--route <name>`. The flag is optional when the file has exactly one route. |
| An explicit head on a route | `--route <name> --head-slot <n> --head-root <hash> [--next-committee-hash <hash>] [--program-vkey <hash>]` |
| An explicit head with no route | `--beacon-url <url> --chain <ethereum\|pulsechain> --head-slot <n> --head-root <hash> [--next-committee-hash <hash>] [--program-vkey <hash>]` |

An explicit head needs a program key. Pass `--program-vkey`, or set `prover.program_vkey` in the file. With a route and no explicit head, the key comes from the light client. A key in the file that differs from the contract key stops the run.

The next committee hash is zero when the light client holds no next committee. The flag defaults to zero. A value that the beacon state does not match stops the run before any proof, because the contract compares that hash.

### Backends

| Backend | What it does | Build |
|---|---|---|
| `remote` | Sends the job to a worker on a GPU host, for example a RunPod endpoint. See `docs/gpu-prover.md`. | Default build |
| `sp1` | Proves on the local processor. See `docs/server-prover.md`. | Cargo feature `sp1` or `sp1-native-gnark` |
| `oracle` | Signs for a development verifier. For tests and local chains. It refuses a route whose destination is not on the local machine. | Default build |

### Handoff

The result is one JSON object. The command prints it on standard output, posts it to a webhook, or does both. The file sets the targets (`handoff.targets`), and `--to stdout` and `--to webhook` replace them for one run.

- Standard output carries the object on one line and nothing else. Logs go to standard error.
- The webhook gets one `POST` with `Content-Type: application/json`. The User-Agent is `zk-bridge-prover`. The URL must use https, or http on the local machine.
- The bearer token is optional. The file sets `handoff.webhook_bearer_env` to the name of the variable that holds it. The command reads the variable at the start of the run. The token never enters a file or a log line.
- A transport error or a status of 408, 429 or 5xx is retried (`webhook_attempts`, default 3). Another 4xx status is final.
- With both targets, standard output comes first. A failed webhook then does not lose the proof. A proof is costly, so choose both targets when you cannot afford to lose one.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | A proof was made and handed off. |
| 3 | The starting head already is the newest final header. There is nothing to prove, and nothing is printed on standard output. |
| 1 | An error. The message is on standard error. |

A server that follows a lagging light client runs `prove` in a loop. It sends the proof of each run, and it stops when the command exits with code 3.

### The proof package

All hashes and byte strings are `0x` hex. Slots are JSON numbers. The version of the shape is `schemaVersion`. A change that removes or renames a key raises it. Long values are shortened here.

```json
{
  "schemaVersion": 1,
  "route": "ethereum_to_pulsechain",
  "programKey": "0x9999999999999999999999999999999999999999999999999999999999999999",
  "startHeadSlot": 10862664,
  "startHeadRoot": "0xbdc75227ae298ff4dcbd00460c3c294bd3eb55f282c7960c46125460ec9dbf90",
  "newHeadSlot": 10862670,
  "newHeadRoot": "0x313b8af758c40110a27481fc782d1bbd5efccb167d52806d93afb4d61ae4a061",
  "latestFinalizedSlot": 10862670,
  "publicValues": "0x3357ba0018a2…",
  "proof": "0xf49023cdbecf…",
  "updateCalldata": "0x3f37dce20000…",
  "backend": "oracle",
  "destination": {
    "chainId": 369,
    "lightClient": "0x4444444444444444444444444444444444444444"
  },
  "createdAt": "2026-10-24T09:30:00Z"
}
```

| Key | Meaning |
|---|---|
| `route` | The route name, or `explicit-head` when the command line gave the head and no route. |
| `programKey` | The program key that the proof is for. The light client stores the same key as `programVKey`. |
| `startHeadSlot`, `startHeadRoot` | The head where the update starts. The light client must still hold it as its head when the server sends the proof. |
| `newHeadSlot`, `newHeadRoot` | The head after the update. |
| `latestFinalizedSlot` | The newest final slot that the beacon node reported. When it is above `newHeadSlot`, run `prove` again after the update. |
| `publicValues` | The ABI encoding of `LightClientOutput`. |
| `proof` | The proof bytes that the verifier contract reads. |
| `updateCalldata` | The calldata of `BeaconLightClient.update(proof, publicValues)`. Send it to `destination.lightClient`. |
| `backend` | The backend that made the proof. |
| `destination` | The chain identifier and the light client address. The key is absent when the command line gave the head and no route. |
| `createdAt` | When the proof was made, as a time in UTC, such as `2026-10-24T09:30:00Z`. |

A proof stays valid until the light client head moves. After another update, the stored head differs from `startHeadSlot`, and the contract refuses the proof. A server should discard such a proof and run `prove` again.

## The `evidence` command

A withdrawal needs no zero-knowledge proof. The destination vault checks the evidence itself. The `evidence` command builds that evidence for one deposit and prints it. It sends nothing. A server sends the calls.

```
zk-bridge-prover --config prover.toml evidence --tx <hash> --log-index <n> [--route <name>] [--anchor-slot <n>]
```

The deposit is the log at index `n` in the receipt of the source transaction. The index counts inside the receipt, not inside the block. The anchor is the head of the destination light client, or the stored header at `--anchor-slot`.

The command reads two execution chains, the beacon node of the source chain and the destination light client. Then it checks its own work:

- The destination vault names the source vault, the source chain, its own chain and the light client as the file says. The command reads each relation from the vault.
- The log comes from the source vault, is a `DepositInitiated` event, and names the destination vault and chain of the route.
- The evidence passes the vault checks, which `lc-core` runs natively against the anchor root that the light client stores.
- The deposit that the evidence proves equals the deposit in the log.

The result is one JSON object. Long values are shortened here.

```json
{
  "schemaVersion": 1,
  "route": "ethereum_to_pulsechain",
  "sourceTransactionHash": "0xabab…",
  "logIndex": 1,
  "deposit": {
    "nonce": "0x7474…",
    "token": "0x7171…",
    "sender": "0x7272…",
    "recipient": "0x7373…",
    "amount": "1500000000000000000",
    "sourceBlockNumber": 15,
    "sourceBlockHash": "0x847b…",
    "depositSlot": 10862670
  },
  "destination": { "chainId": 369, "vault": "0xb2b2…", "lightClient": "0xb3b3…" },
  "anchor": { "slot": 10862679, "root": "0xc7a5…" },
  "alreadyClaimed": false,
  "withdraw": { "to": "0xb2b2…", "data": "0x30568d83…" },
  "prerequisites": [
    {
      "function": "addBlockHashLayout",
      "reason": "no validated block hash row covers the deposit slot 10862670; this call uses the stored header at slot 10862664",
      "to": "0xb2b2…",
      "data": "0x…"
    }
  ],
  "createdAt": "2026-10-24T09:31:00Z"
}
```

The vault needs a validated layout row for each generalized index that the evidence uses. Anyone may add a row, and the chain validates it. `prerequisites` lists the calls that add the missing rows, in the order to send them. The list is empty when the vault has every row.

The calls for one function are alternatives. After each call, read the layout views of the vault again, and skip the rest once a row covers the slot. The block hash row has up to two calls: one from the stored header at or below the deposit slot, and one from the stored header at or below the anchor.

When the light client stored too few heads to validate a row, the command stops with an error that says what is missing. Wait for more updates, then run it again. When `alreadyClaimed` is true, the vault paid the deposit already, and the withdrawal would revert.

## Catching up a light client that lags

One update moves a light client across at most one sync committee period. The beacon source therefore builds a fold. It reads the committee handoff update of each period from the head period of the light client to the present (`/eth/v1/beacon/light_client/updates?start_period=&count=`, paged, because a node returns at most a count of its own choice). It adds the latest finality update and proves all of them as one fold. When the light client already holds a next committee, the store of the proof carries it, read from the beacon state of the head. The contract compares its hash.

A node that pruned the update of a needed period cannot serve the catch-up. The error names the period and asks for a node with a longer history of light-client updates.

## Old deposits

The vault takes `state.block_roots` of the anchor for a deposit up to 8192 slots below it, and `state.historical_summaries` beyond that. The evidence builder builds either branch with `lc-core`. For an old deposit, it rebuilds the 8192 block roots of the deposit era from the canonical block roots of the node (`/eth/v1/beacon/blocks/<slot>/root`). It never reads them from an old state. The node must still serve the state of the anchor, so anchor at the newest stored head.

## Tests

```
cargo test --offline
cargo clippy --offline --all-targets --all-features -- -D warnings
scripts/check-crate-ages.sh        # every locked crate was published on or before 2026-09-22
```

| Test | What it shows |
|---|---|
| `tests/produce.rs` | The producer and the `prove` command on a signed beacon chain, with the oracle backend: the package, the exit codes, the webhook and the route mode. |
| `tests/evidence.rs` | The `evidence` command on a synthetic world: a beacon chain, a source chain with one deposit and a destination chain with a vault. The evidence passes the native vault check. |
| `tests/signed_beacon.rs` | The beacon source on the signed beacon chain: the update from a stored head, the withdrawal path and the layout evidence. |
| `tests/remote_prover.rs` | The remote backend against a fake worker, with a real Groth16 proof and the checks that refuse a changed proof. |
| `tests/sp1_execute.rs` | The two guest programs in the SP1 executor against `lc-core` (cargo feature `sp1`). Run it with `cargo test --features sp1 --test sp1_execute -- --test-threads=1`. It takes about 4.5 minutes and needs the guest program files from `cargo prove build` in `light-client/guests/*`. The full Groth16 proof test is ignored on a laptop. |

The Anvil tests of the old relayer, the attack scripts and the end-to-end scripts are on the branch `archive/full-relayer`.

## The seams

- `src/light_client.rs` is the only file that calls `lc-core`.
- `src/contracts.rs` holds every contract binding. The crate only encodes the calls that a server sends.
- The cargo feature `signed-beacon` (on by default) adds a beacon chain over local blocks with real signatures, and the test crate behind it. `--no-default-features` leaves both out.
- The `sp1` cargo feature is off by default. It adds `Sp1Prover`, which proves on the local processor with `sp1-sdk` 6.8.1. The feature `sp1-native-gnark` adds the in-process Groth16 wrapper, and the server image uses it. The feature `sp1-cuda` adds the GPU client and builds the `prove-worker` binary. See the module documentation of `src/prover.rs` and `docs/server-prover.md`.
- `.cargo/config.toml` sets `GOPROXY` for the Go build of the Groth16 wrapper (feature `sp1-native-gnark`).
