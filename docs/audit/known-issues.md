# Known issues, accepted risks and open items

This file lists what we already know. Each entry has three parts: what it is, why we accept it or what is left to do, and where to read more. Please do not report these as new findings unless you think the reasoning is wrong. If you do, say why.

Terms (SP1, SSZ, RLP, BLS, EIP) are explained at the top of [`README.md`](README.md).

Where two documents disagree, the code wins, and in `docs/hardened-build-contract.md` the latest dated section wins. Some older documents are stale; the team keeps a list and is fixing them.

## 1. Accepted risks and user decisions

### 1.1 No refunds (H-09)
- **What.** A message sent just before an unsupported fork, or a release that the token refuses, is never refunded on the source chain.
- **Why accepted.** User decision (2026-10-22). A refund without a cross-chain cancellation proof lets one deposit be paid twice: once on the destination and once as a refund. Leaving refunds out removes that path.
- **Link.** [`README.md`](../../README.md) "Open items"; [`docs/red-team-revision-2.md`](../red-team-revision-2.md) "H-09 — Out of scope".

### 1.2 A failed release is final
- **What.** When a native token refuses the transfer to the recipient (block list, pause, revert, gas burn), the mediator emits `ReleaseFailed`, lowers its record by the value, and keeps the tokens. Nobody can claim them. The mediator has no fallback address and no claim.
- **Why accepted.** User decision (2026-10-27): "If tokens get stuck, they are stuck for good." A claim or fallback is an opt-in job for a router, never a default of the bridge.
- **Link.** [`docs/hardened-build-contract.md`](../hardened-build-contract.md) "As built (2026-10-24)", bullet "No fallback in the mediator, and no claim records".

### 1.3 No outflow cap (G-01)
- **What.** The mediator has no rate limit, delay or equivocation halt. A forged header (a dishonest two thirds of a committee, or an SP1 soundness bug) can drain a mediator in one transaction.
- **Why accepted.** User decision (2026-10-22): no flow limits. The empty hook `IFlowLimiter` stays; nothing is attached. A limiter attached later would need its own audit.
- **Link.** [`docs/zk-bridge-comparison.md`](../zk-bridge-comparison.md) G-01; [`docs/hardened-build-contract.md`](../hardened-build-contract.md) "Supply-share flow limiter (removed)".

### 1.4 No admin, no upgrade, no pause, no timelock
- **What.** Nobody can patch, pause or redirect a deployed route. A bug or an unsupported fork is answered by deploying a new route and moving users to it. The old route keeps paying what it can still prove.
- **Why accepted.** User decision. A timelock would stall the bridge at every fork, and every admin power is an attack surface.
- **Link.** [`README.md`](../../README.md); [`docs/sp1-version-policy.md`](../sp1-version-policy.md) "When an advisory hits a deployed route".

### 1.5 The interface cutover before a fork is advice only (HB-02, window 2)
- **What.** The fork schedule is not on chain. The interface stops offering a route one hour (at least three epochs) before an unsupported fork activates. A direct contract call in that window still succeeds.
- **Why accepted.** No contract can see a fork before it activates. This is the one place where safety relies on the interface.
- **Link.** [`docs/red-team-revision-2.md`](../red-team-revision-2.md) HB-02; [`docs/hardened-build-contract.md`](../hardened-build-contract.md) "Interface cutover (HB-02 window 2)".

### 1.6 Sends just before an unsupported fork are stranded
- **What.** A message needs a stored finalized anchor after it. Finality trails the head by about two epochs, so a message in roughly the last two or three epochs before an unsupported fork can never be delivered: about 13 to 19 minutes on Ethereum, 11 to 16 minutes on PulseChain.
- **Why accepted.** The cure is refusing those sends (only the interface can, see 1.5) or refunds (1.1, rejected).
- **Link.** [`docs/red-team-revision-2.md`](../red-team-revision-2.md) HB-02, "Two windows lose funds".

