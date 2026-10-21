# zk-bridge: a red team and a hardened rebuild

This repository holds two things. The first is a red team of the proposed Ethereum and PulseChain zero-knowledge bridge. The proposal sits in `spec/`, unchanged from the original zip. The second is a hardened rebuild of that bridge. The rebuild has no administrator, no upgrade path, no pause and no timelock.

## Status

- The hardened code is **not audited**. Do not put real funds in it.
- Nothing is deployed. Nothing is pushed to any remote.
- The real SP1 prover backend is still a stub. SP1 is the Succinct zero-knowledge virtual machine.
- Only the oracle backend proves today. It runs on Anvil and stands in for the SP1 verifier. It proves nothing about a real chain.
- A real deployment needs the SP1 backend, an audit, and the open items listed below.

## How the hardened bridge works

The bridge moves tokens between two chains. A deposit on the source chain unlocks tokens on the destination chain.

- **Light client.** Each chain has a light client contract for the other chain. It follows the source chain's sync committee. A zero-knowledge proof made with SP1 shows that the committee signed each update. The light client stores only finalized headers.
- **Folded updates.** One proof can cover up to 64 committee handoffs. A light client that lags behind catches up in few proofs.
- **Withdrawal with no proof.** The vault checks a withdrawal itself. It starts from a stored finalized header. It follows a Merkle path through `block_roots` (recent headers) or `historical_summaries` (old headers) to the block. It then checks the receipt and the deposit log. Only light client updates need a proof.
- **Fork safety.** A fork that the proof program does not know would strand deposits. Each vault has a fork gate. On Ethereum, the gate reads the beacon roots contract (Ethereum Improvement Proposal 4788) and refuses a deposit that the route cannot deliver. PulseChain has no such contract today. There the gate runs in a detection mode, and it uses execution canaries (probes for new opcodes and precompiles). A fork registry on PulseChain records fork versions that a committee signature proves. No key switches any of this.
- **Optional fee switch.** A vault can take a deposit fee. One fee authority sets it. An immutable ceiling of 1% limits it. A one-way call turns the fee off for good. Each deposit names a maximum fee, so no timelock is needed.
- **Optional flow limiter hook.** A vault can attach one limiter contract that holds immutable rules. A refusal reverts and leaves the withdrawal claimable later. The rules are not written yet.
- **Funded operator.** One funded operator runs the prover and pays the gas. The contracts take no proving fee. The operator holds no trusted role. The contracts check everything the operator sends.

Details are in [`docs/hardened-build-contract.md`](docs/hardened-build-contract.md).

## Trust assumptions

You must trust all of the following.

1. **Two thirds of the source chain's sync committee are honest.** A forged finalized header lets an attacker forge a deposit. Sync committee signatures carry no slashing. On PulseChain, about 18 withdrawal credentials hold 342 of the 512 committee seats (measured on 2026-10-21). One staking service can use many credentials, so the true number of independent parties is probably smaller. See [`docs/zk-bridge-comparison.md`](docs/zk-bridge-comparison.md).
2. **The SP1 release is sound.** The verifier and the program key are fixed at deployment. A soundness bug in the pinned release lets anyone prove false updates. See [`docs/sp1-version-policy.md`](docs/sp1-version-policy.md).
3. **The deployment checkpoint is correct.** Each light client starts from one checkpoint that people must audit. Every later proof starts from the stored state.
4. **The flow limiter, if one is attached.** A limiter can delay withdrawals. Its rules decide how much a forged proof can drain.

## Findings

Revision 1 findings (H-01 to H-23) are in [`docs/red-team.md`](docs/red-team.md). Every one of them is confirmed against the original specification.

| Severity | Count | Findings |
|---|---|---|
| Critical | 5 | H-01 to H-05 |
| High | 7 | H-06 to H-11, H-21 |
| Medium | 5 | H-12 to H-16 |
| Low | 6 | H-17 to H-20, H-22, H-23 |

