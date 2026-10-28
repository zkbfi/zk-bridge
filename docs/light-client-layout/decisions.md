# Binding decisions for all helpers (written by the lead, 2026-10-27)
Repo: the repository root. Read design.md and test-plan.md in the parent directory.
Rules for every helper: plain English, no acronyms in prose or comments, no abbreviations in names, no nested conditionals,
no boolean parameters, doc comments on every item. Do not run git write commands (the lead commits). Never touch .serena/, e2e/,
explorer/, .gitignore, docs/bots.md. No email, real name or home path in any file. No AI attribution. Never run sp1up or
curl-pipe-bash installers. No network except where a task says so. Run `cargo fmt --all` before finishing Rust work.

## D1. Layout witness (light-client program and observation program)
- `LightClientUpdate` (lc-core types.rs) gains `layout_witness_branch: Vec<B256>`. It is the branch of BeaconState field 1
  (`genesis_validators_root`) under the ATTESTED header's `state_root`. Every step of a fold carries its own.
- `StateLayout` (layout.rs) gains `witness_gindex`: plain depth d is `2^d + 1` (33, 65, 129 for d = 5, 6, 7); Gloas is node 40.
  Witness branch length is the depth of that node: 5, 6, 7 and 5.
- Allowed set: plain 5, 6, 7 and Gloas. Finality lengths 6, 7, 8, 9. Next committee lengths 5, 6, 7, 11. Witness 5, 6, 7, 5.
  Plain depth 7 indices: finality 297, current committee 150, next committee 151.
  Every length in one step must agree with the layout named by the finality length. Branch checks stay exact.
- The witness leaf is `spec.genesis_validators_root` (ChainSpec), never read from the input.
- The witness is checked against the attested state root. New error `Error::InvalidLayoutWitness`.
- Order of checks inside verify_step: finality branch, then next committee branch, then the witness.
  The witness is checked even when `next_sync_committee` is absent.
- Wire format: per step, the witness branch comes after the fork version. Public values stay 352 and 224 bytes... see D2 for the
  observation output change (it grows).

## D2. Observation program proves the shape (new, replaces the old "no shape" rule)
PulseChain has no EIP-4788, so the fork observation program proves the shape of the attested state.
- `Observation` (observation.rs) gains `current_version_branch: Vec<B256>` and `layout_witness_branch: Vec<B256>`, both under
  `attested_header.state_root`. The attested header is already carried in full and hashed to the signed root.
- Leaf of the first branch: the 4-byte `fork_version` left-aligned in a 32-byte chunk. It must equal the observed version.
- Position of fork.current_version: plain depth d: `((2^d + 3) * 4) + 1`, so 141, 269 and 525, branch lengths 7, 8, 9.
  Progressive (Gloas): generalized index 169, length 7.
- Witness branch of the same shape: positions 33, 65, 129, 40 with lengths 5, 6, 7, 5.
- Candidate shapes from the version branch length: 7 gives [plain 5, progressive] (try plain first, then progressive; the
  first candidate whose BOTH branches verify wins, and both lengths must match that candidate); 8 gives plain 6; 9 gives
  plain 7. Any other length: refused. If no candidate verifies: new error `Error::InvalidForkShapeProof`.
- `ForkObservation` output gains an eighth word `uint8 shape` (5, 6, 7, or 255 for progressive). The output grows from 224
  to 256 bytes (plus 32). The lc-core abi, the guest, wire (input encoding), ForkRegistry and fixtures all follow.
- The observation's fold steps carry their own layout witnesses (D1).

## D3. Gate on both chains: one rule (see the coordinator message pasted in the Solidity brief)
Accept any fork version whose state proof has an allowed shape (plain 5, 6, 7 or progressive) with the witness proving
genesis_validators_root at that shape under the same state root. Seal only on a shape outside the allowed set (a proof of
a valid branch at a disallowed depth). Version-name list removed on both chains. One shared Solidity library judges shapes;
Ethereum (EIP-4788 evidence) and the registry path both use it. ForkRegistry stores the shape next to each version.
BeaconForkGate takes `genesisValidatorsRoot` as an immutable constructor argument; the deploy script checks it against the chain.
Detection canaries and the EIP-4788 probe stay as they are.
Trade-off to document: shape judging gives up the check that catches a fork that reorders fields at the same depth; the light
client then fails closed.
