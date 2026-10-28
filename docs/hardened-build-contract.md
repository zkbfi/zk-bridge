# Build contract for the hardened bridge

This document fixes the names, paths, and interfaces for two pieces of work that run in parallel:

1. A red team of revision 2 of the specification (`spec/revision-2/`).
2. A hardened bridge that fixes the holes that revision 2 left open.

Read `docs/red-team.md` first. It lists holes H-01 to H-23 against revision 1.

**Status (2026-10-24).** The single contract `BridgeVault` is retired and deleted. Two layers replace it: `MessageBridge` (proof, lock, send and execute of messages) and `TokenMediator` (tokens, flow limiter hook). The section "Message layer and token mediator" is built, and its last part ("As built") lists where the build differs from the design. Sections that describe the vault below stay as the record of the rules. Each carries a note that says where the rule lives now.

## Scope decisions (made by the user)

- **H-09 is out of scope.** The user accepts that a deposit stays locked when the destination vault has no liquidity. The hardened vault therefore has **no refund function**. A refund without a cross-chain cancellation proof lets one deposit be claimed twice (once as a withdrawal, once as a refund). Leaving the refund out removes that path.
- **Focus:** the holes that revision 2 did not fix: H-01 (no domain separation), H-04 (an ECDSA multisignature, with a decorative BLS check in the circuit), H-08 (no finality), H-15 (update gas with no fee), plus the new revision 2 defects in the table below.

## Revision 2 defects (identifiers for the new holes)

| Id | Defect |
|---|---|
| R2-01 | `DepositInitiated` has 4 `indexed` parameters. Solidity allows 3. The vault does not compile (error 7249). |
| R2-02 | The circuit hardcodes topic 0 `0x2df9…c1ee`. The real topic is `keccak256("DepositInitiated(address,address,address,uint256,bytes32,uint64)")` = `0x9bab…eaf5`. No deposit can ever match. |
| R2-03 | The circuit's BLS check only tests `signature.len() == 96 && pubkeys.len() >= 342`. It verifies no signature, and the public keys are tied to nothing. |
| R2-04 | `alloy_trie::verify_proof(root, key: Nibbles, expected_value: Option<Vec<u8>>, proof)` returns `Result<(), _>`. The circuit uses its return value as the leaf. It does not compile. |
| R2-05 | `Receipt::decode` reads a bare RLP list. Type 1, 2, 3, and 4 transactions store `type_byte ‖ rlp(receipt)` in the trie, so most receipts fail to decode. |
| R2-06 | The circuit checks only the first matching log in a receipt and panics when it does not match. A second deposit in the same transaction can never be proven. |
| R2-07 | The token registry maps a remote token to a local token with no decimals check. Different decimals pay the wrong amount. |
| R2-08 | Each vault needs the other vault's address as an immutable constructor argument. No deploy procedure predicts the addresses. |
| R2-09 | The light client's signed message has no chain or contract domain: `keccak256(attestedHeader, period, nextCommitteeRoot)`. One signed update is valid on every light client that shares the committee. |
| R2-10 | The repository compiled for `cancun`. PulseChain stopped at Capella/Shanghai and rejects `MCOPY` and `TSTORE`. Fixed in `foundry.toml` (now `shanghai`). |

## Facts measured on 2026-10-20

PulseChain beacon API (`https://rpc-pulsechain.g4mm4.io/beacon-api`):

| Parameter | PulseChain | Note |
|---|---|---|
| `SECONDS_PER_SLOT` | 10 | Ethereum: 12 |
| `SLOTS_PER_EPOCH` | 32 | |
| `SYNC_COMMITTEE_SIZE` | 512 | |
| `EPOCHS_PER_SYNC_COMMITTEE_PERIOD` | 256 | A period is 8192 slots, about 22.8 hours |
| `GENESIS_FORK_VERSION` | `0x00000369` | |
| `ALTAIR_FORK_VERSION` / epoch | `0x0000036a` / 1 | |
| `CAPELLA_FORK_VERSION` / epoch | `0x0000036c` / 3 | |
| `DENEB_FORK_EPOCH` | `18446744073709551615` | Never scheduled. No Electra or Fulu. |
| `genesis_validators_root` | `0x3357ba0018a2582aeabe4ae847aa17d50a3a99aaeb66293c01f80a83aecd0c90` | |
| `DOMAIN_SYNC_COMMITTEE` | `0x07000000` | |
| Light-client endpoints | `/eth/v1/beacon/light_client/*` returns 404 on this node | |

The PulseChain execution layer has `withdrawalsRoot` but no `blobGasUsed`, `excessBlobGas`, `parentBeaconBlockRoot`, or `requestsHash`. It rejects `MCOPY` and `TSTORE`.

Succinct's SP1 verifier gateways at `0x397A5f7f3dBd538f23DE225B51f532c34448dA9B` and `0x3B6041173B80E77f038f3F2C0f9744f04837185e` have code on Ethereum (owner `0xCafEf00d348Adbd57c37d1B77e0619C6244C6878`). Neither address has code on PulseChain.

Fetch Ethereum mainnet values (fork versions, fork epochs, genesis validators root) from a live Ethereum beacon API (`/eth/v1/config/spec`, `/eth/v1/beacon/genesis`). Do not type them from memory.

## Ground rules for every agent

- Write only inside the paths you own (table below). Never edit `spec/`.
- Red-team tests **pass when the attack succeeds** and carry a control assertion that shows they can fail.
- Hardened tests **pass when the defense holds**. Each attack test on the hardened code must also show the honest path still works.
- Name tests after the identifier they cover, for example `test_R2_01_...`, `test_H08_hardened_rejectsUnfinalizedBlock`.
- Every test carries a comment: what was claimed, what the test shows, and why it matters.
- Pin every dependency to an exact version published at least 28 days ago. Check the publish date on the registry before you add it.
- Never install `@succinctlabs/sp1-sdk`. Never run `sp1up` or any `curl … | bash` installer.
- Code style: early returns, no nested conditionals, no abbreviations, documentation comments on every public function.
- Do not commit. The coordinator commits.

## Ownership

| Path | Owner |
|---|---|
| `src/revision-2/`, `test/revision-2/`, `checks/revision-2/`, `checks/run.sh`, the "Revision 2" section of `docs/spec-deviations.md` | revision 2 agent |
| `src/hardened/`, `src/mocks/OracleSP1Verifier.sol`, `test/hardened/`, `script/hardened/` | hardened contracts agent |
| `light-client/` | light-client agent |
| `harness/` | harness agent (starts after the hardened contracts exist) |
| `foundry.toml`, `docs/` (except the section above), `README.md`, `progress.txt` | coordinator |

## Hardened contracts

Solidity `0.8.28`, `evm_version = "shanghai"` (set in `foundry.toml`), OpenZeppelin v5.7.0.

### `src/hardened/ISP1Verifier.sol`

The real gateway shape. It reverts on an invalid proof.

```solidity
interface ISP1Verifier {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}
```

### `src/mocks/OracleSP1Verifier.sol`

Implements `ISP1Verifier`. `constructor(address oracle)`. `verifyProof` succeeds only when `proofBytes` is a 65-byte ECDSA signature by `oracle` over the raw digest `keccak256(abi.encodePacked(programVKey, sha256(publicValues)))`. Otherwise it reverts with `InvalidProof()`. This models a sound proof system: a proof exists only when the reference program accepts the statement.

### `src/hardened/BeaconLightClient.sol`

Tracks the **finalized** beacon chain of one source chain. This follows the shape of Succinct's SP1 Helios contract.

Public values of the light-client program (`abi.encode` of this tuple, in this order):

```solidity
struct LightClientOutput {
    bytes32 genesisValidatorsRoot;      // binds the source chain (fixes R2-09 and H-01)
    bytes32 previousHeaderRoot;         // must equal the stored header root at previousHeadSlot
    uint64  previousHeadSlot;           // must equal the stored head
    bytes32 previousSyncCommitteeHash;  // must equal the stored committee for period(previousHeadSlot)
    bytes32 newHeaderRoot;              // a FINALIZED beacon header root
    uint64  newHeadSlot;                // its slot
    bytes32 executionBlockHash;         // the execution payload block hash inside that header
    uint64  executionBlockNumber;
    bytes32 syncCommitteeHash;          // the committee for period(newHeadSlot)
    bytes32 nextSyncCommitteeHash;      // the committee for period(newHeadSlot) + 1, or zero when not proven
}
```

- `constructor(address verifier, bytes32 programVKey, bytes32 genesisValidatorsRoot, uint64 slotsPerPeriod, uint64 genesisTime, uint64 secondsPerSlot, uint64 initialSlot, bytes32 initialHeaderRoot, bytes32 initialSyncCommitteeHash, bytes32 initialNextSyncCommitteeHash, uint64 slotsPerHistoricalRoot)`. The initial checkpoint is the one trust assumption. Anyone can check it against public beacon data. `genesisTime` and `secondsPerSlot` are immutable, and a zero value reverts `ZeroValue`.
- `function update(bytes calldata proof, bytes calldata publicValues) external`. The caller names no period: periods come only from `periodOf(slot)`. Checks, in this order, with custom errors: the public values have the exact length; the genesis validators root matches; the previous head, header root, and committee match stored state (`previousSyncCommitteeHash == syncCommittees[headPeriod]`); `newHeadSlot > head`; `newHeadSlot <= currentSlot` (error `HeadInFuture(newHeadSlot, currentSlot)`, see "Clock bound on the head"); `newHeadSlot - head <= slotsPerHistoricalRoot` (an immutable constructor argument, at most `slotsPerPeriod`, so one update crosses at most one period boundary); the new header root and execution block hash are non-zero; then the committee rules below; then `verifier.verifyProof(programVKey, publicValues, proof)`. Then it stores the header root (every past head stays stored, as an anchor), the execution block hash of that head (`executionBlockHashes(slot)`), marks the execution block hash finalized with its block number, moves the head, and emits `HeadUpdated(uint64 indexed slot, bytes32 indexed headerRoot, bytes32 indexed executionBlockHash)`.
- **Committee rules** (a forged next committee must never enter through an empty slot):
  1. If `newPeriod == headPeriod`, `syncCommitteeHash` must equal `syncCommittees[headPeriod]`, else `SyncCommitteeMismatch`.
  2. If `newPeriod == headPeriod + 1`, `syncCommittees[headPeriod + 1]` must be non-zero, else `NextSyncCommitteeUnknown(period)`, and `syncCommitteeHash` must equal it. An empty slot is never filled from `syncCommitteeHash`.
  3. `nextSyncCommitteeHash == 0` changes nothing. A non-zero value must equal `syncCommittees[newPeriod + 1]` when that slot is stored (`NextSyncCommitteeMismatch`), and is written when the slot is empty. This is the only way a next slot gets filled after construction. The contract relies on the program to output a non-zero next committee only when that update proves it from the attested state, never a carried value.
  4. `syncCommittees[newPeriod]` is never written from the output. The constructor may take a zero `initialNextSyncCommitteeHash`; then the first crossing update reverts until a same-period update fills the slot.
- Views: `head()`, `headers(uint64 slot)`, `syncCommittees(uint64 period)`, `isFinalizedExecutionBlock(bytes32 blockHash) returns (bool)`, `executionBlockNumber(bytes32 blockHash) returns (uint64)`, `periodOf(uint64 slot)`.
- Gas: one proof check per update, no matter the committee size (fixes H-15). Measure it.
- No owner, no upgrade path, no pause.

### `src/hardened/BridgeVault.sol` (retired)

Retired on 2026-10-24. The rules below describe the vault. The proof checks moved to `BeaconProofVerifier` and `MessageBridge`. The token rules moved to `TokenMediator`. The pair tables and the destination token binding are gone, because the mediator computes the bridged copy of a token and needs no registration. See "Message layer and token mediator".

Event (3 indexed parameters, fixes R2-01). It has final `destinationVault` and `destinationToken` parameters that revision 1 did not have, so its signature and topic 0 differ from revision 1. The log data is 160 bytes: `amount`, `nonce`, `targetChainId`, `destinationVault`, `destinationToken`, each padded to 32 bytes. The source vault emits its immutable `remoteVault` as `destinationVault`. The destination vault's `withdraw` requires `destinationVault == address(this)`. The source vault emits `remoteTokenOf[token]` as `destinationToken`. The destination vault requires it to equal the local token that it would pay (see "Destination token binding" at the end of this file):

```solidity
event DepositInitiated(address indexed token, address indexed sender, address indexed recipient, uint256 amount, bytes32 nonce, uint64 targetChainId, address destinationVault, address destinationToken);
```

The signature string is `DepositInitiated(address,address,address,uint256,bytes32,uint64,address,address)`. Topic 0 is `0x2d8b36b0632a230eea6da357dbb14a954a4a3101fb64d1567778dc4bf2a25cd0`.

Expose `bytes32 public constant DEPOSIT_EVENT_TOPIC = DepositInitiated.selector;` so tests can compare it with the circuit's constant (fixes R2-02).

Public values of the withdrawal program (`abi.encode`, in this order):

```solidity
struct WithdrawalOutput {
    uint64  sourceChainId;
    uint64  targetChainId;
    address sourceVault;
    address sourceToken;
    address recipient;
    uint256 amount;
    bytes32 depositNonce;
    bytes32 finalizedAnchorBlockHash;  // a finalized execution block the light client stores
    bytes32 depositBlockHash;          // the deposit's block, proven to be an ancestor of the anchor
}
```

- `constructor(address verifier, bytes32 withdrawalVKey, address lightClient, uint64 localChainId, uint64 remoteChainId, address remoteVault, TokenPair[] memory pairs)` with `struct TokenPair { address localToken; address remoteToken; uint8 remoteDecimals; }`. The constructor requires `localChainId == block.chainid`, a non-zero `remoteVault`, and `IERC20Metadata(localToken).decimals() == remoteDecimals` for each pair (fixes R2-07). The remote decimals value is the deployer's claim. The deploy script must read it from the remote chain.
- `deposit(address token, address recipient, uint256 amount)`: the target is always `remoteChainId` (fixes H-10). It requires a registered local token, a non-zero recipient, and a non-zero amount. It measures the received balance (fee-on-transfer) and uses `SafeERC20`. Nonce: `keccak256(abi.encode(block.chainid, address(this), depositCount++))`. It emits the received amount.
- `withdraw(bytes calldata proof, bytes calldata publicValues)`: decodes `WithdrawalOutput`; requires `sourceChainId == remoteChainId`, `targetChainId == localChainId`, `sourceVault == remoteVault`, an unclaimed nonce, `lightClient.isFinalizedExecutionBlock(finalizedAnchorBlockHash)` (fixes H-08), and a registered `sourceToken`; calls `verifier.verifyProof`; marks the nonce; pays the mapped local token with `SafeERC20`; emits `WithdrawalCompleted`.
- No refund (see scope). No owner. Reentrancy is safe because state changes before the transfer. Add `ReentrancyGuard` (the storage version, not the transient one, because PulseChain has no `TSTORE`).

### `script/hardened/DeployBridge.s.sol`

The deploy script the specification should have shipped. Foundry script, run with `forge script … --broadcast`.

- Reads a JSON configuration (path from `BRIDGE_CONFIG`) holding both chains' RPC aliases, chain identifiers, the verifier address per chain, the program verification keys, the light-client checkpoints and clocks, and the token pairs.
- Never takes a private key on the command line or in a file. Use `--account <keystore name>` or `--ledger`.
- Predicts both vault addresses from the deployer's nonce on each chain with `vm.computeCreateAddress` **before** it deploys anything (fixes R2-08). It refuses to run when the deployer's nonce on either chain differs from the value in the configuration.
- After deployment, it reads every immutable back and asserts it matches the configuration and the predicted cross-chain addresses.
- Prints the plan and does nothing on chain without `--broadcast`.

Tests (`test/hardened/DeployBridge.t.sol`) run the script logic against forked local state or two `vm.createSelectFork` Anvil endpoints, and check the prediction, the nonce guard, and the post-deploy assertions.

## Light-client and withdrawal programs (`light-client/`)

A Rust workspace whose core crate compiles and tests natively. The same functions are the bodies of the SP1 guest programs. The SP1 guest wrappers live in `light-client/guests/` and are excluded from the workspace, because this machine has no SP1 toolchain and must not install it with `sp1up`.

### Chain configuration

`ChainSpec { name, genesis_validators_root, fork_schedule: [(epoch, fork_version, fork_name)], seconds_per_slot, slots_per_epoch, epochs_per_sync_committee_period }` with constants for Ethereum mainnet (fetched, see above) and PulseChain (table above).

### Light-client program: `verify_light_client_update(store, update, spec) -> LightClientOutput`

Implements the Altair light-client sync protocol for both fork schedules:

- `participants * 3 >= 512 * 2` (at least 342 of 512).
- Aggregate the participating public keys and run BLS `FastAggregateVerify` over `compute_signing_root(attested_header, domain)`, with `domain = compute_domain(DOMAIN_SYNC_COMMITTEE, fork_version_at(epoch(signature_slot - 1)), genesis_validators_root)` (fixes R2-03 and H-04).
- Check the committee against `previousSyncCommitteeHash` (the hash tree root of the `SyncCommittee` container).
- Verify the finality branch from the attested header's state root (fixes H-08), the next-committee branch, and the execution payload branch from the finalized header's body root. The generalized indices differ by fork: Capella and Deneb use one set, Electra and later another. Read them from `ethereum/consensus-specs`.
- Hash the `ExecutionPayloadHeader` with the field list of the header's fork (Capella has no blob fields, Deneb and later have them).
- Return the output tuple in the exact ABI layout above, with an `abi_encode` that matches Solidity byte for byte.

### Withdrawal program: `verify_withdrawal(witness, expected_source_vault) -> WithdrawalOutput` (removed)

No withdrawal program exists. The native reference check is now `lc_core::message::verify_message`, the twin of `MessageBridge.executeMessage`. The text below is the first design.

