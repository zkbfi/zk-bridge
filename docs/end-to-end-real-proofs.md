# End-to-end run with real proofs

This page shows how to run the hardened bridge on two local Anvil chains with real SP1 Groth16 proofs and the real SP1 verifier contract. It lists the commands, the results of one run, and what stays synthetic.

**Note (2026-10-24): this page records a run of the full relayer, with the vault contracts. The vault is retired and replaced by `MessageBridge` and `TokenMediator`, so the names below (vault, deposit, withdrawal) are the names of that run.** The repository no longer holds the relayer. The relayer (`zk-bridge-prover run`, `once` and `follow`), the bots, the scripts in `e2e/` and the Anvil tests live on the branch `archive/full-relayer`. To repeat this run, check out that branch. The repository now holds the proof producer (`zk-bridge-prover prove`, see `prover/README.md`) and the evidence builder (`evidence`). A stateful server posts the updates, opens the bridges and delivers the messages (see "Launch sequence" in `docs/hardened-build-contract.md`).

The measurements below still apply to the producer. The proof, its time, its memory and the gas of `update` and `withdraw` do not depend on who sends the transaction. Where the text names the relayer, the scripts or the bots, it describes the run of that branch. The signed beacon chain that the run used is still in `prover/src/local_network/signed_beacon/`, and the tests of the producer run on it (`prover/tests/produce.rs`, `prover/tests/evidence.rs`).

The local network in `docs/local-network.md` uses the oracle backend: a key signs the public values, and `OracleSP1Verifier` accepts the signature. This run replaces both. The prover proves with the SP1 library on a server, and the vendored `SP1Verifier` of circuit v6.1.0 checks each proof on chain.

## What is real and what is synthetic

| Part | Real or synthetic | Note |
|---|---|---|
| The proofs | Real | The prover (`Sp1Prover`, sp1-sdk 6.8.1) proves the light-client program in Groth16 mode on the processor of the server. It checks each proof locally before it sends it. |
| The light-client program | Real | The reproducible Docker build, with the key from `light-client/program-keys.json`. Run 1 used the first program (key `0x00a2b556…584b`). Run 2 used the faster program of the commit "check BLS by subtracting absent keys" (key `0x00ae8429…8bbe`, built with `light-client/scripts/program-keys.sh`, which compares it with the file). The prover refuses to start when its key differs from the contract. |
| The verifier contract | Real | `src/hardened/vendor/sp1-contracts/v6.1.0/SP1VerifierGroth16.sol`, deployed from the vendored source. The deploy script checks its code hash (`0xe5878a94…e84b`). |
| The bridge contracts | Real | `script/hardened/DeployBridge.s.sol` deploys the light clients, the deposit gates and the vaults. |
| The prover service | Real | The same `zk-bridge-prover run` that production uses, with `HttpBeaconSource`, the code that reads a live beacon node. |
| The chain specifications | Real | The fork versions and the genesis validators roots of Ethereum and PulseChain, as `lc-core` holds them. The program checks signatures against them. |
| The execution chains | Local | Two Anvil chains: chain 1 (`cancun`) and chain 369 (`shanghai`). |
| The beacon chains | Synthetic | One chain per Anvil chain, built over its blocks. See "The synthetic beacon chain". |
| The sync committees | Synthetic | 512 keys made from a label, so the secret keys are public. They sign for real: the program checks BLS (Boneh-Lynn-Shacham) signatures of 400 of 512 members. |
| Finality | Synthetic | A header is final when it lies two slots before the attested header. Real chains finalize at epoch borders, about two epochs behind. No program rule checks this. |
| The deposit gate evidence on chain 1 | Synthetic | The bots build the fork proof of the gate from a synthetic state, as in `docs/local-network.md`. The gate of chain 1 lists the fork version `0x0000036c` (PulseChain Capella), which the evidence carries. It does not read the synthetic beacon chain of chain 1. |
| The tokens, the bots, the keys | Local | Test tokens, three bots and the public Anvil mnemonic. |

## The synthetic beacon chain

