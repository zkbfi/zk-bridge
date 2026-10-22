# prover

The prover service of the hardened bridge. It keeps the bridge moving and holds no trusted role: the contracts
check everything it sends. Build contract: `docs/hardened-build-contract.md`, section "Prover service".

```
cargo build --release --no-default-features   # production build: no test crate, no development beacon source
cargo build --release                          # adds the development beacon source for Anvil (cargo feature dev-source)
zk-bridge-prover --config prover.toml once                      # one pass, then exit
zk-bridge-prover --config prover.toml run                       # loop
zk-bridge-prover --config prover.toml status                    # print every deposit and its state
zk-bridge-prover --config prover.toml withdraw --tx <hash> --log-index <n>   # n = index inside the receipt
zk-bridge-prover --config prover.toml retry --tx <hash> --log-index <n>      # send a failed deposit back to the start
zk-bridge-prover --config prover.toml --private-key-env NAME once            # local Anvil only
```

The command line never takes a key. Use a Foundry keystore and a password file (see `prover.example.toml`).

Deposit states: `seen`, `awaiting_finality`, `light_client_updated`, `proven`, `submitted`, `confirmed`, `failed`.
`proven` means the service built the withdrawal and `lc-core` verified it natively. A withdrawal needs no proof.
Only light-client updates are proven.

## Bursts of deposits

Each pass works on all live deposits of a route in four stages. The stages keep a burst of deposits cheap.

1. Light-client update. The service asks for the update for the oldest deposit, then for the newest. One update covers
   every deposit at or below its head, so it sends one update per route per pass when a deposit needs it. The oldest
   deposit goes first because the vault layout rows need a stored header near the oldest deposit.
2. Build. The service builds and checks the withdrawal of each covered deposit.
3. Send. The service sends the withdrawals back to back. It does not wait for a receipt, so the transactions use
   consecutive nonces and share blocks. The flow-limiter simulation, the check for an already claimed nonce and the
   count of attempts still run for each deposit.
4. Confirm. The service waits for the receipts.

A failure of one deposit costs that deposit one attempt. The other deposits go on. Before a transaction is sent, the
service records nothing. After it is sent, the service records the hash and the state `submitted` at once. A crash
between the two steps leaves the deposit `proven`. The next pass finds the nonce claimed, or sends it again.

`max_withdrawals_per_pass` (default 32) limits how many withdrawals a route builds and how many it sends in one pass.
A larger burst takes more passes. The update is still sent once.

## Retry of a failed deposit

A deposit in the state `failed` does not move by itself. Use `retry` when the cause is gone, for example when a
reverted chain removed a light-client update and the update was sent again.

```
zk-bridge-prover --config prover.toml retry --tx <hash> --log-index <n>   # the same pair as `withdraw`
```

`retry` finds the deposit by the hash of its source transaction and its log index. These are stored with the deposit,
so `retry` needs no chain read for that. It then does one of three things.

- The deposit is not `failed`: `retry` refuses and changes nothing.
- The vault already paid the nonce: the deposit becomes `confirmed`.
- Otherwise the deposit goes back to `seen`. The attempt count is zero. The stored calldata and transaction hash are
  cleared, so the next pass builds the withdrawal again. The note keeps the reason of the failure.

## Own-chain light client

A chain whose deposit gate runs in registry mode (PulseChain) has a second light client: one of its OWN beacon chain,
deployed on that chain. The fork registry reads it for freshness and for the start of an observation. Set its address
as `own_light_client` in the section of that chain. Each pass of `once` and `run` then sends it one proof toward the
newest final header of that chain, built from the same beacon source that the route already reads for the other
direction. A failed update is logged (`own_light_client_update_failed`) and never stops a deposit. At startup the
service checks that the contract runs the configured program and follows the same beacon chain (same genesis
validators root) as the light client on the other chain.

## Catching up a light client that lags

One update moves a light client across at most one sync committee period. The HTTP beacon source therefore builds a
fold. It reads the committee handoff update of each period from the head period of the light client to the present
(`/eth/v1/beacon/light_client/updates?start_period=&count=`, paged, because a node returns at most a count of its own
choice), adds the latest finality update, and sends all of them as one proof. This holds for the light clients of both
directions and for the own-chain light client. The program takes 64 updates in one fold, so a light client more than 64
periods behind needs successive proofs on successive passes. When the light client already holds a next committee, the
store of the proof carries it, read from the beacon state of the head (the contract compares its hash). The Anvil
source (`beacon.kind = "dev"`) asserts its output and always needs one proof.

A beacon node that pruned the update of a needed period cannot serve the catch-up. The error names the period and asks
for a node with a longer history of light-client updates. `route-health` probes for this gap on the destination light
client and on the own-chain light client, and gives `WARN` that names the period.

## Tests

```
cargo test
cargo clippy --all-targets -- -D warnings
scripts/check-crate-ages.sh        # every locked crate was published on or before 2026-09-22
```

`tests/anvil_end_to_end.rs` needs `anvil` and `forge` and skips with a message without them. It builds the contracts
into `target/forge`. `PROVER_TEST_CONTRACTS_ROOT` points forge at another copy of the contracts.

