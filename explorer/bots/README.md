# Bots: proof publisher, delivery runner and testnet traffic

Three bots in TypeScript. They share `explorer/shared` (ABIs, pair registry, message decoding, setup file, secret store,
redactor) with the indexer and the terminal dashboard. Design: `docs/bots.md`.

- The **publisher** makes light client update proofs on a remote graphics processor and posts them on msgboard. It holds no wallet.
- The **runner** reads those proofs, posts `update` to the destination light client when it is behind, and delivers
  covered transfers and messages for the fee that each transfer offers. It holds a wallet on the destination chain.
- The **traffic** bot (testnets) sends small test transfers back and forth, a random number each hour, so both chains see regular
  traffic and the runner and the prover have work to measure. It holds a wallet on both chains. See "The traffic bot".

## Commands

All commands run in `explorer/`.

```sh
pnpm install
pnpm --filter @zk-bridge/bots run test                # unit tests (no network, no chain)
pnpm --filter @zk-bridge/bots run test:integration    # local chain: needs anvil and forge; compiles the repository once
pnpm --filter @zk-bridge/bots run typecheck

pnpm --filter @zk-bridge/bots run start publisher --config bots.json
pnpm --filter @zk-bridge/bots run start runner --config bots.json
pnpm --filter @zk-bridge/bots run start traffic --config bots.json
# add --once to run one pass and exit
```

The binary name is `zk-bridge-bot` (`bin/zk-bridge-bot.mjs`). It runs the TypeScript source with `tsx`, because the
workspace has no build step. Logs go to standard error as one JSON object per line. Nothing else prints.

The bots call `zk-bridge-prover` (`prover/`). Build it first: `cargo build --release` in `prover/`.
The runner needs the `verify` command, which this change added to the prover.

## Configuration

Two files. The **setup file** is the one that the terminal dashboard writes in its Prover setup view
(`~/.config/zk-bridge-explorer/prover-setup.json`, or `EXPLORER_CONFIG_DIR`). It holds the remote prover endpoint, the
references to the RunPod key and to the RPC and beacon endpoints, the msgboard endpoint, the pair, the directions and the
proving policy. The **bot configuration** adds what only a bot needs. A sample is `bots.example.json`.