Anvil has no beacon chain, and the development source (`DevBeaconSource`) asserts light-client outputs with no signature. A real proof needs a real update: the program verifies a sync committee signature. The module `prover/src/local_network/signed_beacon/` builds a beacon chain over the blocks of an Anvil chain and serves it over the standard beacon API. The command is `local-network signed-beacon`.

- Execution block `N` takes slot `first_slot + N - 1`. Its beacon block carries the Anvil block as payload: the block hash and the number are those of Anvil. The block hash is what the vault proves from the deposit header.
- Each header names its parent by root. Its state root is the root of a full `BeaconState` (Capella layout) that holds the `block_roots` ring of the last 8192 headers, the finalized checkpoint, the fork and the two sync committees. The state, the blocks and the headers come out of the same functions, so a restarted node serves the same chain.
- Each block carries a sync aggregate: the first 400 members of the committee of its period sign the root of the parent header, in the signing domain of the chain. The finality update at the tip is made from the tip block, the block before it (attested) and the finalized header, as a beacon node makes it.
- The node serves: the genesis, the fork schedule, headers, block roots, signed blocks and states as SSZ (Simple Serialize), the finality update, the handoff updates of ended periods and the bootstrap. `local-network checkpoint` reads the checkpoint of a light client from these endpoints, for the deploy step.
- The slots lie in the Capella fork of each chain (Ethereum period 760, PulseChain period 1326), because the block parser of the prover reads Capella blocks only. The run stays inside one sync committee period for about 8,000 blocks. A period border is handled and tested: the chain serves the handoff update, and the program accepts the fold.

The guest program has no fixed parameter that stops this. The chain specification fixes the fork versions and the genesis validators root, and the synthetic chain uses them. The only extra rule is the clock: the light client contract refuses a head after the current slot (`HeadInFuture`), computed from its own chain clock.

### The clocks

Each Anvil chain mines one block per slot, with the timestamp of block `N` at exactly `genesis + slot * seconds_per_slot` (`anvil_setBlockTimestampInterval`). The light client on a chain tracks the beacon chain of the OTHER chain, and it compares the head slot with the clock of its own chain. So the two chains must run at the same speed. The scripts mine one block every 12 real seconds on chain 1 and every 10 real seconds on chain 369 (`E2E_TIME_SCALE=1`). An early try with fast blocks of equal real length but different slot length (2 seconds each) made the clocks drift apart, and the light client refused every head with `HeadInFuture`.

## Run it (on the branch `archive/full-relayer`)

Needs `anvil`, `forge` and `cast` (Foundry v1.7.0, as `docker/compose.yaml` pins), a Rust toolchain, Go for the Groth16 wrapper, and the program file of the light-client guest. Run the commands from the repository root. All paths below are relative.

```
cd prover && cargo build --release --locked --features sp1-native-gnark && cd ..
export E2E_LIGHT_CLIENT_ELF=<path of the reproducible light-client program file>
e2e/start.sh
python3 -I e2e/report.py        # while it runs, and after
e2e/stop.sh
```

`e2e/start.sh` does these steps:

1. It starts two Anvil chains (ports 38545 and 38546, on 127.0.0.1) with one block per slot, and the signed beacon node (port 39000).
2. `e2e/deploy.sh` deploys test tokens and the vendored SP1 Groth16 verifier on each chain, checks the verifier code hash, reads the checkpoint of each beacon chain, deploys the bridge with `DeployBridge.s.sol` and `e2e/bridge.config.template.json`, and checks every relation by a read back from the chain (vault to light client, gate, remote vault, token pair, program key, verifier, checkpoint header root).
3. The prover runs `follow --rounds 1` for each route, twice. It stores two light client heads for each route with no deposit in view (see "A finding about the first deposits").
4. The prover starts for both routes, and the bots start. The prover runs `once` in a loop (`e2e/prover-loop.sh`), one process for each pass, and the bots deposit a random small amount, alternate the direction, and wait 150 to 270 seconds between deposits.

The prover runs in a systemd scope with `MemoryMax=70G` and no swap, one proof at a time. A Groth16 proof of one update peaks near 50 to 56 GiB. A sampler writes the memory of the scope every two seconds.

### A finding about memory

