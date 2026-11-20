# Audit entry document

This is the starting point for an external security review of the hardened bridge. Read it first. It names the code in scope, the order to read it in, what we claim, what we assume, and how to build and test everything.

Two companion files hold the detail:

- [`known-issues.md`](known-issues.md): accepted risks, user decisions, open items, and the status of every earlier internal finding. Do not report these as new findings unless you disagree with the reasoning.
- [`invariants.md`](invariants.md): the properties the code must keep, where each is enforced, and the tests that check it.

All paths are relative to the repository root.

Terms used in all three files: SP1 is Succinct's zero-knowledge virtual machine. SSZ (Simple Serialize) is the beacon chain's encoding and Merkle hashing. RLP (Recursive Length Prefix) is the execution chain's encoding. BLS is the Boneh–Lynn–Shacham signature scheme that sync committees use. EIP is an Ethereum Improvement Proposal; EIP-4788 puts beacon block roots in a contract on the execution chain. An ELF is a compiled guest program. Gloas is the Ethereum consensus fork that Sepolia already runs.

## 1. What the system is

The bridge moves arbitrary messages, and tokens through them, between Ethereum and PulseChain. Each chain holds a light client of the other chain's beacon chain (the consensus layer). A light client stores only finalized beacon headers, and it accepts a new header only with a Groth16 proof from SP1 (Succinct's zero-knowledge virtual machine). The proof shows that a program, built from `light-client/crates/lc-core`, checked that two thirds of a sync committee bound to the stored state signed the update. A message sent on one chain is delivered on the other with no further proof system: `MessageBridge.executeMessage` checks a chain of Merkle proofs from a stored finalized header through `block_roots` or `historical_summaries` to the source block, then the execution header, the receipt, the transaction and the log. `TokenMediator` sends tokens as messages: it locks a native token and mints a bridged copy, or burns a copy and unlocks the native token. A fork gate on each chain refuses sends when the source chain has moved to a state layout that the program cannot read. Nothing has an owner, an upgrade path, a pause or a timelock. An off-chain program, `prover/`, makes proofs and evidence and hands them to a separate operator server that pays gas. The contracts check everything the prover sends.

### Diagram

```
 OFF CHAIN
   Ethereum beacon node + execution node            PulseChain beacon node + execution node
                  \                                            /
                   v                                          v
          zk-bridge-prover (prover/): prove, evidence, opening-proof, checkpoint
          runs lc-core natively, then the SP1 program for a Groth16 proof
                                   |
                                   v  proof packages and calldata
          operator server (not in this repository): sends transactions, pays gas
                                   |
 ==================================|=====================================================
 ON CHAIN                          v
 ---------- Ethereum (chain 1) -----------------    ---------- PulseChain (chain 369) -----------------
 SP1 Groth16 verifier (vendored, code hash pinned)   SP1 Groth16 verifier (same build)
 BeaconLightClient: follows the PULSECHAIN beacon    BeaconLightClient: follows the ETHEREUM beacon
   chain; update(proof, 352-byte public values)        chain; update(proof, 352-byte public values)
                                                     BeaconLightClient (own chain): follows PULSECHAIN
                                                     ForkRegistry: observe(proof, 256-byte values),
                                                       records fork version and state shape
 BeaconForkGate, mode Enforcing: reads the          BeaconForkGate, mode DetectBeaconRootsAndRegistry:
   beacon roots contract (EIP-4788) of Ethereum       execution canaries + beacon roots probe + registry
 MessageBridge                                       MessageBridge
   requireToPassMessage -> gate.admit("")              executeMessage(proof): anchor = header stored in
   -> event UserRequestForAffirmation                  the light client above; ancestry, block hash,
   executeMessage(proof) <- anchor in the light        receipt, transaction and log proofs
   client above                                        openDeposits(proof): one-way lock release
   openDeposits(proof)
 TokenMediator (+ TokenFactory, BridgedToken)        TokenMediator (+ TokenFactory, BridgedToken)
   target of the bridge; trusts only the mediator      same; lock/unlock native tokens,
   at the same address on the other chain              mint/burn bridged copies
 DeliveryRouter (optional): wraps the native coin,   DeliveryRouter (optional)
   delivers, pays a voluntary tip, unwraps, calls
```

A token relay from PulseChain to Ethereum, step by step:

1. The sender calls `TokenMediator.relayTokens` on PulseChain. The mediator pulls the tokens, raises its record `mediatorBalance(token)` by the amount received, and calls `MessageBridge.requireToPassMessage`.
2. The bridge checks that sends are open, the cutoff and the selector, then calls `BeaconForkGate.admit("")`. It reads no gas number (the gas field of the message is always zero). It emits `UserRequestForAffirmation`.
3. Someone runs `zk-bridge-prover prove` and sends `BeaconLightClient.update` on Ethereum until a stored finalized PulseChain header lies after the send. Each update carries a Groth16 proof of a fold of 1 to 64 light-client updates.
4. Someone runs `zk-bridge-prover evidence`, adds any layout rows it needs (`addBlockRootsLayout`, `addBlockHashLayout`, `addHistoricalSummariesLayout`, each checked against stored data), and calls `MessageBridge.executeMessage` on Ethereum, directly or through `DeliveryRouter`.
5. The bridge marks the message in progress and calls the mediator handler with all the gas it has. When the call fails (a revert, or too little gas) the delivery reverts and the message waits for a run with more gas; there is no failed status. The mediator mints the bridged copy (deploying it on first use) or unlocks the native token. A release refused with gas to spare emits `ReleaseFailed` and is final; one that ran out of gas reverts the delivery (`ReleaseOutOfGas`). A relay with a call gives `onTokenBridged` exactly the callback gas that the sender stated, through `ExactGasCall`.

## 2. State of the repository for the audit

| Item | State |
|---|---|
| Branch | `wip/layout-genesis-root`, to be merged into `main` before the audit. Pin the commit you review. |
| Remote | None yet. The repository is not public. |
| Deployment | None on any chain. No real chain has seen a proof. |
| Earlier audit | None. |
| Licence | No `LICENSE` file at the root. Source files carry `SPDX-License-Identifier: MIT` and the Cargo manifests say MIT. The user has not confirmed the licence. |

## 3. Scope

The addresses of every deployed contract, with the source commit it was built from, its deploy date and where its source is verified (Blockscout, Sourcify, Etherscan), are on the page [Deployed contracts](../../explorer/web/docs/pages/10-deployed-contracts.md). It is generated from `deploy/deployments/<pair>.json`, which holds the same list. Use the source commit in its table to pin the code you review to the code that is on the chain.

### How lines are counted

`cloc` is not installed on the machine that wrote this. The counts below are code lines: non-blank lines that are not wholly a comment. A comment is `//` to the end of the line (also `///` and `//!`) or a `/* ... */` block (also NatSpec `/** ... */`). For Rust, lines inside an inline `#[cfg(test)] mod name { ... }` block are counted apart as "inline test" and are not in the code total. The counter is a short Python script that tracks string literals, so that `//` inside a string is not a comment. To reproduce roughly without it:

```
grep -cvE '^\s*($|//|/\*|\*)' <file>      # close for Solidity; for Rust, remove the inline test blocks first
```

`cloc` counts comments the same way, but it counts Rust inline test modules as code.

### Tier 1: can lose funds if wrong (4,833 code lines)

Review these first and in this order. A defect here can forge a head, forge or replay a message, or break the books of the mediator.

**Light client and verifier wiring (Solidity, 177 lines)**

| File | Lines | What it does |
|---|---|---|
| `src/hardened/BeaconLightClient.sol` | 160 | Stores finalized headers. Checks the 352-byte public values against stored state, the committee rules, the clock bound, then calls the verifier. |
| `src/hardened/BeaconClock.sol` | 7 | Current slot from `block.timestamp`, shared with the gate. |
| `src/hardened/IBeaconLightClient.sol` | 6 | Interface the bridge reads. |
| `src/hardened/ISP1Verifier.sol` | 4 | Interface of the Groth16 verifier. Reverts on an invalid proof. |

**Message bridge, receipt and ancestry checks, SSZ and RLP (Solidity, 1,011 lines)**

| File | Lines | What it does |
|---|---|---|
| `src/hardened/BeaconProofVerifier.sol` | 460 | Anchor lookup, recent and historical ancestry, block hash branch, Gloas source path, header decode, receipt and transaction trie proofs, log checks, the three layout tables and their range rule, the opening proof of `openDeposits`. Abstract base of `MessageBridge`. |
| `src/hardened/MessageBridge.sol` | 293 | Arbitrary message bridge interface (OmniBridge `IAMB`). Send checks, the deposit lock, `executeMessage` with the delivery record, the gas guard and the context during the call. |
| `src/hardened/AmbMessageCodec.sol` | 92 | The OmniBridge message encoding and identifier. |
| `src/hardened/IAMB.sol` | 22 | The interface. |
| `src/hardened/ReceiptLogs.sol` | 72 | Walks receipt logs with no item limit (finding HB-05). |
| `src/hardened/SSZ.sol` | 72 | Simple Serialize (SSZ) header hash and exact Merkle branch checks. |