| Field | Meaning |
|---|---|
| `setupFile` | The setup file. Default: the dashboard path. |
| `deploymentFile` | The file that `docker/deploy.sh` writes (or the variable `EXPLORER_DEPLOYMENT_FILE`). |
| `stateDirectory` | State files and the outcome log. |
| `secretStore` | `none` (default), `system` (Keychain or Secret Service, else the encrypted file) or `encrypted-file`, with `passwordVariable`. |
| `maximumMessageBytes` | The largest msgboard message. Default 8192. |
| `publisher.prover.binary`, `.timeoutSeconds` | The `zk-bridge-prover` binary. |
| `publisher.apiKeyVariable` | The variable that the prover reads the RunPod key from. Default `RUNPOD_API_KEY`. |
| `publisher.remote` | `{ "mode": "load-balancing" }`. The only mode today. It may add `endpoints`, a list of proving endpoints in priority order (`[{ "label", "url", "apiKeyVariable"?, "readyWaitSeconds"?, "timeoutSeconds"?, "attempts"? }]`, as in the backend, `explorer/backend/README.md`, "Proving endpoints"). With `endpoints` the setup file's `endpointUrl` and `runpodApiKey` are not used: each key comes from the environment variable that its entry names, and every endpoint address is removed from the logs. |
| `publisher.backend` | `remote` (default) or `oracle`. The `oracle` backend is for local testing only. The prover signs with a test key, and only a local chain accepts that signature. Never set it on a live deployment. Only the tests and the end-to-end run set it. With it, the publisher posts the oracle form of the proof message (version 2). |
| `publisher.oracleKeyVariable` | The variable that holds the test key of the `oracle` backend. Default `ORACLE_KEY`. With `oracle`, the setup file needs no remote prover endpoint and no RunPod key. |
| `publisher.pollSeconds`, `.republishSeconds`, `.retryBackoffSeconds` | 30, 600 and 120. |
| `publisher.indexerUrl` | Required when the policy proves when a transfer waits. |
| `runner.signer` | `private-key`, `keystore`, `mnemonic`, `ledger` or `trezor`, as in the dashboard. |
| `runner.indexerUrl` | The indexer. |
| `runner.maximumLossPercent` | A whole number from 0 to 100. A delivery is a loss only when its fee is below its cost. A delivery at break-even (fee equal to cost, including a zero cost with a zero fee) always delivers, even at a limit of 0. Below the cost, the runner leaves out a delivery whose loss is this share of its cost or more. The cost includes the share of the light client update that the delivery carries. A left-out message stays deliverable by anyone. Default 20. A configuration that still names `minimumMarginWei` is refused. |
| `runner.acceptOracleProof` | Take proofs in the oracle form (message version 2, a 65 byte proof). For local testing only: set it only when the destination light client uses the oracle stand-in as its verifier. Never on a live deployment. Default off. |
| `runner.deliverWithoutOffer` | Deliver items with no fee offer, for the gas cost alone. Default off. |
| `runner.deliveryRouter` | Default: `delivery_router` of the deployment file. At start the runner reads `DeliveryRouter.rewardAddress()` from it and logs the value. The runner uses that address only for its accounting and its display. The router decides where each tip goes, so the configuration names no reward address. When the read fails, the runner stops with an error that names the router and the chain. |
| `runner.multicall3` | The Multicall3 contract that batches the deliveries. Default `0xcA11bde05977b3631167028862bE2a173976CA11`, the canonical address. At start the runner refuses to run when the address holds no code. |
| `runner.maximumBatchSize` | The most items in one batch transaction. Default 5. |
| `runner.maximumBatchGas` | The most gas that the assumed gas of the items of one batch may add up to. A message whose own assumed gas is above it is sent alone, with the gas it needs, and is never cut. Default 6000000. |
| `runner.tokenValuationsWei` | Wei value of one whole token, by token address. A fee in the wrapped native token needs none. |
| `runner.proofCheckGas` | Gas of the light client proof check inside a delivery, on top of the gas limit of the message. The assumed gas of an item is the gas that the bridge requires for its message limit, plus this number. Default 400000 (the bridge test measures 290,655, plus the entry of the router). A configuration that still names `executionGasFallback` is refused. |
| `runner.minimumPriorityFeeWei` | The smallest priority fee in wei, by chain id. A smaller fee, set by `priorityFeeWei` or suggested by the node, is raised to it, and the fee cap rises by the same amount. Chains 943 and 369 default to 10000000 (0.01 gwei): their validators skip a tip of 0.001 gwei or less, and such a transaction waits in the pool for good and holds back every later nonce of the runner. A chain id in this map wins over the default. |
| `runner.maximumPrerequisiteRounds` | The most layout calls that one delivery sends. Default 4. |
| `runner.prerequisiteGasFallback` | Gas that the runner assumes for a layout call that it cannot simulate before the call before it is mined. Default 300000. |
| `runner.maximumPrerequisiteSpendPerSweepWei` | Required. The most wei that the layout calls of one sweep may cost, counted at the worst case of each send. A sweep that reserved or sent a layout call counts toward `maximumDeliveriesPerSweep`. The example file uses 0.05 of the native coin. |
| `runner.maximumPrerequisiteSpendPerDayWei` | Required. The most wei that layout calls may cost in a rolling 24 hours. The runner keeps the spend in its state file, so a restart does not reset it. At the limit the runner sends no layout call until the window rolls. The example file uses 0.2 of the native coin. |
| `runner.maximumUnrecoveredPrerequisiteLossWei` | Required. The loss at which the runner stops sending layout calls, over a rolling 24 hours. A loss is the layout spend on an item that was then not delivered. The example file uses 0.1 of the native coin. |
| `runner.openDeposits` | Open the bridge on the destination chain while it is closed (see "Opening the bridges" below). Default `true`. |
| `runner.prerequisiteLossRefusalSeconds` | After layout calls were paid for an item and the delivery did not follow, the runner does not try the item for this long. Default 1800. |

A secret is a reference: `env:NAME`, `op://vault/item/field`, or `{ "source": "store", "name": "..." }`. A secret value in
the file is refused. Every resolved secret is removed from every log line, error and outcome line, by value and by shape
(`vk_...`, `rpa_...`, bearer tokens, keys in query strings, `/rpc/<key>` paths).

## The publisher, step by step

For each direction of the setup file, every `pollSeconds`:

1. Read the stored head, its header root and the program key from the destination light client.
2. If the latest proof is at or below the stored head, drop it (`covered`). If the head moved to another slot, drop it (`head-moved`).
3. If the latest proof still starts at the stored head, post it again when the last post is `republishSeconds` old.
   A message lasts about 120 blocks on the board.
