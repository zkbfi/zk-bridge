# prover

The proof producer of the hardened bridge. It makes proofs and hands them to other servers. Those servers store the proofs and send them to the chains.

The producer keeps no state. It has no database, no wallet, no keystore and no transaction code. It holds no trusted role: the contracts check everything that a server sends. Anyone can run it.

The producer once was a full relayer. That version watched deposits and withdrawals, kept a database and sent every transaction. It lives on the branch `archive/full-relayer`. This crate is the part that makes proofs.

Build contract: `docs/hardened-build-contract.md`, section "Prover service".

```
cargo build --release --no-default-features    # production build: no test crate, no signed beacon chain
cargo build --release                           # adds the signed beacon chain that the tests use
zk-bridge-prover --config prover.toml prove                              # one proof, from the head that the light client stores
zk-bridge-prover --config prover.toml prove --route <name> --to webhook  # choose the route and the handoff target
zk-bridge-prover --config prover.toml evidence --tx <hash> --log-index <n>   # the evidence that delivers one message
zk-bridge-prover verify --program-vkey <hash> --public-values <hex> --proof <hex>   # check one Groth16 proof locally
zk-bridge-prover checkpoint --beacon-url <url> --chain <name>            # the values that a new light client starts from
zk-bridge-prover --config prover.toml opening-proof --route <name>       # the evidence of openDeposits
zk-bridge-prover deployment-file --output <path> --broadcast <file> ...  # the deployment file of the explorer
```

The command line never takes a key. A secret lives in an environment variable, and the configuration names the variable (see `prover.example.toml`).

## Chains

A route names its source chain with `source.chain`, and `--chain` takes the same names.

| Name | Chain | Fork | Light-client routes of the public node |
|---|---|---|---|
| `ethereum` | Ethereum mainnet | Fulu | served |
| `pulsechain` | PulseChain (369) | Capella | 404: the producer builds updates from blocks and states |
| `sepolia` | Sepolia (11155111) | Gloas | served; needs the execution RPC (see below) |
| `pulsechain-testnet-v4` | PulseChain testnet v4 (943) | Capella | 404: the producer builds updates from blocks and states |

Each name selects the fork table and the genesis validators root of `lc-core`. An unknown name stops the command, and the message lists the known names.

**PulseChain states one summary short (2026-10-29).** The PulseChain nodes run Lighthouse-Pulse v2.5.1. It serves every state older than the newest finalized one without its last `historical_summaries` entry (64 bytes short), so the state does not hash to its header `state_root`. The cause is in its frozen-state storage, which counts the entries as `(slot - capellaForkSlot) / 8192` instead of `slot / 8192 - capellaForkSlot / 8192`; PulseChain forked Capella off an era boundary. On `pulsechain` and `pulsechain-testnet-v4` only, when a state does not hash to its root and exactly the last entry is missing, the prover takes that entry from the newest finalized state, which the node serves whole, and accepts the state only when it then hashes to its root. It logs `state_repaired` with the slot and the index. Any other mismatch stops the run as before (`src/beacon/http.rs`, `repair_frozen_state`; `src/light_client.rs`, `missing_summary_index`).

**Old states (2026-10-29).** An update starts from the state of the head the light client stores, and public nodes keep old states badly: Lodestar answers 500 for a Sepolia state that is no longer recent, and Lighthouse-Pulse serves frozen states one summary short (above). Two settings of a route source help. `state_urls` lists more beacon APIs that the prover asks, in order, only for `/eth/v2/debug/beacon/states/<root>`, when `beacon_url` does not serve the state or serves one with another root; `checkpoint` also takes them as `--state-url`. `state_cache_dir` names a directory where the prover keeps every state it fetched and verified, under `<chain id>/<slot>-<root>.ssz` (mode 0600, with a `.summary` file for a repaired state). A later run reads the state of its start head from there before it asks a node. The directory keeps the 16 newest states of each chain and every state younger than 3 days. Nothing in it is trusted: each state is parsed again and must hash to the root of its header, and a file that does not is removed (`src/beacon/state_store.rs`). The cache is what makes a long gap safe. Checkpointz servers, for example `https://beaconstate-sepolia.chainsafe.io`, serve only their own recent finalized checkpoint, so they help only for a state a few epochs old.