**Fork gate and registry (Solidity, 539 lines)**

| File | Lines | What it does |
|---|---|---|
| `src/hardened/BeaconForkGate.sol` | 332 | `admit`, `confirm`, `seal`. Enforcing mode with beacon roots evidence; detection mode with execution canaries and the beacon roots probe; registry mode. |
| `src/hardened/ForkShape.sol` | 94 | The one shape rule: allowed shapes plain depth 5, 6, 7 and the Gloas progressive form; seal only on plain depth 8 to 31. Positions of `fork.current_version` and `genesis_validators_root`. |
| `src/hardened/ForkRegistry.sol` | 105 | Accepts fork observation proofs (256-byte public values) bound to the own-chain light client. |
| `src/hardened/IDepositGate.sol`, `src/hardened/IForkRegistry.sol` | 4, 4 | Interfaces. |

**Token layer without the router (Solidity, 651 lines)**

| File | Lines | What it does |
|---|---|---|
| `src/hardened/mediator/TokenMediator.sol` | 440 | Lock, unlock, mint, burn. The record `mediatorBalance`. Handlers callable only by the bridge with the remote mediator as sender. Gas reserve that tells a refused transfer (`ReleaseFailed`, final) from a lack of gas (`ReleaseOutOfGas`, the delivery reverts and waits). |
| `src/hardened/mediator/BridgedToken.sol` | 78 | The bridged copy. Mint and burn only by the mediator. Its own EIP-2612 `permit` and ERC-677 `transferAndCall`. |
| `src/hardened/mediator/TokenFactory.sol` | 41 | `CREATE2` deployment of copies at an address computed from the home chain and the native token. |
| `src/hardened/mediator/TokenReader.sol` | 42 | Reads name, symbol and decimals of any token. |
| `src/hardened/mediator/I*.sol` (7 files), `src/hardened/IFlowLimiter.sol` | 45, 5 | Interfaces. No flow limiter is attached; the hook is empty. |

**The two SP1 programs (Rust, 2,455 code lines plus 926 inline test lines)**

These are the parts of `lc-core` that the guest programs compile and run. A defect here can let a dishonest prover prove a false head.

| File | Code | Inline test | What it does |
|---|---|---|---|
| `light-client/guests/light-client/src/main.rs` | 9 | 0 | Guest wrapper: reads input, runs `wire::run_light_client_guest`, commits 352 bytes. |
| `light-client/guests/fork-observation/src/main.rs` | 9 | 0 | Guest wrapper: runs `wire::run_fork_observation_guest`, commits 256 bytes. |
| `light-client/crates/lc-core/src/wire.rs` | 419 | 0 | Input decoding with count limits, the two guest entry points. |
| `light-client/crates/lc-core/src/update.rs` | 351 | 0 | One update step and the fold: finality, committees, genesis validators root branch, execution anchor, signature, period rules. |
| `light-client/crates/lc-core/src/layout.rs` | 374 | 336 | Layout from branch lengths. Generalized indices. Position rules shared with the bridge. |
| `light-client/crates/lc-core/src/observation.rs` | 112 | 199 | The fork observation statement and its shape proof. |
| `light-client/crates/lc-core/src/execution.rs` | 226 | 0 | Execution payload header roots and the Recursive Length Prefix (RLP) header decoder. |
| `light-client/crates/lc-core/src/types.rs` | 204 | 34 | Headers, updates, store, committee hashing. |
| `light-client/crates/lc-core/src/bls.rs` | 78 | 0 | BLS12-381 fast aggregate verification, signer key by subtraction. |
| `light-client/crates/lc-core/src/chain.rs` | 131 | 92 | Chain constants, including the genesis validators root of each chain. |
| `light-client/crates/lc-core/src/ssz.rs` | 181 | 113 | SSZ hashing and exact branch checks. |
| `light-client/crates/lc-core/src/abi.rs` | 54 | 152 | Solidity application binary interface (ABI) encoding of the public values. |
| `light-client/crates/lc-core/src/error.rs` | 265 | 0 | Error variants. |
| `light-client/crates/lc-core/src/lib.rs`, `profile.rs` | 24, 18 | 0 | Module list; profiling hook, off in the shipped guests. |

Read `docs/light-client-layout/test-plan.md` Part A before this code. It is the threat narrative for the layout rules (T1 to T24) and lists the assumptions S1 to S8.

### Tier 2: deploy script, configuration checks, router (1,432 lines)

