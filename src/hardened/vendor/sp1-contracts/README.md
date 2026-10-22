# Vendored SP1 Groth16 verifier

These files come from the SP1 contracts repository of Succinct, directory `contracts/src/`.

| Item | Value |
|---|---|
| Repository | https://github.com/succinctlabs/sp1-contracts |
| Release tag | `v6.1.1` (tag object `2ac7311ccc5b400dc7773727ec0d15eb9ff1cfa0`) |
| Commit | `d3629729c3216eb51bd4859d027a8eb729399fa4` |
| Release date | 2026-04-28 |
| Verifier circuit version | `v6.1.0` (the directory `v6.1.0/`; release v6.1.1 changed only the compiler pragma of `Groth16Verifier.sol`) |
| Licence | The files carry the SPDX line `MIT`. The repository has no licence file at its root. |
| Fetched | 2026-10-22 with a shallow clone of the tag |

## Why this release

The Rust crate `sp1-sdk` 6.8.1 builds Groth16 proofs for the circuit version in the file `SP1_CIRCUIT_VERSION` of the crate `sp1-prover` 6.8.1.
That file holds `v6.1.0`. The verifier in this directory reports `VERSION() = "v6.1.0"`.
Two more facts agree, and both come from the crate `sp1-verifier` 6.8.1:

- The SHA-256 of its `vk-artifacts/groth16_vk.bin` is `4388a21c687fdd5f218d7e3d13190cac4c5355818d3605fd5fb811df468ee696`.
  This equals `VERIFIER_HASH()` of `v6.1.0/SP1VerifierGroth16.sol`. The first four bytes are the selector that the sp1-sdk crate puts in front of every proof.
- Its constant `VK_ROOT_BYTES` is `0x002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f25352`.
  This equals `VK_ROOT()` of the verifier.

Releases v6.0.0 and v6.1.0 are the other candidates. v6.0.0 has another circuit (selector `0x0e78f4db`), so it rejects every proof of sp1-sdk 6.8.1.
v6.1.0 and v6.1.1 hold the same verifier logic. v6.1.1 is newer and pins the compiler version as the release notes say.

## Files

- `ISP1Verifier.sol` (also holds `ISP1VerifierWithHash`)
- `v6.1.0/Groth16Verifier.sol`
- `v6.1.0/SP1VerifierGroth16.sol` (the contract `SP1Verifier`)

## Changes

None. The files are byte for byte the files of the commit. The relative imports (`../ISP1Verifier.sol`, `./Groth16Verifier.sol`) work without a remapping.
The contract `ISP1Verifier` in this directory has the same function `verifyProof` as `src/hardened/ISP1Verifier.sol`, so the light client and the fork registry call it without a change.

## SHA-256 of the files as vendored

```
9e918032a5aa799c1319b14b013154d6a40ca6e5f2267c9f540560abd7fd7689  ISP1Verifier.sol
01ab92508b9d56556ee247c7cb6b2ebd9c17835a4618896462b2a3a8708a50bf  v6.1.0/Groth16Verifier.sol
48e1db5baca3b102242ebd88280b3689a088076688146cd0d98876f5dacb76d0  v6.1.0/SP1VerifierGroth16.sol
```

## Tests

`test/hardened/SP1VerifierGroth16.t.sol` checks the constants above and shows that this verifier refuses a wrong selector, a wrong key root,
a bad exit code and a garbage proof. The release ships no proof for circuit `v6.1.0`, so no accepting test exists for this verifier yet.
The file `test/hardened/vendor-sp1-contracts-v6.0.0/README.md` explains the proof of circuit `v6.0.0` that the same test file uses.