### 1.7 Sync committee concentration on PulseChain
- **What.** About 18 withdrawal credentials hold 342 of 512 PulseChain sync committee seats (measured 2026-10-21). One operator may use many credentials, so the true number of parties is probably smaller. Sync committee signatures are not slashable.
- **Why accepted.** It is trust assumption 1. Proving the full validator set would not help much on PulseChain (19 credentials hold two thirds of all validators).
- **Link.** [`docs/zk-bridge-comparison.md`](../zk-bridge-comparison.md) "Measured on 2026-10-21"; G-06, G-07.

### 1.8 SP1 soundness and a single proof system (G-02)
- **What.** The verifier and program keys are immutable. A soundness bug in SP1 6.8 or in circuit v6.1.0 lets anyone prove false updates for the life of the route. The guest library is `sp1-zkvm` 6.8.0; advisory GHSA-p7v2-jjv3-8p8f affects the prover side in 6.0.0 to 6.8.0, and the prover pins 6.8.1.
- **Why accepted.** A second proof system was not adopted (cost and audit surface). A version policy is in place: check advisories before each deployment.
- **Link.** [`docs/sp1-version-policy.md`](../sp1-version-policy.md).

### 1.9 The gate judges shape, not version names (T18, the reorder-fork trade-off)
- **What.** The gate accepts any fork version whose state proof has an allowed shape (plain depth 5, 6, 7 or Gloas) with `genesis_validators_root` proven at that shape. A future fork that keeps the depth but moves `finalized_checkpoint` (field 20) or a committee field (22, 23) passes the gate. The light client could then read the wrong field.
- **Why accepted.** User decision D3/D4 (2026-10-27). A name list stops sends at every fork, including harmless ones, and the shape rule lets Gloas and PulseChain upgrades need no new route. The residual rests on assumption S6: plain forks only append fields.
- **Link.** [`docs/light-client-layout/test-plan.md`](../light-client-layout/test-plan.md) T18; [`docs/light-client-layout/decisions.md`](../light-client-layout/decisions.md) D3.

### 1.10 Plain depth 7 is accepted; depth 8 and beyond stall
- **What.** The programs accept a plain state of depth 7 (65 to 128 fields) because the genesis validators root branch pins the depth. A state of depth 8 or more, or a new progressive form, is refused: honest updates stop and the route needs a new deployment.
- **Why accepted.** Refusal is the safe failure. Depth 7 acceptance still rests on S6.
- **Link.** [`docs/light-client-layout/test-plan.md`](../light-client-layout/test-plan.md) T4, T5; [`docs/hardened-build-contract.md`](../hardened-build-contract.md) "Fork gate by shape (2026-10-27)".

### 1.11 Gate false positives and liveness costs
- **What.** On PulseChain an execution-only upgrade can fire a canary (`TSTORE`, `MCOPY`, `BLOBBASEFEE`, `CLZ`, the BLS precompile, the beacon roots probe) and switch the gate to enforcing for good; sends then stop until a new route exists. On an enforcing gate, a send fails when no beacon block exists yet in the current epoch, and the first sender of each epoch pays about 40,000 to 43,000 gas to confirm.
- **Why accepted.** Both fail closed. No funds move; sends stop.
- **Link.** [`docs/hardened-build-contract.md`](../hardened-build-contract.md) "Execution canaries in the gate", "Gate evidence: confirm, then send".

### 1.12 A corrupt committee can seal a gate (G-08)
- **What.** The fork observation program accepts a committee signature over an attested header, not a finalized one. A dishonest two thirds can prove a fake disallowed shape and seal the PulseChain gate.
- **Why accepted.** A seal only stops sends. It moves no funds, and a dishonest two thirds can do worse anyway (assumption 1).
- **Link.** [`docs/zk-bridge-comparison.md`](../zk-bridge-comparison.md) G-08.

### 1.13 No staleness limit on the starting head (G-05)
- **What.** An update may fold forward from a head of any age. After months without updates, the old committee keys may carry no stake, which makes a bribe cheaper.
- **Why accepted.** A hard limit with no admin would strand messages for good when it fires. The operator should alert when the head is older than one period.
- **Link.** [`docs/zk-bridge-comparison.md`](../zk-bridge-comparison.md) G-05.