The Anvil tests start two chains. Chain 1 (Ethereum role) runs on `cancun`. Anvil does not deploy the EIP-4788 beacon
roots contract, so the tests install the genuine runtime code and write the beacon roots by hand. Its gate is
`Enforcing`, so the first deposit of every epoch carries a fork proof built by the evidence builder. Chain 369
(PulseChain role) runs on `shanghai`. It has no beacon roots contract, and its gate is `DetectBeaconRoots`.

## Old deposits

The vault takes `state.block_roots` of the anchor for a deposit up to 8192 slots below it, and
`state.historical_summaries` beyond that. The service builds either branch with `lc-core`. For an old deposit it
rebuilds the 8192 block roots of the deposit era from the node's canonical block roots
(`/eth/v1/beacon/blocks/<slot>/root`), never from an old state, and it fetches the anchor state while it is near the
head. It also adds the `historical_summaries` layout row of the vault when the row is missing.

## Deposit gate evidence

`src/gate.rs` reads a `BeaconForkGate` and returns empty evidence when the epoch is confirmed (or the gate is still
detecting), and a fork proof when it is stale. `lc_core::gate` builds the proof. The service sends no deposit; a
wallet, a keeper or a test calls `gate::gate_evidence_for_deposit`.

## Route health

```
zk-bridge-prover --config prover.toml route-health [--json] [--margin-seconds 3600] [--stale-epochs 64] [--own-light-client-warn-periods 32]
```

The command answers one question for each route: can it still deliver a deposit made now? A route cannot deliver
deposits made in the last three epochs or so before a source-chain fork that its light-client program does not know
(finding HB-02, window 2). The fork schedule is not on chain, so only an off-chain tool can see the fork coming. The
command reads `/eth/v1/config/fork_schedule`, `/eth/v1/beacon/genesis` and `/eth/v1/beacon/headers/head` from the
source beacon API. It compares the schedule with the fork table of the light-client program (`lc-core`) and, when the
source vault has a deposit gate, with the gate's `supportedVersions`. It also reads the gate (`mode`, `enforcing`,
`isSealed`, `confirmedEpoch`) and the head slot of the destination light client. The decision is the pure function
`route_health::route_status`. It does no input or output, and an interface should copy its rules.

| Status | Meaning |
|---|---|
| `OPEN` | No unsupported fork is scheduled, the gate is not sealed, the light client head is fresh. |
| `WARN` | An unsupported fork is scheduled beyond the margin. The reason says whether it is more than 24 hours ahead. |
| `STOP` | An unsupported fork is active, or activates within the margin. |
| `SEALED` | The gate is sealed. Every deposit reverts. |
| `STALE` | The light client head lags the source head by more than `--stale-epochs` epochs. |

`WARN` also covers the own-chain light client (see above) when its head lags the current slot by
`--own-light-client-warn-periods` periods or more. The default is 32, half of the fold limit of one proof (64 updates).
The lag comes from the wall clock, so a stuck beacon node cannot hide it. It is a `WARN` and not a `STOP`: a deposit
made now does not depend on that light client, so the exit code stays 0.

The margin is the larger of `--margin-seconds` and three epochs. A smaller value is raised to three epochs. When
several findings apply, the most severe one wins (`SEALED`, `STOP`, `STALE`, `WARN`, `OPEN`) and the others appear
as other findings. A schedule entry with epoch 18446744073709551615 (the beacon API value for "never") is not
scheduled. PulseChain lists Deneb that way, with version `0xffffffff`.

Output is one line of `key=value` pairs per route, or one JSON array with `--json`. Each route shows the reason, the
fork version, the activation epoch and time, and the seconds remaining. Exit codes: 0 when every route is `OPEN` or
`WARN`; 2 when any route is `STOP`, `SEALED` or `STALE`; 1 when the command cannot read a route (it never reports an
unread route as open). The check is advisory. A direct contract call skips it, and in the window before a fork such a
call can strand funds.

## The seams

- `src/light_client.rs` is the only file that calls `lc-core` (and `lc-testkit`, for the development source only).
- `src/contracts.rs` holds every contract binding and the vault `deposit` call, with its `gateEvidence` argument.
- The cargo feature `dev-source` (on by default) adds `DevBeaconSource` and the test crate behind it.
  `--no-default-features` leaves both out.
- The `sp1` cargo feature is off by default. It adds `Sp1Prover`, which proves on the local processor with `sp1-sdk` 6.8.1.
  The feature `sp1-native-gnark` adds the in-process Groth16 wrapper and is the one the server image uses.
  See the module documentation of `src/prover.rs` and `docs/server-prover.md`.
- `tests/sp1_execute.rs` (feature `sp1`) runs the two guest programs in the SP1 executor on real and synthetic inputs and
  compares their public values with `lc-core`. Run it with `cargo test --features sp1 --test sp1_execute -- --test-threads=1`
  (about 4.5 minutes). It needs the guest program files from `cargo prove build` in `light-client/guests/*`.
  The full Groth16 proof test is ignored on a laptop because it needs the server.
- `.cargo/config.toml` sets `GOPROXY` for the Go build of the Groth16 wrapper (feature `sp1-native-gnark`).
