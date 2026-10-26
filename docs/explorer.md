# Explorer: indexer, terminal dashboard, web interface

User decisions (2026-10-25): the explorer lives in this repository under `explorer/`. It uses TypeScript: Ponder for the indexer and OpenTUI for the terminal dashboard. A web interface comes later and reads the same indexer.

## Packages

| Path | What it is | Runtime |
|---|---|---|
| `explorer/shared` | Contract ABIs (generated from the Foundry build output), the chain pair registry, shared types, number formatting | any |
| `explorer/indexer` | Ponder project that indexes both chains of a pair into a local database and serves it | Node.js |
| `explorer/terminal` | OpenTUI dashboard | Bun |
| `explorer/web` | Later: React web interface on the same indexer API | browser |

"Load the data instantly": the dashboard never scans a chain itself. It reads the indexer's database through the indexer's API, so it opens with history already in place and live updates arrive as the indexer follows new blocks.

## Pairs

A pair is two chains joined one to one: on each chain a light client of the other, a gate, a `MessageBridge`, a `TokenFactory`, a `TokenMediator`, a `WETHOmnibridgeRouter` and optionally a `FeeRouter`. The pair registry in `explorer/shared` lists pairs by name with each side's chain identifier, RPC and beacon endpoints (from configuration, never committed with keys) and contract addresses (from a deployment file). The default pair is Ethereum and PulseChain (`eth-pls`). A second known pair joins Sepolia and PulseChain testnet v4 (`sepolia-pls943`, chains 11155111 and 943).

## What the indexer stores

From both chains of each pair:
- Messages: `UserRequestForAffirmation` (sent), `AffirmationCompleted` (delivered, with status), decoded AMB fields (sender, executor, gas, data), transaction hash, block and timestamp on each side.
- Token transfers: `TokensBridgingInitiated`, `TokensBridged`, `NewTokenRegistered`, fallback and claimable events, `FeeCharged`, fee collections; joined to their message by message identifier.
- Light clients: each head update (slot, header root, execution block, transaction, gas used, poster), committee changes.
- Gate and registry: confirmations, seals, observed versions.
- Escrow and supply: per native token, the mediator balance on its home chain and the bridged token supply on the other chain (from mint and burn events), and accrued and collected fees.
- Status of each transfer or message, derived: sent, waiting for finality, covered by a stored head, delivered, failed call, fallback used, claimable.

The indexer tracks only what lands on chain. It stores no proofs and accepts no off-chain records (user decision, 2026-10-25). Proof-related data comes from chain events: each light client head update with its transaction, gas used and poster.

## Terminal dashboard layout

```
+--------------------------------------------------------------------------------+
| SUMMARY (top): pair, both chains' head lag, transfers in flight, 24 h volume,   |
| fees accrued, last light client update, gate status per chain                   |
+---------------------------------------+----------------------------------------+
| ACTION AREA (left)                    | FILTERS (fixed header of the feed)     |
|  account and signer                   +----------------------------------------+
|  balances on both chains              | FEED (right): transfers and messages,  |
|  bridge tokens (relay, relay and call)|  newest first, with timestamps on both |
|  send a message                       |  sides and status                      |
|  claim claimable balances             |                                        |
|  post an update / execute a message   |                                        |
+---------------------------------------+----------------------------------------+
| LIGHT CLIENT HEADS (footer): per chain stored head slot, finalized slot, lag,   |
| last update time                                                                |
+--------------------------------------------------------------------------------+
```

Views:
- Global view: choose a pair (default `eth-pls`); one line per pair with its health.
- Pair view: the layout above for one pair.
- Audit view: escrow against bridged supply per token, fee balances, any mismatch flagged.
- Prover and costs view: light client updates as recorded on chain (slot, transaction, gas used, poster, time). Off-chain proof timing and RunPod cost are left out for now.

The feed filters: direction, kind (token or message), status, token, address (sender or recipient), time range.

## Signing

