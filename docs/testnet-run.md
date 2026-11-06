# Testnet run: Sepolia and PulseChain testnet v4

This page lists the ordered commands to run the bridge on Sepolia (chain 11155111, chain A) and PulseChain testnet v4 (chain 943, chain B). Run every command from the repository root. Nothing here runs by itself. Each step that sends a transaction says so.

## Status on 2026-10-26: read this first

Read items 1 to 3 before you spend time on the rest. They decide whether the run can finish.

1. **Sepolia runs the Gloas fork, and the light client now follows it.** Sepolia is on fork version `0x90000076` since epoch 353024. That version is **Gloas**, not Fulu (`0x90000075`, epoch 272640). Gloas makes `BeaconState` and `BeaconBlockBody` progressive containers, so the generalized indices change (see "How Gloas is handled" below). The program anchors a Gloas head on `state.latest_block_hash` of the finalized state and reads the block number from the execution header RLP. A message proof from a Gloas source block verifies through the bid `parent_block_hash` of a later block (see below); the prover builds it with `evidence`. The openDeposits proof and the head of the light client work. The program ELFs are not rebuilt yet.
2. **The program keys change.** One guest program serves every chain through the chain selector in its input. The selector now has four values (Ethereum mainnet, PulseChain, Sepolia, PulseChain testnet v4), so the program file changes, and so do its keys. **This includes the mainnet key** `0x00f776e8...2f70`, and the fork observation key too, because both programs share `lc-core`. The behaviour on mainnet is the same, but the key is not. The programs were rebuilt on 2026-10-26. `bridge.config.testnet.json` and `light-client/program-keys.json` hold the new keys, and the image v4 holds the new ELFs (see `docs/gpu-prover.md`). Rebuild on the build host with `light-client/scripts/program-keys.sh --write`, copy the two files to `light-client/elf/`, build the new RunPod image, and write the new keys into the configuration. Nobody has built this yet.
3. **Chain 943 is ready on the prover side.** Its beacon node serves no light-client routes (404). The prover assembles the updates from debug states instead. A real finalized state of 4.8 MB and its block parse correctly: the computed roots equal the header roots.
   **Node fault, and the repair (checked on 2026-10-29):** the public node of chain 943 serves the state of a finalized header whole only while that header is the newest finalized one. After the next finalization it serves the same state 64 bytes short: the last `historical_summaries` entry is missing, every other field is the same, and the state no longer hashes to the header `state_root`. The cause is in Lighthouse-Pulse v2.5.1 (based on upstream Lighthouse v5.1.3, [gitlab.com/pulsechaincom/lighthouse-pulse](https://gitlab.com/pulsechaincom/lighthouse-pulse)): for a frozen state it counts the entries as `(slot - capellaForkSlot) / 8192` instead of `slot / 8192 - capellaForkSlot / 8192` (`beacon_node/store/src/chunked_vector.rs`, `start_and_end_vindex`). The two agree only when Capella forked on an era boundary, which PulseChain did not (slot 134400 on testnet v4, slot 96 on mainnet). Upstream Lighthouse v6.0.0 replaced that storage with hierarchical state diffs, which keep the real list. The prover repairs such a state: on PulseChain only, when exactly the last entry is missing, it takes that entry from the newest finalized state and accepts the result only when it hashes to the header `state_root`. It logs `state_repaired`. So the publisher can prove from an older head, and a light client that lags by many finalizations catches up through this node. The Lodestar node of Sepolia is stricter: it answers 500 for the state and for the bootstrap of an older root.
4. **Public endpoints work.** You do not need the valve.city key to read the beacon chains. Run `ENDPOINTS=public script/testnet/preflight.sh`. See "Endpoints" below.
5. **The explorer knows the pair `sepolia-pls943`.** The bots can run for chains 11155111 and 943.
6. **The helpers exist.** `checkpoint`, `opening-proof` and `deployment-file` are subcommands of the prover (steps 4, 5 and 8).
7. **The wrapped native token of chain 943 is known.** It is `0x70499adEBB11Efd915E3b69E700c331778628707` (symbol `WPLS`, name `Wrapped Pulse`, 18 decimals). The configuration holds it. See "Checks done on 2026-10-26".

Multicall3 at `0xcA11bde05977b3631167028862bE2a173976CA11` has code on both chains. The runtime code is the same on both.

### How Gloas is handled

Sources: `specs/gloas/beacon-chain.md` (`BeaconState`, `BeaconBlockBody`, `ExecutionPayloadBid`, `apply_parent_execution_payload`, `process_execution_payload_bid`), `eip-7495.md`, `eip-7916.md`, `specs/gloas/light-client/sync-protocol.md`. Every index below is derived from the field lists in `light-client/crates/lc-core/src/layout.rs` and written to `light-client/tests/fixtures/gindices.json` (key `gloas`).

- **Head anchor.** `state.latest_block_hash` (field 24 of 46) is at index 2947, 11 siblings, under `finalized_header.state_root`. `apply_parent_execution_payload` writes it when a block builds on a FULL parent (`state.latest_block_hash = parent_bid.block_hash`). A block on an EMPTY parent leaves it. So in the post-state of a finalized block it names the newest payload that the finalized chain confirmed: one slot or more before the finalized slot, never the payload of the finalized slot. `process_execution_payload_bid` asserts `bid.parent_block_hash == state.latest_block_hash`, so the specification's `execution_block_hash` (index 2856) has the same value. The program does not read the bid.
- **Block number and receipts root.** The prover supplies the execution header RLP. The guest checks `keccak256(rlp) == latest_block_hash` and reads item 8 (number). The decoder takes any field count (Amsterdam has 23 items, with `blockAccessListHash` and `slotNumber`) and pins items 5, 8 and 11.
- **Other indices.** Finality root 735, current committee 2945, next committee 2946, `block_roots` 352, `historical_summaries` 2950, `fork.current_version` 169 (7 siblings, the gate).
- **Contracts.** `BeaconProofVerifier` takes 352 and 2950 next to the depth rule. `BeaconForkGate` takes the marker 255 (progressive) for a supported version and a seal depth, and checks index 169. The bridge takes `gloasForkSlot` (config key `gloasForkEpoch` of the light client of the Gloas chain): the body-layout path refuses every slot from that slot on.
- **Prover.** It hashes the Gloas state, reads `debug_getRawHeader` from `source.rpc_url`, and attaches both. See `prover/README.md`.
- **Message source.** A message in execution block X is proven by a beacon block B after the block of X, an ancestor of the stored head, whose bid `parent_block_hash` (index 2856) equals `keccak256(RLP of X)`. Receipts and transactions roots come from that RLP. `process_execution_payload_bid` asserts `bid.parent_block_hash == state.latest_block_hash`, and `latest_block_hash` is written only from a confirmed parent payload, so X is a payload that the canonical chain accepted (a block on an empty parent names an older accepted payload, also canonical). The bid `block_hash` is never accepted. The contract applies this rule from the slot `gloasForkSlot` on; the layout path stays closed to Gloas. The prover builds this evidence: it scans the canonical blocks after the slot of X (up to 64) for the first one whose bid names X, hashes that Gloas block body (`lc-core` `ssz_block_gloas`), reads the header RLP with `debug_getRawHeader`, and checks `gloasForkSlot` of the destination bridge. The `evidence` command needs `source.rpc_url` with that method.

### What the build host rebuild must regenerate

1. The two program ELFs (`light-client.elf`, `fork-observation.elf`) with `light-client/scripts/program-keys.sh --write`, because `lc-core` and the wire format changed. Copy them to `light-client/elf/`.
2. `light-client/program-keys.json`, and the keys in `script/testnet/bridge.config.testnet.json` and in the mainnet configuration (`lightClientProgramVKey`, `programVKey`, `observationProgramVKey`). The verifier code hash does not change.
3. The RunPod GPU image with the new ELFs, and its `VERIFIER_HASH` check.
4. The contract bytecode changed (`BeaconProofVerifier`, `BeaconForkGate`, `MessageBridge`): any pinned code hash or predicted address from the old build is stale. The deploy script prints the new ones.


## Endpoints

| Chain | Beacon (no key) | Execution (no key) | Light-client routes |
|---|---|---|---|
| Sepolia 11155111 | `https://lodestar-sepolia.chainsafe.io` | none known; use the valve.city route | bootstrap, updates, finality_update: 200 |
| Chain 943 | `https://rpc-testnet-pulsechain.g4mm4.io/beacon-api` | `https://rpc-testnet-pulsechain.g4mm4.io` | 404 (use debug states) |
| PulseChain mainnet | `https://rpc-pulsechain.g4mm4.io/beacon-api` | | 404 |
| Sepolia states (Checkpointz) | `https://beaconstate-sepolia.chainsafe.io` | | 404; serves only its own recent finalized state |

Lodestar answers 500 for a Sepolia state that is no longer recent, so a proof from a head stored half an hour earlier failed there on 2026-10-29. Give each route source `state_cache_dir`, so the prover keeps every state it verified and starts the next proof from its own copy, and list the Checkpointz server in `state_urls` as a second source for states a few epochs old (see `prover/README.md`, "Old states").

The valve.city proxy (`https://one.valve.city/beacon/$VALVE_KEY/<chainId>`) answers genesis, config and fork schedule, but 404 for light-client and debug state routes. The prover accepts a path prefix such as `/beacon-api` in `beacon_url`. It sends the User-Agent `Mozilla/5.0 (compatible; zk-bridge/1.0)`.

```sh
ENDPOINTS=public script/testnet/preflight.sh          # keyless, no VALVE_KEY needed
SEPOLIA_RPC_URL=<url> ENDPOINTS=public script/testnet/preflight.sh   # also check the Sepolia execution layer
script/testnet/preflight.sh                           # valve.city, needs VALVE_KEY
```

With `ENDPOINTS=public`, the light-client routes of chain 943 print `INFO` and do not count as failures.

## Keeping the light clients alive

**Current state (2026-11-06): the backend's watcher owns keep-alive.** It sees each finality and requests the proofs that
the planner calls for (explorer/backend/README.md, "Proving on finality"). The systemd timer
`zk-bridge-keepalive.timer` (and the cron variant) is retired: it is disabled on the app server, the status page no
longer checks it, and the "Schedule on the app server" section below is kept as history and as a manual backstop only.
The march command (`zk-bridge-keepalive.mjs status|march`) still works for a manual check or a forced march.

Owner: "we need to have setup scripts to march the contracts forward to handle this situation."

### Why a light client strands

A light client with its head in period P stores the committee of P, and of P + 1 once an update proved it. Call the
highest stored period K. The program verifies an update only with a stored committee: the signature must lie in P, or
in P + 1 with the next committee stored. So once the source chain signs in period K + 1, the newest update cannot be
verified by anything the light client holds. Call the first slot of K + 1 the deadline.

- **Before the deadline** one ordinary proof (a keep-alive) moves the head to the newest finalized header. The next
  committee it proves pushes the deadline one period further.
- **After the deadline** only committee handoff updates help: the update of period p (attested and signed in p) proves
  the committee of p + 1. The prover reads them from `/eth/v1/beacon/light_client/updates` and folds each period's
  handoff and the newest update into **one proof** (up to 64 updates; `prover/src/beacon/http.rs`, "Catching up"). So a
  single proof does cross period borders, period by period inside the fold, as long as the source node gives every
  handoff. The program refuses a fold step that skips a period, so there is no shortcut.
- **Stranded**: the source node gives no handoff for a needed period. The public chain 943 node serves no
  `light_client/updates` at all; valve.city's chain 943 beacon serves recent periods (it gave 1367 and 1368 on
  2026-10-31, not 1366). A node that pruned a period strands the light client the same way. Once stranded, no proof
  can move it: it needs a node with that history, or a new light client from a new checkpoint.

The prover asks for a handoff only from the first period whose next committee the light client lacks (fixed on
2026-10-31: it used to ask for the head period too, which failed with "no light-client update for sync committee
period 1366" for the Sepolia light client although it held committee 1367).

The deadline comes about 46 hours after a head update at most (two periods minus the time into the first), and once a
period (22.75 hours on PulseChain, 27.3 on Sepolia) after the head at least. The backend proves a direction once its
head is 12 hours old (`limits.keepAliveSeconds`), so a keep-alive every few hours keeps every light client well before
its deadline, even on a source node without history.

### Status

```sh
script/testnet/light-client-status.sh              # valve.city when VALVE_KEY is set, else the public servers
ENDPOINTS=public script/testnet/light-client-status.sh --json
```

For each light client it prints the head slot and period, the committees it stores, the source chain's slot and
finalized period, how many periods behind it is, when the deadline comes (or how long ago it passed), and a verdict:

| Verdict | Meaning | Exit code |
|---|---|---|
| fresh | The head is recent and the deadline is more than the margin (6 h) away. | 0 |
| needs keep-alive | One ordinary proof moves it: the head is older than 12 h, or the deadline is inside the margin. | 10 |
| needs stepping (k steps) | The deadline passed; the source node gives the k handoffs, and one proof folds them. | 11 |
| STRANDED | The deadline passed and the source node lacks a needed handoff. | 12 |

Exit code 3 means a read failed, 2 a bad argument. The worst light client decides. Use the beacon endpoint the prover
uses (`EXPLORER_BEACON_URL_<chainId>`): which periods it serves decides between stepping and stranded.

### March

```sh
script/testnet/march-light-clients.sh                         # plan only: prints what it would request
script/testnet/march-light-clients.sh --execute               # keep-alive requests through https://prove.zkb.fi
script/testnet/march-light-clients.sh --execute --via local --prover-config "$RUN_DIR/prover.toml"   # sends transactions
```

For each light client that is not fresh it prints the steps (each handoff, signed by a committee the light client
stores by then, then the newest update) and makes one proof at a time. With `--via backend` (default) it posts
`{pair, direction, reason: "keep-alive"}` to `POST /requests` and follows `GET /requests/:id` until the job is
`published`; the runner bot then posts `update`. With `--via local` it runs `zk-bridge-prover prove --route <route>
--to stdout`, checks that the package starts at the stored head and names the right light client, and sends
`updateCalldata` with `cast send --account $KEYSTORE_NAME`. Either way it then reads `head()` until the head moved
(`--head-timeout-minutes`, default 90), judges again, and continues up to `--max-proofs` (default 3). Every decision
comes from the chain as it is, so a second run, or a run after a crash, picks up where the chain stands.

The backend's limits apply to every request: it starts a paid job only when its indexer sees a waiting message or a
head older than `limits.keepAliveSeconds`, at most one job per direction every `secondsBetweenJobsPerDirection`, and
`jobsPerDirectionPerDay` in total; a request for a direction with an active job joins that job. The march waits out a
limit of up to `--max-retry-wait-seconds` (300) and otherwise defers to the next run. A `nothing-to-prove` refusal
near the deadline (only possible for a light client without a stored next committee) is an alert: use `--via local`.

Exit codes as in the status, plus 13: a proof failed, was refused while the deadline is inside the margin, or the head
did not move. Each problem prints a line that starts with `ALERT light-client`. The code is
`explorer/backend/src/keepalive/` (plan, reads, proof paths; tests in `explorer/backend/test/keepalive-*.test.ts`),
the command `explorer/backend/bin/zk-bridge-keepalive.mjs status|march` (without arguments it prints its options).

### Schedule on the app server (retired)

The timer is retired; see the note at the top of this section. What follows describes how it was installed.

The backend proves on finality by itself (explorer/backend/README.md, "Proving on finality"): a message gets its proof
seconds after the source chain finalizes it, and a keep-alive the planner calls for starts at the next finality. Check
it with `journalctl -u zk-bridge-backend -g '"finality_seen"\|"proof_due"\|"job_started"\|"watch_transport"' --since -1h`.
The timer below stays as the backstop.

`deploy/app-server/keepalive/zk-bridge-keepalive.{service,timer}` run the status and then the march every three hours
as the backend's user, with the backend's own settings (`--backend-config /etc/zk-bridge/backend/backend.json`):
same endpoints, same keep-alive age. `deploy.sh` does not install them:

```sh
install -m 0644 /opt/zk-bridge/current/deploy/app-server/keepalive/zk-bridge-keepalive.{service,timer} /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now zk-bridge-keepalive.timer
journalctl -u zk-bridge-keepalive -g 'ALERT light-client' --since -1d     # problems
systemctl list-units --failed 'zk-bridge-keepalive*'                      # a run that exited non-zero
```

A run that exits non-zero leaves the unit failed; `OnFailure=` in the unit can point at a mail or webhook unit.
`deploy/app-server/keepalive/crontab.example` does the same with cron and `flock`. At most one request per direction
every three hours reaches the backend, and it pays for a proof only when the head is 12 hours old: about two proofs per
direction per day, far below `jobsPerDirectionPerDay`.

### State on 2026-10-31

| Light client | Head (period) | Stores | Source | Verdict |
|---|---|---|---|---|
| chain 943 `0x1dbb...d958` (tracks Sepolia) | 11463040 (1399) | 1399, 1400 | Sepolia in 1401 | needs stepping: handoff 1400 from Sepolia, one proof |
| Sepolia `0x64dd...7e4e` (tracks chain 943) | 11194368 (1366) | 1366, 1367 | chain 943 in 1368 | stranded on the public 943 node; needs stepping (handoff 1367) on valve.city, with the prover fix |

## Checks done on 2026-10-26

- Chain 943, `eth_getCode` at `0x70499adEBB11Efd915E3b69E700c331778628707`: 4,119 hex characters of code with the selectors `deposit()` (`d0e30db0`) and `withdraw(uint256)` (`2e1a7d4d`). `symbol()` is `WPLS`, `name()` is `Wrapped Pulse`, `decimals()` is 18, and `totalSupply()` equals the balance of the contract. That is the behaviour of a canonical wrapped native token. I did not find the address in a document of the PulseChain projects, so check it once more against the PulseX testnet documentation before you rely on it for value.
- Sepolia, the configured wrapped native token `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9`: code with the same two selectors, symbol `WETH`, 18 decimals.

## Step 0: set up the shell

Keep every secret in an environment variable. Never write a key into a file in the repository.

```sh
export VALVE_KEY=$(op read 'op://<vault>/<item for your valve.city key>/<field>')
export RUNPOD_API_KEY=$(op read '<reference of your RunPod key>')
export FOUNDRY_RPC_ENDPOINTS="{sepolia=\"https://one.valve.city/rpc/$VALVE_KEY/evm/11155111\",pulsechain_testnet_v4=\"https://one.valve.city/rpc/$VALVE_KEY/evm/943\"}"
export KEYSTORE_NAME='<name of your Foundry keystore account>'
export DEPLOYER=$(cast wallet address --account "$KEYSTORE_NAME")
redact() { sed -f <(printf 's|%s|[redacted]|g\n' "$VALVE_KEY"); }
umask 077
export RUN_DIR=$(mktemp -d)
```

If `op read` fails with an authorization timeout, unlock 1Password and run it again. Pipe the output of each Foundry command through `redact`, because Foundry can print a web address with the key in it.

## Step 1: preflight

```sh
script/testnet/preflight.sh
```

The script prints one line for each route. It exits with 0 when all counted routes answer. Do not continue to step 5 until the light-client routes of Sepolia show OK. Chain 943 serves none, and the prover uses debug states there.

## Step 2: build the prover

```sh
(cd prover && cargo build --release --no-default-features)
export PROVER=$PWD/prover/target/release/zk-bridge-prover
```

## Step 3: deploy the verifier on both chains (sends transactions)

The deploy script needs a verifier address on each chain. Deploy the vendored verifier. Its runtime code hash must equal `0xe5878a94678c40ab6b1bebc391f4d4c12f44bedb8291921b5c0f5a251ec6e84b` (see `docs/sp1-version-policy.md`).

```sh
forge create src/hardened/vendor/sp1-contracts/v6.1.0/SP1VerifierGroth16.sol:SP1Verifier \
  --rpc-url sepolia --account "$KEYSTORE_NAME" --broadcast --json 2>&1 | redact
forge create src/hardened/vendor/sp1-contracts/v6.1.0/SP1VerifierGroth16.sol:SP1Verifier \
  --rpc-url pulsechain_testnet_v4 --account "$KEYSTORE_NAME" --broadcast --json 2>&1 | redact
```

Copy each `deployedTo` address into `VERIFIER_A` and `VERIFIER_B`. Then check the code hash and read the nonces.

```sh
export VERIFIER_A=<deployedTo on Sepolia>
export VERIFIER_B=<deployedTo on chain 943>
cast codehash "$VERIFIER_A" --rpc-url sepolia
cast codehash "$VERIFIER_B" --rpc-url pulsechain_testnet_v4
export NONCE_A=$(cast nonce "$DEPLOYER" --rpc-url sepolia)
export NONCE_B=$(cast nonce "$DEPLOYER" --rpc-url pulsechain_testnet_v4)
```

Both hashes must equal the pinned value. If one differs, stop.

## Step 4: fill the configuration

Work on a copy. Foundry reads a file only from a folder that `foundry.toml` allows, so the deploy script reads its configuration from `.deploy/` (listed in `.gitignore`). The file holds no secret. Set the placeholders with `jq`. The checkpoint values come from the light-client bootstrap of each chain (see below).

```sh
mkdir -p .deploy
jq --arg deployer "$DEPLOYER" --arg va "$VERIFIER_A" --arg vb "$VERIFIER_B" \
   --arg na "$NONCE_A" --arg nb "$NONCE_B" \
   --arg reward '<reward address>' \
   '.deployer=$deployer
    | .chainA.verifier=$va | .chainB.verifier=$vb
    | .chainA.deployerNonce=$na | .chainB.deployerNonce=$nb
    | .chainA.deliveryRouter.rewardAddress=$reward | .chainB.deliveryRouter.rewardAddress=$reward' \
   script/testnet/bridge.config.testnet.json > .deploy/bridge.config.json
```

The runner key pays gas and signs deliveries. The reward address receives the tips. Anyone may deliver through the router, and the tip always goes to the reward address.

Fetch each checkpoint at one finalized root of the same chain. Use all four values of a checkpoint from one bootstrap.

```sh
beacon() { printf 'url = "https://one.valve.city/beacon/%s/%s%s"\nsilent\nuser-agent = "Mozilla/5.0 (compatible; preflight/1.0)"\n' "$VALVE_KEY" "$1" "$2" | curl -K -; }
ROOT=$(beacon 943 /eth/v1/beacon/headers/finalized | jq -r .data.root)
beacon 943 "/eth/v1/beacon/light_client/bootstrap/$ROOT" > "$RUN_DIR/bootstrap-943.json"
```

The prover prints all four values from one finalized root with the command `checkpoint`. It reads the bootstrap route. When that route answers 404 (chain 943), it builds the values from the finalized debug state and checks the state root against the header. The next committee hash is zero when none is known (the field `nextCommitteeKnown` says which).

```sh
"$PROVER" checkpoint --beacon-url https://rpc-testnet-pulsechain.g4mm4.io/beacon-api --chain pulsechain-testnet-v4
"$PROVER" checkpoint --beacon-url https://lodestar-sepolia.chainsafe.io --chain sepolia   # reads the Gloas state; a Gloas run needs source.rpc_url for the execution header
```

The command also prints the genesis validators root, genesis time, seconds per slot, Capella fork epoch and `capellaEra`. Compare them with the configuration. Fill these fields:

- `chainA.lightClient.*` and `chainB.observation.*` from chain 943.
- `chainB.lightClient.*` from Sepolia.

Then run the deploy script without `--broadcast`. It checks every value and sends nothing.

```sh
BRIDGE_CONFIG=.deploy/bridge.config.json forge script script/hardened/DeployBridge.s.sol \
  --tc DeployBridge --account "$KEYSTORE_NAME" --sender "$DEPLOYER" 2>&1 | redact
```

A placeholder or a wrong value stops the script before any transaction.

## Step 5: deploy the bridge (sends transactions)

Run this step only when the dry run passes. A bridge starts locked.

```sh
BRIDGE_CONFIG=.deploy/bridge.config.json forge script script/hardened/DeployBridge.s.sol \
  --tc DeployBridge --account "$KEYSTORE_NAME" --sender "$DEPLOYER" --broadcast --slow --skip-simulation 2>&1 | redact | tee "$RUN_DIR/deploy.log"
```

**Why `--skip-simulation`.** Without it, Foundry sets the gas limit of each transaction from its own local run, times 1.3. Sepolia runs the Amsterdam fork and charges much more gas for new contract code than Foundry counts. On 2026-10-26 `eth_estimateGas` on the real Sepolia endpoint gave these figures for the deploy transactions, next to the gas that the transaction used on a local fork of Sepolia:

| Contract | Local fork gas used | Real Sepolia estimate |
|---|---|---|
| `BeaconLightClient` | 917,335 | 6,124,770 |
| `BeaconForkGate` | 1,813,282 | 12,549,961 |
| `MessageBridge` | 5,006,027 | 35,838,770 |
| `TokenMediator` (largest) | 5,693,201 | 40,484,761 |
| `WETHOmnibridgeRouter` (deleted; historical measurement) | 574,658 | 3,871,406 |
| `DeliveryRouter` | 1,396,348 | 9,824,883 |
| Sum | 15,400,851 | 108,694,551 |

The real figure is about 7 times the local figure. A limit of 1.3 times the local figure runs out of gas on Sepolia, and the deployed addresses then shift. With `--skip-simulation` and `--slow`, Foundry asks the node for each estimate when it sends the transaction, after the earlier transactions are mined, so the estimate uses the real gas rules. A plain transfer to a new account costs 207,391 gas on Sepolia (21,000 on a local fork). The block gas limit of Sepolia is 200,000,000. Chain 943 follows the usual rules: its estimates are about 1.2 times the local figures, and its block gas limit is 30,029,266. Check that your Foundry version sends transactions with a gas limit above 16,777,216 (EIP-7825) to Sepolia before the real run: nobody has sent one yet.

The log lists the addresses of each chain: light client, gate, bridge, mediator, native coin router, delivery router and token factory. It ends with two lines that start with `prover flags`. Those lines hold the addresses as arguments of the prover.

Do not give the Foundry broadcast files to the prover. One deployer uses both chains, so the nonce ranges overlap and the two chains create contracts at the same addresses. Foundry then names a contract by the first chain that made it, and the file for chain 943 has wrong `contractName` fields (the registry is called a gate, and two contracts are called a delivery router). The prover refuses such a file. The multi-chain file is also in `broadcast/multi/`, not in a folder for each chain.

Write the deployment file with the prover. It writes `$RUN_DIR/deployment.json` (mode 0600) with the fields of `deploymentChainSchema` in `explorer/shared/src/pairs.ts`. The start block of a chain is the block before its first deployment transaction.

```sh
RUN=broadcast/multi/DeployBridge.s.sol-latest/run.json
HEX='def hex: ltrimstr("0x") | explode | map(if . >= 97 then . - 87 else . - 48 end) | reduce .[] as $digit (0; . * 16 + $digit);'
START_A=$(jq "$HEX"'[.deployments[] | select(.chain == 11155111) | .receipts[].blockNumber | hex] | min - 1' "$RUN")
START_B=$(jq "$HEX"'[.deployments[] | select(.chain == 943) | .receipts[].blockNumber | hex] | min - 1' "$RUN")
FLAGS_A=$(sed -n 's/^ *prover flags, chain A: //p' "$RUN_DIR/deploy.log")
FLAGS_B=$(sed -n 's/^ *prover flags, chain B: //p' "$RUN_DIR/deploy.log")
eval "$PROVER deployment-file --output $RUN_DIR/deployment.json $FLAGS_A --chain-a start_block=$START_A $FLAGS_B --chain-b start_block=$START_B"
```

The command refuses to overwrite without `--force`. Check `start_block` of each chain against the block of the first deployment transaction.

## Step 6: write the prover configuration

The prover configuration holds the beacon address with the key in it. Write it to a file of mode 0600 in `$RUN_DIR` and delete it at the end. Use the addresses from step 5.

```sh
cat > "$RUN_DIR/prover.toml" <<EOF
[prover]
backend = "remote"
remote_url = "https://<your-endpoint-identifier>.api.runpod.ai"
remote_api_key_env = "RUNPOD_API_KEY"

[handoff]
targets = ["stdout"]

[routes.sepolia_to_pulsechain_testnet.source]
chain_id = 11155111
chain = "sepolia"
beacon_url = "https://lodestar-sepolia.chainsafe.io"
rpc_url = "https://one.valve.city/rpc/$VALVE_KEY/evm/11155111"
bridge = "<bridge on Sepolia>"

[routes.sepolia_to_pulsechain_testnet.destination]
chain_id = 943
rpc_url = "https://one.valve.city/rpc/$VALVE_KEY/evm/943"
light_client = "<light client on chain 943>"
bridge = "<bridge on chain 943>"
start_block = <first block on chain 943>

[routes.pulsechain_testnet_to_sepolia.source]
chain_id = 943
chain = "pulsechain-testnet-v4"
beacon_url = "https://rpc-testnet-pulsechain.g4mm4.io/beacon-api"
rpc_url = "https://one.valve.city/rpc/$VALVE_KEY/evm/943"
bridge = "<bridge on chain 943>"

[routes.pulsechain_testnet_to_sepolia.destination]
chain_id = 11155111
rpc_url = "https://one.valve.city/rpc/$VALVE_KEY/evm/11155111"
light_client = "<light client on Sepolia>"
bridge = "<bridge on Sepolia>"
start_block = <first block on Sepolia>
EOF
```

The key `chain` accepts `ethereum`, `pulsechain`, `sepolia` and `pulsechain-testnet-v4`. Each name selects its own fork table and genesis validators root. The route from Sepolia needs `source.rpc_url` for the execution header of the Gloas head (status, item 1). The beacon addresses above need no key. You can use the valve.city addresses for the other routes if you prefer.

## Step 7: first light-client update through the RunPod endpoint

First check that the endpoint answers. It can answer 204 while a worker starts, then 200. Write down the time between the two.

```sh
printf 'url = "https://<your-endpoint-identifier>.api.runpod.ai/ping"\nsilent\nwrite-out = "%%{http_code}\\n"\noutput = "/dev/null"\nheader = "Authorization: Bearer %s"\n' "$RUNPOD_API_KEY" | curl -K -
```

Make one proof for each direction. The command exits with 0 when it made a proof, and with 3 when there is nothing to prove.

```sh
"$PROVER" --config "$RUN_DIR/prover.toml" prove --route sepolia_to_pulsechain_testnet --to stdout 2>"$RUN_DIR/prove-a.log" | tee "$RUN_DIR/proof-a.json" | jq '{newHeadSlot, latestFinalizedSlot, backend}'
echo "exit code: ${PIPESTATUS[0]}"
```

Send the update to the light client of the destination (sends a transaction). Use the calldata of the package.

```sh
cast send "<light client on chain 943>" --data "$(jq -r .updateCalldata "$RUN_DIR/proof-a.json")" \
  --rpc-url pulsechain_testnet_v4 --account "$KEYSTORE_NAME" 2>&1 | redact
```

Repeat for the other direction with `--route pulsechain_testnet_to_sepolia`, the light client on Sepolia, and `--rpc-url sepolia`. Run each route again until the exit code is 3. Write down the wall time, the line `proved` in the log, and the cost in the RunPod console.

## Step 8: open both bridges (automatic: the runner sends the transactions)

The runner does this step. With `runner.openDeposits` on (the default), each direction of the runner opens the bridge on its destination chain: at start, after each pass, and right after an update of its own is mined, while the bridge is closed. It builds the proof below with `opening-proof`, simulates `openDeposits`, sends it from the runner's signer, and records the open bridge in its state file, after which it never checks again. The log lines are `deposits_open_checked`, `deposits_opening`, `deposits_opened` and `deposits_open_failed`; `explorer/bots/README.md`, "Opening the bridges", has the details. So start the bots (step 10) after step 7 and watch for `deposits_opened` in both directions.

Which update opens which bridge: the runner of the direction Sepolia to 943 posts to the light client on chain 943, so it opens the bridge on chain 943. For the prover that is the source bridge of the opposite route (`pulsechain-testnet-v4_to_sepolia` in the file the runner writes), and `eth_getProof` runs on Sepolia. The runner of the direction 943 to Sepolia opens the bridge on Sepolia, with `eth_getProof` on chain 943. Both directions must run for both bridges to open.

A bridge opens only after its own light client stored a block that came after the first update of the other light client. Chains need about two epochs to finalize, so the first round of updates for one direction only prepares the second; the runner tries again at each new head.

The proof must be built soon after the light client stores the block. `eth_getProof` runs at that block on the other chain, and a node serves the state of a block only for a while: on 2026-11-01 a manual run hours after the last update failed for both routes with `rpc error 4444/-32602: distance to target block exceeds maximum proof window`. The runner builds the proof right after an update, with the default slots, which take the newest stored block.

A stored head is a finalized checkpoint, already about two epochs old when it is stored, which is past the window of the public Sepolia node (about 64 blocks). So while a bridge is closed the runner also fetches the `eth_getProof` answer at each epoch boundary, within a few blocks of the tip, into `<stateDirectory>/proof-cache`, and the prover file of `opening-proof` names it as `proof_cache_dir`. The prover verifies a cached answer like a live one. Watch for `proof_prefetched` in the runner log and `proof_cache_hit` in the prover's standard error. By hand, add `proof_cache_dir = "<stateDirectory>/proof-cache"` to the destination section of the route in `prover.toml`.

By hand, the steps are as follows. The call is `openDeposits(OpeningProof)` on the bridge of each chain. The proof holds a remote block, the state proof of the remote light client (from `eth_getProof`), and the storage proof of one stored head. See `docs/hardened-build-contract.md`, "Launch sequence", step 3. The prover builds the proof and checks it natively before it prints anything. It sends nothing.

```sh
"$PROVER" --config "$RUN_DIR/prover.toml" opening-proof --route sepolia_to_pulsechain_testnet
"$PROVER" --config "$RUN_DIR/prover.toml" opening-proof --route pulsechain_testnet_to_sepolia
```

The JSON holds `to` and `calldata`. Send the calldata with `cast send` (sends a transaction). The command takes `--bridge-source`, `--remote-slot` and `--stored-slot` when you want to choose them.

```sh
cast call "<bridge on Sepolia>" 'depositsOpen()(bool)' --rpc-url sepolia
cast call "<bridge on chain 943>" 'depositsOpen()(bool)' --rpc-url pulsechain_testnet_v4
```

Both calls must print `true`. Until then, a send reverts with `DepositsNotOpen()`. Run the manual commands right after an update of the light client of the bridge, or the proof window error above comes back.

**The runner needs a header RPC with `debug_getRawHeader` when its main RPC lacks it.** Besides `eth_getProof`, the proof needs the raw header of the remote block (`debug_getRawHeader`): a Sepolia block under Gloas has header fields that the block JSON does not show, so the rebuild from JSON hashes to another value. On 2026-11-01 the runner opened the bridge on Sepolia, but the bridge on chain 943 failed: the keyless Sepolia RPC with enough proof history (`https://ethereum-sepolia-rpc.publicnode.com`, about 100 blocks) answers `-32601` for `debug_getRawHeader`, and the keyed RPC that serves it keeps too short a proof window. The error was `malformed answer: the remote header: the raw header failed (rpc error -32601 ...) and the rebuild from JSON failed (...)`. Keep the main RPC of Sepolia on the node with the proof history, and name the keyed node as a header RPC, asked only for `debug_getRawHeader`:

- in the environment of the bots: `EXPLORER_HEADER_RPC_URL_11155111=<keyed Sepolia RPC>` (a comma separated list for several), or `chains."11155111".headerRpc` of `prover-setup.json` as a reference (`{ "source": "environment", "variable": "EXPLORER_HEADER_RPC_URL_11155111" }`, or an `op://` reference);
- in the backend configuration: `headerRpcUrls: { "11155111": ["<keyed Sepolia RPC>"] }`;
- by hand, in the destination section of the route in `prover.toml`: `header_rpc_urls = ["<keyed Sepolia RPC>"]`.

Every header is checked against the block hash that the own light client stored, so a header RPC is never trusted. When no source gives the header, the error names each one (`destination.rpc_url`, `destination.header_rpc_urls[i]`, the rebuild from JSON) with its cause and no URL. Never paste the keyed URL into a log or a ticket.

**The delivery of a message from Sepolia needs the same header RPC.** On 2026-11-01 the first delivery Sepolia → chain 943 failed in `evidence` with `rpc error -32601: the method debug_getRawHeader does not exist/is not available`: a message in a Gloas block is proven with the raw header of its block, and the main Sepolia RPC lacks the method. The same setting covers it: the bots and the backend write the header RPCs of a chain into the source section of each route whose source is that chain, too. By hand, set `header_rpc_urls = ["<keyed Sepolia RPC>"]` in the source section of the route in `prover.toml`. The `evidence` command asks `source.rpc_url`, then each `source.header_rpc_urls` entry in order; a Gloas header cannot be rebuilt from the block JSON, so there is no rebuild step, and the error names `source.rpc_url` and each `source.header_rpc_urls[i]` with its cause and no URL.

## Step 9: confirm the gate on Sepolia

Owner, 2026-11-01: "sounds like we need to finish the initial inputs to enable deposits, right?", then "yes, build the gate evidence tool", and: "more toolING - functions that can be used by other parts of the codebase such as the frontend".

The gate of Sepolia is enforcing. The first sender of each epoch (6.4 minutes) calls `BeaconForkGate.confirm(evidence)` before a send; later senders in that epoch just send. See "Gate evidence" in `docs/hardened-build-contract.md`. Nobody needs to confirm by hand: every sender confirms when it needs to, with the same functions of `@zkb/data` (`explorer/data/README.md`, "Gate evidence"):

- `ensureGateConfirmed({ client, gate, beacon, account })` reads the gate. When the epoch of the next block is not confirmed, it builds the evidence, checks it with the contract's rules (`checkConfirmEvidence` of `@zkb/core`) against the root that the EIP-4788 contract holds, simulates `confirm` from the sender, and returns the call to send first. It sends nothing.
- The traffic bot calls it before each send from Sepolia and logs `gate_confirmed` with the epoch and the transaction (`traffic.gateBeaconUrls`, step "Start the traffic bot"). The runner never needs it: the bridge calls the gate on a send only, not on a delivery or an update.
- The web app's send flow needs the same step on Sepolia (not built yet; see the note in `explorer/data/README.md`).

**How the evidence is bound.** The latest Sepolia block names its `parentBeaconBlockRoot`, which EIP-4788 stores under the block's time. The evidence is that time, the beacon header of that root, and two branches under its state root: `fork.current_version` (index 169, 7 siblings, Gloas `0x90000076`) and `genesis_validators_root` (index 40, 5 siblings). The branches come from a compact multiproof of the state (`/eth/v0/beacon/proof/state/<state root>?format=0x231f80`), which the public Lodestar node `https://lodestar-sepolia.chainsafe.io` serves; the proof is checked against the on-chain root, so that node need not be trusted. Whether the valve.city beacon endpoint serves this Lodestar endpoint was not checked. The confirmation must land in the epoch of the header, so the evidence is good until the start of the next epoch. In the first slot of an epoch (and after missed slots) the newest header is from the epoch before: wait a slot.

**Cost.** `eth_estimateGas` of `confirm` on Sepolia on 2026-11-01 (read only, from the address `0x...dEaD`): 79,050 gas for the whole transaction, 836 bytes of calldata. It runs once per epoch that has a send.

To look at one confirmation without sending it, record a fixture from public endpoints (read only):

```sh
(cd explorer && pnpm --filter @zkb/data build && node data/scripts/capture-gate-fixture.mjs)
# writes test/hardened/fixtures/gate_evidence_sepolia.json: the reads, the header, the proof, the calldata and the gas estimate
```

## Step 10: start the bots

The pair `sepolia-pls943` is in `explorer/shared/src/pairs.ts`. Set `"pair": "sepolia-pls943"` in the bot configuration. Write the bot configuration from `explorer/bots/bots.example.json` into `$RUN_DIR/bots.json`. Set these values:

- `deploymentFile`: `$RUN_DIR/deployment.json`.
- `publisher.prover.binary` and `runner.prover.binary`: the path in `$PROVER`.
- `runner.signer`: a reference to the runner key, for example `op://<vault>/<item>/<field>`. Never put the key itself in the file.
- `runner.rewardAddress`: the reward address of step 4.
- `runner.maximumLossPercent`: `0` for the first run, so a fee that only covers the cost still delivers.

Set the endpoint variables, then start both bots in two terminals.

```sh
export EXPLORER_RPC_URL_11155111="https://one.valve.city/rpc/$VALVE_KEY/evm/11155111"
export EXPLORER_RPC_URL_943="https://one.valve.city/rpc/$VALVE_KEY/evm/943"
export EXPLORER_BEACON_URL_11155111="https://one.valve.city/beacon/$VALVE_KEY/11155111"
export EXPLORER_BEACON_URL_943="https://one.valve.city/beacon/$VALVE_KEY/943"
(cd explorer && pnpm install && pnpm --filter @zk-bridge/bots run start publisher --config "$RUN_DIR/bots.json")
(cd explorer && pnpm --filter @zk-bridge/bots run start runner --config "$RUN_DIR/bots.json")
```

Add `--once` to run one pass and exit. The runner refuses to start when it cannot read the reward address of the router, or when the Multicall3 address is wrong.

## Step 11: send one transfer and measure the delivery gas

Send one token relay with a fee offer from Sepolia to chain 943 through the mediator (sends a transaction). Use the terminal dashboard or `relayTokensAndCall` on the mediator with a `FeeDirector` that names the delivery router. Keep the transaction hash as `SEND_TX`.

When the runner delivers, read the gas from the receipts. Keep each delivery hash as `DELIVERY_TX`.

```sh
cast receipt "$DELIVERY_TX" --rpc-url pulsechain_testnet_v4 --json | jq '{gasUsed, effectiveGasPrice, status}'
cast receipt "$SEND_TX" --rpc-url sepolia --json | jq '{gasUsed}'
```

Compare the numbers with the values in `docs/bots.md`.

| Item | Expected gas |
|---|---|
| One delivery through `executeMessage` | about 417,000 |
| The `update` call with the real verifier | about 337,000 |
| The Groth16 verifier call alone | about 226,000 |
| Multicall3 overhead for each call | about 17,000 |
| Transaction base cost, once | 21,000 |

The runner also writes the outcome of each item (gas and fee earned) to the state directory that `bots.json` names. A delivery is final when the bridge wrote `AffirmationCompleted` for the message identifier.

## Test tokens and traffic

Owner: "we should start out with a minimum of 1 proof/hour. this will help with keeping things current on both chains and giving us a benchmark to check against. we need to mint tokens on both sides too to test the bridge's utility" and "and then setup bots to move said tokens back and forth". Later: "seems like it would be best to have these proofs be posted if and only if they have erc20s moving across the bridge. otherwise they are useless. so perhaps we should be doing bridges 4x/hr".

Two test tokens on each chain: `zkb Test Dollar` (`tUSD`, 6 decimals) and `zkb Test Token` (`tTKN`, 18 decimals), `src/testnet/TestToken.sol`. Only the deployer (the minter, fixed at deployment) mints; there is no public mint, so nobody can print an amount near the 256 bit limit and push it through the mediator. A tester who wants tokens asks the minter. Their bridged copies are `ztUSD` and `ztTKN`. The traffic bot (`explorer/bots`, "The traffic bot") draws, at the start of each clock hour (UTC) and for each direction on its own, how many transfers to send in that hour (0 to 3, uniformly) and sends them at random times inside it, at least 5 minutes apart. Some hours hold none, some several. Every proof the backend makes then carries token transfers, because the runner proves only for a transfer that waits (the profitability check stays on: testnet transfers earn nothing, so proving only for them is what keeps the cost down).

### What is needed first

1. **The traffic wallet.** A new account, used for nothing else. Create a 1Password item **"testnet traffic wallet"** in the vault **zkb.fi** with two fields: `address` and `private-key`. Generate it where you keep keys (for example `cast wallet new`, in a shell whose history you do not keep), store both fields, and close the shell. Nothing in this repository generates it.
2. **Gas for the traffic wallet**, from the faucets (estimates below): about 2 Sepolia ETH and 10 tPLS to start.
3. **Open bridges.** On 2026-11-01 `depositsOpen()` is `false` on both bridges (`0xb018...fb21` on Sepolia, `0xf59d...1fd1` on chain 943). Until the runner opens them (step 8), every send skips with `deposits-not-open`.
4. **A confirmed gate on Sepolia, each epoch.** Sepolia's gate enforces (`confirmedEpoch()` is `(0, false)` on 2026-11-01). A send from Sepolia in an epoch that nobody confirmed reverts with `ForkNotConfirmed`. The traffic bot confirms the epoch first when it needs to (step 9) and logs `gate_confirmed`; it needs `traffic.gateBeaconUrls` for chain 11155111 (the template names the public Lodestar node). The gate of chain 943 detects and admits, so sends from 943 need nothing.

### Deploy and mint (sends transactions)

Run from the repository root, after step 0. The keystore account (`$KEYSTORE_NAME`, the deployer) becomes the minter. The key stays in the keystore; nothing goes on the command line. The traffic wallet's address is not secret.

```sh
export TRAFFIC_WALLET=<the traffic wallet's address, from your secret store>
# Dry run first (no --broadcast): nothing reaches the chain and no file is written.
forge script script/testnet/DeployTestTokens.s.sol --rpc-url sepolia --account "$KEYSTORE_NAME" --sender "$DEPLOYER" 2>&1 | redact
# Sepolia: --skip-simulation and --slow, because Sepolia charges about 7 times what Foundry counts for new code (step 5).
forge script script/testnet/DeployTestTokens.s.sol --rpc-url sepolia --account "$KEYSTORE_NAME" --sender "$DEPLOYER" \
  --broadcast --slow --skip-simulation 2>&1 | redact
# Chain 943: a priority fee of 0.01 gwei. Foundry's default of 1 wei never gets included there.
forge script script/testnet/DeployTestTokens.s.sol --rpc-url pulsechain_testnet_v4 --account "$KEYSTORE_NAME" --sender "$DEPLOYER" \
  --broadcast --slow --priority-gas-price 10000000 2>&1 | redact
```

Each run mints 1,000,000 tUSD and 1,000,000 tTKN to the traffic wallet (`TUSD_MINT_WHOLE`, `TTKN_MINT_WHOLE` change it) and writes the chain's section into `deploy/deployments/sepolia-pls943.test-tokens.json`. A second run on a chain that the file lists refuses, unless `TEST_TOKENS_REDEPLOY=true`. Commit the file: the traffic bot reads it from the release. The keystore asks for its password; to take it from 1Password instead, add `--password-file <(op read 'op://<vault>/<item>/password')`.

Gas of the deploy, per chain: each token is one creation and one mint. On 2026-11-01 `eth_estimateGas` gave 3,585,793 gas for one token on Sepolia and 657,710 on chain 943 (548,092 on a local chain), so about 7.5 million on Sepolia and 1.5 million on chain 943 with the mints.

### Start the traffic bot

On the app server (`deploy/app-server/config/traffic/`): run `provision.sh` once more (it adds the user `zkb_traffic` and `/etc/zk-bridge/traffic`), then copy the four templates to `/etc/zk-bridge/traffic/` and fill `bots.env` (the two RPC endpoints) and `traffic.env`:

```sh
<print the traffic wallet's private key from your secret store> | ssh zkbfi-app 'umask 027; { echo -n TRAFFIC_PRIVATE_KEY=; cat; echo; } > /etc/zk-bridge/traffic/traffic.env; chgrp zkb_traffic /etc/zk-bridge/traffic/traffic.env'
```

`deploy.sh` then starts `zk-bridge-traffic.service` with the others; it skips it while a file is missing. `ansible-playbook bots.yml -e commit=<hash> -e bots=traffic` moves it alone. Logs: `journalctl -u zk-bridge-traffic -g '"traffic_sent"\|"traffic_skipped"'`. At start the bot logs `traffic_tokens`: every test token with the address of its copy on the other chain.

The settings of the template: amounts from 5 to 50 whole tokens, a home balance band from 100,000 to 990,000, the default tip of 0.1 percent, `newCopyGasLimit` 9,000,000 for sends to Sepolia, `gateBeaconUrls` with the public Lodestar node for Sepolia (the gate evidence, step 9), and native reserves of 0.05 ETH (Sepolia) and 1 tPLS (943).

**Sepolia needs `newCopyGasLimit`.** The first send of a chain 943 token to Sepolia deploys its copy there. With the state of Sepolia overridden for an estimate, `TokenFactory.deploy` of a copy took 6,971,380 gas on 2026-11-01 (989,775 on a local chain). The mediator's default gas limit for that message is 2,750,000 (2,000,000 plus the callback to the router), and a delivery that runs out of gas is final: the tokens stay locked on chain 943 and the copy does not exist. The traffic bot asks for 9,000,000 (below the bridge's `maxGasPerTx` of 10,000,000) while the copy has no code. Anyone else who sends a new token to Sepolia meets the same limit.

**The runner must value the test tokens.** The runner prices a tip only in a token it has a value for (`runner.tokenValuationsWei`), so without entries it skips every test transfer. Add each address of `traffic_tokens` (the four native tokens and the four copies), valued in wei of the coin of the chain where the token is paid out. The test tokens have no market value, so pick values at which the 0.1 percent tip covers a delivery: with 1 whole token worth `10000000000000000000` wei (10 coins) on Sepolia and `1000000000000000000` (1 coin) on chain 943, a 5 token transfer offers 0.05 ETH and 0.005 tPLS, which covers 750,000 gas (a delivery and its share of an update) up to about 66 gwei on Sepolia and 6.6 gwei on chain 943.

**Deploy messages are delivered by the runner.** Until a copy of a native token came home once, the mediator sends every relay of it as a deploy message (`deployMessage: true` in `traffic_sent`). The runner prices it in the copy that the token factory predicts, with the home token's decimals, and delivers it; the first one deploys the copy (on Sepolia about 7 million gas). The traffic bot keeps sending the token meanwhile: waiting for a copy to come home would stall everything while the other bridge's deposits are closed, because only traffic triggers the proofs that open them.

### What a month costs the traffic wallet

Only the traffic wallet's own sends; the runner pays the deliveries and the light client updates. Zero to three sends an hour from each chain, 1.5 on average: about 1,080 relays a month on each chain, plus one approval for each token and copy (eight in all, once). The gas figures below are for the old four an hour (2,880 relays a month on each chain); multiply the gas and coin a month by 0.375.

| | Sepolia | Chain 943 |
|---|---|---|
| Gas of one relay | about 235,000. The estimate of a token's first relay was 362,203 (with the Sepolia state overridden, 2026-11-01); on a local chain a first relay took 138,939 and an ordinary one 90,428 (end-to-end stage `traffic`), so an ordinary one on Sepolia about 235,000 | about 110,000 (the local 90,428 times 1.2, the ratio of step 5) |
| Gas of one approval | 129,344 (estimate) | about 55,000 |
| Gas a month | about 0.68 billion | about 0.32 billion |
| Gas price | 18 wei on 2026-11-01; it swings to several gwei | base fee 7 wei on 2026-11-01, plus the 0.01 gwei tip |
| Native coin a month | 0.012 ETH at today's price, 0.68 ETH at 1 gwei, 3.4 ETH at 5 gwei | about 0.003 tPLS |

Fund 2 Sepolia ETH and 10 tPLS to start, and watch `native-below-reserve` skips.

**Token balances.** A send moves 5 to 50 tokens (27.5 on average). One direction made 2,880 sends a month at the old four an hour (about 1,080 now), so even with no way back the native balance of one token moves at most about 80,000 tokens a month, far inside the 900,000 above the band's minimum. The way back runs as often, and the band brings copies home first when a home balance falls below 100,000. What leaves for good is the tip, 0.1 percent of each send: about 80 tokens a month on each chain. A mint of 1,000,000 of each token lasts for years.

**Proving cost.** The backend batches with a one hour maximum wait, so each direction needs at most one proof an hour, and only in an hour with at least one send. With the count drawn uniformly from 0 to 3, an hour holds a send with probability 3 in 4, so a direction needs a proof in about 18 hours a day and the two directions together about 36 proofs a day (an upper bound for the pair when the backend can prove both directions in one batch). On RunPod serverless that is about 40 US dollars a month, the owner's figure: "<$40/month costs for proving + some gas money which we can get from faucets".

### Checked on local chains

`explorer/e2e` stage `traffic` (run after `open` and `gate`): it deploys the tokens with the script on both Anvil chains, runs `zk-bridge-bot traffic --once` (both directions send their native tUSD, each after one approval: the deploy messages) and delivers these two by hand; sends again, so that both copies go home, posts an update on both light clients, lets the runner deliver both through the delivery router for the default tip, and checks that the wallet got each returned amount back less the 0.1 percent tip; then sends once more, every send now an ordinary release, and the runner delivers both.

## The status page (status.zkb.fi)

The owner asked: "where can i and you go to get a gut check of your uptime / the status. explore.zkb.fi?" and then: "yeah, give it a try. might be better as a standalone, non ipfs server though. then we can have checks on each of the services and a centralized (small) db". So the status page is its own service on the app server, `explorer/status` (README there), not part of the explorer on IPFS.

It runs the checks every 60 seconds: the services (indexer local and public, backend local and public, webhook, `next.zkb.fi` and `zkb.fi` with their release sequence, the IPFS gateway with the dapp CID of each channel), the systemd units (the keep-alive timer is not among them: it is retired), each chain's RPC and beacon, both light clients (head age and deadline, through the keep-alive planner), both bridges (`depositsOpen`), both gates (a gate in a detection mode is ok: it admits sends by design until PulseChain gains beacon roots or a newer opcode; an enforcing-mode gate that does not enforce is degraded, a sealed gate is down), the pipeline (backend `/benchmarks` and `/directions/<dir>/pipeline`, indexer deliveries), the RunPod endpoint (through RunPod's REST API only, never its `/ping` or `/prove`) and the wallet balances. Results go into a SQLite file for 30 days.

