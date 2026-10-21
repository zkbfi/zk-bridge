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

## The seams

- `src/light_client.rs` is the only file that calls `lc-core` (and `lc-testkit`, for the development source only).
- `src/contracts.rs` holds every contract binding and the vault `deposit` call, with its `gateEvidence` argument.
- The cargo feature `dev-source` (on by default) adds `DevBeaconSource` and the test crate behind it.
  `--no-default-features` leaves both out.
- The `sp1` cargo feature is off by default. See the module documentation of `src/prover.rs`.