Revision 2 (the specification's second version) is in [`docs/red-team-revision-2.md`](docs/red-team-revision-2.md). It lists findings R2-01 to R2-15.

Findings in the hardened design (HB) are in the same file.

| Id | Severity | Status | Summary |
|---|---|---|---|
| HB-01 | Critical | Fixed | An unbound next committee could sign a forged head |
| HB-02 | High | Built, not audited | Deposits into a route that cannot follow a fork. Fork gate, registry and canaries exist. The interface cutover before a fork is advice only. |
| HB-03 | Critical | Fixed | A block roots layout row could point at votes that proposers write |
| HB-04 | Critical | Fixed | A block hash layout row could point at graffiti |
| HB-05 | High | Fixed | A deposit in a transaction with more than 32 logs was stuck |
| HB-06 | Medium | Fixed | Nothing named the destination vault |

The code review and the comparison also produced fixes: the destination token binding, the verifier code hash pin, the clock bound on the head, and the seal evidence age check. The comparison lists gaps G-01 to G-08.

### Open items

| Item | State |
|---|---|
| Refunds (H-09) | Out of scope by user decision. A deposit made just before an unsupported fork, or to a blacklisted recipient, stays locked. |
| Flow limit rules | Pending. The user will send them. |
| Real SP1 prover backend | A stub. The program for fork observation is also stubbed in it. |
| Outflow cap (G-01) | The flow limiter hook is built and waits for the limit rules. |
| Second proof system (G-02) | Not adopted. Reconsider if the value at risk grows. See [`docs/sp1-version-policy.md`](docs/sp1-version-policy.md). |
| Block parser | Reads Capella blocks only. The state parser reads Capella through Fulu. |
| Real chain checks | No real Ethereum historical path check, and no reproducible SP1 build with a program key test. |
| Audit | None. Deploy the hardened code only after an audit. |

## What runs

The red team tests pass when an attack **succeeds**. A green red team run means the specification fails. The hardened tests are ordinary tests. Test counts are as of 2026-10-22.

| Suite | What it proves | Command | Count |
|---|---|---|---|
| Forge, root | The specification's contract holes (red team), and the hardened contracts: light client, vault, fork gate, registry, layouts, fee, limiter, deploy script | `forge test` | 422 passed |
| Light client | The Rust reference programs: update verification, folds, fork observation, layouts, state parsing | `cargo test --offline` in `light-client/` | 143 passed |
| Prover | The prover service, with two Anvil chains and the oracle backend | `cargo test --offline` in `prover/` | 156 passed |
| Harness | End-to-end red team exploits on two Anvil chains (chain 1 on port 18545, chain 369 on port 18546) | `pnpm --dir harness install && pnpm --dir harness test` | Not rerun for this note |
| Checks | The specification's circuit does not compile, the frontend fails, the deploy script cannot deploy, and the npm package does not exist | `bash checks/run.sh` | Not rerun for this note |

Requirements: Foundry (`forge`, `anvil`), Node.js with pnpm, and Rust with Cargo. Clone with `--recurse-submodules`, or run `git submodule update --init`. The Anvil tests skip with a message when `anvil` or `forge` is missing.

## Layout

| Path | Contents |
|---|---|
| `spec/` | The original specification. Read only. |
| `src/` | The specification's contracts, copied verbatim, plus test doubles in `src/mocks/` |
| `src/hardened/` | The hardened contracts: light client, vault, fork gate, fork registry, clock, receipt and tree libraries |
| `script/hardened/` | The deploy script and an example configuration |
| `test/` | Red team forge tests |
| `test/hardened/` | Forge tests for the hardened contracts |
| `light-client/` | Rust reference programs and SP1 guest programs (`lc-core`, `lc-testkit`, `guests/`) |
| `prover/` | The prover service. See [`prover/README.md`](prover/README.md). |
| `harness/` | Two-chain TypeScript red team tests |
| `checks/` | Static red team checks |
| [`docs/red-team.md`](docs/red-team.md) | Revision 1 findings H-01 to H-23, by severity |
| [`docs/red-team-revision-2.md`](docs/red-team-revision-2.md) | Revision 2 findings and the hardened findings HB-01 to HB-06 |
| [`docs/hardened-build-contract.md`](docs/hardened-build-contract.md) | The design and interfaces of the hardened build, with every decision |
| [`docs/zk-bridge-comparison.md`](docs/zk-bridge-comparison.md) | Comparison with other zero-knowledge bridges, the PulseChain concentration measurement, and the gap list |
| [`docs/sp1-version-policy.md`](docs/sp1-version-policy.md) | How we pin the SP1 release, and what to do after an advisory |
| [`docs/zkbridge-paper-review.md`](docs/zkbridge-paper-review.md) | A review of the zkBridge paper |
| [`docs/build-contract.md`](docs/build-contract.md) | The shared interfaces that the red team suites follow |
| [`docs/spec-deviations.md`](docs/spec-deviations.md) | Changes made to compile the specification (line endings only) |
| `progress.txt` | Session checkpoints and next steps |

## Safety

- **Never use the code in `spec/`.** The tests show that an attacker can take over its light client and drain both vaults.
- **Deploy the hardened code only after an audit.**
- `spec/Deployments/deploy.sh` and the shell commands in `spec/frontend-setup-notes.md` are bricked. Every original line carries a `#BRICKED# ` prefix, and the script exits before any of them. Do not un-brick them. See "Containment" in [`docs/red-team.md`](docs/red-team.md).
- Never run `npm install @succinctlabs/sp1-sdk` from `spec/frontend-setup-notes.md`. That package does not exist, and anyone can register the name (H-21).
- This repository never installs the SP1 toolchain or `sp1-sdk`.
