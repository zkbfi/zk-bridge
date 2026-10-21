# Specification deviations

This file lists every change between `spec/Smart contracts/*.sol` and the copies in `src/`.

## Source files

| Specification file | Copy | Change |
|---|---|---|
| `spec/Smart contracts/LightClientSync.sol` | `src/LightClientSync.sol` | Line endings only |
| `spec/Smart contracts/ZKBridgeVault.sol` | `src/ZKBridgeVault.sol` | Line endings only |

### Line endings

- Before: the specification files use CRLF line endings.
- After: the copies use LF line endings (`tr -d '\r'`).
- Why: LF is the repository norm, and Solidity treats both the same. No other byte changed.

### Compilation changes

None. Both files compile as delivered with solc 0.8.28, evm version cancun, optimizer on (200 runs), against OpenZeppelin Contracts v5.7.0. Their `pragma solidity ^0.8.20;` accepts that compiler. The imports `@openzeppelin/contracts/...` resolve through `remappings.txt`.

`forge build` prints two `erc20-unchecked-transfer` lint warnings for `ZKBridgeVault.sol` lines 74 and 106. They match hole H-13 and were left unchanged on purpose.

## Dependencies

- `lib/forge-std`: installed with `forge install` as a git submodule.
- `lib/openzeppelin-contracts`: tag `v5.7.0`, cloned shallow, with its `.git` directory removed. It is vendored as plain files, not a submodule, because `forge install` could not resolve the tag in this environment.

## Revision 2

This section lists every change between `spec/revision-2/Smart contracts/*.sol` and the copies in `src/revision-2/`, and every addition that the revision 2 red team needs.

### Source files

| Specification file | Copy | Change |
|---|---|---|
| `spec/revision-2/Smart contracts/LightClientSync.sol` | `src/revision-2/LightClientSync.sol` | Line endings only. Byte for byte equal to the specification after `tr -d '\r'`. `checks/revision-2/r2-01-vault-compile.sh` asserts this. |
| `spec/revision-2/Smart contracts/ZKBridgeVault.sol` | `src/revision-2/ZKBridgeVault.sol` | Line endings, plus the two compile repairs below. |

Line endings: the specification files use CRLF, the copies use LF. No other byte changed outside the repairs below.

### Repair 1 (R2-01): `indexed` removed from `nonce`

- Before (line 49): `event DepositInitiated(address indexed token, address indexed sender, address indexed recipient, uint256 amount, bytes32 indexed nonce, uint64 targetChainId);`
- After: `event DepositInitiated(address indexed token, address indexed sender, address indexed recipient, uint256 amount, bytes32 nonce, uint64 targetChainId);`
- Why: Solidity allows 3 indexed parameters. The verbatim file fails with error 7249 ("More than 3 indexed arguments for event"). Removing `indexed` from `nonce` is the smallest change. It gives the layout that `main.rs` reads: 3 indexed topics after topic 0, and `data = amount, nonce, targetChainId`.
- The signature is unchanged, so topic 0 is unchanged: `keccak256("DepositInitiated(address,address,address,uint256,bytes32,uint64)")` = `0x9bab...eaf5`.
- Evidence that the verbatim file fails: `checks/revision-2/r2-01-vault-compile.sh` copies the specification file to a temporary directory and asserts that `forge build` fails with 7249.

### Repair 2 (R2-11): `withdraw` split to avoid "Stack too deep"

- After repair 1 the vault still does not compile with the repository settings (solc 0.8.28, optimizer on, no `viaIR`). The compiler stops with `Stack too deep` at `sp1Verifier.verifyProof(programVKey, publicInputsBytes, proof);` (line 131). The cause is eight decoded locals plus four calldata slots in one function.
- Change: the first half of `withdraw` moved into a new `internal view` function `_checkContextAndProof(bytes calldata proof, bytes calldata publicInputsBytes)`. It decodes the tuple with the unused fields skipped and runs, in the same order: the source chain check, the source vault check, the target chain check, the nonce check, the light client check, and `verifyProof`. `withdraw` calls it, decodes the four fields it still needs (`tokenAddress`, `recipient`, `amount`, `depositNonce`), and continues unchanged (mark nonce, registry lookup, `safeTransfer`, event).
- No require message, order of checks, storage write, or external call changed. All revert strings are identical.
- Alternative that was not taken: `via_ir = true` in `foundry.toml`. That file belongs to the coordinator, and it would change the code generator for the whole repository.
- Evidence: the check script runs a second build with only repair 1 applied and asserts the `Stack too deep` error.

### Contract names

No rename was needed. `src/revision-2/` holds contracts with the same names as `src/` (`LightClientSync`, `ZKBridgeVault`, `ILightClientSync`, `ISP1Verifier`). Forge accepts this. It writes the artifacts of the copies in `out/revision-2/`. Tests import by path, for example `../../src/revision-2/ZKBridgeVault.sol`.

### Additions (not specification code)

