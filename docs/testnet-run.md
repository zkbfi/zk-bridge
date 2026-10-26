# Testnet run: Sepolia and PulseChain testnet v4

This page lists the ordered commands to run the bridge on Sepolia (chain 11155111, chain A) and PulseChain testnet v4 (chain 943, chain B). Run every command from the repository root. Nothing here runs by itself. Each step that sends a transaction says so.

## Status on 2026-10-26: read this first

The preflight (`script/testnet/preflight.sh`) found these facts. They decide whether the run can finish.

1. **Light-client routes answer 404 on both chains.** The routes `light_client/bootstrap`, `light_client/updates` and `light_client/finality_update` fail. The routes `debug/beacon/states` fail too. All other routes answer 200. Sepolia needs the light-client routes, because the assembled update path reads the Capella block layout only. Chain 943 can use the debug states instead. Run the preflight again when the proxy allows the routes.
2. **The program keys cover mainnet only.** The guest program in `light-client/guests/light-client` selects `EthereumMainnet` or `Pulsechain` in `lc-core` (`ChainSelector`). Those two chains have fixed genesis validators roots and fork tables. Sepolia and chain 943 have other roots and other fork versions. A proof from the current program fails on testnet updates. A testnet run needs a new program build with new keys, and a new RunPod image that holds the new program file. Until then, the keys in `bridge.config.testnet.json` are the mainnet keys.
3. **Sepolia is already past the Fulu fork.** `config/fork_schedule` lists version `0x90000076` from epoch 353024. The table `ETHEREUM_FORKS` in `lc-core` knows mainnet versions only. The gate entry for `0x90000076` uses state depth 6. That depth is not checked against the consensus specification.
4. **The explorer knows one pair.** `PAIR_DEFINITIONS` in `explorer/shared/src/pairs.ts` holds `eth-pls` (chains 1 and 369). The bots cannot run for chains 11155111 and 943 until a pair is added.
5. **Three helpers do not exist in this repository.** No command builds the `openDeposits` proof. No command prints the sync committee hashes of a checkpoint. No command writes the deployment file on a public chain, because only `docker/deploy.sh` writes it, for the local stack.
6. **The wrapped native token of chain 943 is unknown.** The configuration holds a placeholder for it.

Multicall3 at `0xcA11bde05977b3631167028862bE2a173976CA11` has code on both chains. The runtime code is the same on both.

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

The script prints one line for each route. It exits with 0 when all routes answer. Do not continue to step 5 until the light-client routes show OK on both chains.

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

Work on a copy outside the repository. Set the placeholders with `jq`. The checkpoint values come from the light-client bootstrap of each chain (see below).

```sh
jq --arg deployer "$DEPLOYER" --arg va "$VERIFIER_A" --arg vb "$VERIFIER_B" \
   --arg na "$NONCE_A" --arg nb "$NONCE_B" \
   --arg runner '<runner address>' --arg reward '<reward address, not the runner>' \
   --arg feeRecipient '<fee recipient on chain 943>' --arg wpls '<wrapped Pulse address on chain 943>' \
   '.deployer=$deployer
    | .chainA.verifier=$va | .chainB.verifier=$vb
    | .chainA.deployerNonce=$na | .chainB.deployerNonce=$nb
    | .chainA.feeRouter.runner=$runner | .chainB.feeRouter.runner=$runner
    | .chainA.feeRouter.rewardAddress=$reward | .chainB.feeRouter.rewardAddress=$reward
    | .chainB.fee.recipient=$feeRecipient | .chainB.wrappedNative=$wpls' \
   script/testnet/bridge.config.testnet.json > "$RUN_DIR/bridge.config.json"
```

The runner key pays gas and signs deliveries. The reward address receives the fees. The runner bot refuses the same address for both roles. Keep them apart.

Fetch each checkpoint at one finalized root of the same chain. Use all four values of a checkpoint from one bootstrap.

