# Audit prep: one folder for proposal v0 and its red team, and a clean scope

Date: 2026-11-20. Status: approved for implementation.

## The owner's words

- "we should also prep the codebase for an audit. it looks like users are complaining that we have draining code in the repo"
- "not users on production mind you, just busy body ai's that want to claim that the code we write is not trustworthy, when they are just looking at the rough drafts"
- Asked where the red team of the proposal should live, the owner chose: "One labeled folder here" (keep it in zk-bridge, all of it under one top-level folder with a README banner: the design, attacks against it, never deployed).
- "don't call it the original 3rd party. just call it proposal v0"

## Why

The repository is public. Reviewers that skim it (often automated) read `src/ZKBridgeVault.sol`, `src/revision-2/` and the
tests outside `test/hardened/`, which are attacks that pass when they drain the proposal v0's vault, and
`src/mocks/MockSP1Verifier.sol`, which trusts one signer. They conclude our bridge drains. None of it is deployed:
`docs/audit/README.md` says so in a table near its end, which a skim never reaches.

## Decision 1: one top-level folder, `proposal-v0/`

Everything that belongs to the red team of the proposal moves under `proposal-v0/`, keeping its inner layout:

- `spec/` (the proposal v0) → `proposal-v0/spec/`
- `src/ZKBridgeVault.sol`, `src/LightClientSync.sol`, `src/revision-2/` → `proposal-v0/src/...`
- the tests outside `test/hardened/` that attack the proposal → `proposal-v0/test/...`
- `harness/`, `checks/` → `proposal-v0/harness/`, `proposal-v0/checks/`
- the red-team reports (`docs/red-team.md`, `docs/red-team-revision-2.md`, `docs/local-attack-report.md`, and any other
  document that is about the proposal, not about our code) → `proposal-v0/docs/`

`proposal-v0/README.md` opens with a banner: proposal v0, the specification this project started from (the first commit); the attacks in here are
against that design and pass when the attack succeeds; none of it is deployed or used by zkb.fi; our code is in
`src/hardened/`, `light-client/`, `prover/`, `explorer/`. The red-team suite still builds and passes from its new
place (its own Foundry profile or config), and the command to run it is in that README.

Our own red-team tests of our own code (`explorer/*/test/redteam/`, `docs/red-team-2026-10-29-offchain.md`) are
reviews of zkb.fi and stay where they are.

## Decision 2: test doubles live under `test/`

`src/mocks/` moves to `test/mocks/` (the hardened tests import them; `src/` then holds only `src/hardened/` and
`src/testnet/`). Each mock opens with a NatSpec line: a test double, never deployed. `src/testnet/TestToken.sol` stays (it is
deployed on testnet) and says so.

## Decision 3: the scope is the first thing a reader sees

- The README's first screen says what zkb.fi is, which code is deployed (with the deployment record and the deployed
  contracts page), where the audit entry document is, and that `proposal-v0/` is not ours to ship.
- `docs/audit/README.md` updates every path that moved.
- `DeliveryRouter.sweep` is explained at the top of `docs/audit/known-issues.md`: anyone may call it; it hands the
  router's whole balance of a token to the immutable `failedDeliveryAddress`; why it exists (tokens sent to the router
  with no callback); the address on each chain and who holds it.

## Decision 4: green before an auditor runs anything

- `forge test` passes in full (today 4 fail on main: 2 in RedeployLayers, 2 in BeaconForkGateGas).
- The terminal `review-gate` test passes.
- `script/check-docs-public.sh` passes.
- The audit commit is the deployed code: either the round-3 `RouterCaller` change is redeployed on testnet, or the
  audit entry document names the commit to audit and says what differs from the testnet deployment.

## Checks

- `forge build` and `forge test` (main profile) pass; the red-team suite passes from `proposal-v0/`.
- `git grep` finds no path that still points at a moved file (docs, scripts, CI, Foundry config, the release and
  deploy scripts, the docs site).
- The explorer suites and the docs-site checks pass.
