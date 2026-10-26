# Fixtures

All files are JSON. They are test data for the Rust tests in `crates/lc-testkit/tests/` and for the Solidity tests.
Real-data files record where they came from (`source_url`) and when (`fetched_on`).

Regenerate:

- `scripts/fetch-fixtures.sh ethereum|pulsechain|all` fetches real data and, for PulseChain, derives the light-client update
  and beacon paths from a real beacon state (`derive-pulsechain-fixtures`).
- `cargo run -p lc-testkit --bin write-message-fixtures` writes `gindices.json` and `message/*.json`.
  A Rust test fails when these files are stale.

## Wrapper of raw data files

`ethereum/*.json`, `pulsechain/*.json`, `sepolia/*.json` and `pulsechain-testnet-v4/*.json` have the shape `{ "source_url", "fetched_on", "response" }`
(`"request"` is added for JSON-RPC calls). `response` is the beacon API or JSON-RPC result.
`sepolia/` and `pulsechain-testnet-v4/` hold three raw beacon responses each (`chain_spec.json`, `genesis.json`, `fork_schedule.json`),
fetched 2026-10-26. The `source_url` names the endpoint path; the host was not recorded. A test in
`crates/lc-testkit/tests/testnets.rs` compares every constant of the chain with them.
Files named `derived`: `pulsechain/light_client_update.json` and `pulsechain/beacon_paths.json` carry a `source_url`
that lists the real endpoints the tool read; every branch in them was computed from a real beacon state and checked against the
roots that the node reports.

## Real Sepolia Gloas head (`sepolia/gloas_head_*`, `sepolia/gloas_fork_version.json`)

Fetched 2026-10-26 from a Sepolia beacon node and a Sepolia execution node. `gloas_head_finality_update.json` is a finality update (real
sync aggregate). `gloas_head_state.ssz` is the SSZ `BeaconState` whose root is the `state_root` of its finalized header (3.6 MB, Gloas
layout). `gloas_head_execution_header.json` holds `debug_getRawHeader` and the block of the execution block that `state.latest_block_hash`
of that state names (23 items, Amsterdam), and the raw header of its parent as a header of another block. `gloas_fork_version.json` is
derived: the branch of `fork.current_version` (7 entries, index 169) over the same state. The tests are `gloas_real.rs` (lc-core and
the prover `checkpoint` and plan tests) and `test/hardened/GloasGate.t.sol`. Regenerate by fetching the same four objects again.

## `gindices.json`

Generalized indices per fork, computed from `ethereum/consensus-specs`. Keys:

| Key | Meaning |
|---|---|
| `forks.<fork>.blockRootsFieldGindex` | Generalized index of `BeaconState.block_roots` (37 Capella and Deneb, 69 Electra and Fulu). |
| `forks.<fork>.blockRootsGindexBase` | `blockRootsFieldGindex * 8192`. The index of `block_roots[slot % 8192]` is `blockRootsGindexBase + slot % 8192`. |
| `forks.<fork>.blockRootsBranchLength` | Exact length of the recent-path `ancestryBranch` (18 or 19). |
| `forks.<fork>.historicalSummariesFieldGindex` | Generalized index of `BeaconState.historical_summaries` (59 Capella and Deneb, 91 Electra and Fulu). Field 27 in every fork, from `ethereum/consensus-specs` (`specs/capella/beacon-chain.md`, container `BeaconState`). |
| `forks.<fork>.historicalAncestryBranchLength` | Exact length of the historical-path `ancestryBranch` (44 or 45). |
| `historicalRootsLimit`, `historicalSummariesListDepth` | `2^24` and 24: the limit of the `historical_summaries` list and its depth. |
| `chains.<chain>.capellaEra` | `floor(capellaForkSlot / 8192)` from the chain's fork schedule: Ethereum `758`, PulseChain `0`. The bridge takes it as an immutable argument. |
| `forks.<fork>.blockHashGindex` | Combined index of `BeaconBlockBody.execution_payload.block_hash` (412 Capella, 812 Deneb and later). |
| `forks.<fork>.blockHashBranchLength` | Exact length of `blockHashBranch` (8 or 9). |
| `forks.<fork>.finalizedRootGindex`, `currentSyncCommitteeGindex`, `nextSyncCommitteeGindex`, `executionPayloadGindex` | Light-client indices (for the SP1 program and for reference). |
| `gloas.*` | The Gloas positions, derived from the field lists by `lc-core`: `forkVersionGindex` 169, `blockRootsFieldGindex` 352, `historicalSummariesFieldGindex` 2950, `latestBlockHashGindex` 2947, with branch lengths. |
| `chains.<chain>.forkSchedule` | Rows `(activationEpoch, blockRootsGindexBase, blockHashGindex, historicalSummariesGindex)` for the bridge constructor. Only forks with a supported layout appear. All numbers are decimal strings. |

