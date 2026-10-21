# SP1 version policy

This policy answers gap G-02 in `docs/zk-bridge-comparison.md`. The light client has no admin, so its verifier and program key are fixed at deployment. A soundness bug in the pinned SP1 release would let anyone prove false updates for as long as the route lives. The only defence is to choose the release with care before deployment, and to stop using a route after a bug.

## What is pinned today

| Item | Pin | Where |
|---|---|---|
| Guest library `sp1-zkvm` | `=6.8.0` | `light-client/guests/light-client/Cargo.toml`, `light-client/guests/fork-observation/Cargo.toml` |
| Precompile patches | tags `patch-*-sp1-6.0.0` | the same files |
| On-chain verifier | the code hash in `verifierCodeHash` for each chain | `script/hardened/bridge.config.example.json`, checked by `script/hardened/DeployBridge.s.sol` |
| Program keys | `programVKey` and the observation key | the deploy config |

The repository never installs the SP1 toolchain or `sp1-sdk`. The real prover backend is still a stub.

## Advisories checked (2026-10-22)

Source: the security advisories of the `succinctlabs/sp1` repository on GitHub, and the open source vulnerability database at osv.dev.

| Advisory | Published | Affects | Effect on us |
|---|---|---|---|
| GHSA-p7v2-jjv3-8p8f, tensor length mismatch | 2026-10-11 | `sp1_prover`, `sp1_hypercube`, `sp1_sdk` 6.0.0 to 6.8.0; fixed in 6.8.1 | None on chain. The advisory says Groth16 and Plonk verification are unaffected. It matters for any native Rust verifier that accepts proofs from untrusted provers. The prover must use 6.8.1 or later when it is built. |
| GHSA-63x8-x938-vx33, recursion row-count binding (CVE-2026-40323) | 2026-04-11 | before 6.0.2; fixed in 6.1.0 | None. We pin 6.8.0. |
| GHSA-6248-228x-mmvh, Plonky3 and verifier checks | 2025-06-03 | before 5.0.0 | None. |
| GHSA-c873-wfhp-wx5m, missing verifier checks | 2025-01-15 | before 4.0.0 | None. |
| GHSA-8m24-3cfx-9fjw, cumulative sum | 2024-11-08 | before 3.0.0 | None. |
| GHSA-f77q-r5qm-w4m8, BabyBear range checks | 2024-10-28 | before 1.2.0 | None. |

## Rules before each deployment

1. **Check the advisories.** List the `succinctlabs/sp1` security advisories (for example `gh api /repos/succinctlabs/sp1/security-advisories`). Refuse a release that any advisory lists as affected for the Groth16 path. Record the date of the check in the deploy notes.
2. **Respect the age rule.** Pin exact versions at least 28 days old, as for every other dependency.
3. **Move the guest and the prover together.** A new `sp1-zkvm` changes the program key. The deploy config must then carry the new key, and the old route stays on its old key.
4. **Pin the verifier by code hash.** Deploy the Groth16 verifier from the matching SP1 contracts release and record its code hash in `verifierCodeHash`. The deploy script refuses any other code. Check that the verifier's `VERIFIER_HASH()` matches the release too.
5. **Publish a reproducible build** of each program, so anyone can rebuild the program key and compare it with the deployed one.

## When an advisory hits a deployed route

The contracts cannot be patched. The response is the same as for an unsupported fork:

1. The operator stops proving on the affected route, and route-health reports STOP.
2. Deploy a new route with a fixed release, and move the interface to it.
3. The old vaults still hold deposits. Withdrawals on the old route stay possible only while its proofs stay honest. That is why the flow limiter hook exists: a limiter can cap what a forged proof drains while people move.

## Not adopted

A second, independent proof system for each update (for example RISC Zero) would survive a bug in either system. It doubles the proving work and the audit surface. Reconsider it if bridge value grows large next to the cost.