4. Otherwise decide by policy whether to prove: not after a failure inside `retryBackoffSeconds`; not within 120 seconds of
   a "nothing to prove" answer; yes when `proveWhenTransferWaits` and the indexer lists a `waiting_for_finality` item; yes
   when `intervalSeconds` have passed since the last proof (zero means never by time).
5. Run `zk-bridge-prover prove --route <route> --to stdout` with the remote backend. The bot writes the prover
   configuration file for one run into a fresh directory of mode 0700 (file mode 0600) and deletes it afterwards. The RunPod key
   goes to the child process only in the environment variable that the file names, never on the command line.
   Exit code 3 means nothing to prove. Any other failure waits for the backoff.
6. Check the package: the program key equals the light client key, the start equals the stored head. Encode the proof
   message (`encodeProofMessage` in `explorer/shared`). Save it to the state file. A crash after the proof loses nothing.
7. Grind the proof of work in a worker thread (`src/msgboard/grind-worker.mjs`), then post with `msgboard_addMessage`.

The state file `publisher-<pair>-<direction>.json` holds the latest proof and the last attempts. A restart continues
from it.

**Remote jobs.** The publisher knows only the interface `ProofSource` (`src/publisher/proof-source.ts`). Today it is
the prover binary with the remote backend against a load balancing endpoint: one `POST /prove` that answers when the
proof is ready, 30 to 75 seconds. A queue endpoint (submit, then poll, or a webhook) is a second `ProofSource` plus a case
in `remoteModeSchema` and `renderProverConfig`. Callers do not change. The setup file and the key handling stay as they are.

## The runner, step by step

For each direction:

1. Subscribe to the msgboard category (`MsgBoardWsClient.subscribeMessages` with the category filter). The client routes
   notifications by subscription identifier and reconnects after a close, for example the valve.city close after 60 seconds
   with code 4008. Each pass also reads `msgboard_content` for the category, to fill gaps.
2. For each message: decode it. Ignore it unless it names this pair and direction. Refuse it unless
   - the program key equals `programVKey()` of the destination light client,
   - the proof ends above the stored head,
   - the start slot and the start root equal the stored head,
   - `zk-bridge-prover verify` accepts the Groth16 proof for that key and those public values.
   A message is looked at once in five minutes.
3. Keep the proof for the sweep (see step 6). The runner posts `update(proof, publicValues)` on its own only when no batch
   carries it. It simulates first. A revert means that another party posted first: skip.
   - Read the call data of the message. A fee offer is a message to the mediator whose recipient is the delivery router and whose
     callback data is a `FeeDirector` (recipient, settings, limit, multiplier). No offer: skip, unless `deliverWithoutOffer`.
   - Compute the fee with `DeliveryRouter.feeInfo(token, value, gasUsed, director)` at the current fee quote. Convert it to wei
     (the wrapped native token one for one, other tokens through `tokenValuationsWei`; no price means skip).
   - Read the gas limit of the message from the feed item. When the indexer has none (a row first seen from the destination
     side), skip with `gas-limit-unknown`. The runner never guesses a limit. The assumed gas of the item is the gas that a
     delivery must supply for that limit (`requiredDeliveryGas`: the limit, one sixty-third of it, one unit and 100000 of
     overhead) plus `proofCheckGas`.
   - Gas cost = gas × (base fee + priority fee). Deliver only when the loss is under the limit: (cost − fee) × 100 is less
     than `maximumLossPercent` × cost. A fee at or above the cost always delivers, so a zero cost with a zero fee delivers. A fee below the cost is a loss. A loss of exactly the limit is left out, so a limit of 0
     delivers at break-even and not below. Otherwise skip with `loss-at-or-above-limit`. The first check uses the assumed gas and needs no evidence. The
     second check uses the gas of the simulation.
   - Build the evidence with `zk-bridge-prover evidence`. The log index inside the receipt comes from the source receipt.
     Skip when the bridge shows the message as delivered.
   - Before the first layout call, estimate the gas of every layout call: simulate the first, and use
     `prerequisiteGasFallback` for a later call that cannot be simulated yet. Skip unless the fee covers the layout calls
     plus the execution (the assumed gas) at the current base fee plus priority fee, with the loss under the limit. Skip
     with `prerequisite-budget-exhausted` when the layout calls would take the sweep over
     `maximumPrerequisiteSpendPerSweepWei`, over the daily budget, or when the loss threshold is reached. The check prices
     the worst case of each call: its gas limit (the simulated gas plus 30 percent) times the maximum fee per gas that the
     send uses (twice the base fee plus the priority fee). No layout call is sent before these checks pass. The calls and
     the gas of this estimate are the approved set.
   - Send the layout calls that the evidence lists, one at a time, each after a simulation. Build the evidence again after
     each call, because the calls of one function are alternatives. Before each send the runner refuses (a) a call that is
     not in the approved set (`prerequisite-not-approved`), (b) a simulation that wants more gas than the estimate
     assumed (`prerequisite-gas-above-approval`), and (c) a send whose worst case would take the spend over a cap
     (`prerequisite-budget-exhausted`). The runner writes the worst case to the state file before it broadcasts, and
     replaces it with `gasUsed` times `effectiveGasPrice` when the receipt arrives. A send that throws, or a receipt that
     never arrives, leaves the worst case charged, because the transaction may be in the pool.
   - An item with a fee offer that passed the steps above waits as ready. After the sweep prepared all items, the ready
     items go to the delivery router in as few batches as `maximumBatchSize` and `maximumBatchGas` allow, oldest first. The
     assumed gas of the items of a batch adds up to at most `maximumBatchGas`. An item whose own assumed gas is above that
     maximum is never packed: it goes alone in a transaction of its own, after the batches, with exactly the gas it needs.
     When the node refuses to run it (the block gas limit), the item skips with `message-gas-above-batch-maximum`. An item
     without an offer (`deliverWithoutOffer`) is not batched: it goes straight to the bridge with its own simulation.
