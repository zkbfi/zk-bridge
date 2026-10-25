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

A pair is two chains joined one to one: on each chain a light client of the other, a gate, a `MessageBridge`, a `TokenFactory`, a `TokenMediator`, a `WETHOmnibridgeRouter` and optionally a `FeeRouter`. The pair registry in `explorer/shared` lists pairs by name with each side's chain identifier, RPC and beacon endpoints (from configuration, never committed with keys) and contract addresses (from a deployment file). The default pair is Ethereum and PulseChain (`eth-pls`).

## What the indexer stores

From both chains of each pair:
- Messages: `UserRequestForAffirmation` (sent), `AffirmationCompleted` (delivered, with status), decoded AMB fields (sender, executor, gas, data), transaction hash, block and timestamp on each side.
- Token transfers: `TokensBridgingInitiated`, `TokensBridged`, `NewTokenRegistered`, fallback and claimable events, `FeeCharged`, fee collections; joined to their message by message identifier.
- Light clients: each head update (slot, header root, execution block, transaction, gas used, poster), committee changes.
- Gate and registry: confirmations, seals, observed versions.
- Escrow and supply: per native token, the mediator balance on its home chain and the bridged token supply on the other chain (from mint and burn events), and accrued and collected fees.
- Status of each transfer or message, derived: sent, waiting for finality, covered by a stored head, delivered, failed call, fallback used, claimable.

Proving costs are not on chain. The indexer accepts proof records from the proof producer's webhook (`zk-bridge-prover prove --to webhook`) into the same database: route, slots, backend, duration and, when known, the RunPod job time and cost.

## Terminal dashboard layout

```
+--------------------------------------------------------------------------------+
| SUMMARY (top): pair, both chains' head lag, transfers in flight, 24 h volume,   |
| fees accrued, last proof time and cost, gate status per chain                   |
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
- Prover and costs view: proof jobs, durations, RunPod time and cost, gas spent on light client updates.

The feed filters: direction, kind (token or message), status, token, address (sender or recipient), time range.

## Signing

The dashboard can act (relay tokens, send messages, claim, post updates, execute messages), so it needs signers:
- A private key, loaded from an environment variable, a file, or an encrypted keystore (Foundry or Ethereum keystore format). Never written to disk in clear.
- A mnemonic, with key derivation: the standard path `m/44'/60'/0'/0/i` by default, a custom path, and a list of derived addresses to pick from.
- Hardware wallets: Ledger (USB, through the Ethereum application) and Trezor. Derivation paths as above.

The signer never leaves the dashboard process. Every transaction is shown in full (chain, contract, function, arguments, value, gas) and needs explicit confirmation.

## Numbers

Amounts are integers in each token's base units; rates are 18-decimal (1e18 = 100%). The display formats them with the token's decimals; the stored values are never rounded.

## Dependencies

Every package version is pinned exactly and must be at least 28 days old, as for the rest of this repository.
