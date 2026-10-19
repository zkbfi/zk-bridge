# Red team of the zk-bridge specification

This document attacks the specification in `spec/`. The specification is a set of chatbot screenshots (`spec/Bridge*.jpg`) plus six code files. It describes an Ethereum ↔ PulseChain bridge that it calls "production-grade", "100% immutable", "adminless", "0% fee", and "user-validated".

Each hole has an identifier (`H-01` …). An executable test exists for each hole marked **Tested**. The test passes when the attack succeeds, so a green test means the specification fails.

Severity scale:

- **Critical** — an attacker steals locked funds, or every user's funds lock forever.
- **High** — the bridge breaks for real users, or one party controls it.
- **Medium** — loss for a subset of users, or a griefing attack with a cost.
- **Low** — defects that stop the build or the deployment, with no direct fund loss.

## Summary

| Id | Severity | Component | Hole | Tested |
|---|---|---|---|---|
| H-01 | Critical | Light client | The committee signs the header but not `nextCommitteeRoot`. Anyone can copy a valid update from the mempool and install their own committee. | Yes |
| H-02 | Critical | Vault, circuit | The public inputs do not name the source vault. A fake contract that emits `DepositInitiated` produces a valid withdrawal. | Yes |
| H-03 | Critical | Vault | Tokens map 1:1 by address. PulseChain copied Ethereum's state, so a cheap PulseChain copy at the same address withdraws the real Ethereum token. | Yes |
| H-04 | Critical | Light client | Ethereum's sync committee signs with BLS12-381 over beacon block roots. The contract recovers ECDSA addresses. A real committee can never satisfy it, so the deployer must pick the "committee" keys. That is a trusted multisignature, not an adminless bridge. | Yes (by construction) |
| H-05 | Critical | Circuit | `main.rs` is not a zkVM program. It has no entry point, uses an async runtime and network calls, checks no Merkle proof, and commits no public values. It does not compile. No circuit exists, so `programVKey` constrains nothing. | Yes |
| H-06 | High | Deployment | Each chain's light client starts with its own chain's committee root, but it must track the other chain. Each vault checks block roots from the wrong chain. | Yes (static) |
| H-07 | High | Light client | The contract accepts one block root per period (about 27 hours). Anyone can lock a period with its earliest signed header, so later deposits wait a full period. | Yes |
| H-08 | High | Light client | The committee attests a header, not a finalized checkpoint. After a reorganization the destination still honors the orphaned block. | Yes |
| H-09 | High | Vault | The spec has no liquidity model. The destination vault pays only from earlier deposits, and no refund path exists. Withdrawals revert, and the source deposit stays locked forever. | Yes |
| H-10 | High | Vault | `deposit` does not check `targetChainId` against a supported chain. A typo locks funds forever. | Yes |
| H-11 | High | Vault | The vault calls `verify(bytes32,bytes32,bytes) returns (bool)`. The real SP1 verifier exposes `verifyProof(bytes32,bytes,bytes)`, which reverts on failure and returns nothing. With the real verifier every withdrawal reverts. | Yes |
| H-12 | Medium | Vault | Two identical deposits in one block produce the same nonce. Only one can be claimed. | Yes |
| H-13 | Medium | Vault | The vault ignores ERC-20 return values and does not measure received amounts. Fee-on-transfer tokens make it insolvent. A token that returns `false` burns the claim. USDT-style tokens revert. | Yes |
| H-14 | Medium | Light client | OpenZeppelin `recover` reverts on a malformed signature. The `if (validatorAddress == address(0)) continue;` branch is dead code. One bad signature fails the whole update. | Yes |
| H-15 | Medium | Light client | An update costs about 342 signature recoveries plus 342 Merkle proofs. Nobody earns a fee for this, so with "0% fee" nobody has a reason to relay. | Yes (gas measured) |
| H-16 | Medium | Vault | `withdraw` never checks `sourceChainId`. The nonce does not include the source chain or the source vault. | Yes |
| H-17 | Low | Deployment | `forge create` without `--broadcast` only simulates in Foundry 1.x. Folder names do not match the `cd` targets. `source ~/.bashrc` fails on macOS zsh. Placeholder strings reach the constructor. | Yes |
| H-18 | Low | Frontend | `generateProof` calls a server at `/api/prove-deposit`, which contradicts "no backend". The worker is never used. The worker imports an `SP1Prover` browser class that the spec cannot point to. SP1 Groth16 wrapping needs native tooling and many gigabytes of memory, not a browser tab. | Static |
| H-19 | Low | Specification | The specification cites `FORK_GUIDE.md`, but the zip does not contain it. An immutable contract cannot follow a hard fork. A community guide cannot change deployed bytecode. | Static |
| H-20 | Low | Specification | No `Cargo.toml`, `foundry.toml`, or `package.json` exists. Nothing in the specification builds as delivered. | Static |
| H-21 | High | Frontend setup | `npm install @succinctlabs/sp1-sdk` names a package that does not exist. The npm registry returns 404, and the `@succinctlabs` scope has no public packages. Anyone who claims the name can run code on every machine that follows the setup notes. | Yes (registry check) |
| H-22 | Low | Frontend setup | The setup pins nothing (`create-next-app@latest`, `viem@2.x`, `wagmi@2.x`). The current Next.js is 16, which builds with Turbopack by default and does not run a `webpack()` hook. `worker-loader` is a webpack 4 era loader whose last release was in 2023. | Static |
| H-23 | Low | Frontend setup | The notes justify the WebAssembly setup with the browser prover from H-18 and H-21. That prover does not exist, so the whole build patch serves no code. | Static |