5. Send a batch through Multicall3 (`aggregate3`, failure allowed on each call). The first call is `update(proof, publicValues)`
   at the light client when an update is offered. Each other call is `DeliveryRouter.executeMessage(proof)`.
   Any account may send that call. The router pays every tip to its own reward address, so a copy of a delivery gains the
   copier nothing. When the router cannot deliver the tokens to a recipient, it hands them to its `failedDeliveryAddress`.
   Before the send the runner simulates the batch and drops what cannot go:
   - It reads the result that the simulated call returns for every call. A message that the bridge shows as delivered
     (`AlreadyDelivered`) is dropped and final (`already-delivered`). A message whose anchor the light client has not stored
     (`AnchorNotStored`) is dropped with `anchor-not-stored`, and the next sweep tries it again. `InsufficientGas` is dropped
     with `insufficient-gas`. Any other revert is dropped with `simulation-reverted`, the name of the error and the hash of
     the revert data.
   - It measures each remaining item at the router (`executeMessage`, sent to the router itself). The gas estimate of
     the batch is no use, because a call that fails does not revert the batch, so an estimate settles on a gas amount at
     which calls fail. The gas of an item in a batch is its single gas plus 20000 (the call and the result of Multicall3).
   - It splits the gas of the update among the items by their gas, so that each item carries its share of the update in its
     cost. It judges the fee of each item again at that gas against that cost. Items whose loss reaches the limit leave the
     batch. When the set changed, the runner simulates the smaller batch again, at most three times, and the update is
     split among the items that stay.
   - The gas limit is the sum of the gas of the items and of the update, plus 30 percent, and never below the sum of the
     required delivery gas of the items plus the update. No setting cuts it. The runner reads the result once more under
     this limit, so that a limit that is too short shows as failed calls.
   - It sends only a batch in which every remaining call succeeds and every item pays. A single item uses Multicall3 too.
   Before the send the runner reserves the worst case of the whole transaction in the state file (list `deliverySpend`) and
   replaces it at the receipt with the actual cost. A send that throws leaves the reservation charged. This list appears in
   the rolling spend of the logs (`delivery_batch_mined`) and does not count toward `maximumPrerequisiteSpendPerDayWei` or
   the sweep cap: those bound gifts to other senders, and the fee repays a delivery.
   Multicall3 writes no event and keeps no revert data, so the runner reads the events of the bridge in the receipt. An item
   is `delivered` when the bridge wrote `AffirmationCompleted` for its message identifier. It has the same `transactionHash`
   as the others, and its share of the gas and cost by its assumed gas. The fee tokens of an item are the transfers to the
   reward address from the release of its tokens to the router up to the next release, so they are exact for each item. An
   item without that event failed in the mined block (`batch-result-missing`). The cost share of the items that did not
   execute is an unrecovered loss (`delivery_batch_loss`). A transaction that reverts as a whole fails every item
   (`transaction-reverted`), and its whole cost is a loss.