**The programs read no fork table (2026-10-27).** The light-client program and the fork observation program take their layouts from the evidence in the input: the finality branch length names the state layout (6, 7 or 9 entries), the form byte of each header names the full or compact shape, the blob flag of a payload header names the 15 or 17 field list, and the length of a compact execution branch names its anchor. The signing fork version is an input of each fold step. The prover builds these inputs. It reads the fork schedule from the beacon node at run time, never from the compiled table: `/eth/v1/config/fork_schedule` gives the version and first epoch of each scheduled fork, `/eth/v1/config/spec` gives the name, and the prover joins the two by version and stops with `ForkScheduleMismatch` if they disagree (see `src/fork_schedule.rs`). The signing version of a fold step is the version of the epoch of `signature_slot - 1`. A node that serves neither answer stops the prover with an error that names the path. An active fork that the prover does not know stops it with `UnknownActiveFork`. Nothing the prover supplies is trusted: a wrong version fails the signature check, and a wrong branch length or form fails the branch check. So a new fork that keeps an accepted layout (for example Gloas on Ethereum, or Deneb or Electra on PulseChain) needs no new program and no new verification key. The accepted finality branch lengths are 6, 7 and 9. A plain state of 65 or more fields (length 8) is refused, and a new route is then needed.

**The branch of `genesis_validators_root` (2026-10-27).** Each step also proves `genesis_validators_root` (state field 1) under the state root of its attested header, at generalized index 33, 65, 129 or 40 for the layout that the finality branch names. A beacon node does not serve this branch. The prover computes it from the attested state with `LightClientUpdate::with_genesis_validators_root_branch`, and keeps it by state root as untrusted public data (`src/beacon/branch_store.rs`). A later catch-up reads it back when the node has pruned the state. The store lives in memory for one run. Set `source.branch_store_dir` in a route to keep it in a directory across runs: this is the only file the `prove` command writes. A wrong stored branch is refused by the native run (`InvalidGenesisValidatorsRootBranch`) before any proof starts, and it can only stall a catch-up.

**A transition update.** A node that serves a Gloas update pads the branch of a header from before Gloas at the front with zeros up to 11 entries. The program reads 11 entries as the state anchor and refuses the padded form. For the finalized header only, the prover removes the padding (it keeps 8 entries for a Capella header and 9 for Deneb to Fulu, chosen by the fork name of the header slot, and it requires exactly 11 entries with zero padding), asks the execution node for the encoded header, and checks its keccak hash before it proves. The encoding comes from `debug_getRawHeader`. When the node answers that call with an error object, the prover rebuilds the encoding from `eth_getBlockByHash`. A header that does not hash to the block hash gives `Error::Malformed` on both paths. Any other form that does not fit the fork gives `HeaderFormMismatch`. The execution node is `source.rpc_url`.

**Fork observation.** The observation input carries `current_version_branch` and `genesis_validators_root_branch`, and the output has 256 bytes (eight words, the last one is the `uint8 shape`: 5, 6, 7 or 255 for the progressive form). `contracts::ForkRegistryContract` holds the registry bindings, and `contracts::observe_calldata` builds the call.

**Sepolia runs the Gloas fork.** A Gloas finalized header proves `state.latest_block_hash` from its state, and the program reads the block number from the RLP of that execution block. So for each Gloas finalized header the producer downloads the state (3.6 MB), hashes it in full with the Gloas layout, compares the root with the header, asks the source execution node for `debug_getRawHeader` of `latest_block_hash` (the hash is checked), and attaches both. A route needs `source.rpc_url`; `prove --beacon-url` needs `--source-rpc-url`. Without it the producer stops with an error that names the setting. `evidence` builds the proof of a message in a Gloas block through the bid `parent_block_hash` of the first later canonical block that names it (scan of up to 64 slots), reads the header RLP with `debug_getRawHeader` (from `source.rpc_url`, then from each `source.header_rpc_urls` entry in order; every header is checked against the block hash, and when none gives it the error names each source and no URL), and requires the destination bridge to report `gloasForkSlot` at or below that block. Chain 943 stays at Capella and works.