### 1.14 Chain splits (T19)
- **What.** On a contested fork with one genesis validators root, committee members can sign both sides without penalty. The light client follows the first valid update it receives.
- **Why accepted.** Inherent to every light client.
- **Link.** [`docs/light-client-layout/test-plan.md`](../light-client-layout/test-plan.md) T19.

### 1.15 The own-chain light client and registry freshness
- **What.** On PulseChain the registry checks freshness against a light client of PulseChain on PulseChain. If nobody updates it, old observations look fresh, and after 64 periods of lag one proof cannot catch up.
- **Why accepted.** Keeping it current is the operator's job (launch sequence step 5). A stale registry weakens fork detection; it cannot move funds.
- **Link.** [`docs/hardened-build-contract.md`](../hardened-build-contract.md) "Own-chain light client freshness", "Launch sequence".

### 1.16 The Sepolia Gloas boundary waits about two epochs
- **What.** The Sepolia Gloas fork starts exactly at sync committee period 1379. The transition update (pre-Gloas finalized header, Gloas signature) is refused with `SignatureInNextPeriodWithoutCrossing`. Later updates in that period apply.
- **Why accepted.** Reviewed 2026-10-27: a wait of about two epochs, not a stall. Every Ethereum mainnet fork has the same short gap.
- **Link.** `progress.txt`, checkpoint "review fixed, keys rebuilt, audit preparation".

### 1.17 Token behaviour the mediator does not support
- **What.** Rebasing and interest-bearing tokens are not supported: the record can exceed the balance and releases then fail for that token. A token with no `decimals()` gets a copy with 0 decimals. A fee-on-transfer token bridges the amount that arrived. Decimals above 255 are refused.
- **Why accepted.** Amounts are integers everywhere; decimals are display only. Each problem stays inside one token's record.
- **Link.** `src/hardened/mediator/TokenMediator.sol` header comment; [`docs/hardened-build-contract.md`](../hardened-build-contract.md) "As built", bullet "Decimals".

### 1.18 The sender of a message is `msg.sender`
- **What.** A send through a multicall or any contract shows that contract as `messageSender()`. A token relay pulls tokens from that contract.
- **Why accepted.** This is an arbitrary message bus. Contract senders and recipients are allowed by design.
- **Link.** [`docs/hardened-build-contract.md`](../hardened-build-contract.md) "Gate evidence: confirm, then send", "A recipient may be a contract".

### 1.19 A message names a destination chain, not a destination bridge
- **What.** A second bridge on the same chain that trusts the same remote bridge can deliver the same message to its own targets.
- **Why accepted.** A target must trust exactly one bridge (`msg.sender == bridge`). The mediator does, and refuses a handler call from another bridge (`NotBridge`).
- **Link.** [`docs/hardened-build-contract.md`](../hardened-build-contract.md) "As built", "Names and shapes".

### 1.20 Delivery router: tips, hand-offs and the user call
- **What.** (a) A deliverer can raise a gas-based tip up to the sender's `limit` by supplying more gas; the tip always goes to the immutable `rewardAddress`, so its owner benefits. (b) Value the router cannot deliver goes to `failedDeliveryAddress`; if that token also refuses that address, the tokens stay in the router (`HandOffRefused`) until a later `sweep` succeeds. (c) The user call after a delivery runs from the router and can move stray router tokens, never delivered value. (d) A reentrant callback is handed off whole after its tip (`DeliveryFailed(Reentered)`).
- **Why accepted.** User decisions (2026-10-26 and 2026-10-27). Tips are voluntary and set by the sender. The router is optional.
- **Link.** [`docs/hardened-build-contract.md`](../hardened-build-contract.md) "Fees: a router that delivers a message and pays a tip from it", "The call after a delivery".

