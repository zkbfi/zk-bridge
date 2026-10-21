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
| `forks.<fork>.blockRootsBranchLength` | Exact length of `blockRootsBranch` (18 or 19). |
| `forks.<fork>.blockHashGindex` | Combined index of `BeaconBlockBody.execution_payload.block_hash` (412 Capella, 812 Deneb and later). |
| `forks.<fork>.blockHashBranchLength` | Exact length of `blockHashBranch` (8 or 9). |
| `forks.<fork>.finalizedRootGindex`, `currentSyncCommitteeGindex`, `nextSyncCommitteeGindex`, `executionPayloadGindex` | Light-client indices (for the SP1 program and for reference). |
| `chains.<chain>.forkSchedule` | Rows `(activationEpoch, blockRootsGindexBase, blockHashGindex)` for the vault constructor. Only forks with a supported layout appear. All numbers are decimal strings. |

The vault picks the block roots row by the epoch of the ANCHOR header slot, and the block hash row by the epoch of the DEPOSIT header
slot. Branches must have exactly the stated length.

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
| `storedAnchorHeaderRoot` | What `lightClient.headers(anchorSlot)` must return for this case. Zero means the slot is not stored. |
| `remoteVault` | The vault address on the source chain (`remoteVault` in the verifying vault). |
| `localChainId` | `localChainId` of the verifying vault. |
| `sourceForkSchedule` | Rows `(activationEpoch, blockRootsGindexBase, blockHashGindex)` for the verifying vault. |
| `expected.result` | `"accept"` or `"reject"`. |
| `expected.deposit` | On accept: `token`, `sender`, `recipient`, `amount` (decimal string), `nonce`, `targetChainId`, `depositBlockHash`. |
| `expected.reason` | On reject: the Rust reason code. Mapping to Solidity custom errors is the Solidity test's job. |

Reason codes: `AnchorNotStored`, `DepositOutsideHistoricalWindow`, `InvalidBlockRootsBranch`, `InvalidBlockHashBranch`,
`ReceiptProofInvalid`, `ReceiptDecode`, `ReceiptFailed`, `LogIndexOutOfRange`, `LogEmitterMismatch`, `LogTopicMismatch`,
`LogDecode`, `TargetChainMismatch`, `HeaderDecode`, `UnsupportedFork`.

The vault checks in the same order as the Rust function: anchor stored, window, block roots branch, block hash branch (the leaf is
`keccak256(executionHeaderRlp)`), header decode, receipt proof, receipt decode and status, log index, emitter, topic, field decode,
target chain. The vault state checks (registered token, unclaimed nonce) are not part of these cases.