- Ancestry: the light client stores only one execution block per update, so the deposit block is proven against a finalized anchor. Path: the anchor's state root, then `state.block_roots` (the deposit slot must be within 8192 slots before the anchor), then the deposit beacon header, then its execution payload branch, then `keccak256(header_rlp) == deposit_block_hash`. Older deposits use the historical path through `historical_summaries`; see "Change: historical ancestry and folded updates".
- The verifier argument of both contracts is a specific versioned SP1 verifier, never Succinct's ownable gateway. Decode the header for both Ethereum (Prague fields) and PulseChain (Shanghai fields).
- Prove the receipt with `alloy_trie::verify_proof(receipts_root, Nibbles::unpack(rlp(tx_index)), Some(receipt_bytes), proof)` (fixes R2-04).
- Decode the receipt as an EIP-2718 envelope (fixes R2-05) and require success status.
- Take the log at the witness's `log_index` (fixes R2-06). Require `log.address == expected_source_vault` and `topic0 == DEPOSIT_EVENT_TOPIC`, computed from an alloy `sol!` event declaration, never hardcoded (fixes R2-02).
- Decode token, sender, recipient from topics, and amount, nonce, target chain, destination vault from data.

### Tests

- Real data: verify real Ethereum light-client updates and real PulseChain sync-committee signatures fetched from public beacon APIs, saved as fixtures under `light-client/tests/fixtures/`. Prove real type 0 and type 2 receipts from both chains.
- Tampering: flip a signature bit, use the other chain's fork version or genesis validators root (cross-chain replay, H-01), drop to 341 participants, corrupt each branch, use the wrong fork's generalized index, submit an unfinalized header, use a log from another emitter, use a wrong log index.
- Synthetic: where real PulseChain data cannot be fetched (for example the finality branch, because the light-client endpoints return 404), build Capella-layout fixtures with a test-only state builder and generated keys.

## Harness (`harness/`)

**Decision (2026-10-20):** the hardened two-chain tests live in Rust, in `prover/tests/`, on the prover's existing two-Anvil setup. The prover is the reference prover, so this avoids a second stack and a fresh Node install on a nearly full disk. `harness/` keeps the red-team tests against revision 1. The list below still defines what the hardened tests must cover. Chain A (id 1) runs `cancun`, so EIP-4788 exists; chain B (id 369) runs `shanghai`.

- Chain B (the PulseChain role, id 369) runs Anvil with `--hardfork shanghai`. Chain A (id 1) keeps `prague`.
- Add hardened tests under `harness/test/hardened/` on two Anvil chains: the happy path both ways, the fake emitter (H-02), the same-address token (H-03), an unfinalized block after a reorganization (H-08), cross-chain replay of a light-client output (H-01), a deposit and withdrawal with a second deposit in the same transaction (R2-06), a typed receipt (R2-05), the deploy procedure with predicted addresses (R2-08), and `MCOPY` bytecode failing on chain B while the Shanghai build works (R2-10).
- The reference light-client prover models finality: it emits a `LightClientOutput` only for a block that is at least a fixed number of blocks deep, and it signs with the oracle key.

## Prover service (`prover/`)

**Decision (2026-10-24):** the repository makes proofs and hands them to other, stateful servers. Those servers store the proofs and act on them. The crate `prover/` was a full relayer. It watched deposits, kept a SQLite file, sent every transaction and ran its own checks of route health. It now holds only the part that makes proofs. The full relayer lives on the branch `archive/full-relayer`.

Several sections below were written for the relayer. Where they name the service loop, the database, the deposit states, `follow`, `route-health`, the own-chain light client updater, the flow limiter wait or the submission of a fork observation, they describe the relayer of that branch. A stateful server now does that work (see "Launch sequence"). The same holds for the tests `prover/tests/hardened_*.rs` and `prover/tests/anvil_end_to_end.rs`, which these sections name: they are Anvil tests of the relayer, and they live on that branch too. The forge tests under `test/hardened/` stay in this repository.

A Rust binary that makes proofs. It holds no trusted role: every proof it makes is checked on chain, so a faulty or hostile producer can only fail to deliver, never steal. Anyone can run one. It keeps no state, holds no key for a wallet and sends no transaction.

### Responsibilities

1. **Make a light-client proof (`prove`).** Read the head, the committee hashes and the program key from the destination light client, or take an explicit starting head. Fetch the updates from that head to the newest final header (a fold of up to 64 updates). Run `verify_light_client_update` natively. Get the proof from the backend. Check the public values against the native run, the shape of the proof and the program key. Hand the result off: one JSON object on standard output, a webhook, or both.
2. **Build withdrawal evidence (`evidence`).** For a deposit that the caller names by the hash of its source transaction and the index of its log, build the calldata of `MessageBridge.executeMessage` and the calls that add the missing layout rows. Run `verify_message` natively against the stored anchor. Print one JSON object (the vault version called `BridgeVault.withdraw` and `verify_withdrawal`).

Exit codes of `prove`: 0 for a proof, 3 when the light client already holds the newest final header, 1 for an error.

### Proving backends (one trait, `Prover`)

- `OracleProver` (development and tests): runs the program natively first and refuses to sign when it fails. Then it signs `keccak256(programVKey ‖ sha256(publicValues))` with the oracle key, which `OracleSP1Verifier` accepts. This models a sound proof system. The key comes from an environment variable that the configuration names.
- `Sp1Prover` (production): behind the cargo feature `sp1`, off by default. It calls the official `sp1-sdk` crate 6.8.1 on the local processor, with Groth16 proofs. It never uses the Succinct prover network. See `docs/server-prover.md`.
- `RemoteProver`: sends the job to a worker on a GPU host and checks the answer. See `docs/gpu-prover.md`.

### Beacon source

- `HttpBeaconSource`: a standard beacon API. Uses the light-client endpoints when the node serves them. Otherwise it assembles the update from block, state and committee endpoints. PulseChain's public node returns 404 for the light-client endpoints, so this path matters.
- The tests run it on a signed beacon chain over local blocks (`prover/src/local_network/signed_beacon/`), whose committee signs for real.

### Interface

- Configuration file (TOML) plus environment overrides: the proving backend, the handoff targets, and for each route the source beacon API, the destination chain, its RPC URL and its light client. A secret never enters the file. The file names the environment variable that holds it.
- Subcommands: `prove` and `evidence`. See `prover/README.md` for the flags and the shape of both results.
- Logs: structured, one line per event, on standard error. Standard output carries only the result.

### Tests

Unit tests for the configuration, the checks of the producer, the handoff and the stored state. Integration tests run the producer and the commands on a signed beacon chain, with the oracle backend, and against a fake worker with a real Groth16 proof. The tests of the old relayer, with two Anvil chains, are on the branch `archive/full-relayer`.

## Change: the vault verifies withdrawals directly (user decision, 2026-10-20)

The checks below now live in `BeaconProofVerifier` and `MessageBridge.executeMessage`. The calldata names `depositHeader` and `transactionIndex` became `sourceHeader`, `receiptIndex`, `transactionIndex` and the transaction branch of `MessageBridge.MessageProof`.

Nothing in a withdrawal is secret, and the evidence is a few kilobytes. So the vault checks it directly, and **the withdrawal program and its verification key are removed.** Only the light-client update (proof 1) uses SP1. A user's browser can build a withdrawal from public RPC and beacon data and submit it with no prover. This replaces the `WithdrawalOutput` section above.

### Calldata

```solidity
struct BeaconBlockHeader {
    uint64  slot;
    uint64  proposerIndex;
    bytes32 parentRoot;
    bytes32 stateRoot;
    bytes32 bodyRoot;
}

struct WithdrawalProof {
    BeaconBlockHeader anchorHeader;   // its hash tree root must equal lightClient.headers(anchorHeader.slot)
    BeaconBlockHeader depositHeader;  // the beacon block that carries the deposit's execution payload
    bytes32[] blockRootsBranch;       // anchorHeader.stateRoot -> state.block_roots[depositHeader.slot % 8192]
    bytes32[] blockHashBranch;        // depositHeader.bodyRoot -> body.execution_payload.block_hash
    bytes   executionHeaderRlp;       // keccak256 must equal the proven block hash
    bytes[] receiptProof;             // Merkle-Patricia nodes from receiptsRoot to the receipt
    uint256 transactionIndex;         // trie key = rlp(transactionIndex)
    uint256 logIndex;                 // index of the deposit log inside that receipt
}

function withdraw(WithdrawalProof calldata proof) external;
```

### Checks, in order

1. `hashTreeRoot(anchorHeader) == lightClient.headers(anchorHeader.slot)` and that value is non-zero. The light client stores only finalized headers, so the anchor is final.
2. `depositHeader.slot < anchorHeader.slot` and `anchorHeader.slot - depositHeader.slot <= 8192`.
3. `hashTreeRoot(depositHeader)` is the leaf of `blockRootsBranch` at `generalizedIndex(BeaconState.block_roots, slot % 8192)` under `anchorHeader.stateRoot`.
4. The execution block hash is the leaf of `blockHashBranch` at `generalizedIndex(BeaconBlockBody.execution_payload.block_hash)` under `depositHeader.bodyRoot`.
5. `keccak256(executionHeaderRlp) == blockHash`. Decode `receiptsRoot` from the header.
6. Verify `receiptProof` against `receiptsRoot` with key `rlp(transactionIndex)`. Decode the EIP-2718 receipt envelope. Require success status.
7. Take the log at `logIndex`. Require `log.address == remoteVault` and `topic0 == DEPOSIT_EVENT_TOPIC`. Decode token, sender, recipient, amount, nonce, target chain, destination vault. Require `targetChainId == localChainId`, `destinationVault == address(this)`, a registered token, an unclaimed nonce.
8. Mark the nonce, pay with `SafeERC20`, emit `WithdrawalCompleted(token, recipient, amount, nonce, depositBlockHash)`.

SSZ hashing uses the SHA-256 precompile (address `0x02`), which exists on both chains.

### Generalized indices depend on the source chain's fork

`BeaconState.block_roots` and `BeaconBlockBody.execution_payload` sit at different tree depths in different forks (Capella, Deneb, Electra and later). The vault takes the source chain's fork schedule as an immutable constructor argument: a list of `(activationEpoch, blockRootsGindexBase, blockHashGindex)` rows. It picks the row by each header's epoch. Take every value from `ethereum/consensus-specs` and cite it.

A future source-chain fork that moves these indices breaks new withdrawals. That failure is safe: proofs fail and nothing pays out, but deposits made after that fork wait for a redeployment. This is the immutability trade-off from H-19, and the documentation must say so plainly.

### Libraries