### 1.21 The verifier code hash differs from Succinct's deployed copy
- **What.** Our build of the vendored verifier has code hash `0xe5878a94...e84b`. Succinct's deployed verifier for the same circuit has `0xcceb864c...04dd`. The cause was not found.
- **Why accepted.** The deploy script pins whichever code hash the operator chooses. Deploying the vendored source needs no trust in a deployer account.
- **Link.** [`docs/sp1-version-policy.md`](../sp1-version-policy.md) "Code hash for `verifierCodeHash`".

## 2. Open items

### 2.1 The real Ethereum mainnet genesis validators root branch fixture is missing
- **What.** `light-client/tests/fixtures/ethereum/state_proofs.json` does not exist. No public mainnet node tried on 2026-10-27 serves old debug states. The real Ethereum tests run a reduced check (see `lc_testkit::real_proofs`), and two tests are ignored: `ethereum_state_proofs_are_on_file`, `every_golden_case_is_computed`.
- **What is left.** Fetch the attested states from a node that keeps them and run `derive-attested-state-proofs`.
- **Link.** [`light-client/tests/fixtures/README.md`](../../light-client/tests/fixtures/README.md).

### 2.2 No real Groth16 proof of the current program keys
- **What.** The 13 tests in `prover/tests/remote_prover.rs` are ignored: their real Ethereum update has no genesis validators root branch, and the stored proof belongs to an older program. `test/hardened/SP1VerifierGroth16.t.sol` runs a real proof of an older program, so it tests the verifier, not today's key.
- **What is left.** Make a real proof of the rebuilt program from an update with its attested state, regenerate the fixture, and un-ignore the tests.
- **Link.** Header of `prover/tests/remote_prover.rs`.

### 2.3 Groth16 proving is not reproduced in continuous integration
- **What.** There is no continuous integration. Real proofs were made by hand on a CPU server and on a rented GPU worker. The SP1 executor test (`prover/tests/sp1_execute.rs`, feature `sp1`) needs about 16 GB of memory.
- **What is left.** A reproducible proving job.
- **Link.** [`docs/server-prover.md`](../server-prover.md), [`docs/gpu-prover.md`](../gpu-prover.md).

### 2.4 No deployment and no end-to-end run on the current contracts
- **What.** Nothing is deployed on any chain, including testnets. The last end-to-end run with real proofs used an older contract stack and the archived relayer. The new harness in `e2e/` is not committed.
- **What is left.** An Anvil end-to-end run with real proofs on the final contracts, then the testnet run (Sepolia and PulseChain testnet v4).
- **Link.** [`docs/testnet-run.md`](../testnet-run.md), [`docs/end-to-end-real-proofs.md`](../end-to-end-real-proofs.md).

### 2.5 Who pays for proving (H-15)
- **What.** Decided: a funded operator runs the prover and pays gas; the contracts take no proving fee. The operator server is not in this repository and does not exist yet. Delivery tips are voluntary.
- **What is left.** The operator server and its funding.
- **Link.** [`README.md`](../../README.md) "Funded operator"; [`docs/hardened-build-contract.md`](../hardened-build-contract.md) "Launch sequence".

### 2.6 The GPU worker image holds old program keys
- **What.** The documented worker image (v5) was built for earlier program keys.
- **What is left.** Rebuild with `script/build-gpu-image.sh` and update the worker.
- **Link.** [`docs/gpu-prover.md`](../gpu-prover.md).

### 2.7 Real data stops before the transaction proof
- **What.** The real fixtures hold transaction hashes, not transaction bytes, so real-chain message tests stop before the transaction trie proof. The transaction proof is tested on synthetic data.
- **What is left.** Real transaction bytes in the fixtures. The prover needs a node that serves `eth_getRawTransactionByHash`.
- **Link.** [`light-client/tests/fixtures/README.md`](../../light-client/tests/fixtures/README.md) "Real data".

### 2.8 No real Ethereum historical-path check
- **What.** The historical ancestry path is confirmed on real PulseChain data (eras 0, 1325, 1326) but not on real Ethereum data.
- **What is left.** A real Ethereum fixture for the historical path.
- **Link.** [`docs/hardened-build-contract.md`](../hardened-build-contract.md) "Ancestry: two paths".