The SP1 prover keeps memory after a Groth16 proof (about 40 GiB in our measurement). The second proof in the same process reached 77 GiB within a minute, and a limit of 80 GiB killed the process. The first run (run 1 below) therefore ran with a limit of 100 GiB and two proofs in some processes: the proofs of run 1 that came second in their process peaked at 82 to 88 GiB. That is too much for a machine of 109 GB that also runs a desktop, and the kernel killed the prover twice. The scripts now set `max_proofs_per_process = 1` (new in `[prover]`, with the error `ProofBudget`, which the service treats as transient) and start a new process for each pass (`e2e/prover-loop.sh`). Each process makes at most one proof, and the limit is 70 GiB. Run 2 ran this way. A production service that runs `run` for ever with SP1 needs the same: one process for each proof, or a limit above 90 GiB.

Settings are environment variables (`e2e/env.sh` lists them): `E2E_BACKEND` (`oracle` by default: a rehearsal in seconds with the oracle verifier, and the free way to run the whole system; `remote` for real proofs, chosen only when `RUNPOD_API_KEY` is set, and then `E2E_RUNPOD_URL` must name the RunPod endpoint, which no file holds), `E2E_TIME_SCALE`, `E2E_MINIMUM_WAIT_SECONDS`, `E2E_MAXIMUM_WAIT_SECONDS`, `E2E_SEED_UPDATES` (the least number of `follow` rounds), `E2E_OPENING_ROUNDS` (the most rounds before both vaults must be open), `E2E_MEMORY_LIMIT`. The rehearsal (`e2e/run-all.sh` with no RunPod key, or `E2E_BACKEND=oracle E2E_TIME_SCALE=2`) runs the same scripts, the same beacon chain and the same contracts, and the program runs natively before the oracle signs.

On the server of this run the build and the tools lived in one directory. Foundry came from the release tarball of the tag v1.7.0 (SHA-256, Secure Hash Algorithm 256, checked against the digest that GitHub shows), and the compiler `solc` 0.8.28 from `binaries.soliditylang.org` with its hash checked. `FOUNDRY_SOLC` points forge at that compiler, so forge downloads nothing. The wrappers of `forge`, `cast` and `anvil` set `HOME` to a directory of the run, so Foundry writes nothing outside it.

The copy of the repository on the server comes from `git archive HEAD`. Only committed work reaches the server that way.

## A finding about the first deposits

The first try (oracle rehearsal, bots from the start) showed two properties of the prover and the vault. Both matter for the first deposits after a deployment.

1. A vault accepts a block hash layout row only with evidence from a stored header that has an execution block hash. A row covers the slots from its first evidence slot. The constructor of the light client stores no execution block hash for the initial checkpoint, so the first evidence slot is the first head that an update stores. Every deposit at a slot below that head fails with `no validated block hash layout covers slot N yet` for ever. The first update is the one that the first deposit causes, and it finalizes a head after that deposit. So the first deposit of each route is never paid, and it stays in the loop until `max_attempts` ends it.
2. The block roots row needs two stored headers below the anchor, and the prover counts the headers that `HeadUpdated` events name. So the first withdrawal needs three updates.

The command `zk-bridge-prover follow` (new, `prover/README.md`) removes both: it moves the light client toward the newest final header with no deposit in view. The run stores two heads for each route before the first deposit. With them, every deposit of the run was paid, including the first one of each route, and each later deposit needs one proof.

The vault no longer accepts a deposit before it can be delivered: a locked vault reverts with `DepositsNotOpen()` until `follow` has stored the first heads and the vault proved them (see "Launch sequence" in `docs/hardened-build-contract.md`). The scripts below run `follow` until both vaults report open, then start the bots.

The failed attempts of a deposit that waits count against `max_attempts` (5 by default). The scripts set 1,000.

`zk-bridge-prover follow` runs once for each route and round in the scripts (a configuration for each route, `prover-a_to_b.toml` and `prover-b_to_a.toml`), so that each process makes one proof.

## Results

Two full runs, with the same scripts, on a server with 32 threads, about 106 GB of free memory and no GPU. Both ran in real time (`E2E_TIME_SCALE=1`): one block every 12 seconds on chain 1 and every 10 seconds on chain 369. In both runs each direction paid at least two deposits through proofs that the vendored verifier accepted on chain. Table terms: "chain-a" below is chain 1, "chain-b" is chain 369. The light client on chain-a follows the beacon chain of chain-b, and the other way round.