For Merkle-Patricia proofs and RLP decoding, prefer vendoring an audited implementation (for example Optimism's `MerkleTrie.sol` and `RLPReader.sol`, MIT licensed) at a release tag at least 28 days old, with the tag and commit recorded. Writing new parsers is a last resort and needs tests against real receipts from both chains.

### The light-client crate's role

`verify_message` (first `verify_withdrawal`) stays in Rust as the reference implementation and the proof builder. It produces the exact `MessageProof` calldata. A Rust test and a Solidity test run the same fixtures and must agree on accept or reject. No withdrawal guest program is built.

## Decision: source-chain forks (user decision, 2026-10-20)

**A permissionless, self-validating fork-layout table, plus versioned redeployment (option A).** No admin, no upgrade path, no time lock.

- **The vault's layout table is open to anyone.** `addForkLayout` accepts a row only when the chain's own stored data proves it. The `block_roots` position must map two stored header slots to the stored header roots, under a later stored state root. The `block_hash` position must map a stored header's body root to its stored execution block hash. Matching evidence is not enough on its own, because proposers write some state and body leaves freely (HB-03, HB-04). So each function also accepts only its field's own position, at the depths a future fork could plausibly produce:
  - `block_roots`: `2**d + 5`, and `historical_summaries`: `2**d + 27`, with d in {5, 6, 7}.
  - `block_hash`: `(2**db + 9) * 2**dp + 12`, with db and dp in {4, 5}.
  The evidence then only picks the depth.
- **A range never covers a slot of another position.** Each row holds the lowest and highest slot at which its position was validated. A new validation grows a range of the same position only when the grown range overlaps no range of another position. Otherwise it starts a new range. A validation at a slot that another position's range already covers reverts with `LayoutRangeConflict`. So ranges of different positions never overlap, and a lookup has at most one answer. An anchor in a gap has no layout, and its withdrawal reverts with `LayoutNotValidated` until anyone validates a position there. The rule keeps a position that was validated, replaced, and validated again from covering the slots of its replacement.
- **The light-client program takes the fork version as an input.** The committee signs the domain that contains it, so a wrong version yields no valid signature.
- **The program takes its layout from the evidence, so a fork that keeps one of the accepted layouts needs no new program** (superseded 2026-10-27, see "Change: the layout comes from the evidence"). The program accepts three layouts: plain depth 5 (finality branch of 6 entries), plain depth 6 (7 entries) and the Gloas progressive form (9 entries). It refuses every other length, depth 7 included. A new route (light client, program and vault pair) is needed only when a fork leaves these three: a plain state of 65 or more fields, or a new progressive form. The old route keeps paying out what it can still prove.
  Earlier text (superseded): "Merkle positions in the program move only when a container crosses a power-of-two field count. The beacon state crossed 32 fields at Electra (37); Fulu has 38; the next crossing is at 65." Gloas is progressive, so its positions no longer move with the field count.
- **Deposit cutoff.** Each vault takes an immutable `depositCutoffTimestamp` (zero disables it). After it, `deposit` reverts, so nobody deposits into a route whose counterpart may no longer prove. Set it at deployment only when a breaking fork is already scheduled.
- **Future work, not built:** a liveness gate that proves the counterpart light client's recent head through a storage proof of the other chain, so deposits stop automatically when the other direction stalls.

## Change: the layout comes from the evidence, not from the fork table (user decision, 2026-10-27)

Goal: Ethereum's Gloas activation, and PulseChain's adoption of Deneb or Electra, need no new program. Neither guest program chooses anything from the compiled fork table (`ChainSpec.fork_schedule`) that the evidence can decide. This replaces the fork-table rules of "Decision: source-chain forks" and the table-based parts of the light-client program above.

### Rule: state proofs follow the length of the finality branch

| Finality branch length | Layout | Finality, current committee, next committee |
|---|---|---|
| 6 | plain, depth 5 | 105, 54, 55 |
| 7 | plain, depth 6 | 169, 86, 87 |
| 9 | Gloas progressive | 735, 2945, 2946 |

- Every other length is refused (`UnsupportedStateBranchLength`), depth 7 (finality length 8, committee length 7) included (superseded: see 'Fork gate by shape (2026-10-27)'). On a chain that is truly depth 7, a wrong claim would land on a field that no specification defines yet.
- The next committee branch of the same step must have the depth of that layout (5, 6 or 11). Mixed lengths in one step are refused. Different steps of one fold may use different layouts.
- Branch checks are exact. The branch has exactly `floorlog2(gindex)` entries. A leading zero hash is neither stripped nor accepted. The length is the depth.
- The plain indices are computed from the depth: `2^d + field` and `(2^d + 20) * 2 + 1`.

### Rule: execution proofs follow the form byte, the payload form and the branch length

- The body has depth 4 in every layout. The positions are 25 (full header), 412 (Capella payload, depth 4) and 812 (Deneb and later payload, depth 5). The positions 41, 668 and 1324 are refused.
- The header form (full or compact) comes from the form byte of the wire format. It is not chosen by the fork of the slot.
- The payload field list (Capella with 15 fields, Deneb with 17) is named by the prover in the input (the blob flag of the payload header). The two root forms cannot collide: that would need a `uint64` or padding leaf to equal a hash.
- The Gloas compact anchor (`state.latest_block_hash`, index 2947, 11 entries, under the STATE root) is chosen by the branch length: 8 is 412, 9 is 812 (both under the body root), 11 is 2947. The keccak check of the header RLP against the proven block hash stays mandatory. It is the only guard for 2947 on a Capella or Deneb state, and for 412 on a Deneb payload.
- The attested header of an update is not read for execution data when it is compact with a state anchored branch (11 entries). Every other attested header gets the branch check.

### Rule: the signing fork version is an input of every step

- It is a private input, one per fold step and one for the observation (the fork observation program already took it). The committee signs a domain that contains the version, so two thirds of a bound committee signing under version V shows that the chain ran V. A wrong version gives no valid signature.
- The existing rules stay: the store binding, a signature slot after the attested slot, and a next-period signature needs a crossing.
- The prover may still read the fork schedule from a beacon node, but only to build inputs (`table_fork_version`). Nothing it supplies is trusted without the proof checks.
- `ChainSpec` keeps `fork_schedule` for code that does not run in a program: the ancestry and era helpers, the message proof builders and the input builders. No program path reads it.

### Why every allowed pair is safe

A claimed layout is tested against a true layout. Every allowed pair lands on a basic leaf, padding, a hash-only node or a fixed-shape container, where no honest branch reaches a chosen header root:

- True depth 5: 169 lands below `eth1_deposit_index`; 86 is the data root of the `validators` list (the aggregate key chunk cannot match); 87 is the `validators` length; 735 lands in `randao_mixes`; 2945 and 2946 land in `slashings`.
- True depth 6: 105 lands on a padding zero chunk; 54 and 55 land on zero-hash level 1; 735 lands below the `historical_summaries` length; 2945 and 2946 land below field 28 (`deposit_requests_start_index`).
- True Gloas: 105, 54 and 55 land below the `active_fields` chunk (node 3); 169 is `fork.current_version`; 86 and 87 are the children of `latest_block_header`.
- Execution: 812 on Capella lands below `block_number`; 412 on Deneb is caught only by keccak; 2947 on Capella or Deneb is caught only by keccak; 2947 on Electra or Fulu lands below a `uint64`; 412, 812 and 25 on Gloas land below `active_fields`.

### Public values and keys

The public values keep their layout: 352 bytes for the light-client program and 256 bytes for the observation (it was 224 bytes before the shape word was added; see 'Fork gate by shape (2026-10-27)'). Both verification keys change (`BeaconLightClient.programVKey` and `ForkRegistry.observationProgramVKey`). The keys are in `light-client/program-keys.json` and are pinned in `script/testnet/bridge.config.testnet.json` and `docs/sp1-version-policy.md`.

### Consequences to know

- A chain that moves to a plain state of 65 or more fields (depth 7) stops the bridge: honest updates have a finality branch of 8 entries, which the program refuses. This is the safe failure. A new route is then deployed. (superseded: see 'Fork gate by shape (2026-10-27)') Depth 7 is accepted now.
- On a true depth 7 state, a branch of 7 entries still reads field 41 at index 169. The guard is that no specification defines a proposer-writable field there, and that honest depth 7 updates are refused (superseded: see 'Fork gate by shape (2026-10-27)'). A test of a synthetic 70 field state shows a permissive selector accepting a forged header root at field 41, and the real rule refusing the honest update.
- `BeaconForkGate` keeps the seal depths 5, 6, 7 and the marker 255. A seal stops sends at a fork that the program cannot read, so depth 7 stays sealable (superseded: see 'Fork gate by shape (2026-10-27)'). A seal now needs plain depth 8 to 31.

## Change: historical ancestry and folded updates (2026-10-20)

Source: `docs/zkbridge-paper-review.md`. These two changes remove the need for an update in every 8192-slot window, and with it the 8192-slot head-jump cap. They replace the parts of the sections above that conflict.

### Ancestry: two paths, chosen by distance

`WithdrawalProof.blockRootsBranch` is renamed `ancestryBranch`. The vault picks the path from the two slots. The prover never picks it.

- **Recent path** (unchanged), when `0 < anchorSlot - depositSlot <= 8192`: leaf `hashTreeRoot(depositHeader)` at `blockRootsGindex(anchorSlot)` for `block_roots[depositSlot % 8192]`.
- **Historical path**, when `anchorSlot - depositSlot > 8192`:
  - `era = depositSlot / 8192`. Require `era >= capellaEra`. `index = era - capellaEra`.
  - The era is always complete at the anchor, because `(era + 1) * 8192 <= anchorSlot`.
  - Generalized index, built in this order:
    1. `g = historicalSummariesGindex(anchorSlot)` (the field's position in `BeaconState`)
    2. `g = g * 2` (list data root, past the length mix-in)
    3. `g = g * 2**24 + index` (`HISTORICAL_ROOTS_LIMIT = 2**24`)
    4. `g = g * 2 + 0` (`HistoricalSummary.block_summary_root`)
    5. `g = g * 2**13 + depositSlot % 8192` (into that era's `block_roots`)
  - Branch lengths are exact. Padding is refused, as on the recent path.
- **`capellaEra`** is an immutable vault constructor argument: `floor(capellaForkSlot / 8192)`. Expected values: Ethereum 758 (Capella slot 6209536), PulseChain 0 (Capella epoch 3, slot 96). The deploy script reads the Capella epoch from each chain's spec and refuses a mismatch.
  - Confirmed on real PulseChain data (2026-10-20): `historical_summaries[era - capellaEra].block_summary_root` equals the hash tree root of the era's 8192 block roots for eras 0 (Capella starts mid-era at slot 96), 1325 and 1326. The anchor is a real state at slot 10875900. Fixture: `light-client/tests/fixtures/pulsechain/historical_paths.json`. Ethereum is not yet checked on real data.
- **Layout row:** add `addHistoricalSummariesLayout`, validated like the block-roots row:
  - The evidence is a stored header in a completed era, proven at the claimed position under a later stored anchor's state root.
  - The row is usable over the slot range its evidence covers.
  - Add a rejection test for every state field that also holds a block root (`block_roots`, `finalized_checkpoint.root`, `latest_block_header`), and for a wrong list depth.
  - Expected field positions: take them from `ethereum/consensus-specs`, cite them, and add them to `gindices.json`. `historical_summaries` is field 27 in Capella through Fulu.

### Folded updates

The light-client program accepts a list of 1 to 64 updates. It applies `verify_with_layout` step by step, carrying the store. Each step keeps every existing rule, including "a next-period signature needs a crossing".

`LightClientOutput` gains one field, after `previousSyncCommitteeHash`:

- `startNextSyncCommitteeHash`: the hash of the initial store's next committee, or zero if the store has none. This binds the private starting next committee. If the store has none, the first crossing must come after a step that proves it.

The other fields:

- `previous*` describe the initial store.
- `new*`, `executionBlock*` and `syncCommitteeHash` describe the final store.
- `nextSyncCommitteeHash` is the final store's next committee, but only if a step in this fold proved it. Otherwise it is zero.

The public values grow from 320 to 352 bytes.

The prover uses the fold to catch up a light client that lags by several sync committee periods: the committee handoff update of each period, then the latest finality update, in one proof of at most 64 updates. A longer catch-up goes in successive proofs. When the contract holds a next committee, the initial store of the proof must carry it. See `prover/README.md`, "Catching up a light client that lags".

### Contract rules (replace the earlier committee rules)

1. `previousSyncCommitteeHash == syncCommittees[headPeriod]` and `startNextSyncCommitteeHash == syncCommittees[headPeriod + 1]`. Zero equals zero.
2. `newHeadSlot > headSlot`. There is no jump cap, and `slotsPerHistoricalRoot` is removed from the constructor.
3. `newPeriod == headPeriod`: `syncCommitteeHash == syncCommittees[headPeriod]`.
4. `newPeriod > headPeriod`:
   - If `syncCommittees[newPeriod]` is stored, the two must be equal.
   - If it is empty, write `syncCommitteeHash`. The program proved the chain of handoffs from the bound start.
5. `nextSyncCommitteeHash` keeps its rule: zero changes nothing. A non-zero value must equal a stored `syncCommittees[newPeriod + 1]`, or it fills an empty one.

### Builders

- `lc-core` builds both ancestry paths.
- The prover service needs two extra inputs for an old deposit:
  - the anchor state's `historical_summaries` branch;
  - the era's 8192 block roots. Rebuild them from the node's canonical block roots. Do not take them from an old state: on 2026-10-20 the PulseChain node served states older than a few hundred slots without their newest `historical_summaries` entry, so their roots did not match their headers. Fetch the anchor state while it is near the head.
- After a crossing, a next committee proven in an earlier period no longer counts as the next committee, because the crossing makes it current. A proof followed only by steps that do not cross still counts.
- If the contract stores a next committee, the prover's initial store must carry it. Otherwise `startNextSyncCommitteeHash` is zero and rule 1 refuses the update.

## Fork gate on the Ethereum vault (HB-02, 2026-10-20)

The `MessageBridge` takes the place of the vault. Its send calls `admit("")` with empty evidence, and there is no way to pass evidence through a send. See "Gate evidence: confirm, then send" at the end of this file. Read "vault" in this section as "message bridge", and "deposit" as "send".

The Ethereum vault refuses a deposit unless the chain's current fork version is one its route supports. This closes HB-02 window 1 on Ethereum. Window 2 (the epochs before activation) is the interface's job; see `docs/red-team-revision-2.md`, HB-02.

### Shape

- New interface `IDepositGate { function admit(bytes calldata evidence) external; }`. The vault takes an immutable `depositGate` and calls `admit(evidence)` first in `deposit`. A gate that reverts refuses the deposit.
- `deposit(address token, address recipient, uint256 amount, bytes calldata gateEvidence)`. The new last argument changes the selector.
- One contract, `BeaconForkGate`, deployed on both chains. The vault constructor refuses a zero gate address.
- **Detection mode (PulseChain, which has no EIP-4788 today).** Each `admit` first probes `beaconRoots.staticcall(abi.encode(block.timestamp))`. If the call fails, or returns anything other than 32 non-zero bytes, the beacon-root contract is absent and the gate admits the deposit. Measured cost: about 745 gas per deposit. A deposit that reverts also undoes a switch to enforcing made in that same call; the next deposit detects again. When the probe returns a root, the gate switches itself to enforcing mode for good (`enforcing = true`, event `BeaconRootsDetected`), and the same call continues as an enforcing `admit`.
- **Enforcing mode (Ethereum from deployment, PulseChain after detection).** The rules below apply.
- **Why no admin key (user proposal, 2026-10-20).** The user proposed a self-destructing admin key that turns the gate on once PulseChain adopts EIP-4788. The probe gives the same switch with no key:
  - A key could turn the gate on too early and halt deposits forever, because the switch is one-way. It could also be lost, and then the gate would never turn on.
  - The probe cannot be spoofed. Only the protocol writes roots, through the system address `0xfffffffffffffffffffffffffffffffffffffffe`. A replay of the keyless deployment of the genuine code on PulseChain leaves its storage empty, so every read reverts and the gate stays in detection mode.
- **Expected effect on PulseChain.** EIP-4788 can only arrive through a PulseChain fork, which the route's program does not know. So the first deposit after that fork detects the beacon-root contract, finds an unsupported version, and reverts. Anyone can then call `seal`. The old route closes itself at the fork. A PulseChain fork that does not bring EIP-4788 is not covered; only the interface cutover protects it.

### `BeaconForkGate`

Immutable configuration, checked against the chain spec by the deploy script:
- `beaconRoots`: `0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02` (EIP-4788);
- `genesisTime`, `secondsPerSlot` (12), `slotsPerEpoch` (32);
- `supportedVersions`: a list of `(bytes4 version, uint8 stateDepth)` pairs. The depths must lie in the set of layouts that the light-client program accepts (5 and 6, and the marker 255 for Gloas), and a test compares the two sets. The program has no fork table. Expected values: Capella `0x03000000` depth 5; Deneb `0x04000000` depth 5; Electra `0x05000000` depth 6; Fulu `0x06000000` depth 6. Take each depth from `ethereum/consensus-specs` and cite it.
- `sealDepths`: the depths allowed for a seal proof, namely 5, 6 and 7. Depth 7 covers a future fork that crosses 64 state fields. The value 255 (`PROGRESSIVE_STATE_DEPTH`) also stands for a progressive state (see below).
- Gloas. The Gloas `BeaconState` is a progressive container, so the version leaf is at the fixed index 169 (7 siblings), not at the depth formula. A supported version with `stateDepth` 255 uses that index. A seal proof of 7 siblings is also tried at 169 when 255 is in `sealDepths`. Config values 0 and 32 to 254 stay refused.

Immutable mode: `Enforcing` (Ethereum) or `DetectBeaconRoots` (PulseChain), from a configuration enum, not a boolean.

State:
- `enforcing` (set at deployment in `Enforcing` mode; set once by detection otherwise; never cleared);
- `confirmedEpoch` (one storage slot);
- `sealed` (one storage slot; once set, never cleared).

`currentEpoch = (block.timestamp - genesisTime) / secondsPerSlot / slotsPerEpoch`.

`admit(evidence)`:
0. If not `enforcing`, run the probe. An absent beacon-root contract admits the deposit. A present one sets `enforcing` and continues.
1. If `sealed`, revert `GateSealed()`.
2. If `confirmedEpoch == currentEpoch`, return. Most deposits stop here, at the cost of one storage read.
3. Otherwise decode `evidence` as a `ForkEvidence { uint256 timestamp; BeaconBlockHeader header; bytes4 version; bytes32[] branch; }` and call `_confirm`:
   - `root = beaconRoots.staticcall(abi.encode(timestamp))`. It must succeed and be non-zero. The beacon roots contract reverts for a timestamp outside its 8191-entry ring buffer.
   - Require `hashTreeRoot(header) == root` and `header.slot / slotsPerEpoch == currentEpoch`.
   - `version` must be in `supportedVersions`, and the branch length must match its depth.
   - Verify that `version`, right-padded with zeros to 32 bytes, is the leaf at generalized index `((2**depth + 3) * 4) + 1` under `header.stateRoot`. That is `BeaconState.fork` (field 3), then `Fork.current_version` (field 1 of 3, depth 2).
   - Store `confirmedEpoch = currentEpoch`.
4. Empty evidence with an unconfirmed epoch reverts `ForkNotConfirmed(currentEpoch)`.

Anyone may also call `confirm(evidence)` directly. It runs the same checks without a deposit, for keepers.

`seal(evidence)`: the same proof, except that `version` must NOT be in `supportedVersions` and the depth must be in `sealDepths`. There is no epoch rule, but `header.slot` must be at least the larger of the deployment slot and the highest header slot that a confirmation accepted, else it reverts `SealEvidenceTooOld(slot, minimumSlot)`. Fork versions only move forward, so this stops an old header that the ring buffer still holds from sealing the gate. It sets `sealed = true` and emits `GateSealedByFork(version, header.slot)`.

### Why this is sound

- The gate computes the generalized index itself. The caller cannot point it at `Fork.previous_version`; if it could, a proof of the previous version would wrongly seal the gate before any fork.
- Fork versions change only at an epoch boundary. A proof from a header in the current epoch therefore shows the version of the block the deposit lands in.
- A wrong depth lands inside a leaf field or a fixed-shape container, so the proof needs a SHA-256 preimage. Test this for every depth pair.

### Costs and limits

- The first deposit in an epoch pays for the proof: about 30,000 to 40,000 gas, mostly calldata and one storage write. Later deposits in that epoch pay about 3,500 gas for the gate call and its storage read (measured).
- Deposits fail when no beacon block exists yet in the current epoch. That happens in the first slot of each epoch, and after missed slots. The interface should wait one slot.
- The proof needs a beacon state branch. Some beacon clients serve state proofs. Otherwise the prover service computes the branch from the state and serves it. A dedicated keeper can call `confirm` each epoch. That costs about 225 transactions a day, so on-demand confirmation by the first depositor is the default.

### Tests

- Every revert, with its exact error.
- A confirmation in epoch E admits later deposits in E, but not in E+1.
- A header from the previous epoch is refused.
- A proof of `previous_version` neither confirms nor seals.
- A wrong depth is refused for every pair of depths.
- A seal with a supported version is refused, and a seal with an unknown version blocks all later deposits.
- Withdrawals still work after a seal.
- A timestamp outside the ring buffer is refused. Use a mock at the EIP-4788 address in unit tests, and the real system contract in the harness.
- Detection mode:
  - It admits deposits when there is no code at the address.
  - It admits deposits when the genuine runtime code has empty storage (use `vm.etch`). The probe must read this as absent.
  - It admits deposits when the code returns zero, short or garbage data.
  - It switches to enforcing for good once the mock returns a root, and then the same deposit needs evidence.
  - A seal in detection mode first requires a working probe.
- A test that the state depths of `supportedVersions` equal the layouts that the light-client program accepts (`program` in `gindices.json`: finality branch lengths 6, 7 and 9, so plain depths 5 and 6 and the progressive marker), and that each fork keeps its own depth and version. The seal depths stay wider (5, 6, 7): a seal stops sends at a fork that the program cannot read.
- The harness runs chain A (Ethereum) on a fork with EIP-4788 (Cancun or later). Chain B (PulseChain) stays on Shanghai, so its gate stays in detection mode. A second harness case runs chain B on Cancun to show detection, enforcement and the seal on a real beacon-root contract.

### Interface cutover (HB-02 window 2)

- The interface reads `/eth/v1/config/fork_schedule` from each source chain. It stops offering a route one hour before the activation epoch of any fork whose version the route does not support, never less than three epochs before.
- It shows the gate's state, and it builds the gate evidence when `confirmedEpoch` is stale.
- This is advisory. The documentation must state that a direct contract call in that window can strand funds.

## Fork observation registry (HB-02 on PulseChain, 2026-10-20)

PulseChain has no EIP-4788, so its vault cannot read its own beacon state. This registry gives the PulseChain gate a proven view of PulseChain's current fork version without an admin. Build it after the two-chain tests are committed.

### Why a signature proves the fork version

The sync committee signs `compute_signing_root(attested_header, domain)`, where the domain is built from the fork version of the signature epoch and the genesis validators root. An honest committee signs only under the chain's real current version. So two thirds of a bound committee signing under version V proves the chain runs V at that slot. The proof needs no state layout, only the signature over a header root. That means a program that does not know V's layout can still prove that V is active.

### Program: `guests/fork-observation`

- It is separate from the light-client program and has its own verification key, so one kind of output can never pass for the other.
- **Input:** a store; zero or more fold steps under known versions; then one observation of the form `{ attestedHeaderRoot, signatureSlot, syncAggregate, forkVersion }`.
- **Check:** the fold steps follow every existing rule, including HB-01. The observation's signing committee is the current committee of the final store, or its proven next committee after a crossing, under the same "a next-period signature needs a crossing" rule. It needs at least 342 of 512 signers. It needs `signatureSlot > finalStore.headerSlot`. It needs a valid BLS `FastAggregateVerify` under `compute_domain(DOMAIN_SYNC_COMMITTEE, forkVersion, genesisValidatorsRoot)`.
- **Output (`ForkObservation`):** `genesisValidatorsRoot`, `previousHeaderRoot`, `previousHeadSlot`, `previousSyncCommitteeHash`, `startNextSyncCommitteeHash`, `observedVersion`, `observedSignatureSlot`.
  - The first five bind the starting store exactly as `LightClientOutput` does.
  - No head moves: the observation never feeds the light client.

### Contract: `ForkRegistry`

- **Immutable:** `lightClient` (the light client of the observed chain, on this chain), `verifier`, `observationProgramVKey`.
- `observe(bytes proof, bytes publicValues)`, open to anyone:
  - It verifies the proof.
  - It applies light-client rule 1 to the five start fields against `lightClient`: header root, head slot, current committee, and the stored next committee, where zero equals zero.
  - It requires `observedSignatureSlot > lightClient.headSlot()`. This freshness rule blocks a replay of an old signature, for example one from the Bellatrix era, which could otherwise seal a gate falsely.
  - It records `firstSeenSlot[observedVersion] = min(existing, observedSignatureSlot)` and `latestObservedVersion`, the version with the highest slot seen, then emits `ForkObserved(version, slot)`.
- `latestObservedVersion()` and `firstSeenSlot(version)` are views. Entries are only added or moved earlier, never removed.

### The PulseChain deployment

- A light client of PulseChain is deployed on PulseChain itself. It is the same `BeaconLightClient`, verified by the same SP1 verifier the route already needs on PulseChain for deposits from Ethereum. Anyone updates it with the same proofs as the copy on Ethereum.
- If it goes stale, an observation proof folds forward from its stored committee. The prover service still keeps it current, because a stale head makes old observations look fresh. See "Own-chain light client freshness".
- **Gate mode:** add `DetectBeaconRootsAndRegistry` to the gate's mode enum, and give the gate an immutable `forkRegistry`. Every `admit` refuses when `latestObservedVersion` is set and is not in `supportedVersions`. `seal()` with no evidence succeeds in that state, so anyone can seal by pointing at the registry. Beacon-root detection stays as before.

### What it closes and what it leaves

- **Window 1 on PulseChain:** the gap shrinks to the time between activation and the first observation proof. That is minutes when the prover service watches for it: `route-health` sees the activation and triggers the proof. On Ethereum, EIP-4788 stays the zero-gap mechanism.
- **Optional liveness rule, off by default (user decision):** the gate also refuses deposits when the PulseChain-side light client's head lags the wall clock by more than N epochs. This closes the remaining gap, at the cost of an update about once an epoch, roughly 270 transactions a day at about 300,000 gas each. It fails safe: if nobody updates, deposits pause and no funds are stranded.
- **Window 2:** still the interface's job. The fork schedule is not on chain anywhere.

### Tests

- **Program:** each item below is an attack with a control.
  - An observation under a version outside the program's table is accepted, and its output names that version.
  - 341 signers fail.
  - A wrong committee fails.
  - A signature at or before the final head fails.
  - A next-period signature without a crossing fails.
  - The other chain's genesis validators root fails.
  - Folding forward from a stale store works.
- **Contract:**
  - The start fields must match.
  - Freshness is enforced.
  - The minimum first-seen slot is kept.
  - An observation proof cannot be passed to `BeaconLightClient.update`, and a light-client proof cannot be passed to `observe`, because the verification keys differ.
- **Gate:** an unsupported observed version refuses deposits and allows `seal()`. A supported observed version changes nothing.
- **Two chains:** on chain 369, observe an unsupported version, then a deposit reverts, then anyone seals, then withdrawals still work.

## Execution canaries in the gate (HB-02, 2026-10-20)

A PulseChain consensus fork almost always arrives with an execution fork, and the EVM can detect its own upgrades. The gate's detection mode widens from "the EIP-4788 contract answers" to a list of canaries. The first canary that works switches the gate to enforcing for good. No gap, no proof, no keeper, no admin.

- **Canaries:**
  - opcodes: `TSTORE` (0x5d), `MCOPY` (0x5e), `BLOBBASEFEE` (0x4a), `CLZ` (0x1e);
  - precompiles: the BLS12-381 precompiles from `0x0b` (call one with a known valid input and require the known output);
  - the EIP-4788 probe that already exists.
  Cite each opcode and address from its EIP.
- **Opcode probe:** one tiny immutable contract (`opcodeProbe`, deployed by the gate constructor) serves all four opcodes. The first byte of the calldata picks the path: 1 is `TSTORE`, 2 is `MCOPY`, 3 is `BLOBBASEFEE`, 4 is `CLZ` (the enum index plus one). A path runs its one opcode and returns the word 1. Any other selector, and empty calldata, reverts. The gate calls the probe once per opcode, in enum order, with at most 400 gas (`PROBE_GAS`). The costliest path needs 167 gas, measured. Before the fork, the opcode is invalid, that call fails, and only its forwarded gas is lost. Each call runs one path alone, so a missing opcode fails only its own call and no result depends on another path. A bytecode scan test requires exactly one of each of the four opcodes in the probe and none in the gate.
- **Switch:** if any canary succeeds, the gate sets `enforcing`. On PulseChain, enforcing needs EIP-4788 evidence or a supported version in the observation registry, so deposits refuse until a new route is in place.
- **False positive:** an execution-only change that leaves the consensus version alone would also trip a canary. It fails closed: deposits into that route stop, and users move to a new route. No funds are stranded.
- **Not covered:** a fork that changes only consensus and nothing the EVM can see. The fork observation registry covers that case.
- **Order of defence:**
  1. canaries, for the first block of most forks;
  2. the observation registry, for consensus-only forks, within minutes;
  3. the interface and `route-health`, for the window before activation.
- **Liveness rule:** dropped as unnecessary, unless the user asks for it.
- **Tests:**
  - On a Shanghai chain, every canary fails and deposits are admitted.
  - On a Cancun chain, `TSTORE` and `MCOPY` fire and the gate enforces.
  - With a BLS precompile mock, the precompile canary fires.
  - Gas per deposit before the switch, with a bound. With one probe, a cold deposit before the switch costs 85,463 gas, which is 9,827 over the plain deposit (75,636 in this run). The four-probe design cost 91,628, which was 16,272 over its plain deposit (75,356). The cold deposit is 6,165 gas cheaper. `admit("")` alone, all accounts cold, costs 15,062 (was 21,507). The saving comes from three fewer cold account accesses (2,600 each), less the dispatch and the three warm calls.
  - Each opcode path runs alone, an unknown selector fails, and the first canary in enum order wins.
  - A probe that consumes all forwarded gas still costs at most the bound.
- **Decision (2026-10-22): probe on every deposit.** The code review asked whether the canaries could run less often, for example once per block or only in `confirm` and `seal`. They stay on every deposit. The probes exist to catch the first deposit after a fork; probing less often would admit the deposits made in that gap, which are the ones that lock. The cost is about 9,800 gas on a cold deposit before the switch, and nothing after it.

## Protocol fee (removed, user decision 2026-10-26)

The `TokenMediator` takes no fee. The fee schedule of 2026-10-25 is deleted: the library `FeeSchedule.sol`, the six fee immutables, `currentFeeRate`, `feeRateAt`, `FeeCharged`, `accruedFees` and fee collection, and the `fee` block of the deploy configuration. A relay locks or burns exactly the value that it takes in, and a delivery pays out exactly the value that the message carries, so `mediatorBalance` moves by that value alone. The only fee in the system is the voluntary delivery tip of `DeliveryRouter`, which a sender writes into the callback data of a transfer. Gas of the mediator paths fell by about 750 to 980 gas.

## Destination token binding (code review finding)

Retired with the vault. The mediator computes the bridged copy of a native token from the home chain and the token (`CREATE2`), so no table exists that two contracts could keep in different states. The mediator trusts one remote mediator and one message bridge, and the handlers check the source chain.

Before this change, `withdraw` mapped the token of the remote log through the local table only. Two vaults with different tables paid the wrong token.

- **Event:** `DepositInitiated` has a new last field, `destinationToken`. The source vault sets it to `remoteTokenOf[token]`, the token that it expects the destination vault to pay.
- **Withdraw:** the vault reads the token of the log, maps it to its local token, and requires `destinationToken` to equal that local token. Otherwise it reverts with `WrongDestinationToken(expected, actual)`. `expected` is the local token, and `actual` is the token in the log.
- **Order of checks:** target chain, destination vault, registered remote token, destination token, claimed nonce.
- **Decoders:** the log data is 160 bytes. A log of the older 96-byte or 128-byte shape is malformed. The Rust decoders in `prover/src/light_client.rs` and `light-client/crates/lc-core` read the new field. The reference function `verify_withdrawal` reports it as `destination_token`. It does not compare it, because the token table is vault state.
- **Fixtures:** `generate_receipts.py` and `write-withdrawal-fixtures` write the new field. The receipt fixtures name `DESTINATION_TOKEN` (`0x99…99`). The tests deploy their destination token at that address.
- **Test:** `test_destinationToken_asymmetricTablesRefuseTheDeposit` rebuilds the destination vault with a table that maps the remote token to another local token. The withdrawal reverts with `WrongDestinationToken`, and nothing is paid. The symmetric vault pays the same deposit. With the check removed, the test fails.

## Verifier pinning in the deploy script (comparison finding)

The script used to check only that the verifier address has code. An address with other code would pass.

- **Config:** each chain has a `verifierCodeHash` field. It is the `extcodehash` that the operator expects, for example from `cast codehash <verifier> --rpc-url <chain>`. The field must not be a placeholder or zero.
- **Check:** `assertChainEnvironment` compares `verifier.codehash` with the field. A difference reverts with `VerifierCodeHashMismatch(chainId, verifier, expected, actual)`.
- **Timing:** the check runs before the script broadcasts anything, in `_inspectChain` and again at the start of `deployChain`.
- **Fee fields:** each chain also has a `fee` object with `recipient`, `startRate`, `stepRate`, `floorRate` and `stepPeriodSeconds`, all decimal strings. Rates are integers scaled by `1e18`. The example config sets Ethereum to zero everywhere (no fee, and a zero recipient is allowed only then) and PulseChain to 1e15, 1e14, 5e14 and 31536000 with a placeholder recipient. The script reads every fee field back from each mediator after deployment.
- **Tests:** `test/hardened/DeployBridge.t.sol` has a passing case, a case with a wrong hash, and a case with other code at the pinned address. `prover/tests/hardened_deployment.rs` runs the script against two live chains. The honest run uses the real hashes and passes. A run with a wrong hash on either chain stops before any transaction.

## Clock bound on the head (comparison finding G-04)

Before this change, a dishonest committee could store a head far in the future. The head only moves forward, so no honest update could follow. The route would stop for good.

- **Constructor:** `BeaconLightClient` takes two new immutable arguments, `genesisTime` and `secondsPerSlot`, after `slotsPerPeriod`. A zero value reverts `ZeroValue("genesisTime")` or `ZeroValue("secondsPerSlot")`. Both are public views.
- **Rule 2a:** `update` requires `newHeadSlot <= currentSlot`. The check runs right after rule 2 (the head moves forward), and before the proof check. Otherwise it reverts `HeadInFuture(uint64 newHeadSlot, uint64 currentSlot)`.
- **Formula:** the library `src/hardened/BeaconClock.sol` holds it: `(block.timestamp - genesisTime) / secondsPerSlot`, and zero before genesis. The deposit gate uses the same function for its deployment slot.
- **Limit:** the check bounds the head by the clock of the chain that runs the contract. It does not stop a forged head at a slot that is not in the future.
- **Deploy script:** each `lightClient` block and the `observation` block hold `genesisTime` and `secondsPerSlot`. The script reads them back after deployment. A light client tracks the other chain, so its clock must equal the clock in the `gate` block of the other chain. A difference reverts `ClockMismatch`. The `observation` block must equal the light client that tracks the same chain, else `ObservationMismatch`.
- **Gas:** `update` costs 329 gas more (87,111 against 86,782 for the first update, 81,819 against 81,490 for later updates).
- **Tests:** `test/hardened/BeaconLightClient.t.sol` has a head one slot ahead (refused with the exact error, at the last second of the slot), a head at the current slot (accepted), a head far ahead followed by an honest update, a clock before genesis, and the zero constructor values. With the check removed, the three refusal tests fail. `test/hardened/DeployBridge.t.sol` covers the clock checks of the script.
- **Program:** the light-client program cannot read a clock. The comment in `light-client/crates/lc-core/src/update.rs` now says that the contract enforces the check.

## Own-chain light client freshness (comparison finding)

On PulseChain, the fork registry checks freshness and the start of an observation against a light client of PulseChain on PulseChain. Nothing updated it. Its head stayed at the deployment checkpoint. Old observations looked fresh. After 64 updates of lag, one proof can no longer catch up, and the beacon node keeps only a limited history of updates.

- **Config:** each chain section of the prover configuration takes an optional `own_light_client`. It is the light client of that chain's own beacon chain, on that chain. The environment variables `ZK_BRIDGE_PROVER_CHAIN_A_OWN_LIGHT_CLIENT` and `ZK_BRIDGE_PROVER_CHAIN_B_OWN_LIGHT_CLIENT` set it.
- **Loop:** a route that reads deposits from a chain with this setting sends one update per pass to that light client. The update comes from the same beacon source and the same program as the update for the other direction. Only the chain differs. The source chain client signs for this.
- **One update per pass:** the chain keeps finalizing, so a loop that chases the newest header would not end. A head far behind catches up one update per pass.
- **Failure:** a failed update logs `own_light_client_update_failed` and never stops a deposit. A pass that sent one logs `own_light_client_updated`.
- **Startup check:** the service reads the contract and requires the same program key as the route. It also requires the same genesis validators root as the light client on the other chain, because both track the source chain.
- **Route health:** `route-health` prints `own_light_client`, `own_light_client_head_slot` and `own_light_client_lag_periods`. The lag is the current slot from the wall clock, minus the head slot, divided by the slots per period from the contract. The JSON has an `own_light_client` object, or `null`.
- **Rule: WARN, not STOP.** The status is `WARN` when the lag reaches `--own-light-client-warn-periods`. The default is 32, half of the fold limit of 64 updates. A deposit made now does not depend on this light client. `STOP` would make scripts refuse deposits on a route that still delivers them. The cost of a stale head is a weaker registry and a harder catch-up. The operator can fix both, and the warning comes with time to spare.
- **Tests:** unit tests cover the threshold, the clock source, the precedence and the output. `prover/tests/hardened_own_light_client.rs` runs two Anvil chains. The head moves with each pass. The registry refuses the fixture observation as a replay after the move (`ObservationNotFresh`), and accepts an observation built from the new head, which the stale head refused (`PreviousHeadSlotMismatch`). A light client of another beacon chain is refused at startup.

## Flow limiter hook (user decision, 2026-10-21) (built)

Moved to `TokenMediator` on 2026-10-24. The mediator calls `checkDeposit` on a relay and `checkWithdrawal` on a release (the nonce argument is the message identifier). A refused release is recorded in `claimable` instead of reverting, because delivery of a message is final (superseded: there are no `claimable` balances now. A refused release emits `ReleaseFailed` and the mediator keeps the tokens. See the no-claims decision of 2026-10-27). `detachFlowLimiter` stays. No limiter is attached by default.

The user asked for a hook for flow limits that can be nullified, with the rules held by an immutable contract. The user will supply the limit rules later. This section defines only the hook.

### Rules

- **One optional limiter.** The vault takes a constructor argument `flowLimiter`. A zero address means no limiter from the start. Nothing can set or replace a limiter after deployment.
- **The limiter governs itself.** Any rules, parameters or governance live in the limiter contract, which has no upgrade path. The vault trusts the limiter only to say yes or no.
- **One-way detach.** `detachFlowLimiter()` sets the limiter to zero and emits `FlowLimiterDetached(limiter)`. Only the limiter itself may call it, so its own rules decide when. Nothing can attach a limiter again.
- **Interface `IFlowLimiter`:**
  - `checkDeposit(address token, address depositor, uint256 amount)` after the vault measures the received amount and takes the fee. `amount` is the net amount. `token` is the local token.
  - `checkWithdrawal(address token, address recipient, uint256 amount, bytes32 nonce)` after every proof check and before the vault marks the nonce claimed. `token` is the local token it would pay.
  - Both may change the limiter's state (to record usage). A revert refuses the call.
- **A refused withdrawal stays claimable.** The revert undoes the whole transaction, so the nonce stays unclaimed and the recipient can retry later. A rate limit therefore works as "wait and retry" with no queue in the vault.
- **What a limiter cannot do.** It holds no tokens and no approval, so it cannot move funds. The vault calls it under its reentrancy guard, so it cannot reenter the vault. It can delay or block deposits and withdrawals; a limiter that always refuses blocks them for good. So the limiter's code must be audited before deployment like the vault itself, and the vault exposes its address as a public view.
- **Cost.** With no limiter, the vault reads one storage slot per call and calls nothing.

### Deploy script

Each chain's config gains `flowLimiter` (default zero). A non-zero value must have code. The script reads it back from the deployed vault.

### Tests

- No limiter: deposit and withdraw behave as before; record the gas change.
- A test limiter (in `test/` only) that refuses: deposit reverts; withdraw reverts and the nonce stays unclaimed; after the limiter allows, the same withdrawal succeeds.
- The limiter receives the net amount, the local token, and the nonce.
- Only the limiter can detach; detach is one-way; after detach the vault never calls it.
- A limiter that tries to reenter `withdraw` or `deposit` fails.
- A limiter that tries to move vault funds has no way to do so (no approval exists).

### As built

- **Constructor shape:** the argument `flowLimiter` is the last field of the constructor struct. The struct is now `VaultTerms` (it was `DepositTerms`), because it no longer holds deposit terms only. The vault stores the limiter in a plain storage slot after the fee state, so the earlier slots keep their place. The public view is `flowLimiter()`.
- **Hook points:** `checkDeposit` runs in the deposit after the fee is booked, with the net amount, before the vault emits the deposit event. `checkWithdrawal` runs after the `AlreadyClaimed` check and before the nonce is marked. A claimed deposit never reaches the limiter.
- **Detach:** `detachFlowLimiter()` reverts with `NotFlowLimiter(caller)` for every caller but the limiter. After a detach nobody passes, so the same error covers a second detach. The vault has no other function that touches the limiter, and a test reads the compiled interface to prove it.
- **Deploy script:** the setting is `flowLimiter` on each chain, as a string address. The example configuration holds the zero address. `assertChainEnvironment` reverts with `FlowLimiterHasNoCode(chainId, address)` for a non-zero address with no code. The read-back reverts with `DeploymentMismatch("vault.flowLimiter")`.
- **Prover:** before it sends a withdrawal on a vault with a limiter, the prover simulates `checkWithdrawal` with an `eth_call` from the vault address. If that call reverts, the prover sends nothing, counts no attempt, keeps the state `proven`, and stores a note that names the limiter and carries the revert data. It tries again on every pass with no attempt limit. If the simulation passes and the withdrawal still reverts, the attempt counts as usual. A limiter that depends on state that changes between the simulation and the send can still cost one attempt.
- **Tests:** `test/hardened/BridgeVaultFlowLimiter.t.sol` holds every test above, with the test limiter in `test/hardened/utils/FlowLimiterMocks.sol`. The deploy tests are in `test/hardened/DeployBridge.t.sol`. The Anvil test is in `prover/tests/hardened_happy_path.rs`.
- **Gas, deposit:** 88,312 before, 90,464 with no limiter (2,152 more: one cold storage read). 208,633 with a test limiter attached that allows and records every call. That figure includes the limiter's own storage writes.
- **Gas, withdraw:** in the type 2 receipt test, 263,327 before and 265,549 with no limiter (2,222 more).

## Supply-share flow limiter (removed, user decision 2026-10-22)

**Removed.** The user decided on no flow limits. The contract was built in `539bca1` and removed in the next commit. The vault keeps the empty hook from the section above, and the example config deploys with no limiter. The text below is kept as a record of the design.

The user asked for a reasonable first limit: 0.1% of a token's total supply, taking the ETH supply as 100 million and the PLS supply as one million times that (100 trillion). This section defines `SupplyShareFlowLimiter`, the first contract for the hook above.

### Rules

- **Outflow only.** `checkWithdrawal` applies the limit. `checkDeposit` always allows: a forged proof drains through withdrawals, not deposits.
- **Only the vault may call.** Both functions revert with `NotVault(caller)` for any other caller. Without this, anyone could spend the allowance and block honest withdrawals.
- **Cap per token.** The cap is `supply * shareBasisPoints / 10_000`, with `shareBasisPoints = 10` (0.1%). The supply is a fixed number from the constructor when the token has one, else `IERC20(token).totalSupply()` read at the time of the call.
  - Fixed supplies are for tokens whose on-chain supply is not the asset's supply. Wrapped ETH holds only the ETH that is wrapped, so Ethereum's config sets wrapped ETH to 100,000,000 ETH. PulseChain's config sets wrapped PLS to 100,000,000,000,000 PLS. Caps: 100,000 ETH and 100,000,000,000 PLS per window.
  - A token with no fixed supply and a total supply of zero has a cap of zero; its first withdrawal still passes when the allowance is full (see below).
- **Window.** `windowSeconds = 86_400` (24 hours). The allowance refills in a straight line: the full cap over one window. It never exceeds the cap. A thief who finds the allowance full can take at most about two caps in the first 24 hours, then one cap per day.
- **No withdrawal is stranded.** A withdrawal larger than the cap passes when the allowance is full, and the allowance goes into debt (below zero) by the excess. Later withdrawals wait until the debt refills. So the average outflow stays at the cap, and every valid withdrawal can complete.
- **A refusal reverts** with `FlowRefused(token, amount, available)`, so the vault leaves the nonce claimable and the prover waits (built in `5551b23`).
- **Sunset, optional.** An immutable `sunsetTimestamp`. Zero means never. After it, anyone may call `sunset()`, which calls `vault.detachFlowLimiter()`. This is the only way the limiter ends. It has no owner and no other setter.
- **Immutable.** Every parameter is fixed in the constructor: the vault, the share, the window, the fixed supplies, the sunset.

### Deploy script

The vault takes the limiter at construction, and the limiter takes the vault. The script deploys the limiter first with the vault's predicted address (it already predicts addresses by nonce), then checks after deployment that `limiter.vault()` is the vault and `vault.flowLimiter()` is the limiter. The config gains a `flowLimit` object per chain: `shareBasisPoints`, `windowSeconds`, `sunsetTimestamp`, and `fixedSupplies` (token address and supply). When `flowLimit` is absent the vault has no limiter, as today.

### Tests

- Only the vault may call either function.
- Deposits always pass.
- The cap from a fixed supply and from `totalSupply()`; the exact numbers for wrapped ETH (100,000 ETH) and wrapped PLS (100,000,000,000 PLS).
- Linear refill: half a window refills half the cap; a long gap never exceeds the cap.
- A withdrawal larger than the cap passes from a full allowance, puts the allowance into debt, and the next one waits for the debt to refill.
- Caps are per token: draining one token does not affect another.
- Sunset: refused before the timestamp, works after it, works once, and with zero it never works.
- End to end through the vault: the withdrawal over the allowance reverts with `FlowRefused` and stays claimable, then pays after the refill (use `vm.warp`).
- Fuzz: over any sequence of withdrawals and time steps, the total paid in any span of 24 hours is at most two caps (a full allowance plus one window of refill) plus the excess of one oversize withdrawal. Over a long run the average is one cap per window.

## Deposit lock (user decision, 2026-10-23) (built)

Moved to `MessageBridge` on 2026-10-24. The flag is `depositsOpen` and the call is `openDeposits(OpeningProof)`. A send on a closed bridge reverts `DepositsNotOpen()`. The proof and its checks are in `BeaconProofVerifier`. Read "vault" in this section as "message bridge", and "deposit" as "send".

An end-to-end run (`docs/end-to-end-real-proofs.md`) showed that a deposit made before the destination light client stored its first update can never be paid. The user decided: lock deposits on chain until the bridge can deliver them.

### What a deposit at slot `s` needs

A deposit on chain X at beacon slot `s` is paid by the vault on chain Y, which reads the light client on Y. That light client tracks the beacon chain of X. `I` is its checkpoint slot. `H1`, `H2` and so on are the heads that `update` stored.

- **A block hash row that covers `s`.** `withdraw` calls `_blockHashGindexAt(s)`. A row grows by evidence from a stored header that has an execution block hash. The constructor stores none for `I`, so the lowest usable evidence slot is `H1`. A row that covers `s` needs evidence at a stored head `h1 <= s` and at a stored head `h2 >= s`. If `s < H1`, no row can cover `s`, and the deposit is lost for good. This is the only permanent condition.
- **An anchor `a > s`** that the light client stored later.
- **A row for the anchor.** The recent path (`a - s <= 8192`) needs a `block_roots` row that covers `a`. That row needs the anchor and two different stored headers below it within 8192 slots. The headers need only `headers`, so `I` counts as one. The historical path (`a - s > 8192`) needs a `historical_summaries` row at `a`. That row needs one stored header more than 8192 slots below `a`, in an era at or after `capellaEra`. `I` can serve.
- **Why the run needed three heads.** Two earlier headers and one anchor are three stored headers, and `I` is one of them. So two updates suffice (`H1` and `H2`, with `I` within 8192 slots of `H2`). The prover counted only the headers that `HeadUpdated` events name, so it asked for three updates. The number three is an artefact of that count. The synthetic chain does not cause it. The order in which the prover validates rows does not cause it either. After `H1` is stored, every other condition heals as the prover keeps following the chain.

### The lock

- **Where the condition lives.** It lives in the light client on chain Y. The vault on X cannot read chain Y. No fact on chain X implies it, not even the state of the own light client of X, which tracks chain Y and not the light client on Y.
- **The proof.** `openDeposits(OpeningProof)` proves the condition through the own light client of the vault, which tracks chain Y. The proof has four links. First, the own light client stored an execution block hash of a block of chain Y at `remoteSlot`. Second, the header in the proof hashes to that block hash, and its fourth item is the state root. Third, under that state root the account `remoteLightClient` holds a storage root (a state trie proof). Fourth, under that storage root the entry `executionBlockHashes[storedSlot]` is not zero (a storage trie proof). Only `update` writes that entry, so the light client on Y stored one update, at a head that the beacon chain of X had already finalized.
- **Why it is enough for later deposits.** The proven block is final in chain Y and final in the own light client of the vault. A head is never later than the clock of the chain that stored it, and the proven block lies before the call. So a deposit made after the call lies at a slot `s >= H1`, as the first condition needs.
- **Terms.** `VaultTerms.remoteLightClient` is a new constructor field. It must not be zero. The deploy script sets it from the predicted address of the light client on the other chain. `remoteLightClient` is immutable. The vault hard-codes slot 3 for the mapping `executionBlockHashes`, and a test pins that slot to the contract.
- **One-way flag.** `bool public depositsOpen` starts false. `openDeposits` sets it and emits `DepositsOpened(remoteSlot, remoteBlockHash, storedSlot)`. A call after the opening returns at once, so two openers do not fail each other. No function clears the flag. Anyone may call `openDeposits`. It needs no key.
- **Hot path.** `deposit` first reverts with `DepositsNotOpen()` when the flag is false. The flag shares a storage word with `feeAuthority` and `feeBasisPoints`, which `deposit` reads anyway, so the check adds no cold read. The measured cost is 173 gas (90,464 before, 90,637 after, in `test_gas_deposit_feeZero`).
- **What the lock does not do.** It does not make the other conditions true. The prover must keep following the chain so that anchors and rows exist.

### Tests

`test/hardened/DepositOpening.t.sol` holds them. The tries in these tests have one leaf. Real tries (branch and extension nodes) are covered by the Anvil tests of the prover, with `eth_getProof`.

- A closed vault refuses a deposit with the exact error, before every other check. A refusal test fails when the check is removed.
- The vault opens exactly when the remote light client stored an update, and not before.
- Refusals: an unstored slot, another header, another account, another stored slot, a malformed account or header, an empty entry.
- The flag never closes: a second call changes nothing, and `setFee` and `nullifyFee` (which write the same storage word) keep it.
- Pins: the slot of the mapping in the light client, and the position of the flag in the storage word.
- End to end: the first deposit after the opening emits a log that goes into a receipt, and the destination vault pays it.

## Launch sequence

The contracts need no administrator, and the repository has no relayer. A stateful server of the operator does the steps below. It runs the producer (`zk-bridge-prover prove` and `evidence`) for the parts that make proofs or evidence, and it sends every transaction itself. The key of the server pays for them. Anyone can open a bridge and deliver a message.

1. **Deploy** with `script/hardened/DeployBridge.s.sol`. On each chain it deploys, in the order of the nonce table in the script: the light client, the own-chain light client and the fork registry (where the gate mode needs them), the gate, the `MessageBridge`, the `TokenMediator` (which creates its `TokenFactory`), and optionally the `DeliveryRouter`, the one router of the chain (it needs a wrapped native token). Each side learns the bridge, the mediator and the light client of the other side from predicted addresses. Both bridges start locked. The read-back checks every address, every immutable, the pinned verifier code hash, `remoteLightClient`, and a false `depositsOpen`.
2. **Post light-client updates.** For each route, run `prove`. It exits with code 0 and one proof package, or with code 3 when the light client holds the newest final header. Send `updateCalldata` of the package to `destination.lightClient`. Repeat until `prove` exits with code 3. `latestFinalizedSlot` in the package shows whether the head still lags by more than one fold.
3. **Open the bridges.** Call `openDeposits` on the `MessageBridge` of each chain. The call needs a proof that the remote light client stored a head: a block of the other chain whose hash the own light client stored, the state proof of the remote light client in that block (from `eth_getProof`), and the storage proof of one stored head. The server builds this proof. A bridge opens only when its own light client has stored a block of the other chain that came after the first update of the other light client. A chain needs about two epochs to finalize, so the first round of updates for one direction only prepares the second. Repeat steps 2 and 3 until both bridges report `depositsOpen()`.
4. **Announce.** Tell users only after both bridges report open. A send before that reverts with `DepositsNotOpen()` and spends nothing but gas. This covers token relays too, because the mediator sends through the bridge.
5. **Keep the light clients current.** Run step 2 on a schedule for each route. The own-chain light client of a chain with a registry gate is a route too: its source beacon chain and its destination chain are the same chain. A message needs a stored header after its slot.
6. **Confirm the gate.** On a chain whose gate is enforcing, the first sender of each epoch calls `BeaconForkGate.confirm(evidence)` before the send (see "Gate evidence: confirm, then send"). A keeper may confirm too. The server builds the evidence for its own sends.
7. **Deliver the messages.** For each `UserRequestForAffirmation` log on a source bridge (a token relay emits one, and so does any message from an application), run `evidence --tx <hash> --log-index <n>`. Send each call of `prerequisites` in order, and read the layout views again after each call. Then send `execute` to the destination bridge. Skip the message when `alreadyDelivered` is true. Delivery is final: a failed call to the target is not retried by the bridge. For a message that names a `DeliveryRouter` as the receiver of tokens, send the proof to `DeliveryRouter.executeMessage(proof)` instead. To send many in one transaction, put the block proof (`update` at the light client) and one such call for each message in a Multicall3 `aggregate3` with `allowFailure` set on each call, so the router can pay the fee to the reward address; the `execute.data` of the evidence holds the proof as the argument of `executeMessage`.
8. **A release that the recipient cannot take is final.** The mediator tries the recipient once and emits `ReleaseFailed(token, recipient, value, messageId)` when the token or the flow limiter refuses. There is no claim and no retry. The tokens stay in the mediator, owed to nobody.

## Message layer and token mediator (user decisions 2026-10-24) (built)

The vault today mixes four jobs: proving a log, lock-and-release token accounting with fixed pairs, the fee and limiter hooks, and the deposit lock. It is also close to the 24 KB contract size limit. This section splits it into layers, following the split of OmniBridge (a message bridge plus token mediators) without OmniBridge's admin parts: no proxies, no owners, no validators, no adjustable limits, no token registration.

**Built.** `MessageBridge`, `TokenMediator`, `TokenFactory`, `BridgedToken` and `DeliveryRouter` exist, with the tests listed under "Tests" and in "As built" below. The first design text in this section used the names `sendMessage`, `MessageSent`, `MessageDelivered`, `IMessageFee` and a `feeContract` field. The OmniBridge names in "OmniBridge interface compatibility" replaced them, and the later decisions removed the fee contract. Read "As built" for the exact contract.

### Decisions

| Question | Decision |
|---|---|
| Delivery of a message | Final. The bridge marks a message delivered whether the target call succeeds or reverts. Downstream contracts handle their own failures. |
| Fees | The sender names a fee contract in the message. The bridge calls it after delivery through a fixed interface. Any failure of the fee contract falls back to the default: no payment. |
| Order | Messages are independent. No per-sender sequence. |
| PulseChain's existing OmniBridge tokens | Ignored. This bridge cannot mint them, so it deploys its own bridged tokens. |
| A failed token transfer in the mediator | Decided 2026-10-27: the release is final and emits `ReleaseFailed`. There is no claim record (see "Token mediator"). |

### Layer 1: proof (exists)

`BeaconLightClient`, the SP1 verifier, `BeaconForkGate`, `ForkRegistry`. No change.

### Layer 2: message bridge (`MessageBridge`)

Sending, on the source chain:

```solidity
function sendMessage(address target, bytes calldata data, uint256 gasLimit, address feeContract)
    external returns (bytes32 messageId);

event MessageSent(
    bytes32 indexed messageId, address indexed sender, uint64 destinationChainId,
    address target, uint256 gasLimit, address feeContract, bytes data
);
```

- `messageId = keccak256(abi.encode(sourceChainId, address(this), nonce++))`. The nonce only makes identifiers unique; it implies no order.
- The fork gate check (`admit`) and the deposit lock (`DepositsNotOpen` until `openDeposits`) move here, so every message gets them.
- `gasLimit` has a floor and a ceiling (constants), so a message can always be executed in one block.

Executing, on the destination chain:

```solidity
function executeMessage(MessageProof calldata proof) external;

event MessageDelivered(bytes32 indexed messageId, bool success, bytes32 returnDataHash);
event MessageFeeCallFailed(bytes32 indexed messageId, address feeContract);
```

1. Verify the `MessageSent` log: the anchor is a stored header; ancestry goes through `block_roots` or `historical_summaries`; then the block hash, the execution header, the receipt trie, the emitter (the remote bridge) and the destination chain. This is the verification code that is in the vault today, moved unchanged.
2. Refuse a message identifier that was delivered before.
3. Gas guard: refuse to execute unless `gasleft()` is enough to forward `gasLimit` to the target after the 63/64 rule, plus the bookkeeping that follows. Without this guard, an executor could give too little gas, make the target fail, and burn the message for good.
4. Mark the identifier delivered, set the context (`messageSender()`, `messageSourceChainId()`, `messageId()`), call `target` with exactly `gasLimit` gas, clear the context, emit `MessageDelivered`.
5. Fee: if `feeContract` is not zero, call `IMessageFee(feeContract).onMessageExecuted(messageId, msg.sender, gasUsed)` with a fixed gas cap and no value. A revert, an out-of-gas failure or a missing contract emits `MessageFeeCallFailed` and changes nothing else.

```solidity
interface IMessageFee {
    /// Called once on the destination chain after delivery. It may pay the executor. It cannot affect delivery.
    function onMessageExecuted(bytes32 messageId, address executor, uint256 gasUsed) external;
}
```

The layout rows (`addBlockRootsLayout`, `addBlockHashLayout`, `addHistoricalSummariesLayout`) move here, because every message proof needs them.

Gloas. The position rules also take the fixed Gloas positions of `block_roots` (352) and `historical_summaries` (2950). `addBlockHashLayout` refuses every slot at or after the immutable `gloasForkSlot` (`GloasSlotRefused`): from the fork on, `executionBlockHashes[slot]` holds `state.latest_block_hash`, an earlier payload, and the body holds only a bid. A message source at or after `gloasForkSlot` takes no layout. Its source header is a beacon block B after the block of the proven execution block X, and `keccak256(executionHeaderRlp)` must equal the bid `parent_block_hash` of B at the fixed index 2856 (11 entries). This is sound because `process_execution_payload_bid` asserts `bid.parent_block_hash == state.latest_block_hash`, and `latest_block_hash` is written only from a confirmed parent payload. The bid `block_hash` is never accepted. The opening proof works with a Gloas head, because it checks an execution header RLP against the stored hash.

A target trusts a message by checking `msg.sender == bridge` and the pair (`messageSourceChainId()`, `messageSender()`).

Front-running an execution does no harm: a message executes once, with the target, data and gas limit the sender fixed.

### Layer 3: token mediator (`TokenMediator`)

It is a target of the message bridge on each chain, and it trusts only the mediator at the same address on the other chain.

- Native and bridged tokens. A token is native on the chain where it exists. Bridging a native token locks it in the mediator and mints a bridged copy on the other chain. Bridging a bridged copy back burns it and unlocks the native token. Neither side needs pre-loaded funds.
- No registration. The bridged copy's address is `CREATE2(factory, salt = keccak256(homeChainId, homeToken))`. The first message for a token carries name, symbol and decimals; the destination deploys the copy on first use. This replaces the token pair tables and the `destinationToken` check: the destination address is computed, not looked up.
- Accounting per native token, as OmniBridge's `mediatorBalance`: the mediator counts the amount it actually received (balance before and after), not `balanceOf`. Fee-on-transfer tokens bridge the received amount. Stray transfers to the mediator are never paid out. Rebasing tokens are refused (or documented as unsupported).
- Native coins: ETH and PLS are wrapped on deposit (WETH, WPLS) and unwrapped on delivery. The mediator does not do this itself: `DeliveryRouter` wraps and unwraps the native coin.
- Bridge and call: `relayTokensAndCall(token, recipient, amount, data, gasLimit, feeContract)` delivers the tokens and then calls the recipient with `data`.
- The optional fee switch and the empty flow limiter hook move here from the vault.
- A failed transfer on delivery (decided 2026-10-27): if releasing a native token to the recipient fails (a blacklist, a pause, a token that burns its gas, a token that reverts, a refusal of the flow limiter), the mediator emits `ReleaseFailed(token, recipient, value, messageId)` and stops. The handler never reverts, so the message stays delivered. The release is final: there is no claim, no retry and no payee but the recipient. The record `mediatorBalance` falls by the value, because the other chain burned the copies, and the tokens stay in the mediator as a surplus that nobody owns.

### Layer 4: bridged token (`BridgedToken`)

A minimal ERC-20 with `mint` and `burn` callable only by the mediator, plus `permit` (EIP-2612). No owner, not upgradeable. Name and symbol follow the native token with a suffix that marks the bridge (to be chosen).

### What is removed

`BridgeVault` is replaced by `MessageBridge` and `TokenMediator`. The token pair tables, `remoteTokenOf`, `localTokenOf` and the pre-loaded liquidity disappear.

### Tests (to write with the build)

- Message bridge: delivery of a valid message; replay refused; wrong emitter, wrong chain, tampered proof refused (the existing vault reject tests, moved); delivery is final when the target reverts; the gas guard refuses an executor that sends too little gas, and a target that runs out of its own `gasLimit` is a final failure; the context is set during the call and cleared after; the fee contract is called once, and a reverting, gas-burning or missing fee contract changes nothing; independent messages can execute in any order.
- Token mediator: native lock and bridged mint; burn and unlock back; the first message deploys the bridged copy at the computed address with the right metadata; a second token gets a second copy; fee-on-transfer accounting; stray transfers are not paid out; native coin wrap and unwrap; bridge and call; a blacklisted recipient gets a `ReleaseFailed` event and the mediator keeps the tokens (superseded: an earlier design gave a `claimable` balance); only the remote mediator through the bridge can trigger a release.
- End to end on two Anvil chains with the proof producer: a token round trip and an arbitrary message, both directions.

### OmniBridge interface compatibility (user decision, 2026-10-24)

The user asked for the same interfaces as OmniBridge wherever possible, one to one, and new methods only for new features. The names below come from the OmniBridge source (`omni/omnibridge`, master branch, read 2026-10-24): `contracts/interfaces/IAMB.sol`, `IOmnibridge.sol`, `IERC677.sol`, `IBurnableMintableERC677Token.sol`, `BasicOmnibridge.sol`, `BasicAMBMediator.sol`, `components/*`, `modules/factory/TokenFactory.sol`, `helpers/WETHOmnibridgeRouter.sol`. This replaces the names used earlier in this section (`sendMessage`, `MessageSent`, `MessageDelivered`, `relayTokensAndCall` with a fee argument, and so on).

#### Message bridge: the Arbitrary Message Bridge interface (`IAMB`)

| OmniBridge | This bridge |
|---|---|
| `requireToPassMessage(address _contract, bytes _data, uint256 _gas) returns (bytes32)` | Same. |
| `requireToConfirmMessage(address _contract, bytes _data, uint256 _gas) returns (bytes32)` | Same as `requireToPassMessage` (there is no separate manual lane). |
| `event UserRequestForAffirmation(bytes32 indexed messageId, bytes encodedData)` | Same, emitted by every send on both chains. `encodedData` uses the AMB message encoding unchanged (message identifier, sender, executor, gas, chain identifier lengths, data type, chain identifiers, data). |
| `event UserRequestForSignature(...)` | Not emitted (no validators sign). |
| `executeSignatures(...)`, `executeAffirmation(...)` | Replaced by a new method: `executeMessage(MessageProof calldata proof)`. Validators are replaced by the light-client proof. |
| `event AffirmationCompleted(address indexed sender, address indexed executor, bytes32 indexed messageId, bool status)` | Same, on every execution. |
| `event RelayedMessage(...)` | Not emitted (one execution event is enough). |
| `messageSender()`, `messageId()`, `messageSourceChainId() returns (bytes32)` | Same. Set only during the call to the target. |
| `transactionHash()` | Same name. Returns the source transaction hash when the proof carries it (to decide: proving it needs a transaction trie branch; otherwise it returns zero). |
| `messageCallStatus(bytes32)`, `failedMessageDataHash`, `failedMessageReceiver`, `failedMessageSender` | Same. Recorded on a failed call. Delivery stays final; these are data for downstream contracts. |
| `maxGasPerTx()` | Same. A constant ceiling for `_gas`. |
| `sourceChainId()`, `destinationChainId()` | Same. |

#### Token mediator: the OmniBridge interface

| OmniBridge | This bridge |
|---|---|
| `relayTokens(address _token, address _receiver, uint256 _value)` | Same. |
| `relayTokens(address _token, uint256 _value)` | Same. |
| `relayTokensAndCall(address _token, address _receiver, uint256 _value, bytes _data)` | Same. |
| `onTokenTransfer(address _from, uint256 _value, bytes _data) returns (bool)` | Same (ERC-677 entry). |
| `handleNativeTokens`, `handleNativeTokensAndCall`, `handleBridgedTokens`, `handleBridgedTokensAndCall`, `deployAndHandleBridgedTokens`, `deployAndHandleBridgedTokensAndCall` | Same names and parameters, callable only through the message bridge by the mediator on the other side. So the message payloads match OmniBridge's. |
| `event TokensBridgingInitiated(address indexed token, address indexed sender, uint256 value, bytes32 indexed messageId)` | Same. |
| `event TokensBridged(address indexed token, address indexed recipient, uint256 value, bytes32 indexed messageId)` | Same. |
| `event NewTokenRegistered(address indexed nativeToken, address indexed bridgedToken)` | Same. |
| `bridgedTokenAddress(address)`, `nativeTokenAddress(address)`, `isTokenRegistered(address)`, `isRegisteredAsNativeToken(address)`, `mediatorBalance(address)` | Same. |
| `bridgeContract()`, `mediatorContractOnOtherSide()` | Same (immutable values). |
| `getBridgeInterfacesVersion()`, `getBridgeMode()` | Same. |
| Recipient callback `onTokenBridged(address _token, uint256 _value, bytes _data)` | Same (called by `...AndCall` deliveries). |
| `fixFailedMessage`, `requestFailedMessageFix`, `messageFixed`, `event FailedMessageFixed` | Not included: delivery is final, there are no refunds. |
| Owner functions: `setCustomTokenAddressPair`, `fixMediatorBalance`, `claimTokens`, `claimTokensFromTokenContract`, limit setters, gas limit setters, interest functions | Not included: no admin. The limit views (`dailyLimit`, `maxPerTx`, `withinLimit` and the rest) are left out; the empty flow limiter hook covers limits. |
| — | None. OmniBridge has no claim for a failed release, and this mediator has none either (decided 2026-10-27). |
| — | New: `detachFlowLimiter`. There is no fee and no fee admin. |

#### Bridged token: `IBurnableMintableERC677Token`

| OmniBridge | This bridge |
|---|---|
| `mint(address, uint256) returns (bool)`, `burn(uint256)` | Same, callable only by the mediator. |
| `transferAndCall(address, uint256, bytes) returns (bool)`, `event Transfer(address indexed, address indexed, uint256, bytes)` | Same (ERC-677). |
| `increaseAllowance`, `decreaseAllowance`, `permit` | Same. |
| `bridgeContract()` | Same (the mediator). |
| `claimTokens(address, address)` | Not included (owner function). |
| `TokenFactory.deploy(string, string, uint8, uint256)` | Same signature, but deterministic (CREATE2 on home chain identifier and native token), callable only by the mediator. |

#### Native coins: the `DeliveryRouter` (decision 2026-10-27, replaces the separate `WETHOmnibridgeRouter`)

The bridge has one router contract on each chain: `DeliveryRouter`. The separate `WETHOmnibridgeRouter` is deleted. Its destination role (`onTokenBridged` that unwrapped) repeated what `DeliveryRouter` already does with the `UNWRAP` flag and the 20 byte legacy data. It also had a defect: its callback reverted on a token other than the wrapped token and on data that was not 20 bytes (for example the 128 byte `FeeDirector` meant for `DeliveryRouter`). The mediator ignores a failed callback, so the tokens stayed in a router with no owner. A 20 byte zero address burned the coin. Only the source side remains, and it moved into `DeliveryRouter`.

| OmniBridge | This bridge |
|---|---|
| `wrapAndRelayTokens()`, `wrapAndRelayTokens(address _receiver)` payable | Same, as entries of `DeliveryRouter`. The mediator itself handles only tokens. The router wraps the coin and calls `relayTokens` (no data) or `relayTokensAndCall` (data) of the mediator in one call. The mediator pays the receiver only; the router has no fallback option. Two new overloads, `wrapAndRelayTokens(address _receiver, uint256 gasLimit)` and `relayTokensAndCall(address _receiver, bytes _data, uint256 gasLimit)`, pass a gas limit to the mediator. A receiver of the zero address or of the router itself reverts with `InvalidReceiver`. |
| `relayTokensAndCall(address, bytes)` payable | Same, with data that must not be empty (`EmptyData`). Name a `DeliveryRouter` on the other chain as the receiver, with its terms as data, to pay a tip or to get the native coin back. |
| `onTokenBridged(address, uint256, bytes)` | The `onTokenBridged` of `DeliveryRouter`. It never reverts: it unwraps with `UNWRAP` or with the 20 byte data, and it hands off what it cannot deliver to `failedDeliveryAddress`. |
| `claimTokens(address, address)` | Not included (owner function). `sweep(token)` of `DeliveryRouter` replaces it, and it pays `failedDeliveryAddress` only. |

The router holds no coin and no token at rest, except stray tokens (what a plain relay leaves in it, see `sweep`) and tokens that a hand-off could not push because the token refuses `failedDeliveryAddress`. The router keeps no record of either.

**Sweep (decision 2026-10-27, changed the same day: no claim records).** The mediator pays the router with no callback when a sender names the router as the receiver with `relayTokens`, or when a callback fails. The router then holds tokens that nobody owns. `sweep(address token)` is permissionless. It sends the whole balance of the token to `failedDeliveryAddress`, and it emits `Swept(token, amount)`. It reverts with `NothingToSweep` when the router holds none. When the token refuses `failedDeliveryAddress`, the router emits `HandOffRefused(token, amount)` and leaves the tokens where they are: it does not revert and it records nothing. The sweep takes the guard of the router, so a payout hook cannot call it during a delivery.

#### Fees: a router that delivers a message and pays a tip from it (supersedes the fee contract above)

The design solves executor fees without changing the message format: a router contract delivers the message and pays a tip from the bridged tokens. This design drops the earlier `feeContract` field, `requireToPassMessageWithFee` and `IMessageFee`. The message bridge and the AMB encoding stay exactly as OmniBridge has them.

How it works:

1. The sender bridges tokens with `relayTokensAndCall` to a router contract on the destination chain. The `_data` is an encoded `FeeDirector`:
   ```solidity
   struct FeeDirector {
       address recipient;   // who receives the tokens after the tip
       uint256 settings;    // flag bits: 0 = FIXED_FEE (the tip is `limit`); 1 = UNWRAP (wrapped native token to the native coin);
                            // 2 = EXCLUDE_PRIORITY (price gas at the base fee only); 3 = MULTIPLIER_OF_TOTAL (tip = value * multiplier / 1e18)
       uint256 limit;       // the fixed tip, or the price ceiling of a gas based tip (see Tip modes)
       uint256 multiplier;  // 1e18 scaled: the share of the value, or the factor on the gas cost
   }
   ```
2. Anyone calls the router's entry point, which records the starting gas in one storage slot (`DELIVERY_SLOT`, `gasleft()` in the low 96 bits, the value 1 at rest) and then executes the message on the bridge. In OmniBridge this is `safeExecuteSignaturesWithAutoGasLimit(address runner, bytes _data, bytes _signatures)`; here the same pattern wraps `executeMessage(MessageProof)`, as `DeliveryRouter.executeMessage(MessageProof proof)` (decision 2026-10-26, replaces the runner whitelist: any account may call it, the caller names nothing, and the tip always goes to the immutable `rewardAddress` of the router. A copy of a delivery therefore gains the copier nothing).
3. The bridge delivers to the mediator, which calls the router's `onTokenBridged(address _token, uint256 _value, bytes _data)`. The router decodes the `FeeDirector`, computes the tip and splits the tokens: the tip to the reward address, the rest to the recipient (or to the failed delivery address when the router cannot deliver, see below). Tip modes: fixed (`limit`), a share of the value (`multiplier`, 1e18 is the whole value), or gas used (plus a fixed overhead of 100,000 for a token payout and 50,000 for a native payout) times `multiplier` times the base fee or gas price, capped by `limit`. **A gas based tip is computed from the gas that the deliverer's transaction makes available** (`startingGas` at router entry minus `gasleft()` in the callback, plus the fixed overhead). The deliverer chooses the gas limit of that transaction, and the bridge forwards only the message gas limit, so gas that the deliverer holds back above it counts. A sender must therefore expect a gas based tip to reach `limit`: `limit` is the price ceiling, and it is the only bound. `FIXED_FEE` wins over `MULTIPLIER_OF_TOTAL`. The tip never exceeds the value. `UNWRAP` applies to the wrapped native token only: for any other token the router pays the plain token, and the interfaces refuse to build such terms.
4. With the marker slot at rest (someone calls `MessageBridge.executeMessage` directly, not through the router), the mediator still delivers to the router, the router pays no tip and sends everything to the recipient. This costs the user nothing, and it keeps the bridge permissionless.

Design choices of the router, because this bridge has no admin:
- No validator filter (`validatorsFilter`, `isValidator`, `setValidatorStatus`) and no runner whitelist. The bridge trusts the proof, not the caller, so anyone may execute on the bridge and anyone may execute through the router. The router has no `tx.origin` check and no `reward` argument. It has exactly one reward address, the immutable `rewardAddress` (constructor, no zero address, no setter), which receives every tip. Because the caller cannot name the payee, a block builder or a searcher who copies a delivery pays the gas and the reward address still gets the tip. The deploy configuration holds `deliveryRouter.rewardAddress` and `deliveryRouter.failedDeliveryAddress`, and the deploy script reads both back. The marker slot is set only inside `DeliveryRouter.executeMessage`, so a direct `MessageBridge.executeMessage` finds the slot at rest and the callback takes no tip. Known limit, unchanged by this design: a recipient with a payout hook could call `MessageBridge.executeMessage` for another message while a delivery runs. The nested `onTokenBridged` then hits the reentrancy guard and reverts, so the tokens of that other message stay in the router with no record. The marker is set during that call, but nothing is taken, because the callback reverts first.
- The router sends the native coin to a receiver with a fixed gas amount (`NATIVE_SEND_GAS`, 50,000), and a receiver that refuses gets the wrapped token. A receiver that burns gas cannot leave the router without gas for that fallback.
- No owner and no `claimTokens`.
- **Nothing stays in the router, and nothing burns (decision 2026-10-26, changed the same day).** The mediator calls `onTokenBridged` after it paid the router, and a failed call changes nothing: the tokens stay with the router. A revert in the callback therefore returns nothing to anyone, and the fallback address and `claimable` of the mediator do not apply. So the router never reverts there. Whenever it cannot deliver to the recipient, it hands the tokens off to `failedDeliveryAddress`, a second immutable constructor address (not the zero address; it may equal `rewardAddress`; no owner, no setter), and emits `DeliveryFailed(token, recipient, amount, reason)` with `reason` `PayoutRefused`, `InvalidTerms` or `Reentered`. The tip is taken first and paid to the reward address whenever the delivery path takes a tip, as for any delivery. The cases:
  - *The payout to a valid recipient fails* (a token that refuses it, a native send that fails in both coin and wrapped form). The tip goes to the reward address as usual. The router pushes the undelivered amount to the failed delivery address, as the wrapped token for a native payout.
  - *Terms that decode but name the zero address or the router itself* (data of at least 128 bytes). The router takes the tip by the terms of the director, with its limit exactly as for a normal delivery, and pushes the rest to the failed delivery address. Nothing is sent to the zero address. A direct delivery takes no tip, so the whole value is pushed.
  - *Data that cannot be decoded as a director* (neither 20 bytes nor at least 128 bytes, or a first word with bits above 160, which `abi.decode` would refuse), and a 20 byte legacy receiver that is the zero address or the router. No tip can be computed. The router pushes the whole value.
  - *A reentrant callback* (a recipient payout hook makes the bridge deliver another message to the router while a delivery runs, so the mediator calls `onTokenBridged` again). The router detects it with the state of its reentrancy guard and does not revert. It takes the tip by the terms when they decode and a router delivery runs, as the token and with no unwrap, and pushes the rest (the whole value for a legacy receiver, for data of no known shape, or for a direct delivery) to the failed delivery address, with `DeliveryFailed(Reentered)`. `sweep` keeps the guard and refuses a reentrant call.
  - *The 20 byte legacy form with a token that is not the wrapped native token.* There is nothing to unwrap. The router pays the token to the receiver, with no fee, and pushes the value to the failed delivery address if the token refuses the receiver.
  If the push to the failed delivery address fails too (a token that also blocks it), the tokens stay in the router for good, and the router emits `HandOffRefused(token, amount)` after `DeliveryFailed` (user decision 2026-10-27: no claim records in the router). The router has no `claimable`, no `totalClaimable`, no `claim`, no `claimNative` and no `Claimed` event. A later `sweep(token)` tries the push again, so the tokens move once the token stops refusing the address. A delivery uses the balance of the router, up to the value that the mediator reports, so a token that takes a cut on transfer cannot make the router pay more than it holds. Invariants: the router holds no coin at rest, and for each delivery the recipient, the tip, the hand-off and the protocol fee add up to the released value. Gas: a delivery through the router costs the same as before within 130 gas (fixed fee 131,989 to 131,981, share fee 132,197 to 132,189, gas based fee 198,258 to 198,380; the fixed and share paths gain no storage read). The open entry (no origin check, no reward argument) saves about 500 gas more: fixed fee 131,492, multiplier of total fee 131,700, gas based fee 197,868 (`DeliveryRouterGas.t.sol`, call gas). Limits: a token that a stranger sends to the router by plain transfer, or that another router pays to it as a recipient, has no record. The router cannot detect it at the time, but `sweep(token)` hands it to the failed delivery address later.


**The delivery terms format (decided 2026-10-26).** The router reads its terms from a `FeeDirector`. The earlier native only router form used `bool fixedFee` in place of `settings`. The struct is `struct FeeDirector { address recipient; uint256 settings; uint256 limit; uint256 multiplier; }`, encoded as four words (128 bytes) in the `_data` of `relayTokensAndCall`. It has no named flag constants. The flags are bit positions of `settings`, read as `settings << (255 - bit) >> 255`, and each has a comment:

| Bit | Value | Wording and earlier identifier | Meaning |
|---|---|---|---|
| 0 | 1 | "use the limit as the fee amount" (`fixedFee` in V2) | The fee is `limit`. It wins over bit 3. |
| 1 | 2 | "unwrap the tokens" (`toNative`) | Unwrap to the native coin. It counts only when the token is `wNative`; for another token it is ignored and the token is paid (the earlier router test says "the unwrap will not occur"). |
| 2 | 4 | "ask the system to not include the priority fee" (`excludePriority`) | Price gas at `block.basefee`; else `tx.gasprice`. It needs `EIP1559_ENABLED`. |
| 3 | 8 | "use the multiplier as a factor of total tokens" | The fee is `value * multiplier / 1 ether`. |

Scaling and modes: percent is 1e18 scaled (`1 ether` is 100 percent). Fixed: `fees = limit`. Percent: `fees = value * multiplier / 1 ether`. Gas based: `fees = (gasUsed + (toNative ? 50_000 : 100_000)) * multiplier * gasPrice / 1 ether`, with `gasUsed = uint96(runner) - gasleft()` measured in the callback, and `fees = min(fees, limit)`. In every mode `fees = min(fees, value)`. The limit is therefore the fixed fee or the cap of the gas based fee, and the value is the last cap. Entry points: `onTokenBridged(address _token, uint256 _value, bytes _data)` (only the bridge, `nonReentrant`, data of 20 bytes is the legacy "receiver of the unwrapped coin", else `abi.decode(_data, (FeeDirector))`), `safeExecuteSignaturesWithAutoGasLimit(address runner, bytes _data, bytes _signatures)` (the validator filter `isValidator(runner)`, stores `uint96(gasleft()) | uint160(runner) << 96` in `RUNNER_SLOT = keccak256(abi.encode("omnibridgerouter.runner"))`, then calls the foreign bridge), `feeInfo(bool toNative, uint256 _value, uint256 runner, FeeDirector)` and `baseFee(bool excludePriority)` as views, `claimTokens`, `setValidatorsFilter`, `setValidatorStatus`.

**Choices of `DeliveryRouter` against the plain executor router pattern.** Every difference, and why:

| Topic | Plain executor router | `DeliveryRouter` | Reason |
|---|---|---|---|
| Flag names | None in code (comments, and the identifiers `fixedFee`, `toNative`, `excludePriority`) | `FIXED_FEE`, `UNWRAP`, `EXCLUDE_PRIORITY`, `MULTIPLIER_OF_TOTAL`, with the bit values 1, 2, 4, 8 | The plain pattern has no constants. The names come from its identifiers and comments. The TypeScript module uses the same names and a test compares them with the compiled contract. |
| Entry point | `safeExecuteSignaturesWithAutoGasLimit(runner, data, signatures)` | `executeMessage(MessageProof)` | This bridge verifies a proof, not signatures. |
| Who may call | A validator filter decides who may be named, the owner sets it | Anyone | User decision 2026-10-26. No owner exists. |
| Who is paid | The `runner` that the caller names | The immutable `rewardAddress` | User decision: a copied delivery gains the copier nothing. |
| Owner functions | `claimTokens`, `setValidatorsFilter`, `setValidatorStatus` | None | No owner, no admin. |
| Reentrancy slot | `RUNNER_SLOT`, preimage `omnibridgerouter.runner`, value `gas \| runner << 96`, set by a transient guard | `DELIVERY_SLOT`, preimage `deliveryrouter.delivery`, value starting gas, 1 at rest, regular storage | The slot holds no address now, so the old name would mislead. The compiler target has no transient storage. |
| Base fee switch | `EIP1559_ENABLED` immutable | None. `block.basefee` is read | Every target chain has the base fee. |
| Gas measure | In the callback, `startGas - gasleft()`, plus 100,000 for a token payout and for a native payout (it was 50,000 for a native payout until 2026-10-27) | The same: `startingGas` is stored at the entry of `executeMessage`, and the callback pays one transfer to the reward address and one to the recipient | User decision 2026-10-26, as the plain pattern, kept on purpose and not changed. The measure is the gas that the deliverer's transaction makes available, not the gas that the message needs. The deliverer chooses the transaction gas limit, and the bridge forwards only the message gas limit, so gas held back above it counts. A caller can also choose a costlier proof route. So the sender must expect the tip to reach `limit`, and `limit` is the price ceiling. The tip goes to the fixed reward address, so a stranger gains nothing. The test `test_aCallerCanRaiseAGasBasedTipByTheGasItSuppliesUpToTheLimit` documents this. |
| `EXCLUDE_PRIORITY` where `block.basefee` is 0 | Gives a zero gas fee (BSC reports a base fee of 0) | The same in the contract. The shared module refuses `EXCLUDE_PRIORITY` for a chain that is configured with `baseFee: none` | The sender would pay for a flag that gives the runner nothing. |
| Native payout | `call{value}` with all gas, revert `NotPayable` on failure | `call` with 50,000 gas, wrapped token as fallback, then hand-off | The callback must never revert, and a receiver must not burn the gas. |
| Token payout | `safeTransfer`, reverts on failure | `trySafeTransfer`, hand-off to `failedDeliveryAddress`, and `HandOffRefused` with the tokens kept if that fails | A revert in the callback strands the tokens in the router. |
| Reentrant callback | `nonReentrant`, reverts | No revert: the router detects the guard state and hands the whole value of the nested callback off, after the tip when the terms decode, `DeliveryFailed(Reentered)` | A recipient payout hook can make the bridge deliver another message while a delivery runs. A revert would leave those tokens in the router. `sweep` stays guarded. |
| Order of payment | Recipient, then the fee | The tip, then the recipient | The tip rule of the failed delivery paths needs the tip first. |
| 20 byte legacy data | `require(_token == wNative)`, revert on another token | Pays the token to the receiver for any token that is not `wNative` | No revert, nothing stranded. |
| Data of another length, or a dirty address word | `abi.decode` reverts | Hand-off of the whole value, `DeliveryFailed(InvalidTerms)` | Same reason. |
| Recipient is the zero address or the router | Transfer to it | Tip by the terms, rest handed off | Nothing may burn. |
| `feeInfo` | `feeInfo(bool toNative, uint256 value, uint256 runner, FeeDirector)` | `feeInfo(address token, uint256 value, uint256 gasUsed, FeeDirector)` | The router decides `toNative` from the token, and the packed runner value does not exist. |
| `baseFee(bool)` | Present | Present, same meaning, no switch | Kept for compatibility. |
| `wNative` approval to the bridge | `approve(bridge, max)` in the constructor | None at rest. Each wrap approves the mediator for exactly the wrapped amount, and the mediator takes all of it in the same call, so the allowance ends at zero (decision 2026-10-27) | A standing maximum approval lets any bug or any call from the router move wrapped tokens that it holds later. |
| Unwrap for another token | Ignored by the contract | Ignored by the contract (plain token payout) and refused by the interfaces (the shared guard) | User decision 4. The contract stays total, the interfaces stop the mistake. |
| Unknown settings bits | Ignored | Ignored by the contract, refused by the interfaces | An unread bit is a mistake of the sender. |

The same idea works for arbitrary messages: a target contract that wants to pay executors can read the marker from the router slot and decide from its own payload. The bridge itself has no fee logic.

`transactionHash()`: OmniBridge returns the source transaction hash because validators sign it. Here it must be proven. The receipt proof already fixes the transaction index in the source block; proving the hash needs a second trie branch (transactions root, same index). Decision pending.

#### The call after a delivery, no claim records, no standing approval (decisions 2026-10-27)

These are user decisions of 2026-10-27, for `DeliveryRouter`.

1. **No claim records in the router.** `claimable`, `totalClaimable`, `claim`, `Claimed` and `NothingToClaim` are deleted. When `failedDeliveryAddress` cannot take a hand-off, the tokens stay in the router for good and the router emits `HandOffRefused(token, amount)`. `sweep(token)` stays and anyone may call it. With no records, it sends the whole router balance of the token to `failedDeliveryAddress`. If that push fails, it emits `HandOffRefused` and leaves the tokens where they are. The reentrancy guards stay.
2. **A user defined call after a successful delivery.** The flow: the mediator pays the router and calls `onTokenBridged` with the gas limit that the sender set. The router takes the tip and pays the recipient (unwrapping first when asked). Only when that payment succeeded, the router makes one call to a user defined target with user defined call data. The target may differ from the recipient.
   - The router makes the call itself. There is no executor contract.
   - A failed call does not revert the delivery and moves no tokens. The router emits `CallFailed(target, recipient, gasGiven)`. A call that has no spare gas also emits it, with `gasGiven` of zero.
   - The router skips the call when the payment failed and the amount was handed off, when the tip left nothing to pay, when the data has fewer than 20 bytes after the director, and for the 20 byte legacy form. A direct delivery (no router starting gas) pays no tip and still makes the call.
   - The call carries no native value. The router reads no answer, so a target cannot spend the reserve on a large answer.
   - Gas: the call gets the gas that is left, less `CALL_GAS_RESERVE` of 10,000. The router keeps the reserve to emit `CallFailed` and to leave the callback. Measured with a target that burns all its gas (`DeliveryRouterGas.t.sol`): the router needs between 3,361 and 3,586 gas after the call returns (two measures, one inside a test harness and one from outside), so the reserve is about 2.8 times the need. The first version read `gasleft()` twice in the reserve check, and a supply within 21 gas of the threshold made the subtraction underflow and revert the callback. A test caught it, and the router reads `gasleft()` once now. The measure is valid while a 64th of the gas at the call is below the reserve (the call is capped at 63/64 of the gas that is left, and the 64th that the router keeps is larger above 640,000 gas).
   - The gas tip counts the call. The router takes the tip before it pays the recipient and before the call, so the measure `startingGas - gasleft()` at the tip cannot cover the call by itself. This was checked, and it did not. When data asks for a call, the router now adds the gas that the call may use to the measure: the gas left at the measure, less the payout overhead and `CALL_GAS_RESERVE`. With a call, the gas based tip therefore reaches up to what the deliverer made available, whether the target burns the gas or not, and `limit` stays the only bound, as it was. A tip counts the allowance even when the payment later fails and the call does not run. The overhead constants were checked against the gas that runs after the measure (the tip transfer, the recipient payment and the exit of the guard). `TOKEN_GAS_OVERHEAD` of 100,000 holds: 53,740 gas runs after the measure with two new accounts. `NATIVE_GAS_OVERHEAD` of 50,000 did not hold: 71,598 gas runs after the measure when the recipient and the reward address are both empty accounts (44,097 with one new account, 16,597 with none), because a coin sent to an empty account costs more. `NATIVE_GAS_OVERHEAD` is now 100,000, equal to the token constant (figures in `DeliveryRouterGas.t.sol`).
   - Encoding of the data of `relayTokensAndCall` to a router: the 128 byte `FeeDirector` first. Optional bytes follow: the 20 byte target, then the call data, which fills the rest. A director with no extra bytes means delivery only. A tail of 1 to 19 bytes means delivery only for the router, and the shared guard refuses to build it. The 20 byte legacy form stays and carries no call. `explorer/shared/src/delivery-terms.ts` is the one TypeScript module that encodes and decodes this, with vectors that the compiled router printed. The terminal and the web page have an optional target field and an optional call data field, empty by default.
   - What the call can reach. The call comes from the router, so the target can reach only what the router holds when it runs: after the tip and the payment that is stray tokens, which anyone may already sweep. A sender can also name a token as the target with `transfer` call data, and the router then moves its stray balance of that token. The router holds no allowance for a target to use. Delivered value is never reachable, because the router pays it out before the call.
3. **No standing approval.** The constructor no longer approves the mediator for the maximum wrapped native amount. Each wrap and send approves exactly the amount that it wraps. The mediator takes all of it in the same call, and a test checks that the allowance ends at zero for every entry point.

#### Decisions (2026-10-24, later)

- **`transactionHash()` is proven.** `MessageProof` carries a second Merkle Patricia trie branch from the execution header's `transactionsRoot` to the transaction at the same index as the proven receipt. The bridge hashes the transaction bytes and exposes the result through `transactionHash()` during the call. A mismatch between the two indexes is refused.
- **A failed release is final (decided 2026-10-27; this replaces the fallback address of 2026-10-24).** The message carries no fallback address. On delivery the mediator tries the recipient once. If the transfer fails, it emits `ReleaseFailed` and stops. The message stays delivered. The handlers have the OmniBridge signatures only (`handleNativeTokens`, `handleNativeTokensAndCall`, `handleBridgedTokens`, `handleBridgedTokensAndCall`, `deployAndHandleBridgedTokens` and `deployAndHandleBridgedTokensAndCall`), and the payload is the OmniBridge payload byte for byte. `relayTokens`, `relayTokensAndCall` and `onTokenTransfer` keep their signatures.
- **The bridge has no executor entry point and no executor fee.** Anyone may call `executeMessage(MessageProof)`. Executors set their own fees on top of the bridge's optional fee switch, with their own router that records the runner and starting gas, executes the message, and takes its fee in `onTokenBridged` from a `FeeDirector` in the payload. This repository ships such a router as an optional helper that reads the `FeeDirector` delivery terms, but the bridge and the mediator do not depend on it.

### Gate evidence: confirm, then send (user decision, 2026-10-24)

A send carries no gate evidence, and the bridge has no new send method for it. `MessageBridge` calls `depositGate.admit("")` on every send. On an enforcing gate, a send in an epoch that nobody confirmed reverts with `ForkNotConfirmed(epoch)`.

The pattern is simple. **The first poster in an epoch confirms it, and later posters in the same epoch just send.**

1. The first poster calls `BeaconForkGate.confirm(evidence)`. The call is open to anyone. It needs no key. The gate stores the epoch and emits `ForkConfirmed`.
2. The same poster then sends. This can be a second transaction, or the same transaction (see below).
3. Every other sender in that epoch sends with no `confirm`. The gate reads one storage slot and admits the send.
4. In the next epoch the gate refuses again, until someone confirms that epoch.

Anyone may confirm, so a keeper can confirm each epoch as well. The first poster is the default, because a keeper costs about 225 transactions a day. An application may wrap both calls in its own contract.

A general multicall works, with one rule. Inside a multicall, `msg.sender` of the send is the multicall contract. So the multicall is the `messageSender()` that an arbitrary message shows to its target. For a token relay, the mediator pulls the tokens from `msg.sender`, so the multicall must hold the tokens (or hold an allowance from the user) and the user must send them to it first. A target that checks the sender of a message must expect the multicall contract and not the user.

Costs, measured with `forge test` (gas of the call, without the base cost and the calldata): `confirm` with a proof costs 42,748 gas at state depth 6 and 40,069 at depth 5. About 8,000 gas of that is the second branch, the one of `genesis_validators_root`; the version branch alone cost 34,738 and 33,034. A send in a confirmed epoch pays 3,022 gas more than a send through a gate that admits everything. A send in detection mode, before the beacon roots contract exists, pays about 745 gas for the probe.

Tests: `test/hardened/BridgeWorld.t.sol` shows the whole pattern on an enforcing gate with the real `MessageBridge`. A send in an unconfirmed epoch is refused, the first poster confirms and sends, a second sender in the same epoch sends with no `confirm`, the next epoch is refused again, and a message from the epoch is delivered on the other chain. It also shows a multicall (the receiver sees the multicall as the sender). `test/hardened/BeaconForkGate.t.sol` holds the gate rules and the unit level version of the pattern.

### As built (2026-10-24)

The build follows the design. This list holds every place where it differs from the design text above, or where the design left a choice open.

**Names and shapes**
- The OmniBridge names are used throughout: `requireToPassMessage`, `requireToConfirmMessage`, `UserRequestForAffirmation`, `executeMessage` (new), `AffirmationCompleted`, `messageSender`, `messageId`, `messageSourceChainId`, `transactionHash`, `messageCallStatus`, `failedMessageDataHash`, `failedMessageReceiver`, `failedMessageSender`, `maxGasPerTx`, `sourceChainId`, `destinationChainId`. The mediator keeps the OmniBridge functions, events and handler names. There is one `IAMB` (`src/hardened/IAMB.sol`). The mediator and `MessageBridge` both use it.
- `requireToConfirmMessage` differs from `requireToPassMessage` only in the data type byte (`0x80`). Both are delivered the same way.
- The nonce of the sender feeds the message identifier, in the OmniBridge format: version `0x00050000`, twenty bytes of the hash of the source chain and the bridge, and an eight byte nonce. It implies no order.
- The message names a destination chain and a target. It does not name a destination bridge, as the vault log did. A second bridge on the destination chain that trusts the same remote bridge delivers the same message to a target of its own, through its own delivery book. A target must therefore trust one bridge only, with `msg.sender == bridge`. The mediator does so, and `test_secondBridge_*` in `MessageBridgeGaps.t.sol` shows it refuses a handler call from another bridge with `NotBridge`.

**Gas**
- `MAX_GAS_PER_TX` is 10,000,000. `MIN_GAS_PER_CALL` is 100. The send refuses a gas value outside this range with `GasOutOfRange`.
- The gas guard keeps back `gasLimit + gasLimit / 63 + 1 + EXECUTION_OVERHEAD_GAS` (100,000). The call to the target forwards exactly the gas of the message. A test reads the gas at the first instruction of the target and finds the message gas to within 200 gas.
- The mediator asks for 250,000 gas for a release, 1,000,000 with a callback, 2,000,000 for a deployment of a copy, and 2,750,000 for both. These are the defaults. The sender can ask for more (see "Mediator" below). The mediator constructor reads `maxGasPerTx()` of its bridge and reverts with `GasLimitAboveBridgeMaximum` when the bridge allows less than the largest default message. A test of the deploy script checks the same fact on the deployed pair.
- The send refuses a call whose data starts with the selector of `transfer`, `approve`, `transferFrom`, `approveAndCall` or `transferAndCall` (`ForbiddenSelector`). OmniBridge does the same, so that a bridge cannot move the tokens of a contract that approved it.

**Order and context**
- A send checks, in this order: the lock, the cutoff, the gas range, the selector, the gate. The vault called the gate first. The gate is last because it is the only check with a cost and a side effect. A test pins the order.
- `executeMessage` is not reentrant. A call during a delivery reverts with `MessageInProgress`. A target may send messages during its delivery. Sends do not touch the context.
- `transactionHash()` is proven. `MessageProof` carries the transaction branch, and the receipt index and the transaction index must be equal (`IndexMismatch`).
- The layout rows live in the bridge, in the storage that `BeaconProofVerifier` reaches through three hooks. The deposit lock moved with them: `openDeposits`, `depositsOpen` and `DepositsNotOpen`.
- The runtime size of `MessageBridge` is 22,465 bytes. It has 2,111 bytes of room under the limit of 24,576. A new feature in the bridge needs a check of the size first.

**Fees and executors**
- There is no `IMessageFee` and no `feeContract`. The bridge has no executor fee. `DeliveryRouter.executeMessage(MessageProof proof)` wraps `MessageBridge.executeMessage`. Anyone may call it, and the tip goes to the immutable `rewardAddress` (decision 2026-10-26: no runner whitelist, no `reward` argument, so a copied delivery gains the copier nothing; the router has no owner and no setter). It stores the starting gas in the marker slot, and `onTokenBridged` pays the tip from a `FeeDirector` to the reward address. It reverts when the delivery fails. There is no batch entry in the router. The runner batches with the generic Multicall3 contract (`mds1/multicall`, vendored in `src/hardened/vendor/multicall3`, canonical address `0xcA11bde05977b3631167028862bE2a173976CA11`): `aggregate3` with `allowFailure` set on each call. One call goes to `update(proof, publicValues)` of the light client and comes first. The others go to `executeMessage(proof)` of the router. A failed call returns its revert data and never reverts the others. The router does not read the caller, so Multicall3 works with no special rule. The bridge refusals `AlreadyDelivered`, `InsufficientGas` and `AnchorNotStored` fail one call and nothing more. A message whose target reverts counts as executed: the bridge marked it delivered, and the bridge records the target failure. Every tip, also a gas based one, is paid in the callback. A gas based tip is measured in the callback from the starting gas that `executeMessage` stored. `DeliveryRouter` explains the rule in its comment.

**Mediator**
- `TokenMediator` creates its `TokenFactory` in its own constructor. The factory sits at the first `CREATE` address of the mediator. The deploy script predicts it and reads it back. It does not deploy a factory of its own.
- A copy takes the name `<native name> from <home chain name>` (for example `Wrapped Ether from Ethereum`) and the symbol prefix `zkb` with no separator (`zkbWETH`) (decision 2026-10-26). The home chain name is the `remoteChainName` constructor term of the mediator. The mediator passes it to its factory, which stores it once (`TokenFactory.homeChainName()`), with no setter. The deploy configuration holds it per chain. The salt of the copy is `keccak256(homeChainId, homeToken)`.
- A failed release emits `ReleaseFailed` and nothing else. The record of a native token falls by every release, paid or failed, so `mediatorBalance(token)` equals the supply of the copy on the other chain plus the messages in flight. The balance of the mediator is at least the record, and the surplus is the sum of failed releases and plain transfers.
- A defect that the invariant tests found: `_tryRelease` wrote a stale copy of the record back after a refused transfer. A hostile token could relay tokens from inside `transfer` and then refuse, and the write erased the nested lock. The function now writes to storage after the call. `test_aTokenThatRelaysDuringAReleaseAndThenRefusesKeepsTheNestedLock` covers it.
- **The sender sets the gas limit (2026-10-27).** OmniBridge sets the gas limit for each selector and token through an owner. This mediator has no owner, so the sender chooses. The entry points of OmniBridge (`relayTokens`, `relayTokensAndCall`, `onTokenTransfer`) keep the default limits. Two new overloads take a trailing gas limit: `relayTokens(token, receiver, value, gasLimit)` and `relayTokensAndCall(token, receiver, value, data, gasLimit)`. All arguments are positional and there is no struct. The gas limit of the message is the larger of `gasLimit` and the default of the message kind. A value of zero gives the default. A value above `maxGasPerTx()` of the bridge reverts with `GasLimitAboveBridgeMaximum(gasLimit, maximum)`. The mediator never reads `data`: a router that puts a fee schedule in it owns the meaning. The sender pays for the gas that it asks for, and nobody else.
- **A token that uses too much gas cannot make the handler revert (2026-10-27).** The bridge marks a message as delivered whether or not the call works. A handler that reverts loses the tokens for good. The call into a native token used to take all the gas but 1/64. A token that burned all of it left too little gas for what follows, so the handler reverted. Now the transfer attempt gets the gas that is left, less `TRANSFER_GAS_RESERVE`. A transfer that fails, for any reason, is a failed release and the handler goes on. The call reads at most 32 bytes of the answer, so a token cannot spend the reserve on a large answer. **Measured reserve.** `forge test --isolate`, with the real bridge and a token that runs the INVALID opcode. The figure was measured when a claim record was written; with no claim record the handler needs less after the attempt (the event of a failed release, about 2,000 gas), so the constant of 60,000 stays as a wide margin. The tests `TokenMediatorHostileGas.t.sol` check the outcome. A token that needs more gas than the message gives (the test token burns 300,000 against the default 250,000) ends with a failed release, and the same token is paid when the sender asks for 800,000. A delivery that reaches the transfer with no more than the reserve left makes no call to the token and ends as a failed release (`TokenMediatorGaps.t.sol`).
- **The deploy gas follows the length of the name and symbol (2026-10-27).** The copy stores the name and the symbol, and the factory holds them while it deploys, so the cost grows with their length. Measured: 1,058,000 gas for a short name when each call is its own transaction and 1,153,000 in one test transaction. Each byte of name and symbol together costs 1,142 gas (isolated) to 1,419 gas (one transaction). A fixed limit of 2,000,000 ran out at about 627 bytes, and then every later relay of that token failed. On the source side, the default limit of a first message is the larger of `DEPLOY_GAS_LIMIT` (2,000,000) and `DEPLOY_GAS_BASE` (1,300,000) plus `DEPLOY_GAS_PER_BYTE` (1,600) for each byte of name and symbol. It is above 2,000,000 from 437 bytes. The callback limit comes on top for a first message with a call. A name so long that the limit passes the maximum of the bridge (above 5,437 bytes) is refused at the source with `GasLimitAboveBridgeMaximum`, before any token moves. A test deploys a 5,000-byte name through the real bridge. The sender can still ask for more gas.
- **Decimals (2026-10-27).** Amounts are integers everywhere. Decimals are metadata that the copy takes when it is created, and nothing else reads them. The source refuses the first relay of a token whose `decimals()` returns more than 255: `TokenReader.DecimalsOutOfRange(token, value)`. The old reader returned 0 for such a value. The destination refuses a deploy message whose decimals are above 255 too: the four `deployAndHandle...` handlers take a `uint8`, so the decoder of the call reverts before the handler runs, no copy is made and the message fails. A mediator of this repository never sends such a message, because the source refuses first. The mediator runs on both chains, so both sides check. **A missing `decimals()` is still read as 0.** The rule is kept: when both selectors fail or return less than one word, the copy has 0 decimals. A holder loses nothing but the display, because the amounts are exact integers.
- **A recipient may be a contract (2026-10-27, by design).** This is an arbitrary message bus. Contract senders, routers and contract recipients are allowed, and a release to a contract such as Multicall3 works as a release to any account. The payload names the receiver only, so a contract sender need not exist on the other chain. A test shows two messages through Multicall3 with the same payload.
- **No fallback in the mediator, and no claim records (2026-10-27).** The mediator does not carry a fallback recipient in its message and does not take one in calldata. `relayTokensWithFallback`, `relayTokensWithOptions` and the `RelayOptions` struct are deleted, with the six `...WithFallback` handlers, the `FallbackUsed` event and `ZeroFallback`. A release that the recipient cannot take is final: the mediator emits `ReleaseFailed` and keeps the tokens, and there is no `claim`, no `claimable` mapping and no claim event. The mediator never pays anyone but the recipient. Fallback handling, if wanted, belongs in a router, as an opt-in option and never as a default. "If tokens get stuck, they are stuck for good." **Books of the two chains.** The record of a native token falls by the value of every release, paid or failed, because the other chain burned the copies when it sent the message. The balance of the mediator is at least the record, and the surplus belongs to nobody. **Bridged copies.** A failed release of a copy mints nothing. The mint of `BridgedToken` has no block list and no pause, so it fails only for the zero address, and a sender cannot name that address (`InvalidReceiver`). Only a forged message could reach that case, and the native tokens would then stay locked on the other chain. A test shows it.

**Deploy script and tools**
- `DeployBridge.s.sol` deploys the stack of each chain with predicted addresses (see "Launch sequence"). The configuration has no token pairs. It gains `wrappedNative` and `deployDeliveryRouter` per chain. When `deployDeliveryRouter` is `true`, the chain also needs `deliveryRouter.rewardAddress` (the one address that receives the tips) and `deliveryRouter.failedDeliveryAddress` (the address that receives what the router cannot deliver; it may equal the reward address). The script refuses a placeholder or the zero address for either, passes them to the constructor, and reads them back (`DeploymentMismatch("deliveryRouter.rewardAddress")` or `DeploymentMismatch("deliveryRouter.failedDeliveryAddress")` on a difference). Each chain also needs `remoteChainName`, the name of the other chain (for example `PulseChain` on the Ethereum side), which the mediator stores for the names of its copies. The script reads it back from the factory.
- The prover `evidence` command builds `executeMessage` calldata for a message, with the layout prerequisites and the delivery status. `lc-core` has `message::verify_message`, the native twin of `MessageBridge.executeMessage`. A fixture set in `light-client/tests/fixtures/message/` (91 cases) runs through both implementations. `test/hardened/LightClientFixtures.t.sol` requires them to agree on accept and reject.
- The real chain fixtures hold transaction hashes and not transaction bytes. So real data stops before the transaction proof in the Rust tests. The prover needs a source node that serves `eth_getRawTransactionByHash`.

**Tests added for the build**
- `test/hardened/BridgeWorld.t.sol`: two chains in one test, with the real bridge and the real mediator on each side and proofs built from real logs (`utils/DynamicProofs.sol`, `utils/TrieBuilder.sol`, `utils/ReceiptBuilder.sol`). A token round trip, an arbitrary message, the delivery router with any caller, the gate pattern, and a multicall.
- `test/hardened/mediator/DeliveryRouterHandOff.t.sol`: each hand-off, with no claim records. A token that refuses the recipient (the tip is paid, the rest goes to the failed delivery address, `DeliveryFailed` names the recipient); a direct delivery to a refused recipient (no tip, whole value handed off); a gas based refund that the token refuses; a token that blocks the failed delivery address too (`HandOffRefused`, the tokens stay in the router, nothing is recorded, a later `sweep` pays once the token allows the address).
- `test/hardened/invariant/MediatorRouterInvariant.t.sol` (handler in `utils/RouterHandler.sol`): the handler sends terms that name the router, the zero address or data of odd length, the legacy form for any token, and the deny list token (which may also block the failed delivery address) through the delivery routers. Invariants: see the file header (the router holds no coin, and its token balance is exactly what refused hand-offs and stray transfers put there).
- `test/hardened/mediator/DeliveryRouterCall.t.sol` (targets in `utils/CallTargets.sol`): the call after a delivery. A successful call (exact data, sender is the router, no value, target is not the recipient); a reverting target; a target that burns all its gas (the router finishes, the tip and the payment stand); a target that calls `executeMessage`, `sweep` and `onTokenBridged` (each fails, the delivery stands); a target that tries to take tokens (only stray tokens are reachable, and the allowance is zero); the call skipped after a failed payment; a native unwrap with a call; a gas based tip that includes the call.
- `test/hardened/mediator/DeliveryRouterReentry.t.sol`: a recipient payout hook that delivers a second message during a delivery. The second callback is handed off as `Reentered` after its tip, the router holds nothing, and a stranger still gets `NotMediator`. The invariant handler (`deliverReentrant`) covers it for the router balance and the money split.
- `test/hardened/mediator/DeliveryRouterBatching.t.sol`: Multicall3 and the delivery router through the real bridge, the real mediator and real proofs. An update and good messages with one refused proof (the others deliver, and the refusal carries the exact revert data); an already delivered message that fails alone; a target that reverts (the bridge records it); a delivery by an arbitrary caller (the tip reaches the reward address); an empty list; a gas based tip that the callback of each call pays; the update call (permissionless, and a failed or repeated update does not stop the messages); the gas of one update and two messages. `DeliveryRouter.t.sol` also shows that a copy of a delivery pays the same tip to the reward address.
- `test/hardened/MessageBridgeShapes.t.sol`: every receipt type, high transaction indices, long log lists, two messages in one receipt, and transaction branch checks.
- `test/hardened/MessageBridgeGaps.t.sol`: the checks that the vault tests held and that had no counterpart.
- `test/hardened/mediator/TokenMediatorGasLimit.t.sol`: the gas limit of the sender. The existing entry points keep the default of each message kind. A request above the default is used exactly, a request below it (zero, one, one less) gives the default, a request above the maximum of the bridge reverts and moves nothing, the overloads keep the receiver and amount checks, the payload does not change with the gas limit, the data passes through unchanged, and a callback that needs more than the default gas runs only when the sender asks for more.
- `test/hardened/mediator/TokenMediatorHostileGas.t.sol` (tokens in `utils/HostileTokens.sol`): the real bridge and a token that burns 300,000 gas on transfer, a token that runs the INVALID opcode (with the default gas and with 5,000,000), a token that reverts on every transfer, and a blocked recipient. Each ends with the handler not reverting, one `ReleaseFailed` event, no payout, the record lowered by the release and the whole amount still in the mediator. Unblocking the recipient later pays nothing. The heavy token is paid when the sender asks for 800,000 gas, and `relayTokensAndCall` with a gas limit pays a contract recipient that the default gas cannot.
- `test/hardened/mediator/TokenMediatorDeployGas.t.sol`: a 5,000-byte name deploys through the real bridge and a later message of that token delivers; the limit of the message follows the rule for six lengths of name and symbol; a first message with a call adds the callback limit; a name beyond the bridge maximum is refused at the source.
- `test/hardened/mediator/TokenMediatorDecimals.t.sol` and `TokenReader.t.sol`: decimals above 255 are refused at the source and at the destination in all four deploy forms, 255 passes, and a token with no `decimals()` gives a copy with 0 decimals.
- `test/hardened/mediator/TokenMediatorMetadata.t.sol` and `TokenMediatorPause.t.sol`: a token with only a name, only a symbol, or `bytes32` metadata, bridged there and back with exact events and balances; a pausable token (`src/mocks/PausableToken.sol`, the OpenZeppelin `ERC20Pausable` pattern) frozen during a release (`ReleaseFailed`, the record lowered, the tokens still in the mediator, nothing paid after the unpause); a contract recipient (Multicall3) paid, and a contract recipient that the token refuses (final failure); a contract sender whose two messages carry the same payload.
- `test/hardened/mediator/TokenMediatorGaps.t.sol`, `TokenMediatorInvariant.t.sol`, `TokenMediatorFuzz.t.sol`: token behaviour, the limiter and fee rules, and the solvency invariants of the mediator.

**Gas of the stack** (`forge test`, one transaction per test, without the base cost and the calldata; `--isolate` figures in brackets): a token round trip costs 2,065,511 gas in four steps (2,146,744): send on chain A 155,589; execute on chain B with the deployment of the copy 1,423,690; send on chain B 90,499; execute on chain A 395,733. A later relay of the same token costs 410,423 to execute on chain B in the short form. An arbitrary message costs 37,405 to send and 484,919 to execute, 522,324 in all (588,844).

## Fork gate by shape (2026-10-27) (built)

This section supersedes the gate notes in the 2026-10-20 sections above ("seal depths 5, 6, 7 and the marker 255",
`supportedVersions`). The full design is in `docs/light-client-layout/`.

- The gate keeps no list of version names. It accepts any fork version whose state proof has an allowed shape (plain depth
  5, 6 or 7, or the Gloas progressive form) when the branch of `genesis_validators_root` (state field 1) also holds at
  that shape under the same state root. `ForkShape.sol` holds the one rule for both chains.
- A seal needs a valid proof of a plain depth from 8 to 31. A proof at an allowed shape never seals.
- On PulseChain the fork observation program proves the shape the same way and outputs it (256 bytes, eighth word
  `shape`). It can now report plain depths 8 to 31, so the registry can record a disallowed shape: the gate then refuses
  deposits, and `seal()` with empty evidence succeeds.
- The light-client program accepts depth 7 too, because the genesis validators root branch pins the depth.