| File | Lines | Why tier 2 |
|---|---|---|
| `script/hardened/DeployBridge.s.sol` | 728 | Predicts cross-chain addresses from deployer nonces, checks the verifier code hash, the clocks, the gate root, the Capella era, and reads every immutable back. A defect deploys a wrong pair; it does not move funds by itself. |
| `script/hardened/bridge.config.example.json`, `script/testnet/bridge.config.testnet.json` | data | The configuration the script reads. The example must be refused as is (a test checks this). |
| `script/testnet/preflight.sh` | 151 (non-comment shell lines) | Checks a testnet before deployment. |
| `src/hardened/mediator/DeliveryRouter.sol` | 308 | Optional. Wraps the native coin, delivers through the bridge, pays a voluntary tip to a fixed address, unwraps, makes one user call. It holds delivered value for one call frame and stray tokens. It cannot touch the mediator's books. |
| `src/hardened/mediator/RouterCaller.sol` | 83 | Created by the router; the account that makes the user call after a delivery (since 2026-11-18), so the call cannot reach what the router holds. Only its router may use it; it holds nothing. Its exact-gas rule is `ExactGasCall` written out in assembly. |
| `prover/src/checkpoint.rs` | 245 | Computes the four checkpoint values of a new light client (slot, header root, current and next committee hash). These values are trust assumption 3, so this one prover module sits in tier 2. Check the values by hand against several beacon nodes before a deployment whatever this code says. |

### Tier 3: prover and off-chain Rust (8,409 code lines)

| Path | Code | Inline test |
|---|---|---|
| `prover/src/` without `local_network/`, `bin/signed_beacon.rs` and `checkpoint.rs` | 6,478 | 4,676 |
| `light-client/crates/lc-core/src/` modules not compiled into a guest: `ancestry.rs`, `era.rs`, `gate.rs`, `json.rs`, `message.rs`, `mpt.rs`, `receipts.rs`, `ssz_block_gloas.rs`, `ssz_state.rs`, `ssz_state_gloas.rs` | 1,931 | 502 |

**Claim: the prover can only cause a refusal or a stall, never a false head or a false delivery.** The reasons:

- Every proof the prover makes is checked on chain. The light-client program treats the prover as an attacker: every private input (store, updates, fork versions, branches) is either proven inside the program or bound to a public value that the contract compares with its stored state.
- Message delivery has no proof system. `MessageBridge` checks the evidence from the prover directly against a header the light client stored.
- The opening proof of `openDeposits` and the gate evidence of `confirm` and `seal` are checked on chain against stored headers or the beacon roots contract.
- The prover holds no key that any contract trusts. The only key it can hold signs for `OracleSP1Verifier`, a test stand-in that a real deployment never uses (the deploy script pins the verifier code hash).
- The `lc-core` modules in this tier are Rust twins of contract checks (`message.rs` mirrors `executeMessage`) and builders. A defect there gives evidence that the contract refuses.

**Exceptions to check:** the checkpoint values (tier 2 above); liveness, because a prover that stops leaves messages undelivered until someone else proves; and the deployment file for the explorer (`prover/src/deployment.rs`), which only feeds the interface. **Please verify this claim** rather than take it on trust: look for any value the prover passes that a contract stores or acts on without a check.

### Totals

| Tier | Code lines |
|---|---|
| Tier 1 | 4,833 (Solidity 2,378, Rust 2,455) |
| Tier 2 | 1,432 |
| Tier 3 | 8,409 |
| Vendored, out of scope but on the call path | 826 |

## 4. Out of scope

| Path | Why |
|---|---|
| `spec/` | The original third-party proposal. It is the subject of the red team, not our code. Read only. Never deploy it. |
| `src/` outside `src/hardened/` (`src/ZKBridgeVault.sol`, `src/LightClientSync.sol`, `src/revision-2/`), `test/` outside `test/hardened/`, `harness/`, `checks/` | The red team of that proposal. Its tests pass when an attack on the proposal succeeds. |
| `src/mocks/` | Test doubles only: `OracleSP1Verifier`, `MockSP1Verifier`, `RealShapeSP1Verifier`, hostile and odd tokens, `MockWrappedNative`. Nothing in the deploy script uses them. |
| `test/hardened/utils/`, `light-client/crates/lc-testkit/`, `prover/src/local_network/`, `prover/src/bin/signed_beacon.rs` | Test support and a development beacon chain (feature `signed-beacon`; a production build uses `--no-default-features`). |
| `explorer/` | Interface, indexer and bots. It holds no funds and no trusted role. It does give users advice, see "interface cutover" in `known-issues.md`. |
| `docker/`, `e2e/`, `explorer/e2e/` | Local networks and an unfinished end-to-end harness (`e2e/` and `explorer/e2e/` are not committed). |