## Details

### H-01 — Committee hijack through an unsigned `nextCommitteeRoot`

`updateSyncState` computes `signingRoot = keccak256(abi.encodePacked(attestedHeader, period))`. The `nextCommitteeRoot` argument is not in the signed message. When `period > currentPeriod`, the contract replaces the committee with that unsigned value.

Attack: an honest relayer submits an update for a new period. The attacker copies the signatures and the proofs from the mempool, replaces `nextCommitteeRoot` with the root of 512 attacker keys, and pays more gas. The attacker's transaction lands first. The attacker now controls every later block root, so the attacker can attest a forged block that holds a forged deposit receipt. Combined with any vault, this drains all funds.

### H-02 — Fake deposit emitter

`BridgeInputs` contains no source vault address. The deploy script computes `programVKey` before it deploys the vaults, so the circuit cannot hard-code the vault address either. A sound circuit therefore has no way to tell the real vault's `DepositInitiated` event from a copy. An attacker deploys a contract that emits `DepositInitiated(token, attacker, attacker, 1_000_000e18, nonce, 369)` with no tokens behind it, and then withdraws real tokens on the other chain.

### H-03 — Same-address token mapping across a forked chain

`withdraw` pays `inputs.tokenAddress` on the destination. The vault uses the source token address on the destination chain. PulseChain launched as a copy of Ethereum's state, so most Ethereum token addresses also hold a PulseChain copy with a different value. An attacker buys the cheap PulseChain copy, deposits it on PulseChain, and withdraws the real token from the Ethereum vault.

### H-04 — ECDSA cannot check a real sync committee

Ethereum sync committee members hold BLS12-381 keys. They sign the beacon block root under a fork-specific domain, and the network aggregates their signatures. `ECDSA.recover` cannot recover a BLS key, and a committee member's address does not exist. The only way to deploy `LightClientSync` is to choose 512 ECDSA keys yourself. Whoever holds 342 of them controls the bridge. The specification calls this "adminless", but it is a 342-of-512 multisignature that the deployer picks.

The attested value is also a different object. The light client stores a header hash. The vault expects a block root that a receipt proof can reach. The specification never connects a beacon block root to an execution receipts root.

### H-05 — The circuit does not exist

`spec/bridge circuits/src/main.rs`:

- has no `#![no_main]` and no `sp1_zkvm::entrypoint!`, so the SP1 toolchain cannot build it as a guest program;
- uses `tokio` and HTTP calls, but a zkVM guest has no network;
- fetches data and builds a JSON object, then discards it — it verifies nothing and commits no public values;
- does not compile. Against alloy 2.1.1 it fails with four errors: `on_http` no longer exists on `ProviderBuilder`, and three calls need type annotations. With those fixed, `get_block_by_number` and `get_block_receipts` reject their arguments, because the code targets an older alloy API. It also passes `eyre::eyre!(…)` to `ok_or_else`, which needs a closure. With every error fixed, the compiler warns `unused variable: serialized_proof_payload` — the program builds its output and throws it away. See `checks/h05-circuit.sh`.

Because no circuit constrains anything, `programVKey` is only a fingerprint of nothing. The test suite models the circuit the specification describes, as generously as possible: it checks receipt inclusion against the real receipts root. H-02 and H-03 still succeed under that generous model.

### H-06 — Light clients wired to the wrong chain

`deploy.sh` deploys the Ethereum `LightClientSync` with `INITIAL_ETH_COMMITTEE_ROOT` and passes it to the Ethereum vault. The Ethereum vault must check PulseChain block roots, because PulseChain deposits are what it pays out. The wiring is inverted on both chains.

### H-07 — One block root per period

`finalizedPeriods[period] = true` after the first accepted update. A period lasts 256 epochs, about 27 hours. A user who deposits after the accepted header cannot prove the deposit until the next period. An attacker can always submit the earliest signed header of each period, before any deposit lands, and hold every withdrawal back by up to 27 hours.

### H-08 — No finality

The committee attests `attestedHeader`, not a finalized header. If the source chain reorganizes after the update, the orphaned block root stays valid on the destination forever. A deposit that the reorganization removed still withdraws.

### H-09 — No liquidity model and no refund

Both vaults lock and release the same token. The destination vault pays only from tokens that other users deposited in the opposite direction. When it is empty, `withdraw` reverts. Because the source vault has no refund function and no admin, the deposit is locked forever.