6. The light client update. A proof that passed step 2 waits for the sweep that follows at once. When a batch follows, the
   batch carries the update as its first call, to the light client, and the runner posts no update of its own. A stale
   update fails alone in Multicall3 and does not revert the batch.
   - The gas of the update counts as cost. Each item carries a share of it, split by gas. An item whose loss with that
     share reaches the limit skips with `loss-at-or-above-limit`. When no item stays, no batch with the update is sent, and
     the runner posts the update alone, as before.
   - When the light client would refuse the update in the simulation (`HeadNotAdvancing` means that the head is at or past
     it), the update is left out of the batch and not offered again.
   - When no batch is sent, the sweep posts the update alone with its own simulation.
   The outcome of the update is a line of kind `update`: `posted` (the light client wrote `HeadUpdated`) or `skipped` with the reason.
   If the final check fails after layout calls were sent, the runner logs `prerequisite_loss` with the item and the lost
   wei, records `prerequisiteCostWei` in the skip, and does not try the item again for
   `prerequisiteLossRefusalSeconds`. Any error after a layout call was attempted counts the same way: the item
   counts toward `maximumDeliveriesPerSweep`, waits out the refusal window, and its charge is a loss. Layout rows help
   every sender, so the sweep cap, the daily budget, the loss threshold and the count toward `maximumDeliveriesPerSweep`
   bound the loss that an attacker can cause with items that pass the first check only. When the daily budget or the loss
   threshold is reached, the runner logs `prerequisite_spending_paused` with the time at which the window rolls enough to
   resume. It skips items that need layout calls with `prerequisite-budget-exhausted` and still delivers items that need none.
   No transaction is sent without a simulation of the same call that succeeded.
7. Record the outcome.

**Outcomes.** Every decision is a log line (`delivery_outcome`, `delivery_skipped`, `update_posted`, `update_skipped`) and a
line in `stateDirectory/outcomes-<pair>.jsonl`. Fields: `time`, `kind` (`delivery` or `update`), `pair`, `direction`,
`status` (`delivered`, `skipped`, `failed`, `posted`), `reason` (new: `insufficient-gas`, `anchor-not-stored`, `batch-did-not-settle`, `batch-result-missing`), `messageId`, `transactionHash`, `gasUsed`, `gasCostWei`,
`prerequisiteCostWei`, `feeWei`, `feeExpectedWei`, `feeReceivedTokens`, `path` (`delivery-router` or `bridge`). Amounts are
decimal strings. A skip is written once for each change of reason, not once for each pass. The state file
`runner-<pair>-<direction>.json` holds the items that need no second look, the layout spend and losses of the last 24 hours,
and `depositsOpen` once the bridge of the destination chain is open.

### Opening the bridges

Both bridges start closed. A bridge opens for good with `openDeposits(proof)`, which anyone may send. The proof shows that the
bridge's own light client stored a block of the other chain, and that the other chain's light client had already stored a
head in the state of that block. So the runner of the direction S to D, which posts the updates to the light client on D,
opens the bridge on D. It can do that once the light client on S has its first update (from the runner of the other
direction, or anyone), and the light client on D then stores a block of S that comes after it.

With `runner.openDeposits` on (the default), each direction of the runner checks the bridge on its destination chain at
start and after each pass, and also right after an update of its own is mined:

1. When the state file says open, nothing happens, for good.
2. It reads the head of the light client on D. When no attempt used a newer head, it waits: the proof needs a block that
   a node still serves the state of, and an old head fails again with "distance to target block exceeds maximum proof
   window".
3. It reads `depositsOpen()` and logs `deposits_open_checked` (`bridge`, `headSlot`, `open`). Open: it writes
   `depositsOpen: true` to the state file and stops checking.
4. It runs `zk-bridge-prover opening-proof --route <D>_to_<S>`. For the prover this bridge is the source bridge of the
   opposite route. With the default slots the prover takes the head of the light client on D, and runs `eth_getProof` on
   S (the remote RPC of that route) at the block of S that the head stored, the newest one. It logs `deposits_opening`
   (`route`, `remoteSlot`, `storedSlot`, `remoteBlockNumber`).
5. It simulates `openDeposits` with `eth_call`. A revert sends nothing. It sends from the runner's signer, with the runner's
   priority fee settings (0.01 gwei or more on chains 943 and 369), through the same queue as its other transactions, and
   logs `deposits_opened` (`transactionHash`, `gasUsed`).

A failure logs `deposits_open_failed` (warning) with `reason` (`read-failed`, `proof-failed`, `wrong-target`,
`simulation-reverted`, `send-failed`, `transaction-reverted`), `detail` and `retryAfterSeconds`. The next attempt waits for a
newer head of the light client and a backoff of 60 seconds that doubles with each failure up to 30 minutes, so it never
loops on a head that cannot work. Until the other light client has its first update the prover refuses with "it needs its
first update"; that is the same wait.

