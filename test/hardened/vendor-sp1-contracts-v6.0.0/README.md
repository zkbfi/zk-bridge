# SP1 verifier v6.0.0 (test use only)

These files come from the same commit as `src/hardened/vendor/sp1-contracts/` (release `v6.1.1`, commit `d3629729c3216eb51bd4859d027a8eb729399fa4`), directory `contracts/src/v6.0.0/`.
They are not changed. The bridge does not deploy this verifier: its circuit (`v6.0.0`) differs from the circuit of the SDK that the prover uses (`v6.1.0`).

The release ships one real Groth16 proof, in `contracts/test/SP1VerifierGroth16V6.sol`, and that proof is for this verifier.
`test/hardened/SP1VerifierGroth16.t.sol` uses it to show on a real proof that the code of this family of verifiers accepts a good proof and refuses a tampered one.

```
9e918032a5aa799c1319b14b013154d6a40ca6e5f2267c9f540560abd7fd7689  ISP1Verifier.sol
6b3a34fe9db65b80d54283a98870c083c481e81c89a9cfc665d6477063dc7008  v6.0.0/Groth16Verifier.sol
b02203b0252294db5981ad5b38cb217c39562c971d7b6e428eb535bfc6862e91  v6.0.0/SP1VerifierGroth16.sol
```