### Vendored and pinned third-party code

Treat these as trusted dependencies, but confirm they are unmodified and review how our code calls them. The Optimism trie and RLP libraries sit on the message path.

| Source | Pin | Where | Changes | How to diff |
|---|---|---|---|---|
| Optimism `packages/contracts-bedrock/src/libraries/`: `Bytes.sol`, `rlp/RLPReader.sol`, `rlp/RLPErrors.sol`, `trie/MerkleTrie.sol` | tag `op-contracts/v8.0.0`, commit `f45a5ccfebcdf6da3f5b09cbc512667c063730b7` | `src/hardened/vendor/optimism/` | Import paths only | `git clone --depth 1 --branch op-contracts/v8.0.0 https://github.com/ethereum-optimism/optimism`, then `diff` each file against `packages/contracts-bedrock/src/libraries/<file>`. Only `import` lines may differ. SHA-256 of the vendored files are in `src/hardened/vendor/optimism/README.md`; they match the tree today. |
| Succinct `sp1-contracts` `contracts/src/`: `ISP1Verifier.sol`, `v6.1.0/Groth16Verifier.sol`, `v6.1.0/SP1VerifierGroth16.sol` | release `v6.1.1`, commit `d3629729c3216eb51bd4859d027a8eb729399fa4`, circuit `v6.1.0` | `src/hardened/vendor/sp1-contracts/` | None, byte for byte | Clone the tag and compare SHA-256 with `src/hardened/vendor/sp1-contracts/README.md`. They match the tree today. |
| `mds1/multicall` `src/Multicall3.sol` | commit `ebd8b64457454fc10037b3a3ea858f9c08dad4d3` | `src/hardened/vendor/multicall3/` | Pragma `^0.8.12` instead of `0.8.12` | `diff` against the commit. SHA-256 today: `2d25632cb69e4c24f3cda8a4c0f7ffbe596a71417277f96e8fc07f3d2e2f070e`. Used by tests and the bots only; no contract imports it. |
| OpenZeppelin Contracts (`ERC20`, `IERC20`, `IERC20Permit`, `SafeERC20`, `ReentrancyGuard`) | `v5.7.0`, submodule commit `cab19933c33c2ad1d4c7a84864a3601dddfd16f3` | `lib/openzeppelin-contracts` | None | `git -C lib/openzeppelin-contracts describe --tags` prints `v5.7.0`. |
| forge-std | submodule commit `b013eff2ac4fce26f34d789e6f5c49021c5ee817` (`v1.17.0` plus 4) | `lib/forge-std` | None | Tests and the deploy script only. |
| Rust crates in the guests: `alloy-primitives` 1.7.3, `alloy-sol-types` 1.7.3, `alloy-rlp` 0.3.16, `alloy-trie` 0.9.5, `bls12_381` 0.8.0, `sha2` 0.9.9 and 0.10.9, `sha3` 0.11.0 | exact versions in `light-client/Cargo.toml` and the two guest `Cargo.lock` files | crates.io | None | The guests replace `bls12_381`, `sha2` and `sha3` with Succinct's precompile patches: `sp1-patches/bls12_381` tag `patch-0.8.0-sp1-6.0.0` (commit `c6a3a331`), `sp1-patches/RustCrypto-hashes` tags `patch-sha2-0.9.9-sp1-6.0.0` (`1b29839d`), `patch-sha2-0.10.9-sp1-6.0.0` (`e48b656e`), `patch-sha3-0.11.0-sp1-6.0.0` (`540d99e4`). Full commits are in `light-client/guests/light-client/Cargo.lock`. |

## 5. Trust assumptions

These are the four assumptions in [`README.md`](../../README.md), "Trust assumptions", unchanged:

1. **Two thirds of the source chain's sync committee are honest.** A forged finalized header lets an attacker forge a message. Sync committee signatures carry no slashing. On PulseChain about 18 withdrawal credentials hold 342 of the 512 seats (measured 2026-10-21, `docs/zk-bridge-comparison.md`).
2. **The SP1 release is sound.** The verifier and the program keys are fixed at deployment (`docs/sp1-version-policy.md`).
3. **The deployment checkpoint is correct.** Each light client starts from one checkpoint that people must check. Every later proof starts from the stored state.
4. **The flow limiter, if one is attached.** None is attached; the hook is empty by user decision.

The layout rules add assumptions that sit under 1 and 2. `docs/light-client-layout/test-plan.md` A.2 names them S1 to S8: hash functions resist preimages and collisions (S2); the compiled genesis validators root of each chain is right (S5); plain forks only append state fields (S6); only the protocol writes the beacon roots contract (S7); at least one honest prover is online, for liveness only (S8).