```sh
beacon() { printf 'url = "https://one.valve.city/beacon/%s/%s%s"\nsilent\nuser-agent = "Mozilla/5.0 (compatible; preflight/1.0)"\n' "$VALVE_KEY" "$1" "$2" | curl -K -; }
ROOT=$(beacon 943 /eth/v1/beacon/headers/finalized | jq -r .data.root)
beacon 943 "/eth/v1/beacon/light_client/bootstrap/$ROOT" > "$RUN_DIR/bootstrap-943.json"
```

The values `initialSlot` and `initialHeaderRoot` come from `.data.header.beacon` in the bootstrap and the root you used. The committee hash is the Simple Serialize hash tree root of the `SyncCommittee` in the bootstrap. The function `committee_hash` in `prover/src/light_client.rs` computes it. No command prints it yet, so write a small program that calls it. The next committee hash is zero when the bootstrap holds no next committee. Fill these fields:

- `chainA.lightClient.*` and `chainB.observation.*` from chain 943.
- `chainB.lightClient.*` from Sepolia.

Then run the deploy script without `--broadcast`. It checks every value and sends nothing.

```sh
BRIDGE_CONFIG="$RUN_DIR/bridge.config.json" forge script script/hardened/DeployBridge.s.sol \
  --tc DeployBridge --account "$KEYSTORE_NAME" --sender "$DEPLOYER" 2>&1 | redact
```

A placeholder or a wrong value stops the script before any transaction.

## Step 5: deploy the bridge (sends transactions)

Run this step only when the dry run passes. A bridge starts locked.

```sh
BRIDGE_CONFIG="$RUN_DIR/bridge.config.json" forge script script/hardened/DeployBridge.s.sol \
  --tc DeployBridge --account "$KEYSTORE_NAME" --sender "$DEPLOYER" --broadcast --slow 2>&1 | redact | tee "$RUN_DIR/deploy.log"
```

The log lists the addresses of each chain: light client, gate, bridge, mediator, native coin router, fee router and token factory. Write them into a deployment file (`$RUN_DIR/deployment.json`) with the fields that `deploymentChainSchema` in `explorer/shared/src/pairs.ts` lists. Set `start_block` to the block of the first deployment transaction on each chain.

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
chain = "ethereum"
beacon_url = "https://one.valve.city/beacon/$VALVE_KEY/11155111"
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
chain = "pulsechain"
beacon_url = "https://one.valve.city/beacon/$VALVE_KEY/943"
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

The key `chain` accepts `ethereum` and `pulsechain` only. Those names select the mainnet tables (see "Status", item 2).

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

The call is `openDeposits(OpeningProof)` on the bridge of each chain. The proof holds a remote block, the state proof of the remote light client (from `eth_getProof`), and the storage proof of one stored head. See `docs/hardened-build-contract.md`, "Launch sequence", step 3. No command in this repository builds this proof. Build it with a script of your own, then check the result.

```sh
cast call "<bridge on Sepolia>" 'depositsOpen()(bool)' --rpc-url sepolia
cast call "<bridge on chain 943>" 'depositsOpen()(bool)' --rpc-url pulsechain_testnet_v4
```

Both calls must print `true`. Until then, a send reverts with `DepositsNotOpen()`.

## Step 9: confirm the gate on Sepolia

The gate of Sepolia is enforcing. The first sender of each epoch calls `BeaconForkGate.confirm(evidence)` before a send. See "Gate evidence" in `docs/hardened-build-contract.md`.

## Step 10: start the bots

Add a pair for the two chains to `explorer/shared/src/pairs.ts` first (see "Status", item 4). Then write the bot configuration from `explorer/bots/bots.example.json` into `$RUN_DIR/bots.json`. Set these values:

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
rm -rf "$RUN_DIR"
unset VALVE_KEY RUNPOD_API_KEY FOUNDRY_RPC_ENDPOINTS
```

The directory holds the prover configuration with the beacon key in it. Delete it when the run ends.
