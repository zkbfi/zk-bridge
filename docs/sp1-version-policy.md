# SP1 version policy

This policy answers gap G-02 in `docs/zk-bridge-comparison.md`. The light client has no admin, so its verifier and program key are fixed at deployment. A soundness bug in the pinned SP1 release would let anyone prove false updates for as long as the route lives. The only defence is to choose the release with care before deployment, and to stop using a route after a bug.

## What is pinned today

| Item | Pin | Where |
|---|---|---|
| Guest library `sp1-zkvm` | `=6.8.0` | `light-client/guests/light-client/Cargo.toml`, `light-client/guests/fork-observation/Cargo.toml` |
| Precompile patches | tags `patch-*-sp1-6.0.0` | the same files |
| Prover library `sp1-sdk` | `=6.8.1` (crates.io, published 2026-09-24), local processor only, feature `network` off | `prover/Cargo.toml`, feature `sp1` |
| GPU worker | `sp1-sdk` feature `cuda` (crate `sp1-cuda` `=6.8.1`, published 2026-09-24), GPU server release v6.8.1 pinned by SHA-256 hash in `docker/Dockerfile`, `sp1-verifier` `=6.8.1` for local checks of remote proofs | `prover/Cargo.toml`, `docs/gpu-prover.md` |
| On-chain verifier | SP1 contracts release `v6.1.1`, verifier of circuit `v6.1.0`, vendored in `src/hardened/vendor/sp1-contracts/`. The code hash goes in `verifierCodeHash` for each chain. | `script/hardened/bridge.config.example.json`, checked by `script/hardened/DeployBridge.s.sol` |
| Program keys | `programVKey` and the observation key | the deploy config |

The repository never installs the SP1 toolchain with `sp1up` or a `curl | bash` installer. The Rust crate `sp1-sdk` is a dependency of the prover, pinned to one exact version (the npm package of the same name does not exist and must never be installed). The production prover backend is `Sp1Prover`; `docs/server-prover.md` explains how to run it.

## Pinned toolchain and program keys (2026-10-21)

| Item | Value |
|---|---|
| Command line tool | `cargo prove` from sp1-cli 6.8.1, built from source at commit c84ada1 |
| Rust toolchain | rustup toolchain `succinct`, `succinct-1.96.0-64bit-v2` |
| Guest library | `sp1-zkvm` `=6.8.0`. The build works with 6.8.0, so the older release stays. The advisory GHSA-p7v2-jjv3-8p8f concerns the prover side, not the guest library. |
| Build image | `ghcr.io/succinctlabs/sp1:v6.8.1`, linux/amd64 manifest `sha256:2ddd7c1d74be98be628e5e58f9b177a739eb3e7c0a6b8f7b97b358682cb4677b` |
| Dependency lock files | `light-client/guests/light-client/Cargo.lock`, `light-client/guests/fork-observation/Cargo.lock`. Each crate is at least 28 days old (cutoff 2026-09-24). |

| Program | ELF SHA-256 | Program key |
|---|---|---|
| Light client | `acb0948cf9e5f0e6290616b6c3fad500dade96d5160c8622aec6ce11ac167989` | `0x001e477914cbaea2b4b6470e68aecc0d6523a587105bd62ae9e095cbbcacaf71` |
| Fork observation | `b18a356ad5894a9360846c23ebf3c936d6e617ea89f754a59428c96b67ee3a4a` | `0x00c9e04ffbf75e12edabe0461dd30a2e69ab1100bd52f13d35e1d33b11944cb1` |

The two programs changed on 2026-10-27: the layout comes from the evidence (the finality branch length, the form byte, the payload flag and the compact branch length) and the programs read no fork table. The public values keep their 352 and 224 bytes. Two Docker builds gave identical hashes and keys. Before that, the two programs changed on 2026-10-26 (testnet chain selectors and Gloas support, commit 7fc5afa). Two Docker builds on the [private] gave identical hashes and keys. An earlier change, on 2026-10-23: the signature check takes the signer key from the committee aggregate key minus the keys of the absent members, and it ends in one final exponentiation. The keys above are the new ones. Any key deployed before that date belongs to the earlier programs.
The values come from the Docker build and live in `light-client/program-keys.json`. To check them, run `light-client/scripts/program-keys.sh`. It exits with a non-zero code when a value differs.
A native build (`cargo prove build` without `--docker`) gives different ELF hashes and keys, because the output depends on the build machine. Deploy only the Docker keys.
These keys are the values for `programVKey` (light client) and `observationProgramVKey` (fork observation) in the deploy configuration.

## Verifier contract (2026-10-22)