## 6. Security properties we claim

**No admin.** No contract has an owner, a role, a setter, an upgrade path, a pause or a timelock. Every parameter is a constructor argument or a constant. `test/hardened/Immutability.t.sol` scans the compiled interfaces for owner and upgrade names and lists every state-changing function.

**What each actor can and cannot do**, assuming 1 to 3 above:

| Actor | Can | Cannot |
|---|---|---|
| Prover (any account that sends an update) | Choose which real finalized header to prove next, including an older one than the newest. Stall a route by not proving. Fold up to 64 updates in one proof. | Store a header that two thirds of a bound committee did not sign; invent a committee; name another chain's fork version or root; move the head backwards or beyond the current slot; pick a layout the chain does not have (the finality, committee and genesis validators root branches must agree on one shape). |
| Block proposer of the source chain | Write graffiti, `eth1_data` votes, the randao reveal, and in Gloas the payload bid. | Make a layout row or an execution anchor point at those fields: rows accept only the field's own position (HB-03, HB-04), and the bid `block_hash` is never accepted. |
| User or message executor | Send messages, deliver any proven message (once), add layout rows backed by stored data, confirm the gate with true evidence, seal it with a proof of a disallowed shape, open the bridge with a true opening proof, sweep stray router tokens to the fixed hand-off address. Front-run any of these. | Deliver a message twice; starve a delivery of gas so that it fails (the gas guard refuses it and the message survives); change a message's target, data or gas; seal the gate at an allowed shape or with old evidence; release tokens except through the remote mediator. |
| Deliverer through `DeliveryRouter` | Raise a gas-based tip up to the sender's `limit` by sending more gas. | Receive the tip: it always goes to the router's immutable `rewardAddress`. |
| Beacon or execution node that the prover reads | Make that prover stall or refuse (wrong data, wrong fork schedule, missing states). | Cause a false head or a false delivery: every value is checked natively by the prover and again by the program or the contract. At deployment time a lying node could give a false checkpoint, which is why trust assumption 3 needs a manual check. |
| Token author | Make releases of its own token fail (blacklist, pause, revert, gas burn, rebase); then the release is final and the tokens stay in the mediator. | Make a handler revert (gas reserve, bounded return data); touch the record of another token; reenter a relay during the pull (reentrancy guard, one message per pull). |
| Sync committee minority (fewer than 171 of 512) | Nothing. More than 170 who withhold can stop updates (a stall). | Sign anything alone. |

**Fork safety.** A send succeeds only while the gate accepts the source chain's current state shape. On Ethereum the gate proves `fork.current_version` and `genesis_validators_root` under a beacon root of the current epoch. On PulseChain, which has no beacon roots contract, execution canaries and a fork observation registry switch the gate on. The gate refuses a send it cannot judge. The window before a fork activates is not visible on chain; see `known-issues.md`.

## 7. Toolchains and pins

| Item | Pin |
|---|---|
| Solidity | `0.8.28`, `evm_version = "shanghai"` (PulseChain rejects `MCOPY` and `TSTORE`), optimizer on with 200 runs, `bytecode_hash = "none"`, `cbor_metadata = false` (`foundry.toml`) |
| Foundry | `ghcr.io/foundry-rs/foundry:v1.7.0@sha256:ff06299a789deee1d9e07d93961f08330820e2444a8dbbb425c1256bc3d1c206` in `docker/`. The figures below were measured with a local `forge 1.6.0-nightly` (commit `e2f8ef2b60f5`). `foundry.toml` does not pin a Foundry version. |
| Rust (workspaces `light-client/`, `prover/`) | `1.93.0` with clippy and rustfmt (`rust-toolchain.toml` in each) |
| SP1 guest library | `sp1-zkvm =6.8.0` |
| SP1 prover library | `sp1-sdk =6.8.1` (feature `sp1`; GPU feature `sp1-cuda`) |
| SP1 command line | `cargo prove` from sp1-cli 6.8.1, built from source at commit `c84ada1`; rustup toolchain `succinct-1.96.0-64bit-v2` inside the build image |
| SP1 build image | `ghcr.io/succinctlabs/sp1:v6.8.1`, linux/amd64 manifest `sha256:2ddd7c1d74be98be628e5e58f9b177a739eb3e7c0a6b8f7b97b358682cb4677b` |
| On-chain verifier | sp1-contracts `v6.1.1`, circuit `v6.1.0`; `VERIFIER_HASH()` `0x4388a21c687fdd5f218d7e3d13190cac4c5355818d3605fd5fb811df468ee696`; `VK_ROOT()` `0x002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f25352`; runtime code hash with our compiler settings `0xe5878a94678c40ab6b1bebc391f4d4c12f44bedb8291921b5c0f5a251ec6e84b` |