### Run 1: the first light-client program (key `0x00a2b556…584b`)

The prover limit was 100 GiB, and a pass could hold two proofs in one process. 12 proofs in all (4 seeds and 8 for deposits), 13 deposits (7 from chain 1 to chain 369, 6 back), all paid once.

| Measure | Result |
|---|---|
| Prove time of one update (Groth16, 32 threads) | 401 to 432 s, mean 417 s |
| Peak memory, first proof of a process | 48.6 to 56.0 GiB |
| Peak memory, second proof of a process | 82.1 to 87.9 GiB |
| Gas of `update` (includes the Groth16 check, about 226,000 gas by itself) | 337,348 to 337,408, mean 337,376, 12 transactions |
| Gas of `withdraw` | 247,185 to 283,508, mean 258,532, 13 transactions |
| Gas of a layout row (added once for each new anchor range) | block roots 117,000 to 172,000; block hash 63,800 to 122,000 |
| Deposit to payout, as the bots saw it | 531 s to 1,427 s, median 947 s (6 payouts seen before the bots stopped) |
| Books | 13 deposits, 13 payouts, none twice, none missing; both vault balances equal liquidity plus deposits minus withdrawals |

### Run 2: the faster program (key `0x00ae8429…8bbe`, absent keys subtracted)

The prover limit was 70 GiB and each process made one proof. 9 proofs (4 seeds and 5 for deposits), 6 deposits (3 each way), all paid once.

| Measure | Result |
|---|---|
| Prove time of one update | 284 to 322 s, mean 296 s (29 percent less than run 1) |
| Peak memory of a proof | 48.3 to 56.3 GiB |
| Gas of `update` | 337,324 to 337,384, mean 337,362, 9 transactions |
| Gas of `withdraw` | 247,201 to 270,916, mean 259,208, 6 transactions |
| Deposit to payout, as the bots saw it | 385 s, 543 s and 693 s (3 payouts seen before the bots stopped) |
| Books | 6 deposits, 6 payouts, none twice, none missing; both vault balances equal liquidity plus deposits minus withdrawals |

The gas of `update` does not change between the two programs: the verifier cost depends on the proof system, not on the program. The faster program saves proving time only. A single proof of a real Ethereum update, with the program of run 2, took 243 s (the fixture `test/hardened/fixtures/sp1-proof-ethereum-update.json` is that proof).

The time from deposit to payout is dominated by the wait for a proof. A deposit that arrives while the prover proves for the other direction waits for that proof first, because the prover serves the routes one after the other and one proof at a time. A pass with two uncovered deposits on one route needs two proofs: the first update does not cover a deposit that arrived later. Finality adds only two slots here (about 25 seconds).

The full tables of each run (every proof, every update, every layout row, every withdrawal) come from `python3 -I e2e/report.py`. The logs of the deposit times after the bots stopped are in the prover log (`deposit_state` lines).

## Limits

- The beacon chain, the committees and the finality rule are synthetic. A proof of a real update (the fixture `test/hardened/fixtures/sp1-proof-ethereum-update.json`) shows that the program and the verifier accept real Ethereum data, and this run shows that they accept the synthetic chain. Neither shows how a real beacon node behaves under load.
- Finality takes two slots here. On Ethereum it takes about 13 minutes or more, so the time from deposit to payout on a real chain is longer by that time.
- The run stays in one sync committee period. The handoff and the fold across a border are tested on the synthetic chain, with the program running natively (`prover/src/local_network/signed_beacon/chain.rs`), but they were not proven.
- The proofs run one at a time. Two proofs at once would need about 110 GiB.
- The payout times come from the bots. The bots stopped before the run ended, so the last deposits have no time in the tables, and the books list them as paid.
- The gate of chain 1 reads synthetic evidence, as `docs/local-network.md` explains.
- Chain 1 runs the hardfork `cancun`, not the hardfork of today's Ethereum. The vault proves Capella blocks, as the block parser reads them.
