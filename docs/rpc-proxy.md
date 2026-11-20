# rpc.zkb.fi

`https://rpc.zkb.fi/<chainId>` is the dapp's default RPC for Ethereum (1), PulseChain (369), Sepolia (11155111) and
PulseChain testnet v4 (943). It answers the JSON-RPC reads the zkb.fi dapp makes, single requests and batches, and
refuses everything else. It is not a public RPC. The design is in
[superpowers/specs/2026-11-14-rpc-proxy-and-wallets-design.md](superpowers/specs/2026-11-14-rpc-proxy-and-wallets-design.md).

The dapp lists rpc.zkb.fi first and the public RPCs of each chain after it
(`explorer/terminal/src/config/default-rpc.ts`). While rpc.zkb.fi answers, every read goes to it. When it answers 429,
a server error, or nothing, the dapp leaves it out for 30 seconds and reads from the public RPCs in turn. When it refuses
a request (see below), the dapp sends that request to the next RPC of the list at once, without leaving rpc.zkb.fi out.
A visitor who sets their own RPC in Settings uses only that one.

## Layers

```
browser ──TLS──> Caddy (rpc.zkb.fi) ──> backend, rpc-proxy module (127.0.0.1:8787, POST /rpc/<chainId>)
                                         │  checks methods and parameters, caps body and batch
                                         └──> eRPC (127.0.0.1:8792, /zkb/evm/<chainId>)
                                               │  method allowlist again, per-visitor rate limits, cache, eth_getLogs range cap
                                               └──> valve.city with the server's key; the public RPCs as fallbacks
```

1. **Caddy** (`deploy/app-server/Caddyfile`, the `{$ZKB_RPC_HOST:rpc.zkb.fi}` site) terminates TLS, refuses a body
   over 1 MB, and rewrites `/<chainId>` to the backend's `/rpc/<chainId>`. Every other path answers 404.
2. **The filter**, the backend's `rpc-proxy` module (`explorer/backend/src/rpc-proxy/`), checks every request of the
   body. One refused request refuses the whole batch. Accepted requests go to eRPC with the visitor's address in
   `X-Forwarded-For`.
3. **eRPC**, valve's fork, release `0.3.0.15-valve` (the download is pinned in `deploy/ansible/erpc.yml`; the config is
   `deploy/app-server/config/erpc/erpc.yaml.example`), holds the valve.city key and does the rate limits, the cache
   and the failover between upstreams.

The fork offers method allowlists (`ignoreMethods: ["*"]` with `allowMethods`), per-IP rate limits, CORS, a
finality-aware cache and an `eth_getLogs` range cap. It does not check request parameters: nothing in its configuration
or code restricts the addresses of `eth_getLogs` or the target of `eth_call` (checked in the fork's `docs/`, `valve/` and
`common/config.go` at the release tag). So the address rules live in the backend's filter.

## What the filter allows

### Methods

The dapp's chain reads, found by listing every viem action that explorer/web calls, including the code it bundles from
explorer/terminal, data, core, shared and react. eRPC's `allowMethods` holds the same list; `deploy/app-server/test.sh`
fails when the two differ.

