# rpc.zkb.fi and the wallet modal

Date: 2026-11-14. Status: approved by the owner in conversation, being built.

Owner, 2026-11-14, verbatim:

> still seeing lots of 429s and when no wallet exists, we should show a menu with a series of links to install wallets or
> some other mechanism. maybe reown has something we can use. right now we just get errors

> it's the vk demo key of valve city. perhaps we run a thin erpc on the backend? at rpc.zkb.fi? then we can constrain it
> to only serve requests around proofs and zkb?

Choices the owner made from the options offered the same day:

- Parameter checks: **our filter in front of eRPC** (not eRPC alone, not our proxy alone).
- Chains: **all four now**: Ethereum (1), PulseChain (369), Sepolia (11155111), PulseChain testnet v4 (943).
- Wallets: **Reown AppKit**.

## Why

The dapp's default RPC for every chain is valve.city with its public demo key (`vk_…`). Every visitor shares that key's
limit, so browsers get HTTP 429. The server already holds an unlimited valve.city key, which must stay on the server.

When no wallet is installed, wagmi's generic injected connector is still registered, so Connect throws
`ProviderNotFoundError` instead of helping the visitor.

## Part 1: rpc.zkb.fi

`https://rpc.zkb.fi/<chainId>` takes JSON-RPC from the dapp (single requests and batches) and answers only what zkb.fi
needs.

Layers, outside in:

1. **Caddy** terminates TLS for `rpc.zkb.fi` and forwards to the filter.
2. **The filter** (in the backend, Node): reads the body, checks every request of a batch, and refuses the whole batch
   when one request is refused (JSON-RPC error, HTTP 200, a readable message; never the upstream URL). Rules:
   - Methods: an allowlist (the reads the dapp makes: chain id, block number, blocks, receipts, transactions by hash,
     fee reads, `eth_call`, `eth_estimateGas`, `eth_getLogs`, `eth_getProof`, `eth_getBalance`, `eth_getCode`,
     `eth_getStorageAt` where the dapp needs it). No `eth_sendRawTransaction`: wallets send through their own RPC. The
     builder lists every method the dapp calls today and justifies each.
   - `eth_getLogs`: the filter must name addresses, all of them zkb.fi contracts of that chain.
   - `eth_getProof`, `eth_getStorageAt`: zkb.fi contracts only.
   - `eth_call` and `eth_estimateGas`: to a zkb.fi contract, any function; to Multicall3, every inner call checked by
     the same rule; to any other address, token reads only (`name`, `symbol`, `decimals`, `balanceOf`, `allowance`,
     `totalSupply`), so a custom token still loads. `eth_estimateGas` for a send to a zkb.fi contract (and token
     `approve` toward one) is allowed.
   - The zkb.fi contracts of a chain come from the deployment files the backend already loads (bridge, router,
     mediator, token factory, gate, light clients, fork registry, msgboard), plus the bridged tokens the indexer
     knows.
   - Body size and batch length capped.
3. **eRPC from valve's fork `valve-tech/erpc`** (owner, 2026-11-14: "you can use the erpc instance at valve-tech"; release `0.3.0.15-valve`, `erpc-linux-arm64`, checked against its `SHA256SUMS`), listening on localhost only: method allowlist again
   (`ignoreMethods: ["*"]` plus `allowMethods`), per-IP rate limits, finality-aware in-memory cache with a memory cap,
   `eth_getLogs` range cap, upstreams per chain (valve.city with the server key from an environment file; public RPCs as
   fallbacks). eRPC sees the visitor's IP from the filter's forwarded header.

Every limit (methods, rates, cache size, batch length, body size, range) lives in configuration, not code.

The dapp's default RPC for each of the four chains becomes `https://rpc.zkb.fi/<chainId>`. The demo key leaves the
bundle. A visitor can still set their own RPC in Settings.

## Part 2: wallets through Reown AppKit

The Connect buttons open Reown AppKit's modal (wagmi adapter), which lists installed wallets, offers install links and a
QR code for phone wallets. The four chains are AppKit's networks. AppKit needs a Reown project id
(`VITE_WALLETCONNECT_PROJECT_ID`, made by the owner under the zkb.fi account). Without one, the dapp keeps working with
installed wallets only, and Connect with no wallet installed opens our own short list of install links instead of
throwing.

Planner's calls (owner may change):
- AppKit analytics off (`features.analytics: false`), email and social login off, swaps and on-ramp off.
- The modal's theme follows the dapp's (accent colour, square corners where AppKit allows).
- Versions pinned exactly, at least two weeks old.

## Non-goals

- rpc.zkb.fi is not a public RPC. It serves the dapp.
- No new contracts.