### Beacon URLs

`beacon_url` and `--beacon-url` may hold a path prefix, for example `https://rpc-testnet-pulsechain.g4mm4.io/beacon-api`, or a key segment such as `https://host/beacon/<key>/943`. The client keeps the prefix, tolerates trailing slashes and puts one slash between the prefix and each route. Query strings stay as they are.

The HTTP clients for beacon nodes and execution nodes send the User-Agent `Mozilla/5.0 (compatible; zk-bridge/1.0)`, because some public nodes refuse an unknown client name. The webhook and the remote prover get `zk-bridge-prover`.

A URL never appears in a log line or an error message in full. Logs and error text keep the scheme and the host and replace the rest with `/...`, because the path and the query can hold a key.

## The `prove` command

One run makes at most one proof of one light-client update. The steps are these.

1. The command reads where the update starts. With a route, it reads the head, the committee hashes and the program key from the destination light client. With `--head-slot` and `--head-root`, it takes the head from the command line and reads nothing from the destination chain.
2. It fetches the updates from that head to the newest final header of the source beacon chain. One fold holds up to 64 updates. A light client that lags by more periods gets a fold that ends below the newest header. The next run continues from the new head.
3. It runs the light-client program natively with `lc-core`. A fold that the program refuses ends the run with an error.
4. It checks that the native run starts exactly at the starting head. It checks the slot, the header root and the next committee hash. With a route, it also checks the genesis validators root and the committee hash of the head period.
5. It asks the backend for the proof.
6. It checks the answer. The public values must equal the native public values. The proof must have the shape of its backend. A real proof must verify under the program key with the crate `sp1-verifier`, whatever backend made it.
7. It hands the result off.

### Input

| Input | Flags |
|---|---|
| A route of the configuration file | `--route <name>`. The flag is optional when the file has exactly one route. |
| An explicit head on a route | `--route <name> --head-slot <n> --head-root <hash> [--next-committee-hash <hash>] [--program-vkey <hash>]` |
| An explicit head with no route | `--beacon-url <url> --chain <ethereum\|pulsechain> --head-slot <n> --head-root <hash> [--next-committee-hash <hash>] [--program-vkey <hash>]` |

An explicit head needs a program key. Pass `--program-vkey`, or set `prover.program_vkey` in the file. With a route and no explicit head, the key comes from the light client. A key in the file that differs from the contract key stops the run.

The next committee hash is zero when the light client holds no next committee. The flag defaults to zero. A value that the beacon state does not match stops the run before any proof, because the contract compares that hash.

### Backends

| Backend | What it does | Build |
|---|---|---|
| `remote` | Sends the job to a worker on a GPU host, for example a RunPod endpoint. See `docs/gpu-prover.md`. | Default build |
| `sp1` | Proves on the local processor. See `docs/server-prover.md`. | Cargo feature `sp1` or `sp1-native-gnark` |
| `oracle` | Signs for a development verifier. For tests and local chains. It refuses a route whose destination is not on the local machine. | Default build |

### Handoff

The result is one JSON object. The command prints it on standard output, posts it to a webhook, or does both. The file sets the targets (`handoff.targets`), and `--to stdout` and `--to webhook` replace them for one run.

- Standard output carries the object on one line and nothing else. Logs go to standard error.
- The webhook gets one `POST` with `Content-Type: application/json`. The User-Agent is `zk-bridge-prover`. The URL must use https, or http on the local machine.
- The bearer token is optional. The file sets `handoff.webhook_bearer_env` to the name of the variable that holds it. The command reads the variable at the start of the run. The token never enters a file or a log line.
- A transport error or a status of 408, 429 or 5xx is retried (`webhook_attempts`, default 3). Another 4xx status is final.
- With both targets, standard output comes first. A failed webhook then does not lose the proof. A proof is costly, so choose both targets when you cannot afford to lose one.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | A proof was made and handed off. |
| 3 | The starting head already is the newest final header. There is nothing to prove, and nothing is printed on standard output. |
| 1 | An error. The message is on standard error. |