| Item | Value |
|---|---|
| Source | https://github.com/succinctlabs/sp1-contracts, release `v6.1.1` (2026-04-28), commit `d3629729c3216eb51bd4859d027a8eb729399fa4` |
| Contract | `SP1Verifier` in `src/hardened/vendor/sp1-contracts/v6.1.0/SP1VerifierGroth16.sol` (circuit version `v6.1.0`), vendored without change |
| `VERIFIER_HASH()` | `0x4388a21c687fdd5f218d7e3d13190cac4c5355818d3605fd5fb811df468ee696` (selector `0x4388a21c`) |
| `VK_ROOT()` | `0x002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f25352` |

How I confirmed that this release matches `sp1-sdk` 6.8.1:

1. The file `SP1_CIRCUIT_VERSION` in the crate `sp1-prover` 6.8.1 holds `v6.1.0`. The verifier reports `VERSION() = "v6.1.0"`.
2. The SHA-256 hash of `vk-artifacts/groth16_vk.bin` in the crate `sp1-verifier` 6.8.1 equals `VERIFIER_HASH()`. The SDK puts the first four bytes of that hash in front of every proof, and the verifier checks them.
3. The constant `VK_ROOT_BYTES` in the same crate equals `VK_ROOT()`.
4. Release v6.1.1 changed only the compiler pragma of the circuit v6.1.0 verifier, as its notes say. Release v6.0.0 has another circuit (selector `0x0e78f4db`) and refuses every proof of this SDK.

The release ships no proof for circuit v6.1.0. Its one real proof is for circuit v6.0.0. Our own prover made a real proof for circuit v6.1.0: `test/hardened/fixtures/sp1-proof-ethereum-update.json` holds the light-client program on a real Ethereum update. `test/hardened/SP1VerifierGroth16.t.sol` runs it against the vendored v6.1.0 verifier. The verifier accepts it (about 226,000 gas for the call), and it refuses a proof with one changed bit in any public value word, in the nonce or in any proof word, a proof under another program key, and a proof with a changed selector, exit code or key root. The same file checks the constants and the refusals that need no valid proof: wrong selector, proof of another circuit, non-zero exit code, proof of zeros and a short proof. The release proof for circuit v6.0.0 still runs against the v6.0.0 verifier (test use only). `docs/end-to-end-real-proofs.md` shows the same verifier on two Anvil chains, with proofs that the prover made during the run.

### Code hash for `verifierCodeHash`

If you deploy the vendored source with the compiler settings of this repository (solc 0.8.28, optimizer with 200 runs, EVM version shanghai, no metadata hash), the runtime code hash is:

```
verifierCodeHash = 0xe5878a94678c40ab6b1bebc391f4d4c12f44bedb8291921b5c0f5a251ec6e84b
```

The test `test_codeHashIsTheDocumentedVerifierCodeHash` fails when this value drifts. Always check the value against the chain with `cast codehash <verifier> --rpc-url <rpc>` after the deployment.

Two other builds exist, and their hashes differ from the one above. Do not mix them up:

- The verifier that Succinct deployed for circuit v6.1.0 on Ethereum (address in `contracts/deployments/1.json` of the release, key `V6_1_0_SP1_VERIFIER_GROTH16`) has code hash `0xcceb864cd8a5a36b2073a8f2b32a773835cd2dd2c78a56f8e6fdb942feff04dd` (read on 2026-10-22).
- The release source built with its own deploy profile (solc 0.8.20, optimizer with 200 runs, IPFS metadata hash) gives `0x048bdb430e2d55075aae4a2b7633fc4b4baeb61dcb007642bcc03c87f869281d`. It does not equal the deployed hash. I did not find out why. A likely cause is that the deployment predates the pragma change of v6.1.1, but I did not check this.

If you use a verifier that Succinct deployed, put its code hash in the config, and compare its `VERIFIER_HASH()` and `VK_ROOT()` with the table above. The decision between a deployment of the vendored source and an existing deployment is yours. A deployment of the vendored source needs no trust in a deployer account, because anyone can rebuild and compare the hash.

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
4. **Pin the verifier by code hash.** Deploy the Groth16 verifier from the matching SP1 contracts release and record its code hash in `verifierCodeHash`. The deploy script refuses any other code. Check that the verifier's `VERIFIER_HASH()` matches the release too. The current values are in the section "Verifier contract".
5. **Publish a reproducible build** of each program. Anyone can run `light-client/scripts/program-keys.sh` and compare the result with the deployed key.

## When an advisory hits a deployed route

The contracts cannot be patched. The response is the same as for an unsupported fork:

1. The operator stops proving on the affected route, and the stateful servers report the route as stopped.
2. Deploy a new route with a fixed release, and move the interface to it.
3. The old route still holds locked tokens in its mediator. Deliveries on the old route stay possible only while its proofs stay honest. That is why the flow limiter hook exists: a limiter can cap what a forged proof drains while people move.

## Not adopted

A second, independent proof system for each update (for example RISC Zero) would survive a bug in either system. It doubles the proving work and the audit surface. Reconsider it if bridge value grows large next to the cost.