Program keys and ELF hashes (ELF: the compiled guest program), from `light-client/program-keys.json`:

| Program | ELF SHA-256 | Program key | Public values |
|---|---|---|---|
| Light client | `79f80a9b9187f96824fd727a0bc8ead7cf538d42cf40b5fc77465ac1e5af95f0` | `0x000854b9b72ab6bfca191c95cb131971a17a458c2faebdd216d9dbe874eb4730` | 352 bytes, 11 words |
| Fork observation | `9ce4cfd8121a54dc0535f9251db0db9e6d7d854f74a2bbdc983334efdb4f1f24` | `0x00cc01bed0a69f5f40b56834cb19c6507238301ebb816806c90fd038ba42edf0` | 256 bytes, 8 words |

The recorded source hash of the build inputs is `a1c4288b88f8eb02d7d42752f1b0cced13121b083ad26ce7446a7c755adafef1` (`light-client/program-keys.source-hash`). The tree matches it today. The ELF files in `light-client/elf/` (ignored by git) carry the hashes above.

## 8. Build, test, coverage, program keys

Clone with submodules (`git submodule update --init`). The times below are wall-clock times measured on 2026-10-27 on the development machine (Apple silicon) with a warm build cache. A first build takes longer; that time was not measured. The tree was commit `cdd0db9`; the next commit, `d1e3911`, changes only `prover/tests/sp1_execute.rs`, which needs the feature `sp1` and is not part of these runs.

| What | Command | Result measured | Time |
|---|---|---|---|
| All contract tests | `forge test` | 852 passed, 0 failed, 0 skipped, in 72 suites (796 hardened, 56 red team) | 53 s |
| Contract coverage gate | `script/coverage-check.sh` | 839 tests under coverage, then 13 optimizer-dependent tests with `forge test`; 100.0 percent lines, branches and functions on every measured file (`vendor`, `test`, `script` and `mocks` excluded) | 2 min 32 s |
| Light client | `cd light-client && cargo test --offline` | 295 passed, 0 failed, 2 ignored | 79 s |
| Prover | `cd prover && cargo test --offline` | 206 passed, 0 failed, 14 ignored | 26 s |
| Program-key script self-test | `light-client/scripts/test-program-keys.sh` | all cases passed (stubs, no Docker) | 3 s |
| Program-key check | `light-client/scripts/program-keys.sh` | "build inputs unchanged ... skipping the Docker build" | 1 s |
| Program-key rebuild | `light-client/scripts/program-keys.sh --force` | must print the two ELF hashes and keys above and "program keys match program-keys.json" | not measured here; the team measured 6 to 17 minutes per guest under amd64 emulation |
| SP1 executor run | `cd prover && cargo test --offline --features sp1 --test sp1_execute -- --test-threads=1` | not run for this document; needs about 16 GB of memory | |
| Long fuzz and invariant runs | `script/test-deep.sh` | not run for this document (profile `deep`: 50,000 fuzz runs, 2,000 invariant runs of depth 100) | |
| Every suite at once | `script/test-all.sh` | not run for this document; adds the explorer suites | |

Notes:

- **Use `--force` to reproduce the keys.** Without it, `program-keys.sh` only hashes the build inputs and compares with the recorded hash. It needs Docker (Colima works), `jq`, `shasum` and `cargo prove` 6.8.1. A native `cargo prove build` gives other keys; only the Docker build counts.
- The 2 ignored light-client tests (`ethereum_state_proofs_are_on_file`, `every_golden_case_is_computed`) wait for a real Ethereum mainnet fixture. The 14 ignored prover tests are the 13 remote-backend tests in `prover/tests/remote_prover.rs`, which wait for a real proof of the rebuilt program, and one test that needs the network. See `known-issues.md`.
- `script/coverage-check.sh` runs the full forge suite, so you do not need `forge test` as well.
- There is no continuous integration. Every number here comes from a manual run.
- Clippy: `cargo clippy --all-targets -- -D warnings` in each Rust workspace (not run for this document).

## 9. Tests: where and what kind