A server that follows a lagging light client runs `prove` in a loop. It sends the proof of each run, and it stops when the command exits with code 3.

### The proof package

All hashes and byte strings are `0x` hex. Slots are JSON numbers. The version of the shape is `schemaVersion`. A change that removes or renames a key raises it. Long values are shortened here.

```json
{
  "schemaVersion": 1,
  "route": "ethereum_to_pulsechain",
  "programKey": "0x9999999999999999999999999999999999999999999999999999999999999999",
  "startHeadSlot": 10862664,
  "startHeadRoot": "0xbdc75227ae298ff4dcbd00460c3c294bd3eb55f282c7960c46125460ec9dbf90",
  "newHeadSlot": 10862670,
  "newHeadRoot": "0x313b8af758c40110a27481fc782d1bbd5efccb167d52806d93afb4d61ae4a061",
  "latestFinalizedSlot": 10862670,
  "publicValues": "0x3357ba0018a2…",
  "proof": "0xf49023cdbecf…",
  "updateCalldata": "0x3f37dce20000…",
  "backend": "oracle",
  "destination": {
    "chainId": 369,
    "lightClient": "0x4444444444444444444444444444444444444444"
  },
  "createdAt": "2026-10-24T09:30:00Z"
}
```

| Key | Meaning |
|---|---|
| `route` | The route name, or `explicit-head` when the command line gave the head and no route. |
| `programKey` | The program key that the proof is for. The light client stores the same key as `programVKey`. |
| `startHeadSlot`, `startHeadRoot` | The head where the update starts. The light client must still hold it as its head when the server sends the proof. |
| `newHeadSlot`, `newHeadRoot` | The head after the update. |
| `latestFinalizedSlot` | The newest final slot that the beacon node reported. When it is above `newHeadSlot`, run `prove` again after the update. |
| `publicValues` | The ABI encoding of `LightClientOutput`. |
| `proof` | The proof bytes that the verifier contract reads. |
| `updateCalldata` | The calldata of `BeaconLightClient.update(proof, publicValues)`. Send it to `destination.lightClient`. |
| `backend` | The backend that made the proof. |
| `destination` | The chain identifier and the light client address. The key is absent when the command line gave the head and no route. |
| `createdAt` | When the proof was made, as a time in UTC, such as `2026-10-24T09:30:00Z`. |

A proof stays valid until the light client head moves. After another update, the stored head differs from `startHeadSlot`, and the contract refuses the proof. A server should discard such a proof and run `prove` again.

## The `evidence` command

Delivering a message needs no zero-knowledge proof. The destination `MessageBridge` checks the evidence itself. The `evidence` command builds that evidence for one message and prints it. It sends nothing. A server sends the calls.

```
zk-bridge-prover --config prover.toml evidence --tx <hash> --log-index <n> [--route <name>] [--anchor-slot <n>]
```

The message is the `UserRequestForAffirmation` log at index `n` in the receipt of the source transaction. The index counts inside the receipt, not inside the block. The anchor is the head of the destination light client, or the stored header at `--anchor-slot`.

The command reads two execution chains, the beacon node of the source chain and the destination light client. For the source block it fetches the receipts and the raw bytes of every transaction (`eth_getRawTransactionByHash`, one call per transaction, each answer checked against its hash). It builds the receipts trie and the transactions trie, and it checks each root against the block header. Then it proves the receipt and the transaction at one index, as `executeMessage` requires. The source node must serve `eth_getRawTransactionByHash`. Then the command checks its own work:

- The destination bridge names the source bridge, the source chain, its own chain and the light client as the file says. The command reads each relation from the bridge (`remoteBridge`, `remoteChainId`, `localChainId`, `lightClient`).
- The log comes from the source bridge and is a `UserRequestForAffirmation` event. The message names the source chain and the destination chain of the route.
- The evidence passes the bridge checks, which `lc-core` runs natively against the anchor root that the light client stores (`lc_core::message::verify_message`). The check proves the source transaction hash. It must equal the hash that you passed in `--tx`.
- The message that the evidence proves equals the message in the log.

