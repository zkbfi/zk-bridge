# Static checks for the red team holes

Run `checks/run.sh` from the repository root. It prints one `PASS` or `FAIL` line per assertion.
`PASS` means the hole is confirmed. The script exits 0 when every hole is confirmed.

The checks read `spec/` and never run anything from it. They do not install any package that only the
specification names (hole H-21). Logs go to `checks/.out/`. Build output goes to `checks/target/`.

Needs: `cargo`, `node`, `npm`, `curl`, `forge` (optional), network access for the registry checks.

| Script | Holes | What it proves | What makes it FAIL |
|---|---|---|---|
| `h05-circuit.sh` | H-05 | The spec `main.rs` fails `cargo check`. It has no `entrypoint!`, no `no_main`, no `commit`, no trie verification. Fixing one error at a time shows the next error. The fully fixed file compiles, and the compiler warns that the built payload is unused. | The verbatim file compiles, or the final file does not warn about `serialized_proof_payload`. |
| `h18-frontend.sh` | H-18, H-21 | `tsc --strict` rejects both frontend files. The worker imports a package that cannot resolve. `window.ethereum` has no type. The component never references the worker and calls `/api/prove-deposit`. At runtime viem cannot encode the string ABI, while `parseAbi` on the same strings works. | Either file typechecks, or a static pattern is missing. |
| `h21-h22-registry.sh` | H-21, H-22 | The registry still returns 404 for `@succinctlabs/sp1-sdk` and zero search results for the scope. `worker-loader` has not been published since 2021. `next` is at major 16, and the Next.js 16 release post says Turbopack is the default bundler. | The package now exists (someone may have registered it), or the network is down. |
| `h17-h06-deploy.sh` | Containment, H-17, H-06 | First confirms that `deploy.sh` is still bricked. Then: `deploy.sh` has wrong `cd` targets, no `--broadcast`, `source ~/.bashrc`, placeholder constructor arguments, a marketing URL as RPC, and `cargo prove vkey` without `--elf`. Each chain gets its own committee root and its own light client. | Any pattern is missing from the script. |
| `h19-h20-files.sh` | H-19, H-20 | No `FORK_GUIDE` file and no build manifest exist under `spec/`. | A listed file appears in `spec/`. |

## Notes

- `rust-circuit/Cargo.toml` uses `rust-version = "1.93"`. Cargo then picks the newest alloy that the installed
  compiler can build (2.1.1, not 2.5.0, which needs Rust 1.94.1). Upgrade Rust and the resolved version moves up.
- `frontend/package.json` pins exact versions that are older than the 28 day npm release age gate on this machine.
- The `rust-circuit-fixed-*` crates and `frontend/src/` are generated at check time and ignored by git.
- `shellcheck` is not installed here. The deploy check uses `bash -n` and patterns only.