**The raw header of the remote block.** Besides `eth_getProof`, the proof needs the exact header of that block of S, which
the prover asks with `debug_getRawHeader` (a Gloas header on Sepolia has fields that the block JSON does not show, so a
rebuild from the JSON hashes to another value). One node rarely does both: on 2026-11-01 the keyless Sepolia node with
enough proof history (`ethereum-sepolia-rpc.publicnode.com`, about 100 blocks) answers -32601 for `debug_getRawHeader`, and
the keyed node that serves it keeps too short a proof window. So a chain may name **header RPCs**: point
`chains.<chainId>.headerRpc` of `prover-setup.json` at a reference that holds a comma separated list of execution RPC URLs,
or set `EXPLORER_HEADER_RPC_URL_<chainId>` in the environment of the bot:

```json
"chains": {
  "11155111": {
    "rpc": { "source": "environment", "variable": "EXPLORER_RPC_URL_11155111" },
    "beacon": null,
    "headerRpc": { "source": "environment", "variable": "EXPLORER_HEADER_RPC_URL_11155111" }
  }
}
```

The prover file then gets `header_rpc_urls = [...]` in the destination section of each route whose destination is that
chain. The prover asks the main RPC first, then each header RPC in order, only for `debug_getRawHeader`, then the rebuild
from the JSON. Every header must hash to the block hash that the own light client stored, so a header RPC is never trusted:
a wrong one is refused and the next is asked. When all fail, the error names each source (`destination.rpc_url`,
`destination.header_rpc_urls[0]`, ..., the rebuild from JSON) with its cause and no URL. Header RPC URLs can carry a key;
each URL and its key-like parts are removed from every log line.

## The traffic bot

Owner: "we should start out with a minimum of 1 proof/hour. this will help with keeping things current on both chains
and giving us a benchmark to check against. we need to mint tokens on both sides too to test the bridge's utility" and
"and then setup bots to move said tokens back and forth".

The test tokens are `tUSD` (6 decimals) and `tTKN` (18 decimals), deployed on each chain by
`script/testnet/DeployTestTokens.s.sol` (docs/testnet-run.md, "Test tokens and traffic"). Their bridged copies carry the
prefix `z` (`ztUSD`, `ztTKN`). The script writes the test token file that `traffic.tokensFile` names.

Owner, later: "seems like it would be best to have these proofs be posted if and only if they have erc20s moving across
the bridge. otherwise they are useless. so perhaps we should be doing bridges 4x/hr".

Owner, later still: "perhaps the cadence that we should use is something like choose a number, 0-3, and that is how many
bridges will be initated through the course of an hour. 0 because sometimes there will be no bridges. up to 3 because
sometimes there will be multiple. we still use the profitability check because testnet gets us nothing, and that gets us
<$40/month costs for proving + some gas money which we can get from faucets."

At the start of each clock hour (UTC) each direction draws a count uniformly from `cadence.minPerHour` to
`cadence.maxPerHour` (0 to 3 by default) and that many send times uniformly at random inside the hour, sorted, at least
`cadence.minGapSeconds` (300) apart. The two directions draw independently, so some hours hold no send, some hold up
to three in each direction. The bot logs `traffic_hour_planned` (direction, hour, count, times) at each hour start. The
plan is written to the state file before the first send, so a restart in the middle of an hour resumes the same plan and
never sends a time twice. An hour that passed while the bot was down is not caught up: what it still held is dropped and
logged as `traffic_hour_skipped` (direction, hour, planned, unsent, hoursMissed), and the current hour gets a new draw.
A time that came while the bot was down, inside the same hour, sends late (never closer than the gap to the last send).
The source of randomness is injectable (`TrafficOverrides.random`); the tests seed it.

The old keys `intervalSeconds`, `jitterSeconds` and `directions.*.offsetSeconds` are accepted and ignored, with one
`config_ignored` warning at start, so a configuration from before still starts. A send:

1. Lists what can move from the source chain: the test tokens native there, and the copies there of the destination's
   test tokens. Each draws an amount between `amount.minimum` and `amount.maximum` (in hundredths of a token; a copy
   never more than its balance).
2. Keeps balances in their band. A native token goes out only while its home balance stays at or above
   `balance.minimum` after the send. A copy goes home first when its native token is below `balance.minimum` at home; a
   native token goes out first when its home balance is above `balance.maximum`. Otherwise the pick is uniform.