- Page: `https://status.zkb.fi/`. For you and for me: `curl https://status.zkb.fi/api/summary` (one line: operational, degraded or down, and what fails), `/api/status` (every check), `/api/history?check=<id>&window=24h|7d|30d`.
- Deploy (after `provision.sh`, which creates the user `zkb_status` and `/etc/zk-bridge/status`): copy `deploy/app-server/config/status/status.json.example` and `status.env.example` to `/etc/zk-bridge/status/` (mode 0640, owner root, group `zkb_status`), fill in the wallet addresses, the thresholds and the endpoints, then `ansible-playbook bots.yml -e commit=<hash> -e bots=status`. DNS: an A record for `status.zkb.fi` to the app server, like the other hosts; Caddy gets the certificate.
- **The blind spot.** The service runs on the app server, so if the server is down, the page is down too, and it cannot tell you. Point a free external monitor at `https://status.zkb.fi/api/summary` (for example UptimeRobot or Better Stack, 5 minute interval). The route answers 200 while everything works or is degraded, and 503 when something is down or when the checks themselves stopped; add `?strict=1` to get 503 for degraded as well.

## Step 12: clean up

```sh
rm -rf "$RUN_DIR" .deploy
unset VALVE_KEY RUNPOD_API_KEY FOUNDRY_RPC_ENDPOINTS
```

The directory holds the prover configuration with the beacon key in it. Delete it when the run ends.
