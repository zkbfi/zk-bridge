# zk-bridge red team

This repository attacks a proposed Ethereum ↔ PulseChain zero-knowledge bridge. The proposal is in `spec/`, unchanged from the original zip. The findings are in [`docs/red-team.md`](docs/red-team.md).

**Do not deploy the code in `spec/`.** The tests show that an attacker can take over its light client and drain both vaults.

## What runs

Every red-team test passes when its attack **succeeds**. A green run means the specification fails.

| Suite | What it proves | Command | Time |
|---|---|---|---|
| Forge | Contract-level holes on one chain | `forge test` | about 1 second |
| Harness | End-to-end exploits on two Anvil chains (chain 1 on port 18545, chain 369 on port 18546) | `pnpm --dir harness install && pnpm --dir harness test` | about 1 minute |
| Checks | The circuit does not compile, the frontend fails, the deploy script cannot deploy, and the npm package does not exist | `bash checks/run.sh` | several minutes on the first run |

Requirements: Foundry (`forge`, `anvil`), Node.js with pnpm, and Rust with Cargo. Clone with `--recurse-submodules`, or run `git submodule update --init`.

## Layout

| Path | Contents |
|---|---|
| `spec/` | The original specification. Read only. |
| `docs/red-team.md` | Holes H-01 to H-23, by severity |
| `docs/build-contract.md` | The shared interfaces that the test suites follow |
| `docs/spec-deviations.md` | Changes made to compile the specification (line endings only) |
| `src/` | The specification's contracts, copied verbatim, plus test doubles in `src/mocks/` |
| `test/` | Forge tests |
| `harness/` | Two-chain TypeScript tests |
| `checks/` | Static checks |

## Safety

- `spec/Deployments/deploy.sh` and the shell commands in `spec/frontend-setup-notes.md` are bricked. Every original line carries a `#BRICKED# ` prefix, and the script exits before any of them. Do not un-brick them. See "Containment" in `docs/red-team.md`.
- Never run `npm install @succinctlabs/sp1-sdk` from `spec/frontend-setup-notes.md`. That package does not exist, and anyone can register the name (H-21).