### 2.9 Prover cannot build message evidence from Ethereum mainnet blocks
- **Status.** Fixed on 2026-10-28.
- **What was wrong.** The `evidence` command built a message proof from a PulseChain (Capella) or a Gloas source block only. `BlockView::parse_for_chain` (`prover/src/light_client.rs`) refused Deneb, Electra and Fulu by name. Ethereum mainnet runs Fulu, so no message from Ethereum mainnet could be delivered by this prover.
- **The fix.** `try_parse_signed_block_for_fork` in `lc-core` (`light-client/crates/lc-core/src/ssz_state.rs`) reads the Deneb body (12 fields, payload header of 17 fields) and the Electra and Fulu body (13 fields, with `execution_requests`, and the Electra sizes for attestations and attester slashings). It sits behind the `json` feature: the prover enables it and the two guest programs do not, so the program keys are unchanged. `BlockView::parse_for_chain` now accepts Capella, Deneb, Electra and Fulu and still refuses Gloas with the same message.
- **Evidence.** Real mainnet blocks, one per fork, in `prover/tests/fixtures/ethereum-mainnet-blocks/`: Deneb slot 10,000,000, Electra slot 12,000,000, Fulu slot 13,500,000. `prover/tests/mainnet_blocks.rs` checks that the parsed header root, body root and execution block hash equal the values that a beacon node reported, and that the block hash branch verifies. The fixture files record the source of each block.
- **Limit.** This is liveness only: the contracts check any evidence, so a wrong parser could cause a refusal, never a false message.
- **Link.** `prover/src/light_client.rs` (`BlockView::parse_for_chain`), `prover/src/beacon/http.rs` (`message_path`), `prover/src/evidence.rs`.

### 2.10 Mainnet deployment gas
- **What.** On Sepolia after its gas repricing, the deployment cost about 108.7 million gas per chain (TokenMediator 40.5 million, MessageBridge 35.8 million). A per-transaction gas cap on Ethereum mainnet could block the two largest deployments.
- **What is left.** Measure on mainnet conditions before launch; split contracts into libraries if needed. `MessageBridge` is close to the 24,576-byte size limit (2,111 bytes of room when last measured).
- **Link.** `progress.txt`, checkpoints "dry deploy and Sepolia gas" and "funded, image v4, fuzz".

### 2.11 Release housekeeping
- **What.** No remote repository yet; the first commit (`3df2f14`) needs re-signing before it is pushed; no `LICENSE` file (files say MIT, not confirmed); the brand name is not chosen.
- **What is left.** User decisions.
- **Link.** `progress.txt`, last checkpoint.

## 3. Earlier internal findings and their status

### 3.1 Revision 1 of the proposal (H-01 to H-23)

These were found in the third-party proposal (`spec/`). The column "Hardened design" says how the rebuild handles each one.

