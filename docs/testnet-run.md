# Testnet run: Sepolia and PulseChain testnet v4

This page lists the ordered commands to run the bridge on Sepolia (chain 11155111, chain A) and PulseChain testnet v4 (chain 943, chain B). Run every command from the repository root. Nothing here runs by itself. Each step that sends a transaction says so.

## Status on 2026-10-26: read this first

Read items 1 to 3 before you spend time on the rest. They decide whether the run can finish.

1. **Sepolia runs the Gloas fork, and the light client now follows it.** Sepolia is on fork version `0x90000076` since epoch 353024. That version is **Gloas**, not Fulu (`0x90000075`, epoch 272640). Gloas makes `BeaconState` and `BeaconBlockBody` progressive containers, so the generalized indices change (see "How Gloas is handled" below). The program anchors a Gloas head on `state.latest_block_hash` of the finalized state and reads the block number from the execution header RLP. A message proof from a Gloas source block verifies through the bid `parent_block_hash` of a later block (see below); the prover builds it with `evidence`. The openDeposits proof and the head of the light client work. The program ELFs are not rebuilt yet.
2. **The program keys change.** One guest program serves every chain through the chain selector in its input. The selector now has four values (Ethereum mainnet, PulseChain, Sepolia, PulseChain testnet v4), so the program file changes, and so do its keys. **This includes the mainnet key** `0x00f776e8...2f70`, and the fork observation key too, because both programs share `lc-core`. The behaviour on mainnet is the same, but the key is not. The programs were rebuilt on 2026-10-26. `bridge.config.testnet.json` and `light-client/program-keys.json` hold the new keys, and the image v4 holds the new ELFs (see `docs/gpu-prover.md`). Rebuild on the [private] with `light-client/scripts/program-keys.sh --write`, copy the two files to `light-client/elf/`, build the new RunPod image, and write the new keys into the configuration. Nobody has built this yet.
3. **Chain 943 is ready on the prover side.** Its beacon node serves no light-client routes (404). The prover assembles the updates from debug states instead. A real finalized state of 4.8 MB and its block parse correctly: the computed roots equal the header roots.
   **Node limit (checked on 2026-10-26):** the public node of chain 943 serves the state of a finalized header correctly only while that header is the newest finalized one. After the next finalization it serves the same state 64 bytes short (one historical summary less), and the state no longer hashes to the header `state_root`. The prover refuses such a state, as it must. So a run of `prove` from an older head fails with "the state hashes to ... not ...". The publisher must prove from the newest finalized head: start the run while the stored head is the newest finalized header, or read the head state before the node finalizes again. A light client that lags by one finalization cannot catch up through this node. The Lodestar node of Sepolia is stricter: it answers 500 for the state and for the bootstrap of an older root.
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

### What the [private] rebuild must regenerate

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

The valve.city proxy (`https://one.valve.city/beacon/$VALVE_KEY/<chainId>`) answers genesis, config and fork schedule, but 404 for light-client and debug state routes. The prover accepts a path prefix such as `/beacon-api` in `beacon_url`. It sends the User-Agent `Mozilla/5.0 (compatible; zk-bridge/1.0)`.

```sh
ENDPOINTS=public script/testnet/preflight.sh          # keyless, no VALVE_KEY needed
SEPOLIA_RPC_URL=<url> ENDPOINTS=public script/testnet/preflight.sh   # also check the Sepolia execution layer
script/testnet/preflight.sh                           # valve.city, needs VALVE_KEY
```

With `ENDPOINTS=public`, the light-client routes of chain 943 print `INFO` and do not count as failures.

## Checks done on 2026-10-26

- Chain 943, `eth_getCode` at `0x70499adEBB11Efd915E3b69E700c331778628707`: 4,119 hex characters of code with the selectors `deposit()` (`d0e30db0`) and `withdraw(uint256)` (`2e1a7d4d`). `symbol()` is `WPLS`, `name()` is `Wrapped Pulse`, `decimals()` is 18, and `totalSupply()` equals the balance of the contract. That is the behaviour of a canonical wrapped native token. I did not find the address in a document of the PulseChain or gibsfinance projects, so check it once more against the PulseX testnet documentation before you rely on it for value.
- Sepolia, the configured wrapped native token `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9`: code with the same two selectors, symbol `WETH`, 18 decimals.