The result is one JSON object. Long values are shortened here.

```json
{
  "schemaVersion": 2,
  "route": "ethereum_to_pulsechain",
  "sourceTransactionHash": "0xabab…",
  "logIndex": 1,
  "message": {
    "messageId": "0x0005…",
    "sender": "0x7272…",
    "executor": "0x7373…",
    "gasLimit": 250000,
    "dataType": 0,
    "data": "0xabcdef",
    "sourceBlockNumber": 15,
    "sourceBlockHash": "0x847b…",
    "sourceSlot": 10862670
  },
  "destination": { "chainId": 369, "bridge": "0xb2b2…", "lightClient": "0xb3b3…" },
  "anchor": { "slot": 10862679, "root": "0xc7a5…" },
  "deliveryStatus": "notDelivered",
  "alreadyDelivered": false,
  "execute": { "to": "0xb2b2…", "data": "0xa5442804…" },
  "prerequisites": [
    {
      "function": "addBlockHashLayout",
      "reason": "no validated block hash row covers the source slot 10862670; this call uses the stored header at slot 10862664",
      "to": "0xb2b2…",
      "data": "0x…"
    }
  ],
  "createdAt": "2026-10-24T09:31:00Z"
}
```

The bridge needs a validated layout row for each generalized index that the evidence uses. Anyone may add a row, and the chain validates it. `prerequisites` lists the calls that add the missing rows, in the order to send them. The list is empty when the bridge has every row.

The calls for one function are alternatives. After each call, read the layout views of the bridge again, and skip the rest once a row covers the slot. The block hash row has up to two calls: one from the stored header at or below the source slot, and one from the stored header at or below the anchor.

When the light client stored too few heads to validate a row, the command stops with an error that says what is missing. Wait for more updates, then run it again.

### The delivery status

A message executes once, and delivery is final. The bridge marks the message before it calls the target. The mark stays whether the call succeeds or reverts. `deliveryStatus` has three values.

| Value | Meaning | Read from |
|---|---|---|
| `notDelivered` | The bridge never executed the message. `executeMessage` can still succeed. | `messageCallStatus` is false and `failedMessageDataHash` is zero. |
| `succeeded` | The bridge executed the message and the call to the target succeeded. | `messageCallStatus` is true. |
| `failed` | The bridge executed the message and the call to the target failed. The call cannot repeat. | `failedMessageDataHash` is not zero. It is the keccak256 of the call data. |

`alreadyDelivered` is true for `succeeded` and for `failed`. When it is true, `executeMessage` would revert with `AlreadyDelivered`. The bridge has no public view of its delivery state. These two views give it, except for a message in progress, which exists only inside the call to the target.

## The `verify` command

`verify` checks one Groth16 proof against a program key and public values with the crate `sp1-verifier`, the check that
the `prove` command runs on an answer of the backend. It reads no configuration file, makes no network call and takes no
key. The delivery runner calls it before it posts `update`, so a forged proof costs no gas.

```
zk-bridge-prover verify --program-vkey 0x<64 hex> --public-values 0x<352 bytes> --proof 0x<356 bytes>
```

On success it prints `{"valid":true,"programKey":"0x..."}` and exits with code 0. It exits with code 1 and an error on
standard error when the proof has the wrong length or selector, or does not verify for that key and those values. A
proof from the `oracle` backend is not a Groth16 proof, so `verify` refuses it.

## The `checkpoint` command

A new light client starts at one finalized header. `checkpoint` prints the values that the deploy configuration needs, as one JSON object on standard output. All four values come from the same finalized root.

```
zk-bridge-prover checkpoint --beacon-url https://rpc-testnet-pulsechain.g4mm4.io/beacon-api --chain pulsechain-testnet-v4
zk-bridge-prover --config prover.toml checkpoint --route <name> [--finalized-root <hash>]
```

With a route, the command uses the beacon URL and the chain of the source. With `--beacon-url`, it needs no configuration file. Without `--finalized-root`, it uses the newest finalized header of the node.

