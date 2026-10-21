# Build contract for the hardened bridge

This document fixes the names, paths, and interfaces for two pieces of work that run in parallel:

1. A red team of revision 2 of the specification (`spec/revision-2/`).
2. A hardened bridge that fixes the holes that revision 2 left open.

Read `docs/red-team.md` first. It lists holes H-01 to H-23 against revision 1.

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

- `constructor(address verifier, bytes32 programVKey, bytes32 genesisValidatorsRoot, uint64 slotsPerPeriod, uint64 initialSlot, bytes32 initialHeaderRoot, bytes32 initialSyncCommitteeHash, bytes32 initialNextSyncCommitteeHash)`. The initial checkpoint is the one trust assumption. Anyone can check it against public beacon data.
- `function update(bytes calldata proof, bytes calldata publicValues) external`. Checks, in this order, with custom errors: the genesis validators root matches; the previous head, header root, and committee match stored state; `newHeadSlot > head`; `newHeadSlot` is no more than one period past the head (the committee must be known); the committee for the new period matches when already stored; then `verifier.verifyProof(programVKey, publicValues, proof)`. Then it stores the header root, marks the execution block hash finalized with its block number, stores the committees, moves the head, and emits `HeadUpdated(uint64 indexed slot, bytes32 indexed headerRoot, bytes32 indexed executionBlockHash)`.
- Views: `head()`, `headers(uint64 slot)`, `syncCommittees(uint64 period)`, `isFinalizedExecutionBlock(bytes32 blockHash) returns (bool)`, `executionBlockNumber(bytes32 blockHash) returns (uint64)`, `periodOf(uint64 slot)`.
- Gas: one proof check per update, no matter the committee size (fixes H-15). Measure it.
- No owner, no upgrade path, no pause.

### `src/hardened/BridgeVault.sol`

Event (3 indexed parameters, fixes R2-01; same signature as revision 1):

```solidity
event DepositInitiated(address indexed token, address indexed sender, address indexed recipient, uint256 amount, bytes32 nonce, uint64 targetChainId);
```

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
    bytes32 sourceBlockHash;
}
```

- `constructor(address verifier, bytes32 withdrawalVKey, address lightClient, uint64 localChainId, uint64 remoteChainId, address remoteVault, TokenPair[] memory pairs)` with `struct TokenPair { address localToken; address remoteToken; uint8 remoteDecimals; }`. The constructor requires `localChainId == block.chainid`, a non-zero `remoteVault`, and `IERC20Metadata(localToken).decimals() == remoteDecimals` for each pair (fixes R2-07). The remote decimals value is the deployer's claim. The deploy script must read it from the remote chain.
- `deposit(address token, address recipient, uint256 amount)`: the target is always `remoteChainId` (fixes H-10). It requires a registered local token, a non-zero recipient, and a non-zero amount. It measures the received balance (fee-on-transfer) and uses `SafeERC20`. Nonce: `keccak256(abi.encode(block.chainid, address(this), depositCount++))`. It emits the received amount.
- `withdraw(bytes calldata proof, bytes calldata publicValues)`: decodes `WithdrawalOutput`; requires `sourceChainId == remoteChainId`, `targetChainId == localChainId`, `sourceVault == remoteVault`, an unclaimed nonce, `lightClient.isFinalizedExecutionBlock(sourceBlockHash)` (fixes H-08), and a registered `sourceToken`; calls `verifier.verifyProof`; marks the nonce; pays the mapped local token with `SafeERC20`; emits `WithdrawalCompleted`.
- No refund (see scope). No owner. Reentrancy is safe because state changes before the transfer. Add `ReentrancyGuard` (the storage version, not the transient one, because PulseChain has no `TSTORE`).

### `script/hardened/DeployBridge.s.sol`

The deploy script the specification should have shipped. Foundry script, run with `forge script … --broadcast`.

- Reads a JSON configuration (path from `BRIDGE_CONFIG`) holding both chains' RPC aliases, chain identifiers, the verifier address per chain, the program verification keys, the light-client checkpoints, and the token pairs.
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

### Withdrawal program: `verify_withdrawal(witness, expected_source_vault) -> WithdrawalOutput`

- `keccak256(header_rlp) == source_block_hash`. Decode the header for both Ethereum (Prague fields) and PulseChain (Shanghai fields).
- Prove the receipt with `alloy_trie::verify_proof(receipts_root, Nibbles::unpack(rlp(tx_index)), Some(receipt_bytes), proof)` (fixes R2-04).
- Decode the receipt as an EIP-2718 envelope (fixes R2-05) and require success status.
- Take the log at the witness's `log_index` (fixes R2-06). Require `log.address == expected_source_vault` and `topic0 == DEPOSIT_EVENT_TOPIC`, computed from an alloy `sol!` event declaration, never hardcoded (fixes R2-02).
- Decode token, sender, recipient from topics, and amount, nonce, target chain from data.

### Tests

- Real data: verify real Ethereum light-client updates and real PulseChain sync-committee signatures fetched from public beacon APIs, saved as fixtures under `light-client/tests/fixtures/`. Prove real type 0 and type 2 receipts from both chains.
- Tampering: flip a signature bit, use the other chain's fork version or genesis validators root (cross-chain replay, H-01), drop to 341 participants, corrupt each branch, use the wrong fork's generalized index, submit an unfinalized header, use a log from another emitter, use a wrong log index.
- Synthetic: where real PulseChain data cannot be fetched (for example the finality branch, because the light-client endpoints return 404), build Capella-layout fixtures with a test-only state builder and generated keys.

## Harness (`harness/`)

- Chain B (the PulseChain role, id 369) runs Anvil with `--hardfork shanghai`. Chain A (id 1) keeps `prague`.
- Add hardened tests under `harness/test/hardened/` on two Anvil chains: the happy path both ways, the fake emitter (H-02), the same-address token (H-03), an unfinalized block after a reorganization (H-08), cross-chain replay of a light-client output (H-01), a deposit and withdrawal with a second deposit in the same transaction (R2-06), a typed receipt (R2-05), the deploy procedure with predicted addresses (R2-08), and `MCOPY` bytecode failing on chain B while the Shanghai build works (R2-10).
- The reference light-client prover models finality: it emits a `LightClientOutput` only for a block that is at least a fixed number of blocks deep, and it signs with the oracle key.
