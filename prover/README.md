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
zk-bridge-prover --config prover.toml --private-key-env NAME once            # local Anvil only
```

The command line never takes a key. Use a Foundry keystore and a password file (see `prover.example.toml`).

Deposit states: `seen`, `awaiting_finality`, `light_client_updated`, `proven`, `submitted`, `confirmed`, `failed`.
`proven` means the service built the withdrawal and `lc-core` verified it natively. A withdrawal needs no proof.
Only light-client updates are proven.

## Own-chain light client

A chain whose deposit gate runs in registry mode (PulseChain) has a second light client: one of its OWN beacon chain,
deployed on that chain. The fork registry reads it for freshness and for the start of an observation. Set its address
as `own_light_client` in the section of that chain. Each pass of `once` and `run` then sends it one update toward the
newest final header of that chain, built from the same beacon source that the route already reads for the other
direction. A failed update is logged (`own_light_client_update_failed`) and never stops a deposit. At startup the
service checks that the contract runs the configured program and follows the same beacon chain (same genesis
validators root) as the light client on the other chain.

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
- The `sp1` cargo feature is off by default. See the module documentation of `src/prover.rs`.