| Key | Meaning |
|---|---|
| `initialSlot`, `initialHeaderRoot` | The slot and the root of the finalized header. |
| `initialSyncCommitteeHash` | The hash of the sync committee of the period of that header. |
| `initialNextSyncCommitteeHash` | The hash of the next sync committee. Zero when none is known. |
| `nextCommitteeKnown` | False when the hash above is zero because no next committee was read. |
| `source` | `bootstrap` or `debugState`: where the committee values came from. |
| `chain`, `genesisValidatorsRoot`, `genesisTime`, `secondsPerSlot`, `capellaForkEpoch`, `capellaEra` | Chain facts. The command checks the node against the specification of `lc-core` first, and it stops on a difference. |

The command reads the `light_client/bootstrap` route first and checks the branch that ties the committee to the header. When the node answers 404 there (chain 943), it reads the finalized state, checks that the state hashes to the `state_root` of the header, and takes both committee hashes from the state. A Gloas header (Sepolia) stops the command with the Gloas error before any bootstrap or state request.

## The `opening-proof` command

`openDeposits` needs a proof that the remote light client stored a head (launch sequence, step 3). The command builds it for the source bridge of a route and prints it. It sends nothing.

```
zk-bridge-prover --config prover.toml opening-proof --route <name> [--bridge-source <address>] [--remote-slot <n>] [--stored-slot <n>]
```

The source chain holds the bridge to open and its own light client. The destination chain holds the remote light client. The command reads the chain identifiers, the own light client and the remote light client from the bridge, and it stops when the configuration disagrees. Then it follows the four links of `BeaconProofVerifier._verifyOpening`:

1. The own light client stored the block hash of a destination block at `remoteSlot`. The default is its head.
2. The command fetches that block, rebuilds the header RLP and checks its hash. Field 3 is the state root.
3. `eth_getProof` gives the account proof of the remote light client under that state root.
4. `eth_getProof` gives the storage proof of `executionBlockHashes[storedSlot]`. The slot is `keccak256(abi.encode(storedSlot, 3))`. The default `storedSlot` is the head of the remote light client in that block.

Before it prints, the command decodes its own calldata and runs the same walk natively (`opening::verify_opening`). A flipped proof node, a wrong key or an empty entry stops the command with an error and nothing on standard output. The destination node must serve `eth_getProof` and `eth_call` for the old block. The output holds `calldata` (send it to `to`), the decoded `proof` and the facts of the check.

## The `deployment-file` command

The explorer reads a deployment file with one section for each chain (`explorer/shared/src/pairs.ts`). The command writes it.

```
zk-bridge-prover deployment-file --output deployment.json \
  --broadcast broadcast/DeployBridge.s.sol/11155111/run-latest.json --broadcast broadcast/DeployBridge.s.sol/943/run-latest.json
zk-bridge-prover deployment-file --output deployment.json --chain-a chain_id=11155111 --chain-a bridge=0x... --chain-b chain_id=943 ...
```

- The sections are `chain_a` and `chain_b`. Each has `chain_id`, `bridge`, `mediator`, `token_factory`, `wrapped_native`, `gate`, `light_client`, `start_block`, and `delivery_router` and `fork_registry` when the chain has them.
- A broadcast file gives the names from its `contractName` fields. The factory is the first contract of the mediator. The wrapped native token is the second argument of the `DeliveryRouter`. `start_block` is the block before the first deployment transaction. The first `BeaconLightClient` is the light client. A name that occurs twice stops the command.
- A `--chain-a key=value` pair overrides the file. A pair with `chain_id` picks the deployment of that chain from the files. Without it, the section takes the deployment at its position.
- Every address has 20 bytes and the `0x` prefix. The required addresses are not zero. `wrapped_native` is zero for a chain without a wrapped native token.
- The file has no `rpc_url` unless you pass one. The command refuses a URL with a path, a query or user information, because those parts hold keys. Set `EXPLORER_RPC_URL_<chain id>` for the explorer instead.
- The file has mode 0600. The command refuses to replace a file unless you pass `--force`.

## Catching up a light client that lags