## Step 0: set up the shell

Keep every secret in an environment variable. Never write a key into a file in the repository.

```sh
export VALVE_KEY=$(op read 'op://valve/valve city unlimited key v3/password')
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
   --arg runner '<runner address>' --arg reward '<reward address, not the runner>' \
   --arg feeRecipient '<fee recipient on chain 943>' \
   '.deployer=$deployer
    | .chainA.verifier=$va | .chainB.verifier=$vb
    | .chainA.deployerNonce=$na | .chainB.deployerNonce=$nb
    | .chainA.feeRouter.runner=$runner | .chainB.feeRouter.runner=$runner
    | .chainA.feeRouter.rewardAddress=$reward | .chainB.feeRouter.rewardAddress=$reward
    | .chainB.fee.recipient=$feeRecipient' \
   script/testnet/bridge.config.testnet.json > .deploy/bridge.config.json
```

The runner key pays gas and signs deliveries. The reward address receives the fees. The runner bot refuses the same address for both roles. Keep them apart.

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
| `WETHOmnibridgeRouter` | 574,658 | 3,871,406 |
| `FeeRouter` | 1,396,348 | 9,824,883 |
| Sum | 15,400,851 | 108,694,551 |

The real figure is about 7 times the local figure. A limit of 1.3 times the local figure runs out of gas on Sepolia, and the deployed addresses then shift. With `--skip-simulation` and `--slow`, Foundry asks the node for each estimate when it sends the transaction, after the earlier transactions are mined, so the estimate uses the real gas rules. A plain transfer to a new account costs 207,391 gas on Sepolia (21,000 on a local fork). The block gas limit of Sepolia is 200,000,000. Chain 943 follows the usual rules: its estimates are about 1.2 times the local figures, and its block gas limit is 30,029,266. Check that your Foundry version sends transactions with a gas limit above 16,777,216 (EIP-7825) to Sepolia before the real run: nobody has sent one yet.

The log lists the addresses of each chain: light client, gate, bridge, mediator, native coin router, fee router and token factory. It ends with two lines that start with `prover flags`. Those lines hold the addresses as arguments of the prover.

Do not give the Foundry broadcast files to the prover. One deployer uses both chains, so the nonce ranges overlap and the two chains create contracts at the same addresses. Foundry then names a contract by the first chain that made it, and the file for chain 943 has wrong `contractName` fields (the registry is called a gate, and two contracts are called a fee router). The prover refuses such a file. The multi-chain file is also in `broadcast/multi/`, not in a folder for each chain.

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
remote_url = "https://43nsvfb8svkosr.api.runpod.ai"
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
printf 'url = "https://43nsvfb8svkosr.api.runpod.ai/ping"\nsilent\nwrite-out = "%%{http_code}\\n"\noutput = "/dev/null"\nheader = "Authorization: Bearer %s"\n' "$RUNPOD_API_KEY" | curl -K -
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

## Step 8: open both bridges (sends transactions)

A bridge opens only after its own light client stored a block that came after the first update of the other light client. Chains need about two epochs to finalize, so repeat step 7 once more for both directions before you open.

The call is `openDeposits(OpeningProof)` on the bridge of each chain. The proof holds a remote block, the state proof of the remote light client (from `eth_getProof`), and the storage proof of one stored head. See `docs/hardened-build-contract.md`, "Launch sequence", step 3. The prover builds the proof and checks it natively before it prints anything. It sends nothing.

```sh
"$PROVER" --config "$RUN_DIR/prover.toml" opening-proof --route sepolia_to_pulsechain_testnet
"$PROVER" --config "$RUN_DIR/prover.toml" opening-proof --route pulsechain_testnet_to_sepolia
```