3. Approves the mediator once for the largest amount, when the allowance is short (test tokens only).
4. Confirms the deposit gate of the source chain when it enforces and nobody confirmed the epoch of the next block
   (Sepolia): `ensureGateConfirmed` of `@zk-bridge/shared` (from `@zkb/data`) reads the gate, builds the evidence from the
   beacon API of `gateBeaconUrls`, checks it with the contract's rules against the beacon root on chain, and simulates
   `confirm` from the wallet. The bot sends that as its own transaction and logs `gate_confirmed` (direction, chain, gate,
   epoch, `forkVersion`, `transactionHash`, gas, `validUntil`), then relays. In the first slot of an epoch no header of it
   is on chain yet: the bot waits a slot, at most three times. A gate that does not enforce (chain 943, which detects) or
   an epoch that someone confirmed costs only the reads of the gate. The bridge calls the gate on a send only, so the runner's
   deliveries and updates never need a confirmation.
5. Relays with `relayTokensAndCall` to the delivery router of the destination, with the dapp's default tip:
   `defaultTip` of `@zk-bridge/shared` (the share mode, 0.1 percent of the amount, `tipPercent`), the traffic wallet as
   recipient. When the copy does not exist on the destination yet, the delivery deploys it: the send asks for
   `newCopyGasLimit` of the destination chain when one is set. Sepolia needs one: a copy took 6,971,380 gas there in an estimate on 2026-11-01, and the mediator's default is 2,750,000 with the callback. A delivery that runs out of gas is final.
6. Simulates each transaction first and keeps `minimumNativeWei` of the chain: a send whose worst case (gas limit times
   maximum fee) would take the native balance below it does not go.

Every attempt is a log line: `traffic_sent` (direction, symbol, kind, `tokenAddress`, amount, `transactionHash`, `messageId`,
`deployMessage`, `deploysCopy`, `messageGasLimit`, gas), `traffic_approved`, `traffic_skipped` with a reason, or `traffic_failed` (an error, for example
an endpoint that does not answer; the next poll tries again). At start `traffic_tokens` lists each test token with the
address of its copy on the other chain: the runner's `tokenValuationsWei` needs all of them, because the runner prices
a tip only in a token it has a value for.

| Reason | Meaning |
|---|---|
| `no-eligible-token` | No candidate can go; `candidates` says why for each (`home-balance-at-minimum`, `copy-balance-below-amount`, `waiting-for-first-return`). |
| `native-below-reserve` | The worst case of the approval, the confirmation of the gate (`step: "gate-confirm"`) or the relay would take the native coin below `minimumNativeWei`. |
| `gate-evidence-failed` | No confirmation of the gate: `code` names why (`simulation-reverted`, `beacon-request-failed`, `no-proof`, ...; `detail` holds no URL). Nothing was sent. |
| `gate-epoch-has-no-header` | The gate needs a confirmation and no header of the epoch came on chain in three slots. |
| `gate-confirm-reverted` | The confirmation was mined and reverted (another sender confirmed first does not revert: `confirm` then does nothing). |
| `gate-sealed` | The gate of the source chain is sealed for good. |
| `gate-not-confirmed` | The relay still met `ForkNotConfirmed`: the epoch turned between the confirmation and the relay. The next attempt confirms again. |
| `deposits-not-open` | The source bridge is still locked. |
| `no-delivery-router` | The deployment names no delivery router on the destination. |
| `approval-simulation-reverted`, `relay-simulation-reverted` | The node refused the call; `error` names the error when an ABI knows it. |
| `approval-reverted`, `relay-reverted` | The transaction was mined and reverted. |

**The first send of each token is delivered by hand.** Until a copy of a native token came home once, the mediator
sends every relay of it as a deploy message, and the runner skips a deploy message with `no-price-for-fee-token` (the
indexer names no destination token for it). So a native token goes out once, when it was never relayed, and then waits
(`waiting-for-first-return`) until a copy came home; its copies go home first. `traffic_sent` marks the one deploy
message with `deployMessage: true` (and `deploysCopy: true` when the copy has no code yet). Deliver it once by hand
through the delivery router (anyone may). The copies then go home as ordinary releases that the runner prices, and from
then on every send is one. That is one hand delivery for each test token: four on the testnet. The end-to-end stage
`traffic` does exactly that.

An attempt uses up its planned time, sent or skipped. The time is marked in `stateDirectory/traffic-<pair>.json` before the
first transaction leaves, so an attempt whose receipt never arrives is not sent twice. `--once` sends in each enabled
direction at once, whatever the plan, and leaves the plan as it was. A state file from before the hourly plans still
loads; its old fields are dropped.