| Method | Who sends it |
|---|---|
| `eth_chainId` | `getChainId` (data/rpc/chain-reader, at-block); the Settings check of an RPC (data/connection-test) |
| `eth_blockNumber` | `getBlockNumber` (core/token-pricing, data/prover/light-client); the polling of `waitForTransactionReceipt` |
| `eth_getBlockByNumber` | `getBlock` by tag or number (data/rpc, gate-evidence, Explore's block page); `estimateFeesPerGas` (base fee); the replacement check of `waitForTransactionReceipt` |
| `eth_getTransactionByHash` | Explore's transaction page (web/explore/chain-reader); `waitForTransactionReceipt` |
| `eth_getTransactionReceipt` | `getTransactionReceipt` (data/rpc, Explore); `waitForTransactionReceipt` after each send |
| `eth_call` | `readContract` and its Multicall3 batches (every contract read); `call` to the beacon roots contract (data/gate-evidence) |
| `eth_estimateGas` | `prepareTransaction` (terminal/tx/prepare) before each send; the seal and observe offers (data/gate-evidence, fork-observation, fork-cutover-check) |
| `eth_getLogs` | the dapp's own scan when the indexer is down (data/rpc/chain-scan, history-scan) |
| `eth_getBalance` | the account panel (terminal/chain/live-reads); Explore's address page |
| `eth_getCode` | Explore's address page |
| `eth_getTransactionCount` | the pending nonce in `prepareTransaction`; Explore's address page |
| `eth_maxPriorityFeePerGas` | `estimateFeesPerGas` (the fee lines of the transaction dialog) |
| `eth_gasPrice` | `estimateFeesPerGas` when a node has no `eth_maxPriorityFeePerGas` |

Not served: `eth_sendRawTransaction` (a wallet sends through its own RPC; the dapp gives wallets the public RPCs, never
rpc.zkb.fi), `eth_getProof` and `eth_getStorageAt` (the dapp does not ask for them; the backend and the prover read
proofs through their own RPC), filters, subscriptions, `debug_*` and `trace_*`. The filter has address rules for
`eth_getProof` and `eth_getStorageAt` ready, so adding them to `rpcProxy.methods` (and eRPC's `allowMethods`) serves them
for zkb.fi contracts only.

### Parameters

"zkb.fi contract" means a contract of that chain in this set:

- every address in the chain's entry of the deployment files (bridge, delivery routers, mediator, token factory,
  wrapped native token, gate, light client, fork registry, msgboard, and whatever a later deployment adds);
- what the chain itself names: each gate's `forkRegistry()` and `beaconRoots()`, and each fork registry's
  `lightClient()` (the registry's own light client, which the dapp reads and updates), read through eRPC;
- the extra contracts of the configuration: by default the EIP-4788 beacon roots contract on every chain, and on
  PulseChain the two PulseX factories and the Omnibridge, which the dapp reads to price tokens.

Kept apart from that set: every token the indexer knows (`GET /api/tokens`). A token is not trusted as a contract; it
only widens `eth_getLogs` (below). Its reads pass anyway, as token reads on any address.

The chain and the indexer are read again every `refreshSeconds` (300); after a failure, 30 seconds later. A source that
fails keeps what it gave last time.

The rules:

- `eth_getLogs`: the filter names its addresses (one or a list), and every one is a zkb.fi contract or a token the
  indexer knows. When a token is named, `topics[0]` must name only `Transfer` or `Approval`.
- `eth_call` and `eth_estimateGas`:
  - to a zkb.fi contract: any function, and a plain send of the native coin;
  - to Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`): `aggregate3`, `aggregate3Value`, `aggregate` or
    `tryAggregate`, with each inner call checked by these same rules (no Multicall3 inside Multicall3);
  - to any other address: the token reads `name()`, `symbol()`, `decimals()`, `balanceOf(address)`,
    `allowance(address,address)`, `totalSupply()`, the pool reads `getReserves()` and `token0()` (the PulseX pairs of
    the prices), and `approve(spender, amount)` when the spender is a zkb.fi contract, each with calldata of exactly its
    ABI length (4 bytes, 36 for `balanceOf`, 68 for `allowance` and `approve`);
  - `gas`, when named, at most `rpcProxy.maxCallGas` (30,000,000); a call that names none is forwarded with `gas` set to
    `maxCallGas`, so the upstream node's own default never applies;
  - no key twice in different cases (`to` and `To`), no `data` and `input` that differ, and no third parameter (a state
    or block override could run any code at a zkb.fi address).
- `eth_getProof`, `eth_getStorageAt` (when served): a zkb.fi contract, and exactly `[address, storage keys, block]` or
  `[address, slot, block]`: each key a 32-byte hex word, the slot a hex quantity, the block a tag (`latest`, `earliest`,
  `pending`, `safe`, `finalized`) or a hex quantity. A trailing or missing parameter refuses the request.
- The other methods of the default list pass only with their own parameters, each field checked: none for `eth_chainId`,
  `eth_blockNumber`, `eth_gasPrice` and `eth_maxPriorityFeePerGas`; `[address, block]` for `eth_getBalance`,
  `eth_getCode` and `eth_getTransactionCount`; one 32-byte hash for `eth_getTransactionByHash` and
  `eth_getTransactionReceipt`; `[block, boolean]` for `eth_getBlockByNumber`. A method added to `rpcProxy.methods` that
  is not in these lists is refused with "has no parameter rule": it needs a rule in `rules.ts` before it is served.

What goes to eRPC is rebuilt from what was checked, never the visitor's bytes: a fresh `{jsonrpc, id, method, params}` whose parameters are the checked fields;
a call object keeps only `from`, `to`, `gas`, `gasPrice`, `maxFeePerGas`, `maxPriorityFeePerGas`, `value`, `nonce`,
`accessList` and the checked calldata as `data`; a log filter keeps only `address`, `topics`, `fromBlock`, `toBlock` and
`blockHash`. A duplicate JSON key therefore reaches eRPC only as the value the filter checked.

### Refusals and errors

A refused request gets HTTP 200 and a JSON-RPC error with its own id and a sentence that says why:

```json
{"jsonrpc":"2.0","id":7,"error":{"code":-32602,"message":"rpc.zkb.fi refused eth_call: 0x1111…1111 is not a zkb.fi contract of chain 943, and the call is not a token read"}}
```

`-32601` is a method that is not served, `-32602` parameters that leave zkb.fi, `-32600` a body that is not a JSON-RPC
request or a batch over the limit. The other requests of a refused batch get the same code and "refused this batch
because another request in it was refused: …". When eRPC cannot be reached or answers something unreadable, every
request gets `-32603` with HTTP 502. eRPC's own answers pass unchanged except their errors: every URL in a message
becomes `[upstream]`, and error data is kept only when it is revert data (hex). No upstream address or key reaches a
visitor.

### CORS

The backend answers CORS for every route with `Access-Control-Allow-Origin: *` (`explorer/backend/src/app.ts`), and
rpc.zkb.fi is one of its routes. Any origin is accepted: the dapp loads from IPFS subdomains (`<cid>.ipfs.zkb.fi`,
`*.ipfs.inbrowser.link`), `gateway.zkb.fi`, `next.zkb.fi`, `zkb.fi` and localhost, and nothing here reads a login, so
an origin list would protect nothing. eRPC never sees a browser.

## Limits

Each limit is configuration, not code.

| Where | Setting | Default | What it does |
|---|---|---|---|
| backend.json `rpcProxy` | `maxBodyBytes` | 262144 | The largest body, in bytes (413 above it). A batch of 50 reads is about 15 KB. |
| | `maxBatchLength` | 50 | The most requests in one batch (the dapp batches at most 50). |
| | `maxResponseBytes` | 33554432 | The largest answer of eRPC passed on (502 above it). |
| | `timeoutSeconds` | 30 | How long an answer of eRPC may take. |
| | `methods` | the table above | The methods served. Change eRPC's `allowMethods` with it. |
| | `anyAddressFunctions` | the token and pool reads | The functions callable on any address (static argument types only, so each has one exact length). |
| | `maxCallGas` | 30000000 | The most gas an `eth_call` or `eth_estimateGas` may name. |
| | `chains` | 1, 369, 11155111, 943 | The chains served, each with `extraContracts`. |
| | `extraContracts` | the beacon roots contract | Contracts allowed on every chain. |
| | `deploymentFiles` | the backend's `deploymentFile` | The deployment files whose contracts are allowed. |
| | `refreshSeconds` | 300 | How often the chain and the indexer are read again. |
| | `upstreamUrl` | `http://127.0.0.1:8792/zkb/evm/{chainId}` | Where eRPC listens. |
| Caddyfile | `request_body max_size` | 1MB | The body cap at the edge. |
| erpc.yaml | `rateLimiters` `per-visitor` | 1200 a minute, 60 a second, 120 `eth_getLogs` a minute | Per visitor address; an IPv6 visitor counts as its /64. |
| | `rateLimiters` `everyone` | 30000 a minute | All visitors together. |
| | `memory.maxTotalSize` | 256MB | The cache. Finalized data stays until evicted; recent blocks 5 s, the head 2 s, hash-keyed reads 30 s (a missing receipt is never kept). |
| | `getLogsMaxAllowedRange` | 10000 | The widest `eth_getLogs` block range. The dapp's scan halves a window that is refused for its size. |
| zk-bridge-erpc.service | `GOMEMLIMIT`, `MemoryMax` | 448MiB, 512M | eRPC's memory. |

To change a backend limit, edit `/etc/zk-bridge/backend/backend.json` on the server and restart the backend through its
playbook (`ansible-playbook backend.yml -e commit=<current>`, which drains first). To change an eRPC limit, edit
`/etc/zk-bridge/erpc/erpc.yaml` and run `ansible-playbook erpc.yml -e commit=<current>`, which checks the file before it
restarts eRPC. `GET https://rpc.zkb.fi/health` shows the module's counters (served, refused, invalid, without an answer
from eRPC), the number of zkb.fi contracts it knows per chain, and its last refresh.

## Deploy

Once, in this order. Nothing here is done by the build or by `site.yml`.

1. **Release.** Build the commit that holds this change (`ansible-playbook build.yml -e ref=<ref>`).
2. **eRPC configuration**, on the server as root:
   ```sh
   install -d -m 0750 -o root -g zkb_erpc /etc/zk-bridge/erpc     # provision.sh does this too; erpc.yml makes the user
   install -m 0640 -o root -g zkb_erpc /opt/zk-bridge/releases/<hash>/deploy/app-server/config/erpc/erpc.yaml.example /etc/zk-bridge/erpc/erpc.yaml
   install -m 0640 -o root -g zkb_erpc /dev/null /etc/zk-bridge/erpc/erpc.env
   ```
   Then put the server's valve.city key into `erpc.env` as `VALVE_RPC_KEY=<key>` without printing it, for example
   `printf 'VALVE_RPC_KEY=%s\n' "$(op read <reference>)" | ssh zkbfi-app 'cat > /etc/zk-bridge/erpc/erpc.env'` (the
   same key the backend and the runner already use). If the user `zkb_erpc` does not exist yet, run step 3 first; it
   stops at the missing files after making the user, then run it again.
3. **eRPC**: `ansible-playbook erpc.yml -e commit=<hash>`. It downloads `erpc-linux-arm64` of `0.3.0.15-valve`, checks
   its SHA-256 against the value pinned in `deploy/ansible/inventory/group_vars/zkbfi.yml` (from the release's
   `SHA256SUMS`), installs it as `/opt/zk-bridge/erpc/0.3.0.15-valve/erpc` with `/opt/zk-bridge/erpc/current` pointing
   at it, checks the configuration as `zkb_erpc` with its key, installs `zk-bridge-erpc.service`, restarts it, and
   reads `eth_chainId` of each chain through it.
4. **Backend**: add `"rpc-proxy"` to `modules` in `/etc/zk-bridge/backend/backend.json` (an `rpcProxy` section is
   optional; the defaults match `erpc.yaml.example`), then `ansible-playbook backend.yml -e commit=<hash>`.
5. **DNS** (not done by any playbook): an `A` record `rpc.zkb.fi` → `2.31.100.138`, DNS only (grey cloud in
   Cloudflare), like `prove.zkb.fi`. No proxy may sit in front: Caddy gets the certificate itself, and the backend
   trusts exactly one proxy hop (`trustedProxyHops: 1`) for the visitor's address. Add `AAAA` only if the server has an
   IPv6 address that Caddy listens on.
6. **Caddy**: `ansible-playbook caddy.yml -e commit=<hash>` installs the Caddyfile with the `rpc.zkb.fi` site
   (`ZKB_RPC_HOST` in `/etc/caddy/zkb.env` changes the name; the default is `rpc.zkb.fi`). Caddy gets the certificate on
   the first request after the DNS record resolves.
7. **Check** from outside:
   ```sh
   curl -s https://rpc.zkb.fi/943 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
   # {"jsonrpc":"2.0","id":1,"result":"0x3af"}
   curl -s https://rpc.zkb.fi/943 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x00"]}'
   # {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"rpc.zkb.fi refused eth_sendRawTransaction: …"}}
   ```
8. **Dapp**: publish a dapp release built from the same commit; its default RPCs start with rpc.zkb.fi.

Rollback: remove `"rpc-proxy"` from the backend's modules (rpc.zkb.fi then answers 404 and the dapp reads from the
public RPCs), or stop `zk-bridge-erpc` (the filter answers 502 and the dapp does the same).