The JSON holds `to` and `calldata`. Send the calldata with `cast send` (sends a transaction). The command takes `--bridge-source`, `--remote-slot` and `--stored-slot` when you want to choose them.

```sh
cast call "<bridge on Sepolia>" 'depositsOpen()(bool)' --rpc-url sepolia
cast call "<bridge on chain 943>" 'depositsOpen()(bool)' --rpc-url pulsechain_testnet_v4
```

Both calls must print `true`. Until then, a send reverts with `DepositsNotOpen()`.

## Step 9: confirm the gate on Sepolia

The gate of Sepolia is enforcing. The first sender of each epoch calls `BeaconForkGate.confirm(evidence)` before a send. See "Gate evidence" in `docs/hardened-build-contract.md`.

## Step 10: start the bots

The pair `sepolia-pls943` is in `explorer/shared/src/pairs.ts`. Set `"pair": "sepolia-pls943"` in the bot configuration. Write the bot configuration from `explorer/bots/bots.example.json` into `$RUN_DIR/bots.json`. Set these values:

- `deploymentFile`: `$RUN_DIR/deployment.json`.
- `publisher.prover.binary` and `runner.prover.binary`: the path in `$PROVER`.
- `runner.signer`: a reference to the runner key, for example `op://<vault>/<item>/<field>`. Never put the key itself in the file.
- `runner.rewardAddress`: the reward address of step 4.
- `runner.minimumMarginWei`: `0` for the first run, so a fee that only covers the cost still delivers.

Set the endpoint variables, then start both bots in two terminals.

```sh
export EXPLORER_RPC_URL_11155111="https://one.valve.city/rpc/$VALVE_KEY/evm/11155111"
export EXPLORER_RPC_URL_943="https://one.valve.city/rpc/$VALVE_KEY/evm/943"
export EXPLORER_BEACON_URL_11155111="https://one.valve.city/beacon/$VALVE_KEY/11155111"
export EXPLORER_BEACON_URL_943="https://one.valve.city/beacon/$VALVE_KEY/943"
(cd explorer && pnpm install && pnpm --filter @zk-bridge/bots run start publisher --config "$RUN_DIR/bots.json")
(cd explorer && pnpm --filter @zk-bridge/bots run start runner --config "$RUN_DIR/bots.json")
```

Add `--once` to run one pass and exit. The runner refuses to start when the router whitelist, the reward address or the Multicall3 address is wrong.

## Step 11: send one transfer and measure the delivery gas

Send one token relay with a fee offer from Sepolia to chain 943 through the mediator (sends a transaction). Use the terminal dashboard or `relayTokensAndCall` on the mediator with a `FeeDirector` that names the fee router. Keep the transaction hash as `SEND_TX`.

When the runner delivers, read the gas from the receipts. Keep each delivery hash as `DELIVERY_TX`.

```sh
cast receipt "$DELIVERY_TX" --rpc-url pulsechain_testnet_v4 --json | jq '{gasUsed, effectiveGasPrice, status}'
cast receipt "$SEND_TX" --rpc-url sepolia --json | jq '{gasUsed}'
```

Compare the numbers with the values in `docs/bots.md`.

| Item | Expected gas |
|---|---|
| One delivery through `executeMessageWithRunner` | about 417,000 |
| The `update` call with the real verifier | about 337,000 |
| The Groth16 verifier call alone | about 226,000 |
| Multicall3 overhead for each call | about 17,000 |
| Transaction base cost, once | 21,000 |

The runner also writes the outcome of each item (gas and fee earned) to the state directory that `bots.json` names. A delivery is final when the bridge wrote `AffirmationCompleted` for the message identifier.

## Step 12: clean up

```sh
rm -rf "$RUN_DIR" .deploy
unset VALVE_KEY RUNPOD_API_KEY FOUNDRY_RPC_ENDPOINTS
```

The directory holds the prover configuration with the beacon key in it. Delete it when the run ends.