| Id | What (in the proposal) | Hardened design | Link |
|---|---|---|---|
| H-01 | Unsigned `nextCommitteeRoot`; anyone installs a committee | Fixed: the next committee is proven from the attested state, and its hash is bound (HB-01) | [red-team.md](../red-team.md) |
| H-02 | Fake deposit emitter | Fixed: the log emitter must be the remote bridge (`WrongEmitter`) | [red-team.md](../red-team.md) |
| H-03 | Same-address token mapping across a forked chain | Fixed by design: copies live at a `CREATE2` address from the home chain and the native token; no mapping table | [red-team.md](../red-team.md) |
| H-04 | ECDSA "committee" chosen by the deployer | Fixed: BLS aggregate verification of the real sync committee inside the SP1 program | [red-team.md](../red-team.md) |
| H-05 | No circuit exists | Fixed: two guest programs, reproducible program keys | [red-team.md](../red-team.md) |
| H-06 | Light clients wired to the wrong chain | Fixed: the deploy script checks each light client's root and clock against the other chain | [red-team.md](../red-team.md) |
| H-07 | One block root per period | Fixed: every finalized head is stored; folds of up to 64 updates | [red-team.md](../red-team.md) |
| H-08 | No finality | Fixed: only finalized headers, proven by the finality branch | [red-team.md](../red-team.md) |
| H-09 | No liquidity model, no refund | Out of scope by user decision (see 1.1) | [red-team-revision-2.md](../red-team-revision-2.md) |
| H-10 | Unchecked target chain | Fixed: the message names its destination chain (`WrongDestinationChain`); the send has no chain parameter | [red-team.md](../red-team.md) |
| H-11 | Wrong verifier interface | Fixed: `verifyProof`, which reverts; tested against the real verifier | [red-team.md](../red-team.md) |
| H-12 | Nonce collision | Fixed: a bridge nonce in the identifier | [red-team.md](../red-team.md) |
| H-13 | Unsafe token handling | Fixed: `SafeERC20` and received-amount accounting | [red-team.md](../red-team.md) |
| H-14 | One malformed signature fails the update | Not applicable: one aggregate signature with participation bits | [red-team.md](../red-team.md) |
| H-15 | Update gas with no fee | One proof check per update (about 337,000 gas with the real verifier); funded operator (see 2.5) | [red-team-revision-2.md](../red-team-revision-2.md) |
| H-16 | No source chain check | Fixed: `WrongSourceChain` in the bridge and in the mediator | [red-team.md](../red-team.md) |
| H-17 | Deploy script cannot deploy | Not applicable: new deploy script with tests | [red-team.md](../red-team.md) |
| H-18, H-20, H-22, H-23 | Front end, build and setup notes of the proposal | Not applicable to the rebuild | [red-team.md](../red-team.md) |
| H-19 | Immutable contracts against hard forks | Addressed: layout from evidence, fork gate, registry, new routes; residuals in 1.5, 1.6, 1.9, 1.10 | [red-team.md](../red-team.md) |
| H-21 | Setup notes install an npm package that does not exist | Contained: never installed; the rebuild uses the Rust crate `sp1-sdk` only | [red-team.md](../red-team.md) "Containment" |

### 3.2 Revision 2 of the proposal (R2-01 to R2-15)

| Id | What | Hardened design | Link |
|---|---|---|---|
| R2-01, R2-04, R2-11 | The proposal's vault and circuit do not compile | Not applicable | [red-team-revision-2.md](../red-team-revision-2.md) |
| R2-02 | The circuit's event topic matches nothing | Fixed: topic tested against the OmniBridge event signature | same |
| R2-03 | The BLS check checks nothing | Fixed (as H-04) | same |
| R2-05 | Typed receipts cannot be decoded | Fixed: receipt types 0 to 4 | same |
| R2-06 | Only the first matching log can be proven | Fixed: the proof names the log index | same |
| R2-07 | Token registry ignores decimals | Fixed by design: copies take the decimals; amounts are integers; above 255 refused | same |
| R2-08 | No address prediction | Fixed: the deploy script predicts and reads back every address | same |
| R2-09 | No domain separation | Fixed: genesis validators root in the signing domain and in the public values | same |
| R2-10 | Built for Cancun | Fixed: `shanghai`, and a bytecode scan for `MCOPY` and `TSTORE` | same |
| R2-12 | Period not tied to the header | Fixed: periods come only from slots | same |
| R2-13 | Execution block hash not linked to the signed root | Fixed: execution branch under the body root, or the Gloas state anchor with an RLP hash check | same |
| R2-14 | No zero-address checks in constructors | Fixed: every constructor refuses zero values | same |
| R2-15 | Zero recipient accepted | Fixed: `InvalidReceiver` | same |

### 3.3 Findings in our own design (HB-01 to HB-06)

