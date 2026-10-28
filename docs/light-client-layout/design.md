# Design: layout from the evidence, not from the fork table (approved 2026-10-27)

Goal: Ethereum's Gloas activation and PulseChain's adoption of Deneb or Electra need no new program. The light client program and the fork observation program choose nothing from the compiled fork table (`ChainSpec.fork_schedule`) that the evidence can decide.

## 1. State proofs: the layout comes from the finality branch length
- Length 6: plain depth 5. Finality index 105, current committee 54, next committee 55.
- Length 7: plain depth 6. Indices 169, 86, 87.
- Length 9: the Gloas progressive form. Indices 735, 2945, 2946. Keep the field-list derivation in layout.rs:186 and :281.
- Any other length is refused.
- The next committee branch in the same step must have the length of that layout (5, 6 or 11). Mixed lengths in one step are refused. Steps in a fold may use different layouts.
- Do not allow depth 7 (finality length 8). On a chain that is truly depth 7, wrong claims land on fields no spec defines yet. (Superseded: `decisions.md` D1 accepts plain depth 7, with finality length 8 and committee length 7.)
- Branch checks become exact. `branch_is_valid` (update.rs:64-66) must never strip or accept leading zeros. The length is the depth.
- Compute the indices from the depth: `2^d + field` and `(2^d + 20)*2 + 1`.

## 2. Execution proofs
- Body depth 4 only: indices 25 (full form), 412 (Capella payload, depth 4) and 812 (Deneb or later payload, depth 5). Refuse 41, 668 and 1324.
- The header form, full or compact, comes from the form byte that the wire format already carries, not from the fork (update.rs:171-183).
- The payload header field list (Capella with 15 fields, or Deneb with 17) is named by the prover in the input, not chosen by the fork (types.rs:179-181). The two root forms cannot collide: that would need a uint64 or padding leaf to equal a hash.
- The Gloas compact anchor (`latest_block_hash` at state index 2947, length 11, under the state root) is chosen by the branch length, not by the fork (update.rs:111-112). The keccak check of the header RLP against the proven block hash (update.rs:144) stays mandatory. It is the only guard for 2947 on a Capella or Deneb state, and for 412 on a Deneb payload.

## 3. The signing fork version
- Today it comes from the table: `table_fork_version` (update.rs:218). Make it a program input, one per fold step and one for the observation.
- It is safe because the committee signs a domain that contains the version. Two thirds of a bound committee signing under version V shows that the chain ran V.
- The existing rules stay: the store binding, a signature slot after the head, and a next-period signature needs a crossing.
- The fork observation program already takes its observed version as an input. Keep that, and apply the same rule to its fold steps.
- After this change, `ChainSpec` keeps only facts that do not change at a fork: the genesis validators root, slot timing, and so on. Remove whatever has no remaining user.

## 4. Public values
- No change: 352 bytes for the light client and 224 for the observation. (Superseded: `decisions.md` D2 adds a `shape` word. The observation is 256 bytes now.)
- Both verification keys change (BeaconLightClient.programVKey and ForkRegistry.observationProgramVKey).

## Soundness table, from the analysis
Every allowed pair of claimed and true layout lands safely, on a basic leaf, padding, a hash-only node or a fixed-shape container:
- True depth 5: 169 lands below eth1_deposit_index; 86 is the data root of the validators list (the aggregate key chunk cannot match); 87 is the validators length; 735 lands in randao_mixes; 2945 and 2946 land in slashings.
- True depth 6: 105 lands on a padding zero chunk; 54 and 55 land on zero-hash level 1; 735 lands below the historical_summaries length; 2945 and 2946 land below field 28 (deposit_requests_start_index).
- True Gloas: 105, 54 and 55 land below the active_fields chunk (node 3); 169 is fork.current_version; 86 and 87 are the children of latest_block_header.
- Execution: 812 on Capella lands below block_number; 412 on Deneb is caught only by keccak; 2947 on Capella or Deneb is caught only by keccak; 2947 on Electra or Fulu lands below a uint64; 412 and 812 on Gloas land below active_fields.