The bridge picks the block roots row and the `historical_summaries` index by the epoch of the ANCHOR header slot, and the block hash
row by the epoch of the SOURCE header slot. Branches must have exactly the stated length.

The bridge also picks the ancestry path from the two slots, never the prover. `distance = anchorSlot - sourceSlot`:

- `0 < distance <= 8192`: recent path. Leaf `hashTreeRoot(sourceHeader)` at `blockRootsGindexBase + sourceSlot % 8192`.
- `distance > 8192`: historical path. `era = sourceSlot / 8192`, require `era >= capellaEra`, `index = era - capellaEra`. The
  generalized index, in this order: `g = historicalSummariesFieldGindex`; `g = g * 2`; `g = g * 2^24 + index`; `g = g * 2`;
  `g = g * 2^13 + sourceSlot % 8192`. The branch runs bottom to top: 13 levels inside the era's `block_roots`, the
  `state_summary_root` sibling, 24 list levels, the list length chunk, then the state field levels.
- `sourceSlot >= anchorSlot`: refused (`DepositNotBeforeAnchor`).

## `message/<name>.json`

One case per file. Each case is one call of `MessageBridge.executeMessage`. Keys:

| Key | Meaning |
|---|---|
| `name` | Same as the file stem. Names start with `capella_` or `electra_` (synthetic data in that layout). |
| `description` | What the case shows. |
| `beaconData`, `receiptData` | `"synthetic"` in every case. The real fixtures hold no transaction bodies, so real data stops before the transaction proof (see "Real data" below). |
| `chain` | Source chain: `pulsechain` (Capella layout) or `ethereum` (Electra layout, Fulu). |
| `layout` | `capella` or `electra`. |
| `calldata` | Hex of the full calldata of `executeMessage(MessageProof)`: selector `0xa5442804` then the ABI encoding of the struct. |
| `anchorSlot` | `anchorHeader.slot`, as a decimal string. |
| `ancestryPath` | `recent`, `historical`, or `none` (the source slot is not before the anchor slot). The path the bridge takes for this case. |
| `capellaEra` | The `capellaEra` argument of the verifying bridge, as a decimal string. |
| `storedAnchorHeaderRoot` | What `lightClient.headers(anchorSlot)` must return for this case. Zero means the slot is not stored. |
| `remoteBridge` | The bridge address on the source chain (`remoteBridge` in the verifying bridge). |
| `localChainId`, `remoteChainId` | `localChainId` and `remoteChainId` of the verifying bridge, as decimal strings. |
| `sourceForkSchedule` | Rows `(activationEpoch, blockRootsGindexBase, blockHashGindex)` for the verifying bridge. |
| `expected.result` | `"accept"` or `"reject"`. |
| `expected.message` | On accept: `messageId`, `sender`, `executor`, `gasLimit`, `dataType`, `sourceChainId`, `destinationChainId`, `data`, `sourceBlockHash`, `sourceTransactionHash` (the keccak256 of the transaction at the index of the receipt). |
| `expected.reason` | On reject: the Rust reason code. Mapping to Solidity custom errors is the Solidity test's job. |

Reason codes: `IndexMismatch`, `AnchorNotStored`, `DepositNotBeforeAnchor`, `DepositBeforeCapella`, `HistoricalIndexOutOfRange`,
`InvalidAncestryBranch`, `InvalidBlockHashBranch`, `HeaderDecode`, `ReceiptProofInvalid`, `TransactionProofInvalid`,
`ReceiptDecode`, `ReceiptFailed`, `LogIndexOutOfRange`, `LogEmitterMismatch`, `LogTopicMismatch`, `LogMalformed`,
`MalformedEventData`, `MalformedMessage`, `MessageIdMismatch`, `MessageVersionInvalid`, `WrongSourceChain`,
`WrongDestinationChain`, `UnknownDataType`, `UnsupportedFork`.

The bridge checks in the same order as the Rust function (`lc_core::message::verify_message`): receipt index equals transaction
index, anchor stored, path choice (source before anchor, then for the historical path `era >= capellaEra` and the index limit),
ancestry branch (exact length), block hash branch (the leaf is `keccak256(executionHeaderRlp)`), header decode, receipt proof,
transaction proof (same index; the hash of the proven transaction is the source transaction hash), receipt decode and status,
log index, emitter, topic 0, topic count, event data (`abi.encode(bytes)`), message decode, identifier of the topic against the
identifier of the message, version, source chain, destination chain, data type. The bridge state checks (a message executes
once, the gas guard) are not part of these cases.

The cases share one synthetic block with four transactions. Receipt 1 holds 13 logs, one for each log rule: log 0 and 2 are
honest messages, 3 is from another emitter, 4 has another topic 0, 5 names the wrong source chain, 6 the wrong destination
chain, 7 has malformed event data, 8 a bad version, 9 a bad data type, 10 a topic identifier that differs from the message,
11 three topics, 12 the data type of `requireToConfirmMessage`. Receipt 2 has failed status. Receipt 3 is a type 2 receipt.