| Kind | Where | Notes |
|---|---|---|
| Unit tests, contracts | `test/hardened/*.t.sol`, `test/hardened/mediator/*.t.sol` | Tests are named for the finding they cover (`test_HB01_...`, `test_H08_...`). Each attack test has an honest control. |
| Fuzz, contracts | `test/hardened/HardenedFuzz.t.sol`, `testFuzz_*` across files, `test/hardened/invariant/TokenFactoryProperties.t.sol`, `test/hardened/mediator/TokenMediatorFuzz.t.sol` | Default profile in normal runs; `deep` profile for long runs. |
| Invariant, contracts | `test/hardened/invariant/RealBridgeInvariant.t.sol` (real bridges and proofs on two simulated chains), `test/hardened/invariant/MediatorRouterInvariant.t.sol`, `test/hardened/mediator/TokenMediatorInvariant.t.sol` | Handlers in `test/hardened/invariant/utils/` and `test/hardened/mediator/utils/`. |
| Two chains in one test | `test/hardened/BridgeWorld.t.sol` | Real bridge and mediator on each side, proofs built from real logs (`utils/DynamicProofs.sol`, `TrieBuilder.sol`, `ReceiptBuilder.sol`). |
| Rust and Solidity agreement | `light-client/tests/fixtures/message/` (91 cases) run by `light-client/crates/lc-testkit/tests/fixtures_agree.rs` and `test/hardened/LightClientFixtures.t.sol`; fork observation fixtures run by `ForkRegistry.t.sol` | Both sides must give the same accept or reject. |
| Unit and property tests, programs | `light-client/crates/lc-testkit/tests/*.rs`, inline tests in `lc-core` | Synthetic updates with real BLS signatures over 512-key committees, every layout. |
| Real-chain fixtures | `light-client/tests/fixtures/{ethereum,pulsechain,sepolia,pulsechain-testnet-v4}/`, see `light-client/tests/fixtures/README.md`; tests `pulsechain_real.rs`, `ethereum_real.rs`, `gloas_real.rs`, `receipts_real.rs`, `layout_real_accepts.rs` | Real updates, states, receipts and Sepolia Gloas data. Real transactions are not on file, so real data stops before the transaction proof. |
| Real Groth16 proof | `test/hardened/SP1VerifierGroth16.t.sol` and `prover/tests/remote_prover.rs` with `test/hardened/fixtures/sp1-proof-sepolia-update.json` | A real proof of the current light-client program key, made by the testnet backend for a real Sepolia update, against the vendored verifier and the remote backend's checks, with tampering cases. |
| Prover tests | `prover/tests/*.rs`, inline tests | A signed synthetic beacon chain (feature `signed-beacon`), the evidence and opening builders, the remote backend against a fake worker. |
| Two-chain Anvil (local node) | `explorer/indexer/test/integration/real-stack.test.ts` deploys the real contracts on two Anvil chains, but it forces the bridge open with `anvil_setStorageAt` and replaces the gate code: it tests the indexer, not the proofs. | No committed end-to-end test with real proofs on the current contracts exists. An earlier run is in `docs/end-to-end-real-proofs.md` (it used the relayer on the branch `archive/full-relayer`). |
| Mutation lists | `docs/light-client-layout/test-plan.md` Part C (M-1 to M-47) | Each mutation names the tests that must turn red. The team reports M-39 to M-47 (gate) red; run the others yourself. |
| Gas, size and bytecode checks | `*Gas.t.sol`, `test/hardened/Bytecode.t.sol` | No `MCOPY` or `TSTORE`; every contract under 24,576 bytes. |

## 10. Suggested reading order

1. This file, then `known-issues.md` and `invariants.md`.
2. `README.md` (the system and the open items) and `docs/hardened-build-contract.md`. The build contract is a log of dated decisions; later sections supersede earlier ones. The last section, "Fork gate by shape (2026-10-27)", supersedes every older gate note. "As built (2026-10-24)" is the exact contract of the message and token layers.
3. `docs/light-client-layout/test-plan.md` Part A (threats T1 to T24) and `docs/light-client-layout/decisions.md` (D1 to D3). `design.md` in the same folder predates D1 and D2 (see `known-issues.md`).
4. `docs/red-team-revision-2.md`, "Findings in the hardened design" (HB-01 to HB-06), for the reasoning behind the position rules and the committee binding.
5. Tier 1 code: `lc-core` `update.rs`, `layout.rs`, `wire.rs`, `observation.rs`, then `BeaconLightClient.sol`, `BeaconProofVerifier.sol`, `MessageBridge.sol`, `BeaconForkGate.sol` with `ForkShape.sol`, `ForkRegistry.sol`, `TokenMediator.sol`.
6. `docs/sp1-version-policy.md` and `docs/zk-bridge-comparison.md` (the gap list G-01 to G-08 and the committee concentration measurement).