One update moves a light client across at most one sync committee period. The beacon source therefore builds a fold. It reads the committee handoff update of each period from the head period of the light client to the present (`/eth/v1/beacon/light_client/updates?start_period=&count=`, paged, because a node returns at most a count of its own choice). It adds the latest finality update and proves all of them as one fold. When the light client already holds a next committee, the store of the proof carries it, read from the beacon state of the head. The contract compares its hash.

A node that pruned the update of a needed period cannot serve the catch-up. The error names the period and asks for a node with a longer history of light-client updates. When the light client already stores the next committee, the handoff of its head period is not asked for, so a node that serves no `light_client/updates` (chain 943) still moves a light client across one period border. Such a light client must get a proof in every period: once the source signs in the period after the stored next committee, only handoff updates can move it, and that node has none (see `docs/testnet-run.md`, "Keeping the light clients alive").

## Old messages

The bridge takes `state.block_roots` of the anchor for a source block up to 8192 slots below it, and `state.historical_summaries` beyond that. The evidence builder builds either branch with `lc-core`. For an old message, it rebuilds the 8192 block roots of the source era from the canonical block roots of the node (`/eth/v1/beacon/blocks/<slot>/root`). It never reads them from an old state. The node must still serve the state of the anchor, so anchor at the newest stored head.

## Tests

```
cargo test --offline
cargo clippy --offline --all-targets --all-features -- -D warnings
scripts/check-crate-ages.sh        # every locked crate was published on or before 2026-09-22
```

| Test | What it shows |
|---|---|
| `tests/produce.rs` | The producer and the `prove` command on a signed beacon chain, with the oracle backend: the package, the exit codes, the webhook and the route mode. |
| `tests/evidence.rs` | The `evidence` command on a synthetic world: a beacon chain, a source chain with one message in the second transaction of a block, and a destination chain with a message bridge. The evidence passes the native bridge check, and the proven transaction hash is the hash of the sending transaction. |
| `tests/checkpoint.rs` | The `checkpoint` command on a node with and without the light-client routes, a flipped committee branch, a named root, a wrong chain, and a Sepolia checkpoint from the real Gloas state. |
| `tests/opening_proof.rs` | The `opening-proof` command against two mock chains with real tries, a flipped node in each proof, and the constants that must equal the Solidity constants. |
| `tests/deployment_file.rs` | The `deployment-file` command: the explorer rules in Rust, the broadcast file, the mode, the overwrite rule and every refusal. |
| `tests/real_pulsechain_testnet.rs` | A real block of chain 943 parsed to its header. The ignored test downloads the finalized state and block of the public node and compares the roots (`cargo test --test real_pulsechain_testnet -- --ignored`, needs network). |
| `tests/signed_beacon.rs` | The beacon source on the signed beacon chain: the update from a stored head, the message path and the layout evidence. |
| `tests/remote_prover.rs` | The remote backend against a fake worker, with a real Groth16 proof and the checks that refuse a changed proof. |
| `tests/sp1_execute.rs` | The two guest programs in the SP1 executor against `lc-core` (cargo feature `sp1`). Run it with `cargo test --features sp1 --test sp1_execute -- --test-threads=1`. It takes about 4.5 minutes and needs the guest program files from `cargo prove build` in `light-client/guests/*`. The full Groth16 proof test is ignored on a laptop. |

The Anvil tests of the old relayer, the attack scripts and the end-to-end scripts are on the branch `archive/full-relayer`.

## The seams

- `src/light_client.rs` is the only file that calls `lc-core`.
- `src/contracts.rs` holds every contract binding. The crate only encodes the calls that a server sends.
- The cargo feature `signed-beacon` (on by default) adds a beacon chain over local blocks with real signatures, and the test crate behind it. `--no-default-features` leaves both out.
- The `sp1` cargo feature is off by default. It adds `Sp1Prover`, which proves on the local processor with `sp1-sdk` 6.8.1. The feature `sp1-native-gnark` adds the in-process Groth16 wrapper, and the server image uses it. The feature `sp1-cuda` adds the GPU client and builds the `prove-worker` binary. See the module documentation of `src/prover.rs` and `docs/server-prover.md`.
- `.cargo/config.toml` sets `GOPROXY` for the Go build of the Groth16 wrapper (feature `sp1-native-gnark`).
