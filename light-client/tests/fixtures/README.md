# Fixtures

All files are JSON. They are test data for the Rust tests in `crates/lc-testkit/tests/` and for the Solidity tests.
Real-data files record where they came from (`source_url`) and when (`fetched_on`).

Regenerate:

- `scripts/fetch-fixtures.sh ethereum|pulsechain|all` fetches real data and, for PulseChain, derives the light-client update
  and beacon paths from a real beacon state (`derive-pulsechain-fixtures`).
- `cargo run -p lc-testkit --bin write-withdrawal-fixtures` writes `gindices.json` and `withdrawal/*.json`.
  A Rust test fails when these files are stale.

## Wrapper of raw data files

`ethereum/*.json`, `pulsechain/*.json` have the shape `{ "source_url", "fetched_on", "response" }`
(`"request"` is added for JSON-RPC calls). `response` is the beacon API or JSON-RPC result.
Files named `derived`: `pulsechain/light_client_update.json` and `pulsechain/beacon_paths.json` carry a `source_url`
that lists the real endpoints the tool read; every branch in them was computed from a real beacon state and checked against the
roots that the node reports.

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
| `chains.<chain>.capellaEra` | `floor(capellaForkSlot / 8192)` from the chain's fork schedule: Ethereum `758`, PulseChain `0`. The vault takes it as an immutable argument. |
| `forks.<fork>.blockHashGindex` | Combined index of `BeaconBlockBody.execution_payload.block_hash` (412 Capella, 812 Deneb and later). |
| `forks.<fork>.blockHashBranchLength` | Exact length of `blockHashBranch` (8 or 9). |
| `forks.<fork>.finalizedRootGindex`, `currentSyncCommitteeGindex`, `nextSyncCommitteeGindex`, `executionPayloadGindex` | Light-client indices (for the SP1 program and for reference). |
| `chains.<chain>.forkSchedule` | Rows `(activationEpoch, blockRootsGindexBase, blockHashGindex, historicalSummariesGindex)` for the vault constructor. Only forks with a supported layout appear. All numbers are decimal strings. |

The vault picks the block roots row and the `historical_summaries` index by the epoch of the ANCHOR header slot, and the block hash
row by the epoch of the DEPOSIT header slot. Branches must have exactly the stated length.

The vault also picks the ancestry path from the two slots, never the prover. `distance = anchorSlot - depositSlot`:

- `0 < distance <= 8192`: recent path. Leaf `hashTreeRoot(depositHeader)` at `blockRootsGindexBase + depositSlot % 8192`.
- `distance > 8192`: historical path. `era = depositSlot / 8192`, require `era >= capellaEra`, `index = era - capellaEra`. The
  generalized index, in this order: `g = historicalSummariesFieldGindex`; `g = g * 2`; `g = g * 2^24 + index`; `g = g * 2`;
  `g = g * 2^13 + depositSlot % 8192`. The branch runs bottom to top: 13 levels inside the era's `block_roots`, the
  `state_summary_root` sibling, 24 list levels, the list length chunk, then the state field levels.
- `depositSlot >= anchorSlot`: refused (`DepositNotBeforeAnchor`).

## `withdrawal/<name>.json`

One case per file. Keys:

| Key | Meaning |
|---|---|
| `name` | Same as the file stem. Names start with `capella_` or `electra_` (synthetic data in that layout) or `real_`. |
| `description` | What the case shows. |
| `beaconData`, `receiptData` | `"real"` or `"synthetic"`. A `real_*` file with `beaconData` `"synthetic"` has a real Ethereum block and receipts under a synthetic Electra-layout beacon path. |
| `chain` | Source chain: `pulsechain` (Capella layout) or `ethereum` (Electra layout, Fulu). |
| `layout` | `capella` or `electra`. |
| `calldata` | Hex of the full calldata of `withdraw(WithdrawalProof)`: selector `0x30568d83` then the ABI encoding of the struct. |
| `anchorSlot` | `anchorHeader.slot`, as a decimal string. |
| `ancestryPath` | `recent`, `historical`, or `none` (the deposit slot is not before the anchor slot). The path the vault takes for this case. |
| `capellaEra` | The `capellaEra` argument of the verifying vault, as a decimal string. |
| `storedAnchorHeaderRoot` | What `lightClient.headers(anchorSlot)` must return for this case. Zero means the slot is not stored. |
| `remoteVault` | The vault address on the source chain (`remoteVault` in the verifying vault). |
| `localVault` | The address of the verifying vault itself (`address(this)`). The deposit must name it as `destinationVault`. |
| `localChainId` | `localChainId` of the verifying vault. |
| `sourceForkSchedule` | Rows `(activationEpoch, blockRootsGindexBase, blockHashGindex)` for the verifying vault. |
| `expected.result` | `"accept"` or `"reject"`. |
| `expected.deposit` | On accept: `token`, `sender`, `recipient`, `amount` (decimal string), `nonce`, `targetChainId`, `destinationVault`, `depositBlockHash`. |
| `expected.reason` | On reject: the Rust reason code. Mapping to Solidity custom errors is the Solidity test's job. |

Reason codes: `AnchorNotStored`, `DepositNotBeforeAnchor`, `DepositBeforeCapella`, `HistoricalIndexOutOfRange`, `InvalidAncestryBranch`, `InvalidBlockHashBranch`,
`ReceiptProofInvalid`, `ReceiptDecode`, `ReceiptFailed`, `LogIndexOutOfRange`, `LogEmitterMismatch`, `LogTopicMismatch`,
`LogDecode`, `TargetChainMismatch`, `DestinationVaultMismatch`, `HeaderDecode`, `UnsupportedFork`.

The vault checks in the same order as the Rust function: anchor stored, path choice (deposit before anchor, then for the historical path
`era >= capellaEra` and the index limit), ancestry branch (exact length), block hash branch (the leaf is
`keccak256(executionHeaderRlp)`), header decode, receipt proof, receipt decode and status, log index, emitter, topic, field decode,
target chain, destination vault. The vault state checks (registered token, unclaimed nonce) are not part of these cases.

## Historical ancestry

The synthetic anchor states of the withdrawal cases hold the deposit header root in every place a mixed-up proof could point
at: `block_roots`, the era of the deposit, and the two neighbouring eras (same offset). So each wrong branch in the
`*_reject_historical_*` and `*_reject_recent_distance_*` cases is a valid Merkle path of the anchor state, and only the vault's
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
