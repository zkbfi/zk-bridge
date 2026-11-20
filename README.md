# zk-bridge: the zkb.fi bridge between Ethereum and PulseChain

This repository is the code of [zkb.fi](https://zkb.fi), a zero-knowledge bridge between Ethereum and PulseChain. Each
chain runs a light client of the other chain's beacon chain, and every light client update carries a Groth16 proof
made with SP1 (Succinct's zero-knowledge virtual machine). The contracts have no administrator, no upgrade path, no
pause and no timelock.

## What is deployed, and where the code is

- **Testnet only.** The bridge runs between Sepolia and PulseChain testnet v4 (chain 943). Every address is in the
  deployment record [`deploy/deployments/sepolia-pls943.json`](deploy/deployments/sepolia-pls943.json) and on the
  docs page [Deployed contracts](explorer/web/docs/pages/10-deployed-contracts.md), with links to the verified source.
  Nothing is deployed on Ethereum mainnet or PulseChain.
- **Not audited.** Do not put real funds in it. The audit starts at [`docs/audit/README.md`](docs/audit/README.md).
- **The code that is deployed:**
  - [`src/hardened/`](src/hardened/): the contracts (light client, fork gate and registry, message bridge, token
    mediator and factory, delivery router), and the vendored SP1 verifier.
  - [`light-client/`](light-client/): the light client logic and the two SP1 guest programs.
  - [`prover/`](prover/): the prover that makes the proofs and the message evidence.
  - [`explorer/`](explorer/): the dapp, the indexer, the backend that schedules proofs, and the bots.
  - [`src/testnet/`](src/testnet/): test tokens that exist on the testnets only.
- **Test doubles** are in [`test/mocks/`](test/mocks/). Each one says it is never deployed. One of them,
  `OracleSP1Verifier`, accepts a signature in place of a proof; it exists for local tests, and the deploy script pins
  the real verifier's code hash.

### Proposal v0

This project started from a specification, proposal v0 (the first commit of the repository). Our red team broke it,
and the hardened design in `src/hardened/` replaced it. Proposal v0 and its red team (attacks that pass when they drain
proposal v0's vault) were removed from the tree on 2026-11-20; they live at
[commit `e253373`](https://github.com/zkbfi/zk-bridge/tree/e25337322e0004fee8f033a993a3b3e052cc382c). The table of its
holes and how the hardened design answers each one is in [`docs/audit/known-issues.md`](docs/audit/known-issues.md),
section 3.

### `DeliveryRouter.sweep` is not a drain

`DeliveryRouter.sweep(token)` can be called by anyone. It sends the router's whole balance of one token to the
router's `failedDeliveryAddress`, which is fixed at deployment and cannot change. The router never holds a user's
tokens between deliveries: it receives and pays out in the same transaction. A balance appears only when someone sends
tokens to the router directly, with no delivery attached, or when a token refuses the router's hand-off to
`failedDeliveryAddress` (the router then emits `HandOffRefused` and keeps them); `sweep` collects those. On the testnets
`failedDeliveryAddress` is the deployer wallet `0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc`. See
[`docs/audit/known-issues.md`](docs/audit/known-issues.md) "Read first".

## Audit

Auditors start at [`docs/audit/README.md`](docs/audit/README.md). It gives the scope with priority tiers, the trust assumptions, the claimed properties, the pinned toolchains and the commands to build and test. [`docs/audit/known-issues.md`](docs/audit/known-issues.md) lists accepted risks and open items, [`docs/audit/invariants.md`](docs/audit/invariants.md) maps each invariant to its code and tests, and [`docs/audit/hardened-findings.md`](docs/audit/hardened-findings.md) holds our red team's findings against the hardened design.

## How the hardened bridge works

The bridge moves messages and tokens between two chains. A message sent on the source chain is delivered to a contract on the destination chain. A token relay is a message to the token mediator on the other side.

- **Light client.** Each chain has a light client contract for the other chain. It follows the source chain's sync committee. A zero-knowledge proof made with SP1 shows that the committee signed each update. The light client stores only finalized headers.
- **Folded updates.** One proof can cover up to 64 committee handoffs. A light client that lags behind catches up in few proofs.
- **Message layer.** `MessageBridge` has the interface of the OmniBridge Arbitrary Message Bridge. A contract calls `requireToPassMessage`. Anyone delivers the message on the other chain with `executeMessage`. The bridge starts from a stored finalized header. It follows a Merkle path through `block_roots` (recent headers) or `historical_summaries` (old headers) to the block. It then checks the receipt, the transaction and the log. Only light client updates need a proof. Delivery is final, messages are independent, and the bridge takes no executor fee.
- **Token layer.** `TokenMediator` has the interface of the OmniBridge multi-token mediator. It locks a native token and mints a bridged copy on the other chain, at an address that the chain computes. It burns the copy and unlocks the token on the way back. A release that the recipient cannot take is final: the mediator emits `ReleaseFailed` and keeps the tokens. It has no fallback address and no claim. `DeliveryRouter` is an optional helper. On the source chain it wraps the native coin and sends it. On the destination chain anyone may deliver through it, it pays the voluntary tip of the sender to a fixed reward address, and it unwraps the wrapped native token. The runner batches deliveries through Multicall3.
- **Fork safety.** A fork that the proof program does not know would strand messages. Each bridge has a fork gate. On Ethereum, the gate reads the beacon roots contract (Ethereum Improvement Proposal 4788) and refuses a send that the route cannot deliver. A send carries no evidence. The first sender of an epoch calls `confirm` on the gate with evidence, and then sends. Later senders in the same epoch just send. PulseChain has no such contract today. There the gate runs in a detection mode, and it uses execution canaries (probes for new opcodes and precompiles). A fork registry on PulseChain records fork versions that a committee signature proves. No key switches any of this.
- **No protocol fee.** The bridge and the mediator take no fee. The only fee is the voluntary delivery tip in `DeliveryRouter`.
- **Optional flow limiter hook.** A mediator can attach one limiter contract that holds immutable rules. A refused relay reverts. A refused release is final: the mediator emits `ReleaseFailed` and keeps the tokens, because delivery is final. No limiter is attached: by user decision, the bridge has no flow limits, and the hook stays empty.
- **Funded operator.** One funded operator runs a stateful server and pays the gas. The server runs the proof producer in `prover/`. The contracts take no proving fee. The operator holds no trusted role. The contracts check everything the operator sends.

Details are in [`docs/hardened-build-contract.md`](docs/hardened-build-contract.md).

## Trust assumptions

You must trust all of the following.

1. **Two thirds of the source chain's sync committee are honest.** A forged finalized header lets an attacker forge a message. Sync committee signatures carry no slashing. On PulseChain, about 18 withdrawal credentials hold 342 of the 512 committee seats (measured on 2026-10-21). One staking service can use many credentials, so the true number of independent parties is probably smaller. See [`docs/zk-bridge-comparison.md`](docs/zk-bridge-comparison.md).
2. **The SP1 release is sound.** The verifier and the program key are fixed at deployment. A soundness bug in the pinned release lets anyone prove false updates. See [`docs/sp1-version-policy.md`](docs/sp1-version-policy.md).
3. **The deployment checkpoint is correct.** Each light client starts from one checkpoint that people must audit. Every later proof starts from the stored state.
4. **The flow limiter, if one is attached.** A limiter can delay releases. Its rules decide how much a forged proof can drain.

## Findings

Revision 1 findings (H-01 to H-23) are in [`docs/red-team.md`](https://github.com/zkbfi/zk-bridge/blob/e25337322e0004fee8f033a993a3b3e052cc382c/docs/red-team.md) at that commit. Every one of them is confirmed against proposal v0.

| Severity | Count | Findings |
|---|---|---|
| Critical | 5 | H-01 to H-05 |
| High | 7 | H-06 to H-11, H-21 |
| Medium | 5 | H-12 to H-16 |
| Low | 6 | H-17 to H-20, H-22, H-23 |

Revision 2 (proposal v0, revision 2) is in [`docs/red-team-revision-2.md`](https://github.com/zkbfi/zk-bridge/blob/e25337322e0004fee8f033a993a3b3e052cc382c/docs/red-team-revision-2.md) at that commit. It lists findings R2-01 to R2-15.

Findings in the hardened design (HB) are in [`docs/audit/hardened-findings.md`](docs/audit/hardened-findings.md).

| Id | Severity | Status | Summary |
|---|---|---|---|
| HB-01 | Critical | Fixed | An unbound next committee could sign a forged head |
| HB-02 | High | Built, not audited | Deposits into a route that cannot follow a fork. Fork gate, registry and canaries exist. The interface cutover before a fork is advice only. |
| HB-03 | Critical | Fixed | A block roots layout row could point at votes that proposers write |
| HB-04 | Critical | Fixed | A block hash layout row could point at graffiti |
| HB-05 | High | Fixed | A message in a transaction with more than 32 logs was stuck |
| HB-06 | Medium | Fixed | Nothing named the destination vault. The retired vault bound it in the log. A message now names a destination chain, and a target trusts its own bridge address. |

The code review and the comparison also produced fixes: the verifier code hash pin, the clock bound on the head, and the seal evidence age check. The build of the message layer found and fixed one defect in the mediator: a hostile token could erase a nested lock in the record of a native token. The comparison lists gaps G-01 to G-08.

### Open items

| Item | State |
|---|---|
| Refunds (H-09) | Rejected by user decision (2026-10-22). A message sent just before an unsupported fork stays undelivered. A release to a recipient that the token refuses is final: the mediator emits `ReleaseFailed` and keeps the tokens. |
| Stateful server | Not in this repository. It posts the updates, calls `openDeposits` and delivers the messages. The launch sequence in `docs/hardened-build-contract.md` lists its steps. |
| Outflow cap (G-01) | Rejected by user decision (2026-10-22). The empty hook remains. A forged proof could drain a mediator in one transaction. |
| Second proof system (G-02) | Not adopted. Reconsider if the value at risk grows. See [`docs/sp1-version-policy.md`](docs/sp1-version-policy.md). |
| Block parser | The Capella block parser reads Capella blocks only. A Gloas source block goes through a separate path (`GloasBlockView`). The prover refuses blocks of the other forks by name. The state parser reads Capella through Gloas. See `docs/audit/known-issues.md` section 2.9. |
| Real chain checks | No real Ethereum historical path check. The real chain fixtures hold transaction hashes and not transaction bytes, so real data stops before the transaction proof. The guest programs have a reproducible build (`light-client/scripts/program-keys.sh`) and pinned program keys (`light-client/program-keys.json`). The test `the_default_elfs_match_the_pinned_hashes` in `prover/tests/sp1_execute.rs` checks the compiled programs against them. |
| Executor fees | The bridge takes none. `DeliveryRouter` pays the voluntary tip of the sender to a reward address, whoever delivers. A target of an arbitrary message pays its own runner. |
| Audit | None. Deploy the hardened code only after an audit. |

## What runs

The hardened tests are ordinary tests. Test counts are as of 2026-10-27.

| Suite | What it proves | Command | Count |
|---|---|---|---|
| Forge, root | The hardened contracts: light client, message bridge, token mediator and routers, fork gate, registry, layouts, deploy script, and two chains in one test with real proofs | `forge test` | Not rerun for this note |
| Light client | The Rust reference programs: update verification, folds, fork observation, layouts, state parsing, message proofs | `cargo test --offline` in `light-client/` | 295 passed, 2 ignored |
| Prover | The proof producer and the message evidence builder, on a signed beacon chain, and the remote backend against a fake worker | `cargo test --offline` in `prover/` | 206 passed, 14 ignored |

To check the contracts, run `script/coverage-check.sh`. It is the single gate: it runs every forge test (thirteen of them in a second step with the optimizer, because coverage compiles without it) and checks for full line, branch and function coverage. It exits with an error and a table when a test fails or a file is below 100 percent. You do not need `forge test` as well. The header of the script lists the exclusions.
To run every suite at once (contracts, light client, prover, explorer, terminal) and see the time of each step, run `script/test-all.sh`. Add `--serial` for the time of each step alone.
Long fuzz and invariant runs are not part of these commands. Run `script/test-deep.sh` nightly and before a deploy. It uses the `deep` profile of `foundry.toml`.
To run two local chains in Docker with the bridge contracts deployed, see `docs/local-network.md`. The network has no prover and no bots.
For a run on two local chains with real SP1 Groth16 proofs and the real SP1 verifier contract (on a server, without Docker), see `docs/end-to-end-real-proofs.md`. That run used the full relayer, so it lives on the branch `archive/full-relayer`.
To make proofs and message evidence, see `prover/README.md`. The commands are `zk-bridge-prover prove` and `zk-bridge-prover evidence`.

Requirements: Foundry (`forge`, `anvil`), Node.js with pnpm, and Rust with Cargo. Clone with `--recurse-submodules`, or run `git submodule update --init`. The tests of the prover need neither `anvil` nor `forge`.

## Layout

| Path | Contents |
|---|---|
| `src/hardened/` | The hardened contracts: light client, message bridge (`MessageBridge`, `BeaconProofVerifier`, `AmbMessageCodec`, `IAMB`), fork gate, fork registry, clock, receipt and tree libraries |
| `src/hardened/mediator/` | The token layer: `TokenMediator`, `TokenFactory`, `BridgedToken`, `DeliveryRouter` and their interfaces |
| `script/hardened/` | The deploy script (both chains, with predicted addresses) and an example configuration |
| `test/hardened/` | Forge tests for the hardened contracts |
| `test/mocks/` | Test doubles (never deployed) used by the forge tests and the local rehearsals |
| `light-client/` | Rust reference programs and SP1 guest programs (`lc-core`, `lc-testkit`, `guests/`) |
| `prover/` | The proof producer and the message evidence builder. A library and two commands. It keeps no state and sends no transaction. See [`prover/README.md`](prover/README.md). |
| `docker/` | The local network (two Anvil chains and a deploy job) and the images of the proof producer for a server and for a GPU worker |
| [`docs/audit/hardened-findings.md`](docs/audit/hardened-findings.md) | The findings in the hardened design, HB-01 to HB-06 |
| [`docs/hardened-build-contract.md`](docs/hardened-build-contract.md) | The design and interfaces of the hardened build, with every decision |
| [`docs/zk-bridge-comparison.md`](docs/zk-bridge-comparison.md) | Comparison with other zero-knowledge bridges, the PulseChain concentration measurement, and the gap list |
| [`docs/sp1-version-policy.md`](docs/sp1-version-policy.md) | How we pin the SP1 release, and what to do after an advisory |
| [`docs/zkbridge-paper-review.md`](docs/zkbridge-paper-review.md) | A review of the zkBridge paper |
| [`docs/rpc-proxy.md`](docs/rpc-proxy.md) | rpc.zkb.fi: the dapp's RPC (a filter in the backend in front of eRPC), its rules and limits, and how to deploy it |

## Safety

- **Never use the code of proposal v0** (removed from the tree, see the top of this file). Its tests showed that an attacker can take over its light client and drain both vaults.
- **Deploy the hardened code only after an audit.**
- The deploy script and the setup notes of proposal v0 were disabled before they were removed (every original line carried a `#BRICKED# ` prefix). Never run `npm install @succinctlabs/sp1-sdk`: that package does not exist, and anyone can register the name (H-21, see [`docs/red-team.md`](https://github.com/zkbfi/zk-bridge/blob/e25337322e0004fee8f033a993a3b3e052cc382c/docs/red-team.md) at that commit).
- This repository never installs the SP1 toolchain or `sp1-sdk`.
