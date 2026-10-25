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
5. Build the evidence with `zk-bridge-prover evidence --tx <hash> --log-index <n>` (it returns `executeMessage` calldata and any layout prerequisites), send the prerequisites first, then `FeeRouter.executeMessageWithRunner(runner, proof)` so the fee is paid to the runner. Simulate every transaction first; skip on a revert (already delivered, or another runner won).
6. Record outcomes (delivered, skipped and why, gas, fee earned) for the dashboard.

The runner holds a wallet on the destination chain (the same signer options as the dashboard: keystore, key, mnemonic, hardware). It never sends without a successful simulation.

## Shared rules

- Every RPC and beacon endpoint and key comes from configuration or the environment; nothing secret is committed or logged (redact `vk_` keys in all output).
- Idempotent and restart-safe: both bots can stop and start without double work beyond a reverted simulation.
- Metrics and logs in a form the dashboard can read.
- Dependencies pinned exactly and at least 28 days old.