| Id | Severity | What | Status | Link |
|---|---|---|---|---|
| HB-01 | Critical | An unbound next committee could sign a forged head | Fixed (`628e30a`, `0aa1d0a`); `startNextSyncCommitteeHash` added for folds | [red-team-revision-2.md](../red-team-revision-2.md) |
| HB-02 | High | Sends into a route that cannot follow a fork | Built, not audited: gate, canaries, registry. Residuals in 1.5, 1.6, 1.9 | same |
| HB-03 | Critical | A block roots layout row could point at proposer-written votes | Fixed (`2119d5d`): own field position only | same |
| HB-04 | Critical | A block hash layout row could point at graffiti | Fixed (`2119d5d`) | same |
| HB-05 | High | A message in a receipt with more than 32 logs was stuck | Fixed (`2119d5d`): `ReceiptLogs` walker | same |
| HB-06 | Medium | Nothing named the destination | Fixed: the message names a destination chain; a target trusts one bridge (see 1.19) | same |

### 3.4 Comparison gaps (G-01 to G-08)

| Id | What | Status | Link |
|---|---|---|---|
| G-01 | No limit, delay or halt on a forged header | Rejected by user decision (1.3) | [zk-bridge-comparison.md](../zk-bridge-comparison.md) |
| G-02 | No answer to an SP1 soundness bug | Version policy adopted; second proof system not adopted (1.8) | same |
| G-03 | Deploy script did not check the verifier's code | Fixed: `verifierCodeHash` pinned per chain (`VerifierCodeHashMismatch`) | same |
| G-04 | No check against future slots | Fixed: `HeadInFuture` | same |
| G-05 | No staleness limit on the starting head | Not adopted; operator monitoring (1.13) | same |
| G-06 | Participation threshold | Kept at 342 of 512, the protocol value | same |
| G-07 | Full-consensus proving | Not now | same |
| G-08 | Observation uses an attested header | Accepted (1.12) | same |

### 3.5 Code reviews and test campaigns

| Date | What | Status | Link |
|---|---|---|---|
| 2026-10-21 | Seal with an old header that the beacon roots buffer still holds | Fixed (`f35432a`): `SealEvidenceTooOld` | [hardened-build-contract.md](../hardened-build-contract.md) "BeaconForkGate" |
| 2026-10-21 | Layout ranges could cover unvalidated slots of another position | Fixed (`0bbe2db`): `LayoutRangeConflict` | same, "Decision: source-chain forks" |
| 2026-10-21 | Asymmetric token tables paid the wrong token | Retired with the vault: copies are computed | same, "Destination token binding" |
| 2026-10-21 | Registry freshness read a light client nobody updated | Addressed: the own-chain light client is a route the operator updates (1.15) | same, "Own-chain light client freshness" |
| 2026-10-21 | Duplicated SSZ calldata and memory code | Kept: removing it costs about 1,500 gas per delivery | `progress.txt` |
| 2026-10-25 | A hostile token could erase a nested lock in the mediator record | Fixed: write after the call; `test_aTokenThatRelaysDuringAReleaseAndThenRefusesKeepsTheNestedLock` | same, "As built", "Mediator" |
| 2026-10-26 | The delivery router could strand tokens (refused payout, router as recipient, odd data) | Fixed: hand-off to `failedDeliveryAddress`, no revert in the callback | same, "Fees: a router that delivers a message and pays a tip from it" |
| 2026-10-27 | OmniBridge gap audit: a token needing more than the release gas, a very long name, the native router stranding coins | Fixed: sender-set gas limit, deploy gas grows with name length, native router removed, decimals above 255 refused | same, "As built", "Mediator" |
| 2026-10-27 | Branch review: the observation could not report a disallowed shape, so the PulseChain gate could never seal on a real proof (medium) | Fixed (`34b37c5`): the observation proves plain depths 8 to 31 | [decisions.md](../light-client-layout/decisions.md) "D2 addendum" |
| 2026-10-27 | Branch review: the prover trusted stored genesis validators root branches (low) | Fixed (`a43339d`): checked, dropped and rebuilt when bad | `progress.txt` |
| 2026-10-22 | Local attack run on two chains | No real-chain hole. Artefacts of the local setup only (public oracle key, an Anvil chain revert) | [local-attack-report.md](../local-attack-report.md) |