The dashboard can act (relay tokens, send messages, claim, post updates, execute messages), so it needs signers:
- A private key, loaded from an environment variable, a file, or an encrypted keystore (Foundry or Ethereum keystore format). Never written to disk in clear.
- A mnemonic, with key derivation: the standard path `m/44'/60'/0'/0/i` by default, a custom path, and a list of derived addresses to pick from.
- Hardware wallets: Ledger (USB, through the Ethereum application) and Trezor. Derivation paths as above.

The signer never leaves the dashboard process. Every transaction is shown in full (chain, contract, function, arguments, value, gas) and needs explicit confirmation.

## Numbers

Amounts are integers in each token's base units; rates are 18-decimal (1e18 = 100%). The fee follows a fixed declining schedule with no admin (see the fee schedule in `docs/hardened-build-contract.md`): a fee event is `charged_outgoing`, `charged_incoming` or `collected`, and the fee panel shows the current rate that the mediator reports. `explorer/shared` has `feeRateAt`, a copy of the contract math that is tested against vectors from the contract. The display formats them with the token's decimals; the stored values are never rounded.

## Dependencies

Every package version is pinned exactly and must be at least 28 days old, as for the rest of this repository.

## Prover setup view (user decision, 2026-10-25)

Whoever runs the proof side on their own remote GPU configures it in the dashboard. The view is deliberately tucked away: it is always the last option in every list or menu it appears in, never a default and never on the main path.

It holds: the remote GPU endpoint URL (for example a RunPod load balancing endpoint) and its API key; the RPC and beacon URLs per chain; the msgboard RPC and WebSocket URL; the pair and directions to prove; the proving policy. Each value has a test action (endpoint `/ping`, RPC chain identifier, msgboard `status()`).

Secrets are entered masked and never shown again (only the last four characters). They are stored in the operating system secret store where available (macOS Keychain, Linux Secret Service), otherwise in a file encrypted with a password (scrypt and AES-GCM); or the operator points at an environment variable or a 1Password reference instead of storing anything. Every log and error redacts them. The proof publisher bot reads the same configuration.

## Voluntary delivery fees

A sender can tip a runner to deliver a transfer. The sender fixes the tip when the transfer leaves. Nothing at delivery sets or changes the rate, and the runner supplies no rate.

The user interfaces turn the tip on by default at 0.1 percent of the transfer (the percentage mode, multiplier 1e15). The sender can edit the tip or remove it. With the tip removed, the interface sends a plain `relayTokens`.

**The router is chosen in the extra data.** The sender relays the tokens with `relayTokensAndCall`. The receiver of that call is the router, and the call data is a `FeeDirector`: the recipient, the settings flags, a limit and a multiplier. The default router is the `FeeRouter` of the destination chain from the deployment file. An advanced field lets the sender name another router. The review screen marks a router that is not the one of the deployment.

**One runner delivers, and the tip goes to a reward address.** The `FeeRouter` whitelists exactly one externally owned account, the immutable `runner` of its constructor, and exactly one reward address, the immutable `rewardAddress`. It has no owner and no setter. Only a transaction that the runner signs may call `FeeRouter.executeMessageWithRunner(proof, reward)`. The router checks `tx.origin`, so the runner can reach it through Multicall3. Any other origin reverts with `NotRunner`. This stops front-running by block builders and searchers: without it, any account could copy the pending call of the runner and take the tip. The runner names the reward address with each call, and the call reverts with `WrongRewardAddress` unless it equals the whitelisted one. The runner is the hot key that signs and pays the gas. The reward address is the account that receives the tips, and it can be a cold account. A stolen runner key cannot redirect a tip. The router stores the reward address, takes the tip when the mediator releases the tokens to it, pays the tip to the reward address, and pays the recipient the rest. The review screen of the terminal shows the reward address of the router that a transfer names.

