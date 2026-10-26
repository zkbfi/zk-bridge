# Bots: proof publisher and delivery runner

User decision (2026-10-25): two bots, in TypeScript under `explorer/bots/`, sharing `explorer/shared` (ABIs, pair registry, decoding) with the indexer and the terminal dashboard.

## 1. Proof publisher

Makes light-client update proofs on the RunPod endpoint and publishes them on msgboard.

1. Watch both chains of a pair (from the indexer, or directly from the beacon APIs): the destination light client's stored head, and the source chain's latest finalized header.
2. When a new finalized header exists past the stored head (and, by policy, a transfer or message waits, or the interval has passed), build the guest input exactly as `zk-bridge-prover prove` does. Two options, choose and document: run `zk-bridge-prover prove --to stdout` with the remote backend (the Rust producer already folds updates, calls RunPod, and checks the proof against lc-core), or reimplement the request in TypeScript. Prefer the Rust producer: it owns the checks.
3. Call the RunPod endpoint. Today it is a load balancing endpoint: `POST /prove` answers when the proof is ready (about 30 to 75 seconds), within RunPod's 5.5-minute request limit. Polling or a webhook is only needed if the endpoint moves to queue mode; design the client so either works.
4. Publish the result on msgboard (`@msgboard/sdk`, `msgboard_` JSON-RPC module, served by valve.city RPC endpoints on chains 1, 369 and 943; docs in the sdk README, rendered at msgboard.xyz/#/docs):
   - Category: one per pair and direction, for example `categoryHash("zk-bridge/eth-pls/ethereum-to-pulsechain/light-client-update/v1")`.
   - Payload: a compact binary encoding (difficulty grows by 10,000 per byte): version byte, route, program key, start slot and root, new slot and root, the 352 bytes of public values, the 356 bytes of proof. Define it in `explorer/shared` with an encoder, a decoder and tests.
   - Proof of work: `board.grind(category, payload)`, then `board.addMessage`. Grinding is a busy loop; run it off the main event loop.
   - Messages are ephemeral (about 120 blocks) and the board has a size cap. The publisher republishes the latest proof on a timer while it is still useful (until the destination light client stores a head at or past it).

The publisher holds no wallet: it only proves and publishes. Its secrets are the RunPod key and the valve.city RPC key, both from environment variables or `op read`, never in files or logs.

## 2. Delivery runner

Delivers transfers and messages on the destination chain, for the fee that each transfer's payload offers.

1. Subscribe to the msgboard category of each direction (`MsgBoardWsClient.subscribeMessages` with the category filter; reconnect on close, route notifications by subscription identifier). Decode and verify each proof message: the payload decodes, the program key equals the destination light client's `programVKey()`, the start slot and root equal the stored head, and the proof verifies locally (call the Rust producer or `sp1-verifier` through a small command; the chain is still the final check). Ignore anything else.
2. If the destination light client's head is behind the proof, post `update(proof, publicValues)` (simulate with `eth_call` first; skip if it would revert because someone else posted).
3. From the indexer, list transfers and messages sent on the source chain that are now covered (their source block is at or before the stored head's execution block) and not yet delivered.
4. For each, read the fee offer: the `FeeDirector` in the `relayTokensAndCall` data aimed at the `FeeRouter` (gibsfinance format: recipient, settings flags, limit, multiplier). Compute the fee the runner would earn with the router's own `feeInfo` view, compare it with the gas cost at the current base fee, and deliver only when the fee covers the cost plus a configured margin. Transfers with no fee offer are skipped unless configured otherwise.
5. Build the evidence with `zk-bridge-prover evidence --tx <hash> --log-index <n>` (it returns `executeMessage` calldata and any layout prerequisites). Send the prerequisites first. Then deliver all the covered, profitable items of the sweep in one transaction through Multicall3 (`aggregate3`, with failure allowed on each call). The first call is the block proof, `update(proof, publicValues)` at the light client, when the head is behind. Each other call is `FeeRouter.executeMessageWithRunner(proof, rewardAddress)`, so the tips go to the reward address. Simulate the batch first. Drop each item whose call fails in the simulation, and each item that no longer pays. Send only a batch in which every call succeeds and every item pays.
6. Record the outcome of each item (delivered, skipped and why, gas, fee earned) for the dashboard. The outcomes come from the simulation and from the `AffirmationCompleted` events of the bridge in the receipt.

**The call path.** The runner relies on this exact path. The end-to-end test `test_feeRouterPaysARunnerThroughTheRealBridge` in `test/hardened/BridgeWorld.t.sol` and the batch tests in `test/hardened/mediator/FeeRouterBatching.t.sol` check it with exact balances:

1. On the source chain, the sender relays through the mediator with `relayTokensAndCall`, aimed at the router. The mediator sends a message through the message bridge.
2. On the destination chain, the whitelisted runner signs one transaction to Multicall3. It holds one `executeMessageWithRunner(proof, rewardAddress)` call for each message, and the block proof call first when the head is behind. The runner can also call `executeMessageWithRunner` directly for one message.
3. The router checks that the origin of the transaction is the runner and that the reward address is the whitelisted one. It stores the reward address and calls `MessageBridge.executeMessage(proof)`.
4. The bridge calls the mediator. The mediator delivers the tokens to the router and calls `onTokenBridged`.
5. The router sees the stored reward address, takes the tip, pays the tip to the reward address, and pays the recipient the rest.

If anyone calls `MessageBridge.executeMessage` directly, the mediator still delivers the tokens to the router. No reward address is stored, so the router takes no tip and pays the recipient everything.

**The runner account and the reward address are two accounts.** The runner account is the hot key that signs the transactions and pays the gas. The reward address is the account that receives the tips. It can be a cold account or a safe. The router has two immutables, `runner` and `rewardAddress`, and no setter for either. Each execute call must name the reward address, and the router reverts with `WrongRewardAddress` unless it equals the immutable one. So a stolen runner key can run deliveries, but it cannot redirect one tip. It also pays the gas of every delivery it runs.

**Start-up checks.** At start, the runner reads `FeeRouter.runner()` and `FeeRouter.rewardAddress()` from the configured router (`runner.feeRouter`, or `fee_router` of the deployment file). It refuses to run when `runner()` is not the address of its signer. It refuses to run when `rewardAddress()` is not the configured `runner.rewardAddress`. It also refuses to run when the configured reward address is the address of the signer, because the two must be separate accounts. The checks are in `explorer/bots/src/runner/whitelist.ts`. A wrong pair would otherwise pay for a failed simulation of every delivery, or send every tip to an address that the operator does not watch.

**Why Multicall3.** A batch saves the 21,000 gas base cost of a transaction for each item after the first, and it saves the cost of the calldata headers. It also lets the runner clear a backlog in few transactions. One transaction holds many items, so one bad item must not revert the others. Multicall3 is the generic contract of `mds1/multicall`. Its `aggregate3` runs each call with `allowFailure` set. A failed call returns `success = false` and its revert data, and the next call still runs. The router knows nothing about batching. The source of Multicall3 is in `src/hardened/vendor/multicall3`. Most chains have it at `0xcA11bde05977b3631167028862bE2a173976CA11`. The setting `runner.multicall3` holds that address by default, and the runner refuses to start when the address holds no code.

**Why the router reads `tx.origin`.** Inside Multicall3, `msg.sender` of the router is the Multicall3 contract, not the runner. So the router checks `tx.origin` against the immutable `runner`. The runner signs the transaction, so a copier of the call cannot pass the check. The reward address is immutable. A contract that tricks the runner into a call still cannot redirect a tip. A caller that is not the runner gets `NotRunner(tx.origin)` in the result of its call, and the other calls run on.

**The update comes first.** The first call goes straight to the light client: `update(proof, publicValues)`. The light client checks the proof itself, so no router function is needed. A message whose anchor the update did not store fails with `AnchorNotStored`, and it stays open. When the head is at or past the new head, the light client reverts with `HeadNotAdvancing`: another account posted the update first. The runner then leaves the update out. One transaction saves the 21,000 gas base cost of a separate update. The runner counts the gas of the update (about 337,000 with the real verifier) as a cost against the tips of the batch. It sends only when the tips cover the update, the deliveries and the margin.

**How a failed call is read.** The runner decodes the revert data of each failed call. `AlreadyDelivered` is a final skip: a runner on another route or a person delivered the message first. `AnchorNotStored` is a skip that the runner tries again in the next sweep. `InsufficientGas` means the gas left does not cover the gas limit of the message under the 63/64 rule, plus the overhead of the bridge. Any other revert is a skip with the name of the error and `keccak256` of the revert data. A message whose target reverts is not a revert of the bridge: the bridge marks it delivered and failed, as always, and the call succeeds. The state of a reverted call is gone, so the next call starts clean.

**What the receipt shows.** Multicall3 writes no event. The receipt keeps no revert data. So the runner reads the events of the bridge and the light client. An item is executed when the bridge wrote `AffirmationCompleted` for its message identifier. The update is applied when the light client wrote `HeadUpdated` for the new head. An item without that event failed in the mined block, and the runner marks it `batch-result-missing`.

**Gas per item.** One message through `executeMessageWithRunner` costs about 417,000 gas. One `aggregate3` with one update and two messages costs about 949,000 gas with the test verifier (`test_gas_aggregate3WithOneUpdateAndTwoMessages`). Multicall3 adds about 17,000 gas to each call (the call, the copy of the proof and the result). The runner assumes 20,000. A transaction adds 21,000 gas once.


**Limits and spend.** The runner sends a batch of at most `runner.maximumBatchSize` items (default 5) and at most `runner.maximumBatchGas` assumed gas (default 6,000,000). Before it sends a batch, the runner reserves the worst case of the whole transaction (gas limit times maximum fee per gas) in the `deliverySpend` list of its state file. At the receipt it replaces the reservation with the actual cost. The share of the cost that belongs to items that did not execute is an unrecovered loss. A send that throws never settles, so its reservation stays charged. The delivery spend does not count against the daily budget of layout calls: that budget bounds gifts to other senders, and a fee repays the delivery.

The runner holds a wallet on the destination chain (the same signer options as the dashboard: keystore, key, mnemonic, hardware). It never sends without a successful simulation.

## Shared rules

- Every RPC and beacon endpoint and key comes from configuration or the environment; nothing secret is committed or logged (redact `vk_` keys in all output).
- Idempotent and restart-safe: both bots can stop and start without double work beyond a reverted simulation.
- Metrics and logs in a form the dashboard can read.
- Dependencies pinned exactly and at least 28 days old.

## Implementation (2026-10-25)

Code: `explorer/bots`. Commands, configuration and tests: `explorer/bots/README.md`.

Decisions:
- **Proving.** The publisher runs `zk-bridge-prover prove --route <route> --to stdout` with the remote backend. The Rust producer keeps all the checks. The bot writes a short-lived prover configuration file (mode 0600, deleted after the run) from the setup file, and passes the RunPod key only in the environment variable that the file names.
- **Remote jobs.** The publisher depends on the interface `ProofSource`. A queue endpoint becomes a second implementation. Nothing else changes.
- **Proof message.** 823 bytes: `explorer/shared/src/proof-message.ts`. Category: `zk-bridge/<pair>/<source>-to-<destination>/light-client-update/v1`.
- **Size limit.** 8 KiB per message in the board node implementation that is on this machine (`erigon-pulse`) and in the sdk mock. The `valve-tech/reth` fork is not available locally, so the live limit is not verified.
- **Local verification.** The prover has a new command, `zk-bridge-prover verify --program-vkey --public-values --proof`. It reads no configuration file. It checks the Groth16 proof with `sp1-verifier`.
- **Reward address and batches (2026-10-26).** The tip goes to an immutable reward address of the router, not to the runner account. The runner delivers in batches. See "Delivery runner" above.
- **Fee check.** The runner compares the fee of `FeeRouter.feeInfo` in wei with the gas cost at the current base fee plus the priority fee, plus a margin. Tokens other than the wrapped native token need a configured value in wei.
- **Shared code.** The setup schema, the secret store, the setup file and the redactor moved from `explorer/terminal/src/config` to `explorer/shared/src/config`. The terminal imports them as `@zk-bridge/shared/config`.

## Voluntary delivery fees

The runner reads the `FeeDirector` that a sender wrote for the fee router. The sender fixed the rate ahead of time: the runner supplies no rate and nothing at delivery changes it. The default tip of the user interfaces is 0.1 percent of the transfer. The runner takes tips only from messages aimed at its own configured router. The type, the decoder and the encoder are the shared ones in `explorer/shared/src/delivery-fee.ts`, tested against vectors from the compiled router. The runner still asks the router for the fee (`feeInfo`, one call), because the chain is the authority. The shared `expectedFee` computes the same number offline, so the dashboard shows the fee that the runner would take.

The terminal and the web interface suggest fees that cover the gas cost, a share of the proof cost and a margin. The runner applies its own rule: it delivers when the fee covers its gas cost at the current prices plus its configured margin. A suggestion with a margin of zero covers the cost and nothing more, so a runner with a margin above zero skips it. See "Voluntary delivery fees" in `docs/explorer.md` for the modes and the cost model.
