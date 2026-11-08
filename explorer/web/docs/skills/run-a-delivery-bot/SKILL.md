---
name: run-a-delivery-bot
description: Runs the zkb.fi delivery runner (zk-bridge-bot runner), which reads proofs from the msgboard, posts light client updates and delivers covered transfers for the fees they offer. Use when an operator wants to deliver transfers for a fee, and needs the configuration, the keys, what the runner spends and what it can earn.
kind: skill
title: Run a delivery bot
summary: Configure and start the delivery runner, and read what it pays, what it earns and why it skips a transfer.
audience: [integrator]
chains: all
verified_release: 0.1.2-next.14
---

# Run a delivery bot

## When to use

- An operator wants to deliver covered transfers and earn the fees that transfers offer.
- An integrator wants to keep a route moving: the runner also posts the light client update when the destination light client is behind.

There are three bots in one program (`zk-bridge-bot`): the **publisher** makes proofs and posts them on msgboard (it holds no wallet), the **runner** delivers (it holds a wallet on the destination chain), and the **traffic** bot sends small test transfers on testnets. This skill covers the runner. To deliver one transfer by hand, see `deliver-it-yourself`.

## Preconditions

- The source repository, and these tools: Node 22 or newer, pnpm, and a Rust toolchain. The bots run from TypeScript source through `tsx`; the workspace has no build step. The runner calls the prover program, so build it first with `cargo build --release` in `prover/`. The runner needs the prover's `verify` command and its `evidence` command.
- A proof publisher running for the same pair and direction (yours or someone else's), so that proofs reach the msgboard. The runner reads them there.
- The deployment file that `docker/deploy.sh` writes (or the variable `EXPLORER_DEPLOYMENT_FILE`), and the setup file that the terminal dashboard writes in its **Prover setup** view (default `~/.config/zk-bridge-explorer/prover-setup.json`, or the directory in `EXPLORER_CONFIG_DIR`). The setup file holds the references to the RPC and beacon endpoints, the msgboard endpoint, the pair and the directions.
- An indexer the runner can read (`runner.indexerUrl`): your own, or the public one (see `read-bridge-data`).
- A wallet on the destination chain, funded with its native coin (PLS on PulseChain and PulseChain testnet v4, ETH on Ethereum and Sepolia). The runner pays gas from it.
- The delivery router and the light client of the destination chain, for example `{{contracts.943.deliveryRouter}}` and `{{contracts.943.lightClient}}`. The runner reads the router from the deployment file; override it with `runner.deliveryRouter`.
- A Multicall3 contract on the destination chain (the runner uses the canonical address by default and refuses to run when that address holds no code).
- Run it against a local test chain before real funds.

## Steps

1. Install and build, from `explorer/`:

   ```sh
   pnpm install
   cargo build --release   # run this one in prover/
   ```

2. Write the bot configuration (JSON). The sample is `bots.example.json`. A minimal runner section:

   ```json
   {
     "schemaVersion": 1,
     "deploymentFile": "/path/to/deployment.json",
     "stateDirectory": "/var/lib/zk-bridge-bots",
     "secretStore": { "kind": "none" },
     "logLevel": "info",
     "runner": {
       "prover": { "binary": "/usr/local/bin/zk-bridge-prover", "timeoutSeconds": 600 },
       "indexerUrl": "http://127.0.0.1:42069",
       "signer": { "kind": "private-key", "key": "env:RUNNER_PRIVATE_KEY" },
       "maximumLossPercent": 20,
       "maximumPrerequisiteSpendPerSweepWei": "50000000000000000",
       "maximumPrerequisiteSpendPerDayWei": "200000000000000000",
       "maximumUnrecoveredPrerequisiteLossWei": "100000000000000000"
     }
   }
   ```

   The three `maximumPrerequisite...` and `maximumUnrecovered...` fields are required. The values above (0.05, 0.2 and 0.1 of the native coin) are the ones in the example file.

3. Keep keys out of the file. A secret is a reference, never a value: `env:NAME` (an environment variable), a password manager reference, or `{ "source": "store", "name": "..." }`. A literal secret in the file is refused. Signers: `private-key`, `keystore`, `mnemonic`, `ledger` or `trezor`. `secretStore.kind` is `none` (default), `system` (Keychain or Secret Service, else an encrypted file) or `encrypted-file` with a `passwordVariable`. Every resolved secret is removed from every log line, error and outcome line.
4. Do one pass first:

   ```sh
   pnpm --filter @zk-bridge/bots run start runner --config bots.json --once
   ```

5. Run it until stopped (it stops cleanly on SIGINT or SIGTERM):

   ```sh
   pnpm --filter @zk-bridge/bots run start runner --config bots.json
   ```

   Logs go to standard error, one JSON object per line. Nothing else prints. State and outcomes are in `stateDirectory`: `outcomes-<pair>.jsonl` and `runner-<pair>-<direction>.json`. A restart continues from them without double work.

### What the runner pays and earns

- **It pays**: the gas of every transaction it sends from its wallet: the light client `update` when no batch carries it, each delivery batch (through Multicall3 `aggregate3`, with up to `maximumBatchSize` (default 5) deliveries and `maximumBatchGas` (default 6,000,000) assumed gas in one transaction), and any layout calls that a delivery needs first.
- **It earns** the fee that a transfer offers, paid by the delivery router. The router pays every tip to its own reward address, fixed when the router was deployed. The runner reads `DeliveryRouter.rewardAddress()` at start and logs it. The runner earns the fee only when that reward address is an address the operator controls. A copy of a delivery gains the copier nothing. Check the router's reward address before you run.
- **It delivers a transfer only when the loss is under the limit.** The cost of a delivery is gas times (base fee plus priority fee), plus its share of the light client update. `maximumLossPercent` (whole number 0 to 100, default 20): a delivery at break-even always delivers, even at 0; below cost, it is left out when the loss is that share of the cost or more. The dapp's default fee is at least twice the cost, so a runner with a margin up to 100% delivers a default-fee transfer.
- **It skips transfers with no fee offer**, unless `deliverWithoutOffer` is true (default false), which delivers for the gas cost alone.
- **It never guesses.** It simulates every transaction first and sends only a batch in which every call succeeds and every item pays. A message carries no gas limit: the runner sizes each delivery with `eth_estimateGas` of `executeMessage` once the proof exists, and packs a batch by the sum. A delivery that runs out of gas reverts and stays undelivered, so it is a skip, never a final failure.

Other defaults: `pollSeconds` 30, `maximumDeliveriesPerSweep` 10, `deliveryGasFallback` 1,500,000 (the gas assumed for a whole delivery when it cannot be estimated yet: the first fee check, before the proof exists, and a delivery that needs the light client update of its own batch), `receiptTimeoutSeconds` 300, `prerequisiteLossRefusalSeconds` 1,800, `openDeposits` true. A fee in a token other than the wrapped native token needs an entry in `tokenValuationsWei` (wei per whole token), or the item is skipped. On chains 943 and 369 the smallest priority fee defaults to 10,000,000 wei (0.01 gwei): a tip of 0.001 gwei or less is skipped by validators and the transaction waits in the pool and blocks every later nonce.

On a fresh deployment both bridges start closed. With `runner.openDeposits` on (default), the runner opens the bridge on its destination chain once the light clients are ready; this is a one-time transaction that anyone may send.

## Expected result

- The runner logs its start, including the router's reward address, and then one log line per decision: `delivery_outcome`, `delivery_skipped`, `update_posted`, `update_skipped`.
- Each line of `outcomes-<pair>.jsonl` has `time`, `kind` (`delivery` or `update`), `pair`, `direction`, `status` (`delivered`, `skipped`, `failed` or `posted`), `reason`, `messageId`, `transactionHash`, `gasUsed`, `gasCostWei`, `feeWei`, `feeExpectedWei`, `feeReceivedTokens` and `path` (`delivery-router` or `bridge`). A skip is written once for each change of reason, not once for each pass.
- A delivered transfer has status `delivered` in the indexer (see `check-transfer-status`), and the batch transaction lists the bridge's `AffirmationCompleted` event for its message id.

## If it fails

- **Config error naming a field** (`config.runner.<field>: ...`). Fix that field. `executionGasFallback`, `proofCheckGas` and `minimumMarginWei` were removed: use `deliveryGasFallback` and `maximumLossPercent`.
- **The runner stops at start with an error naming the router.** It could not read `DeliveryRouter.rewardAddress()`. Check `runner.deliveryRouter` and the destination RPC.
- **It stops because Multicall3 holds no code.** Set `runner.multicall3` to a deployment on that chain.
- **Skip reasons in the log.** `loss-at-or-above-limit` (fee too low for the cost: raise `maximumLossPercent` or wait for cheaper gas), `already-delivered` (someone delivered first; final), `anchor-not-stored` (the light client has no head that covers it yet; tried again next sweep), `insufficient-gas`, `simulation-reverted`, `prerequisite-budget-exhausted` (a layout-call cap was reached), `message-gas-above-batch-maximum`, `batch-result-missing`, `transaction-reverted`.
- **Layout-call spending paused.** At the daily budget or the loss threshold the runner logs `prerequisite_spending_paused`, skips items that need layout calls and still delivers items that need none.
- **Transactions stuck on testnets 943 or 369.** The priority fee is too low. Keep `minimumPriorityFeeWei` at 10,000,000 or higher.
- **It delivers nothing.** Check in order: proofs reach the msgboard (a publisher is running), the indexer lists `covered` items (`/api/feed?status=covered`), the items carry a fee offer, and the loss limit.
- **Never set** `runner.acceptOracleProof` or `publisher.backend: "oracle"` on a live deployment: they are for local tests only.

<!-- TODO: the repository address and the install route for operators are not named here (no public repository URL was in the files I read). The releases carry the terminal dashboard and the guest program as downloads, not the bots; confirm how an operator gets zk-bridge-bot and zk-bridge-prover. -->
<!-- TODO: confirm with the owner who controls the reward address of the live delivery routers, so the "what it earns" section can say whether third-party operators earn today. The code and the docs say the router fixes it at deployment and nobody can change it; I could not read the deployed value. -->
<!-- TODO: the publisher needs a remote proving endpoint and a key; this skill does not cover running one. -->

## References

- `running-a-bot`: the two bots in plain words, the Prover setup view and how secrets are kept.
- `fees-explained`: who receives the fee, and the default fee that bots see.
- `deliver-it-yourself`, `check-transfer-status`, `read-bridge-data`.
- `safety`.