### H-10 — Unchecked target chain

`deposit` only rejects `targetChainId == currentChainId`. A deposit to chain `56` or `0` succeeds. No vault exists there to pay it, and no refund exists here.

### H-11 — Wrong verifier interface

The real SP1 verifier gateway exposes `verifyProof(bytes32 programVKey, bytes publicValues, bytes proofBytes)`. It reverts on an invalid proof and returns nothing. The vault calls `verify(bytes32, bytes32, bytes) returns (bool)`, a selector that the gateway does not have. Every withdrawal reverts. The vault also hashes the public values with Keccak-256, but SP1 commits a SHA-256 digest.

### H-12 — Nonce collision

`nonce = keccak256(msg.sender, recipient, amount, block.timestamp, block.prevrandao)`. Two equal deposits from one sender in one block share a nonce. Both lock tokens, but `processedNonces` lets only one withdraw.

### H-13 — Unsafe token handling

- `transferFrom` and `transfer` ignore the return value. A token that returns `false` on `transfer` marks the nonce as processed and pays nothing.
- A fee-on-transfer token credits the depositor with `amount`, but the vault receives less. The last withdrawer cannot be paid.
- USDT on Ethereum returns no value. The `IERC20` interface expects a `bool`, so every call reverts.

### H-14 — One malformed signature fails the update

OpenZeppelin 5 `ECDSA.recover` reverts on a bad length, a high `s` value, or a zero result. It never returns `address(0)`. The `continue` branch is dead, and one bad signature in the array reverts the full update.

### H-15 — Update cost with no fee

The contract verifies 342+ signatures and 342+ Merkle proofs in each update. The test suite measures this gas. Nobody earns a fee, so the "0% fee" claim moves the cost to whoever needs a withdrawal next.

### H-16 — No source chain check

`withdraw` reads `inputs.sourceChainId` but never checks it. The nonce does not include the source chain or the source vault. Only the missing circuit could enforce this.

### H-17 — The deploy script cannot deploy

- `forge create` without `--broadcast` only simulates the transaction in Foundry 1.x, so `deployedTo` is empty.
- `cd bridge-circuits` and `cd smart-contracts` do not match the folders `bridge circuits/` and `Smart contracts/`.
- `source ~/.bashrc` does not load the installers' PATH changes on macOS, where the default shell is zsh.
- `cargo prove vkey` needs `--elf` or `--program`.
- Placeholder strings such as `"INITIAL_ETH_COMMITTEE_ROOT"` and `"0xSP1VerifierContractAddressMainnet"` go straight into the constructors.
- `ETH_RPC="https://alchemy.com"` is a marketing site, not an RPC endpoint.

### H-18 — The frontend contradicts "no backend"

The component sends the transaction hash to `/api/prove-deposit`, so a server generates the proof. The web worker is never loaded. Its `SP1Prover` import comes from a package that the specification does not version, and Groth16 wrapping in SP1 runs through native tooling. A browser tab is not a realistic prover. `VAULT_ABI` is a list of human-readable strings without `parseAbi`. TypeScript accepts it, because viem types `abi` loosely, but viem throws a `TypeError` at run time when it encodes the call. Both buttons fail on click. See `checks/h18-frontend.sh`.

### H-19 — Immutability against hard forks

The specification admits that either chain can change its header format or consensus. The contracts have no admin and no upgrade path. After such a fork, the light client stops accepting updates and every locked token stays locked. The missing `FORK_GUIDE.md` cannot fix deployed bytecode.

### H-20 — Nothing builds

The specification ships no build manifests. This repository adds them, and records each change it had to make to compile the contracts in `docs/spec-deviations.md`.

### H-21 — The setup notes install a package that does not exist

`spec/frontend-setup-notes.md` step 4 runs `npm install @succinctlabs/sp1-sdk` and calls it "the official Succinct SDK". On 2026-10-19 the npm registry returned `404 Not Found` for that name, and a registry search for `scope:succinctlabs` returned zero packages. Chatbots often invent package names like this one. Attackers watch for invented names and register them ("slopsquatting"). An install script in such a package runs with the developer's permissions, on the same machine that holds the `DEPLOYER_KEY` from `deploy.sh`.

The registry cannot show from outside whether a private organization owns the scope. Until you confirm that, treat the install line as hostile.

## Test method

- `forge test` covers contract-level holes against single-chain state.
- `harness/` runs two Anvil instances: chain `1` (Ethereum role) and chain `369` (PulseChain role). It deploys the specification's contracts on both, runs an honest relayer with a 512-key ECDSA committee, and runs a reference prover. The reference prover models the circuit that the specification describes, as generously as possible. It rebuilds the real receipts trie from Anvil and checks the receipt against the block's `receiptsRoot`.
- `MockSP1Verifier` keeps the specification's `verify` interface. It accepts a proof only when the reference prover produced it. A real SP1 setup is out of scope, because the specification has no circuit to prove (H-05).
