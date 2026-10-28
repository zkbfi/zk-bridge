# Shared brief for the test helpers

Repository: the repository root (Rust workspace in `light-client/`).

## What changed (already committed, do not redo)
The light-client program and the fork-observation program no longer read the fork table to choose a layout. The evidence
chooses (see `light-client/crates/lc-core/src/update.rs`, `layout.rs`, `types.rs`):

- State layout from the FINALITY branch length (`layout::state_layout_for_finality_branch_length`): length 6 is plain depth 5
  (indices 105 finality, 54 current committee, 55 next committee), length 7 is plain depth 6 (169, 86, 87), length 9 is the
  Gloas progressive form (735, 2945, 2946). Every other length is refused with `Error::UnsupportedStateBranchLength`, depth 7
  (finality length 8, committee length 7) included. The next-committee branch in the same step must have the depth of the
  chosen layout (5, 6 or 11), else `InvalidNextSyncCommitteeBranch`. Branch checks are EXACT (`ssz::is_valid_exact_branch`):
  no leading zero is stripped or accepted.
- Header form from the form byte (`HeaderForm::Full` or `Compact`, the `form` field of `LightClientHeader`). The payload
  field list (Capella 15 fields, Deneb 17) is named by the payload header itself: `ExecutionPayloadHeader::named_form()`,
  which is Deneb when `blob_gas` is `Some` and Capella when it is `None` (the blob flag of the wire format).
- Full header: branch of exactly 4 entries at index 25 against `beacon.body_root`.
- Compact header: `layout::compact_anchor_for_branch_length`: length 8 is index 412 and length 9 is index 812, both under
  `body_root`; length 11 is index 2947 (`state.latest_block_hash`) under `beacon.state_root`. Other lengths give
  `InvalidExecutionBranch`. A zero hash gives `ZeroExecutionBlockHash`. For a FINALIZED compact header the keccak256 of
  `execution_header_rlp` must equal the proven hash, else `ExecutionHeaderHashMismatch`. That check is mandatory and is the
  only guard for 2947 on a Capella or Deneb state and for 412 on a Deneb payload.
- The fork version is an input per fold step (`FoldStep { update, fork_version }`). `update::table_fork_version(spec, slot)`
  is a convenience for tests and tools: it returns the version of the epoch of `signature_slot - 1`.
- Public values: 352 bytes (`LightClientOutput`, 11 words) and 224 bytes (`ForkObservation`, 7 words). Unchanged.

Entry points: `update::verify_step`, `verify_fold`, `verify_light_client_update`, `advance_light_client_store`,
`verify_light_client_fold_with_fork_versions`, `verify_execution_branch(header, which)`,
`verify_finalized_execution(header)`, `wire::{encode_guest_input, run_light_client_guest, ...}`,
`observation::verify_fork_observation`. Test scaffolding: `lc-testkit/src/synthetic.rs` (`build_update`, `UpdateRecipe`,
`StateBuilder`, `build_body_proofs`, `synthetic_payload_header`, `gloas` builders), `lc-testkit/src/json.rs`,
`lc-testkit/src/fork_observation_scenarios.rs`, and the existing tests (`tests/update_rejections.rs`, `tests/gloas.rs`,
`tests/gloas_real.rs`, `tests/fold.rs`, `tests/fork_observation.rs`, `tests/layout_real_accepts.rs`) show the patterns.
The design is in `<scratch>/layout/design.md` (read it, especially the
soundness table).

## Rules for every test you write
1. Every test has a doc comment in the style of the neighbours: `Claim:` (what is asserted), and `Why it is safe` or `Why
   it matters` (the reason). For a wrong-layout pair the reason NAMES THE NODE the claim lands on (for example "index 169 on
   a true depth 5 state lands below `eth1_deposit_index`, a uint64 leaf, so no honest branch reaches it"). Prefer to
   COMPUTE and assert that landing node (walk the generalized index through the true tree) instead of only asserting
   rejection. Every attack test also has a control (the honest case passes), and asserts the EXACT error variant.
2. Rust style: doc comments on every item, no nested conditionals (early returns, guard clauses), no abbreviations in names,
   no boolean parameters, DRY helpers. Run `cargo fmt --all` in `light-client/` before you finish.
3. Only create or edit the files named in your task. If you need a change in `lc-core` or in `lc-testkit/src`, do not make
   it: report what you need. Never edit `lc-core/src/*` (it is the code under test).
4. Run tests with `cd light-client && cargo test --offline -p lc-testkit --test <file>`. Other helpers run builds at the
   same time, so a wait on the build lock is normal. Never use the network.
5. Do NOT run `git add`, `git commit` or any git write command. Do not touch `.serena/`, `e2e/`, `explorer/`, `.gitignore`,
   `docs/bots.md`. Never write an email address, a real name or a home directory path into any file. No AI attribution
   anywhere. Never run `sp1up` or a curl-pipe-bash installer. Plain English, no acronyms in comments and doc text where
   a plain word exists (write "generalized index" not "gindex" in prose; code identifiers may follow the crate).
6. A test must FAIL when the rule is wrong: after it passes, temporarily break the rule in your head or by a scratch
   change to a local copy of the data (not to lc-core) and make sure the assertion is not vacuous. Report anything you
   could not make non-vacuous.
7. Final report (short): the file(s), the test names, and for each test the landing node or reason you asserted, plus any
   surprise (a case where the code did not behave as the design says). Do not paste the code.