| Field of `traffic` | Meaning |
|---|---|
| `signer` | As `runner.signer`. On the app server `env:TRAFFIC_PRIVATE_KEY`. |
| `tokensFile` | The test token file. |
| `tokens` | By symbol: `amount` and `balance`, each `{ "minimum", "maximum" }` in whole tokens as text. |
| `cadence` | `{ "minPerHour", "maxPerHour", "minGapSeconds" }`, defaults 0, 3 and 300. Refused: a maximum below the minimum, a negative number, and a maximum that cannot fit in an hour with the gap between its sends (`(maxPerHour - 1) * minGapSeconds` must be under 3600). |
| `pollSeconds` | Seconds between two looks at the clock. Default 60. |
| `directions` | `first-to-second` and `second-to-first`, each `{ "enabled" }`. Default: both on. |
| `intervalSeconds`, `jitterSeconds`, `directions.*.offsetSeconds` | Removed. Accepted, ignored, `config_ignored` warning. |
| `tipPercent` | The tip as a percentage of the amount. Default `0.1`, the dapp's default. |
| `newCopyGasLimit` | By destination chain id: the gas limit of a send that deploys a copy there, at most the bridge's `maxGasPerTx` (10,000,000). Set `"11155111": "9000000"` on the testnet. |
| `gateBeaconUrls` | By chain id: the beacon API whose state proofs confirm the gate. It needs the compact multiproof endpoint of Lodestar; the public `https://lodestar-sepolia.chainsafe.io` serves it. Default: the beacon URL of the pair (`EXPLORER_BEACON_URL_<chain id>`). Set `"11155111"` on the testnet. |
| `minimumNativeWei` | Required, by chain id, for each chain of the pair. |
| `priorityFeeWei`, `minimumPriorityFeeWei`, `receiptTimeoutSeconds` | As in the runner. Chains 943 and 369 never tip below 0.01 gwei. |

## msgboard size limit

The proof message is 823 bytes: version, pair, direction (3), program key (32), start slot and root (40), new slot and
root (40), public values (352) and proof (356). The difficulty grows by 10,000 for each byte, so the message adds about 8.2
million to the base of 2^24.

The limit: 8 KiB (8192 bytes) per message. Sources: the node implementation of the board in `erigon-pulse`
(`msgboard/msgboardcfg/config.go`, `MsgSizeLimit: 8 * 1024`, flag `--msgboard.msgsize.limit`), and the mock node of
`@msgboard/hardhat` (`messageSizeLimit: 8n * 1024n`). The sdk README says only that the board has a size cap. The
reth fork of the valve.city nodes is not on this machine, so the live limit of the valve.city nodes is not verified. The publisher
refuses a payload over `maximumMessageBytes` before it grinds. The board also caps the total size and count of messages,
and drops new messages when a burst fills it.

## Tests

Unit tests (`test/unit`, no network, no chain, no secret): the codec lives in `explorer/shared`; here are the publisher
decisions (nothing to prove, republish timing, stop when covered, restart, failure backoff, key handling) with a fake prover
script and a fake board; the runner decisions (bad proof refused, wrong start head refused, behind then update, fee below
margin skipped, fee above delivered, simulation revert skipped, layout calls first, never send without simulation) with
fakes for chain, indexer and prover; the board client against a fake node and a fake socket node, including a close with
code 4008; the real grind worker; the real `zk-bridge-prover verify` against a real Groth16 proof.

Integration test (`test/integration/stack.test.ts`): a local Anvil chain with the real `BeaconLightClient` and the real
`DeliveryRouter`. See the header of the file for what is real and what is synthetic: the update values and the proof (no beacon
chain exists on the local stack), the prover (a script), the msgboard node (in this process), and the mediator and bridge
(a stub that releases tokens to the real router).

## Limits and open items

- Dependencies: `explorer/terminal` keeps its own lockfile and is not a workspace dependency. The runner imports the
  signers of the terminal by path (`src/signing/open-signer.ts`). Move them to `explorer/shared` when the terminal joins
  the workspace.
- The first fee check assumes the gas limit of the message plus `proofCheckGas`. Calibrate `proofCheckGas` from `gasUsed` in the outcome file.
- A fee paid in the native coin (unwrap) has no receipt log, so `feeReceivedTokens` is null. `feeExpectedWei` still holds the promise of `feeInfo`.
- The runner posts `update` without a fee check. It costs gas and earns nothing by itself.
- A real delivery needs the prover to build evidence against a beacon node and the source chain node, which must serve `eth_getRawTransactionByHash`.