**Many deliveries go through Multicall3.** The router has no batch entry. The bots runner sends one transaction to Multicall3 (`aggregate3`, with `allowFailure` set on each call). The first call is `update(proof, publicValues)` at the light client, when the head is behind. Each other call is `executeMessageWithRunner(proof, reward)` at the router. One failed call never reverts the others, so the calls work independently of one another. A message that is already delivered fails alone with `AlreadyDelivered`. A message whose anchor is not stored fails alone with `AnchorNotStored`. The router checks `tx.origin`, because inside Multicall3 the caller of the router is the Multicall3 contract. The runner signs the transaction, so a copier cannot pass the check. The source of Multicall3 is in `src/hardened/vendor/multicall3`. The canonical address is `0xcA11bde05977b3631167028862bE2a173976CA11`. The bots runner reads the results from a simulation and the bridge events from the receipt. See `docs/bots.md` for the reasons and the gas figures.

**A direct delivery pays no tip.** The bridge stays permissionless. Anyone may call `MessageBridge.executeMessage` directly. The mediator still releases the tokens to the router, but no reward address is stored, so the router takes no tip and pays the recipient everything. A direct delivery costs the sender nothing. It only means that no tip is paid.

Code: `explorer/shared/src/delivery-fee.ts` (pure bigint), `delivery-suggestion.ts` (the labels and the three suggestions) and `delivery-cost-report.ts` (the shape of the indexer answer). The terminal form "Tip for delivery" is on by default. The web interface shows the same fields.

The three modes:

| Mode | Settings | The tip | Label |
|---|---|---|---|
| Percentage | share of value (8) | `value * multiplier / 1e18`. The default is multiplier 1e15 (0.1 percent) | exact |
| Fixed | fixed fee (1) | `limit` | exact |
| Gas multiplier | none | `(gas used + overhead) * multiplier * gas price / 1e18`, never above `limit` | estimate, at most the limit |

**The gas multiplier works for any token.** The router computes the gas based tip and the limit in base units of the token. The sender folds a price into the multiplier when the transfer leaves: `multiplier = (token units per wei of the destination native coin) * margin * 1e18`. The price is the sender's own. The interface labels the field as theirs and fills it from the token valuation as a starting point. The shared function `suggestGasMultiplier` takes the price as an exact ratio of two integers (`SenderPrice`), rounds the multiplier up, and refuses a multiplier that does not fit in 96 bits. `senderPriceOfToken` turns a token valuation into that ratio.

The limit of a gas multiplier suggestion is the tip at a ceiling base fee, in base units of the transferred token. A spike in the base fee cannot take more. `expectedFee` mirrors `FeeRouter.feeInfo`. The test `explorer/shared/test/delivery-fee.test.ts` checks it, and the encoding of the director, against vectors that the compiled router printed (`explorer/shared/vectors/GenerateDeliveryFeeVectors.s.sol`).

The cost of a delivery has three lines: the gas cost (delivery gas times base fee plus priority fee), the proof cost, and the margin. The proof cost is a share of one proof, set in US dollars (`EXPLORER_PROOF_COST_USD`, default 0.02, the measured cost of one warm proof) and converted with the price of the native coin of the destination chain (`EXPLORER_NATIVE_COIN_PRICE_USD_<chainId>`; no price feed, so with no price the proof cost is left out and the form says so). `EXPLORER_DELIVERIES_PER_PROOF` (default 1) divides it. The conversion uses scaled bigint math, rounded up. Every cost line is an estimate.

Every suggestion shows its data: where the delivery gas comes from ("measured from N recent deliveries, p90" or "default, no deliveries measured yet") and the block and time of the base fee. The indexer records the gas of each delivery transaction and serves `GET /api/delivery-cost` (see `explorer/indexer/README.md`). The figures improve as it records more deliveries, with no change in the clients. Without samples the indexer returns `EXPLORER_DEFAULT_DELIVERY_GAS`, default 550000. That figure comes from Foundry: the fee router call with a gas based fee uses about 197807 gas (`test/hardened/mediator/FeeRouterGas.t.sol`), the proof check of the bridge about 290655 gas (`test/hardened/MessageBridgeGas.t.sol`), and a transaction adds 21000 gas. The sum is 509462, rounded up for calldata.