| Path | What it is |
|---|---|
| `src/revision-2/mocks/RealShapeOracleVerifier.sol` | Verifier double with the real gateway shape `verifyProof(bytes32,bytes,bytes)`. It reverts with `InvalidProof` unless the proof is the oracle's signature over `keccak256(programVKey, sha256(publicValues))`. |
| `src/revision-2/mocks/DecimalsToken.sol` | ERC-20 with configurable decimals, for R2-07. |
| `checks/revision-2/circuit-probe/` | A plain cargo package. `stub/` is a local stand-in for `sp1_zkvm` (three functions and a macro, inputs from stdin). It is NOT the SP1 crate. No SP1 toolchain is installed. |

### Changes to `main.rs` for the compile evidence

The check compiles `spec/revision-2/bridge circuits/src/main.rs` in two forms. The verbatim form (line endings changed to LF) shows the compiler errors. The repaired form applies `checks/revision-2/circuit-probe/compile-fixes.patch` and deletes the `#![no_main]` line. The patch changes the API calls and nothing else:

| Line (verbatim) | Change | Reason |
|---|---|---|
| `use alloy_consensus::Receipt;` | adds `ReceiptWithBloom` | The bare list receipt decodes through `ReceiptWithBloom<Receipt>`. `Receipt` alone has no `decode`. |
| `BridgePublicInputs::abi_decode(&bytes, true)` | the second argument is removed | `alloy-sol-types` 1.x dropped the `validate` flag. |
| `alloy_trie::verify_proof(root, &key, proof)` and `assert_eq!(verified_value, ...)` | `alloy_trie::proof::verify_proof(root, Nibbles::unpack(&key), Some(expected_bytes), &proof_nodes)`, result checked with `expect`, the `assert_eq!` removed | R2-04. The function is in `alloy_trie::proof`. It returns `Result<(), _>` and takes the expected value as an argument. |
| `Receipt::decode(&mut &bytes[..])` | `ReceiptWithBloom::<Receipt>::decode(...).receipt` | R2-05. Same bare RLP list semantics as the original. A typed receipt still fails to decode. |
| `assert!(receipt.status, ...)` | `receipt.status.coerce_status()` | `status` is an `Eip658Value`, not a `bool`. |
| `log.topics().as_slice()` | `log.topics()` | `topics()` already returns a slice. |
| `#![no_main]` (generated copy only) | line deleted | The native binary needs its own entry point. The stub macro `entrypoint!` expands to nothing. |

Dependencies of the probe are pinned to exact versions, each published at least 28 days before 2026-10-20: `alloy-consensus 2.1.1`, `alloy-primitives 1.7.3`, `alloy-rlp 0.3.16`, `alloy-sol-types 1.7.3`, `alloy-trie 0.9.5`. `alloy-trie 0.9.8` (published 2026-09-29) and `0.9.7`, `0.9.6` (2026-09-21) are younger than 28 days and were not used. `Cargo.lock` pins the transitive packages. An age audit on 2026-10-20 found 41 of 287 locked registry packages younger than 28 days (for example `libc`, `syn`, `serde_json`, `zerocopy`, `smallvec`). The attempt to move them to older versions stopped when crates.io returned HTTP 429, and it left some of them downgraded. The remaining transitive ages are NOT verified. The coordinator should finish that audit before the lock file is trusted. The probe only builds and runs locally and never ships.

### New defects found in revision 2 (identifiers continue the R2 list)

| Id | Defect | Evidence |
|---|---|---|
| R2-11 | After the R2-01 repair the vault still fails to compile: `Stack too deep` in `withdraw`. | `checks/revision-2/r2-01-vault-compile.sh` |
| R2-12 | `period` is not tied to the header or to time. With `nextCommitteeRoot == 0` the committee never rotates but keeps attesting headers for any later period. | `test_R2_12_...` |
| R2-13 | The circuit pins an execution block hash (Keccak-256 of the header). A sync committee signs a beacon block root (SSZ, SHA-256). Nothing links the two, so an honest update never verifies the hash that the vault wants. | `test_R2_13_...` |
| R2-14 | The constructor lost the zero address checks of revision 1. A vault with a zero verifier or a zero light client deploys and can never pay. | `test_R2_14_...` |
| R2-15 | `deposit` does not check the recipient. A deposit to the zero address locks tokens, and the claim reverts for ever. | `test_R2_15_...` |
| R2-16 | There is no liquidity model (H-09, out of scope by decision). The paying vault pays from its own balance, and a proven claim reverts while it is empty. Mention only. | `test_R2_16_...` |

### Fixes of revision 1 holes that the tests confirm

H-01 (the next committee root is signed), H-02 and H-16 (source vault, source chain, target chain checks), H-03 (explicit registry and deposit allow list), H-07 (every attested root is stored), H-10 (supported chains), H-11 (`verifyProof` shape), H-12 (per-sender counter), H-13 (balance measurement and `SafeERC20`), H-14 (`tryRecover`). They hold in the tests named `*_fixConfirmed_*`. H-04, H-08, and H-15 remain open. The refund path (H-09) is not tested, by the user's decision.
