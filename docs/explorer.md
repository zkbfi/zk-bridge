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