## Real data

The real PulseChain and Ethereum blocks in `pulsechain/` and `ethereum/` hold the transaction hashes of each block and not the
transactions. A real transaction proof needs the transaction bytes, so real data cannot pass the transaction stage. The Rust
tests `real_beacon_path_reaches_the_log_checks` and `real_historical_message_reaches_the_transaction_stage` run the stages
before it (beacon path, header, receipt proof, receipt) on real data, and `receipts_real.rs` proves every real receipt.

## Historical ancestry

The synthetic anchor states of the message cases hold the source header root in every place a mixed-up proof could point
at: `block_roots`, the era of the source block, and the two neighbouring eras (same offset). So each wrong branch in the
`*_reject_historical_*` and `*_reject_recent_distance_*` cases is a valid Merkle path of the anchor state, and only the bridge's
choice of path, index and length can refuse it.

`pulsechain/historical_paths.json` is real: historical-path ancestry from a real PulseChain anchor header and state to real
blocks in older eras (slot 96 and the end of era 0, both sides of an era edge, the end of an era, and a middle block), and
the check of the era formula. `source_url` lists the endpoints, `fetched_on` the date. Keys of `response`:

| Key | Meaning |
|---|---|
| `anchor_header`, `anchor_header_root` | The anchor header and the root the node reported for it. |
| `era_formula_checks[]` | Per era: `index = era - capella_era`; `block_summary_root_in_anchor_state` (from the anchor state) and `hash_tree_root_of_era_block_roots` (rebuilt from the canonical block roots of the era), `equal`; `slots_compared_with_anchor_block_roots` (where the era overlaps the anchor state's own `block_roots`, both agree). |
| `entries[]` | Per block: `deposit_header`, `ancestry_branch` (44 entries), `block_hash_branch`, `execution_block_number`, `execution_block_hash`. |

`pulsechain/path_historical_block.json` and `path_historical_receipts.json` are the execution block and receipts of the entry
`era_middle_block` (one transaction). The states are not stored: `scripts/fetch-fixtures.sh historical` downloads the anchor
state into `fetch-cache/` (ignored by git). On 2026-10-20 the beacon node served every state older than a few hundred slots with the
newest `historical_summaries` entry missing, so such a state does not hash to the root in its header. The tool therefore rebuilds
each era from the canonical block roots (`GET /eth/v1/beacon/blocks/<slot>/root`).

## `fork-observation/<name>.json`

Cases for the fork observation registry (`docs/hardened-build-contract.md`, section "Fork observation registry").
Synthetic committees on both layouts. `cargo run -p lc-testkit --bin write-fork-observation-fixtures` writes them,
and the Rust test `fork_observation_fixtures_are_current` fails when they are stale. File names start with `pulsechain_` or `ethereum_`.

| Key | Meaning |
|---|---|
| `name`, `description`, `chain` | Same as the file stem, what the case shows, and the source chain. |
| `publicValues` | Hex of `abi.encode(ForkObservation)`: 7 words, 224 bytes (`genesisValidatorsRoot`, `previousHeaderRoot`, `previousHeadSlot`, `previousSyncCommitteeHash`, `startNextSyncCommitteeHash`, `observedVersion`, `observedAttestedSlot`). The `bytes4` version is left-aligned in its word. `null` for `no-proof-exists` cases. |
| `observedVersion`, `observedAttestedSlot` | The two last fields, decoded (accept cases only). |
| `versionInProgramTable` | Whether the fork table of the Rust program holds the version (accept cases only). |
| `startStore` | The start store of the proof: `headerRoot`, `headSlot` (decimal string), `currentSyncCommitteeHash`, `nextSyncCommitteeHash` (zero when the store has none). Equals the first five fields of the public values. |
| `lightClient` | What the observed chain's light client holds in this case: `headSlot`, `headerRoot` (for that slot), `currentSyncCommitteeHash`, `nextSyncCommitteeHash` (zero for none). An accept case has them equal to `startStore`; a reject case changes one. |
| `expected.result` | `accept`, `reject` (the registry reverts), or `no-proof-exists` (the Rust program refuses, so no proof and no public values exist). |
| `expected.reason` | For `reject`: `StartMismatch` (a start field differs from `lightClient`), `NotFresh` (`observedAttestedSlot <= lightClient.headSlot`), `WrongLength` (public values are not 224 bytes). For `no-proof-exists`: the Rust error name. |

The accept cases use a proof-less oracle verifier on the Solidity side, so the proof bytes are not part of the fixture.
`observedAttestedSlot` is the slot of the attested header. The signature authenticates it, because the signed root is the hash of that header. The unsigned signature slot is not in the output.
The freshness rule compares `observedAttestedSlot` with `lightClient.headSlot`, not with `startStore.headSlot`.
