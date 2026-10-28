# Light client layout: threat narrative and test plan

Status: plan only. Nothing here is built yet. It covers the implemented design (commits `fa2f759..4526f7d`) and the five planned changes. Two of the changes wait on a user decision, marked (D).

| Item | Change | Decision |
|---|---|---|
| 1 | The layout witness: each fold step also proves `genesis_validators_root` (state field 1) at the claimed layout. Plain depth 7 joins the allowed set. | (D) |
| 2 | The prover reads the fork schedule and the chain specification from the beacon node at run time. | none |
| 3 | The prover repairs the transition update: it strips the padding of a pre-Gloas finalized header and attaches the encoded execution header. | none |
| 4 | The fork gate judges the shape of the state proof, not the version name. | (D) |
| 5 | Two test gaps from the review: "one layout per step" with an honest branch at another depth, and the attested header checks. | none |

Paths are relative to the repository root. "Exists" means the test is in the tree today, with `file:line`. "New" means someone must write it. "Change" means an existing test must change when its item lands. New error names (for example `InvalidLayoutWitness`) are proposals. The implementer may pick others, but each test must still assert one exact variant.

---

# Part A. The threat narrative

## A.1 How the light client decides, in plain words

The bridge on one chain follows the other chain through a light client. The light client keeps a "head": the newest finalized beacon block header that it accepts.

To move the head, someone sends an update. The update says: "this block is finalized, and 512 validators of the sync committee signed a newer block that confirms it." The light client checks four things:

1. At least 342 of the 512 committee members signed. That is two thirds.
2. The signature is valid for the committee that the light client already trusts.
3. The signed block's state contains the finalized block. A Merkle branch proves this. A Merkle branch is a list of sibling hashes that leads from one value (the leaf) up to a root hash.
4. The finalized block names an execution block (the block that holds transactions and logs). A second branch proves this, and a hash check binds the block number.

A zero-knowledge program runs these checks. A prover runs the program and makes a proof, and the contract checks the proof. The prover chooses every private input to the program. So the program must treat the prover as an attacker.

The difficulty is the **layout**. The beacon state is a tree. The position of a field in the tree depends on how many fields the state has.

- 32 or fewer fields give a tree of depth 5. The finalized root is at position 105 and the finality branch has 6 entries. This covers Capella and Deneb, and PulseChain today.
- 33 to 64 fields give depth 6. The position is 169 and the branch has 7 entries. This covers Electra and Fulu, and Ethereum until Gloas.
- Gloas changes the state to a new "progressive" tree. The position is 735 and the branch has 9 entries.
- 65 to 128 fields would give depth 7. The position is 297 and the branch has 8 entries. No chain has this yet.

The design reads the layout from the evidence: **the length of the finality branch names the layout.** The design does not use a compiled fork table. So a chain can fork into a known layout and the program still works.

The danger is plain. The prover claims a layout that the chain does not have. The claimed position then lands somewhere else in the true tree. If that spot holds a value an attacker can choose, the attacker could "prove" a false finalized block.

## A.2 What the defenses rest on

Each defense below names the assumptions it needs, by these labels.

| Label | Assumption |
|---|---|
| S1 | At least two thirds of each sync committee is honest. They sign only real blocks of the real chain. |
| S2 | SHA-256 and keccak-256 resist preimages and collisions. No one can find an input for a given hash, or two inputs with one hash. |
| S3 | The aggregate signature scheme is sound. No one can forge a signature of 342 members. |
| S4 | The proof system is sound, and the contracts pin the right program keys. |
| S5 | The compiled `ChainSpec` holds the right `genesis_validators_root` for each chain. People check it by hand before deployment. |
| S6 | Plain forks only append state fields. Fields 0 to 37 keep their positions. Every fork from phase 0 to Fulu did this. |
| S7 | The beacon roots contract (Ethereum Improvement Proposal 4788) holds real beacon block roots. Only the protocol writes it. |
| S8 | At least one honest prover is online, and it can reach a beacon node and an execution node. This is for liveness only, not for safety. |

**Why most wrong landings are safe.** A wrong claim lands in one of four kinds of spot:

- **Below a basic leaf.** A basic leaf is a number or a short field padded to 32 bytes. To prove anything "below" it, the attacker needs two values that hash to that leaf. That breaks S2.
- **On a hash-only node or a container root.** The attacker needs a chosen value to equal a hash that someone else made. That breaks S2.
- **On padding.** Padding is a fixed zero hash. The leaf (a block root or a committee root) cannot equal it under S2.
- **On an internal node above two fields.** This is safe only when those two fields are not both free 32-byte values that someone can write. If they were, a proposer could write the two halves of a false header root. This is why fields that no specification defines yet are a risk.

**Liveness.** Under S8 alone, a stall is never permanent. Anyone can run a prover, because `update` is open to everyone. A stall that needs a new program is permanent for the current route, and the fix is a new deployment.

## A.3 The threats

Each entry lists the attacker, the attack, the defense, the assumptions, and the residual risk. "False head" means the light client accepts a header that is not a real finalized header of the chain. "Stall" means honest updates stop.

### T1. Wrong layout claim (malicious prover, false head)

**Attack.** The prover sends a finality branch whose length names a layout that the chain does not have. For example, it sends a 6-entry branch (depth 5) on a depth 6 chain.

**Defense.** Only lengths 6, 7 and 9 are accepted (`light-client/crates/lc-core/src/layout.rs:460`). Every allowed pair of claimed and true layout lands on a safe spot. The design's soundness table lists each one:

- Index 105 on a true depth 6 state lands on a zero padding chunk.
- Index 169 on a true depth 5 state lands below `eth1_deposit_index`, a number.
- Indices 105, 54 and 55 on a true Gloas state land below the `active_fields` chunk.

**Assumptions.** S2 and S6. Also the chain must be in one of the three known layouts.

**Residual.** There is a gap when the true state is wider than any allowed layout (depth 7 or more). Today, two claims then land on fields that no specification defines:

- A 7-entry claim reads index 169 on a true depth 7 state. That is field 41. The test at `light-client/crates/lc-testkit/tests/layout_state_depth.rs:1091` shows that a permissive selector accepts a forged header there.
- A 9-entry Gloas claim reads 735 on a true depth 7 state. That lands below field 55. The committee indices 2945 and 2946 land below field 56. On a true depth 8 state they land below fields 111 and 112. The design's table does not list these Gloas landings. I computed them with the scratch landing script (`layout/analysis/landing2.py`).

Today the only guard against both is that no defined field sits there. Item 1 closes this gap (see T4).

### T2. Padding or cutting a branch to change the layout (malicious prover, false head)

**Attack.** The specification's branch check, `is_valid_normalized_merkle_branch`, accepts extra leading zero entries. A prover could pad a depth 5 branch with one zero and make it 7 long. The length would then name the depth 6 layout while the proof stays a depth 5 proof.

**Defense.** Every branch check in the programs is exact (`update.rs:70-72`, `ssz.rs:147-153`). The branch must have exactly as many entries as the depth of its position. No zero is stripped or accepted.

**Assumptions.** None beyond S2.

**Residual.** None in the program. The prover must strip the padding itself when a node serves a padded branch (T15).

### T3. Mixed layouts in one step (malicious prover, false head)

**Attack.** The prover proves the finalized root at one layout and the next committee at another. Each claim could then pick the safest spot for the attacker on its own.

**Defense.** The layout is chosen once per step, from the finality branch (`update.rs:317`). The committee branch is then checked at that layout's position, so it must have that layout's length (`update.rs:329-337`).

**Assumptions.** S2.

**Residual.** None, but a test gap exists. No test sends a committee branch that is valid at another layout's position against the same state root. Today's tests only send cut, padded or flipped branches. Those fail on the hash check whether or not the rule exists. Test S-7 closes the gap.

### T4. The layout witness (item 1, D)

**What it adds.** Each fold step also proves `genesis_validators_root` (state field 1) at the claimed layout:

| Layout | Witness position | Witness length | Finality length | Next committee length |
|---|---|---|---|---|
| plain depth 5 | 33 | 5 | 6 | 5 |
| plain depth 6 | 65 | 6 | 7 | 6 |
| plain depth 7 | 129 | 7 | 8 | 7 |
| Gloas | 40 | 5 | 9 | 11 |

The leaf comes from `ChainSpec`, never from the input.

**Why it pins the layout.** `genesis_validators_root` is the root of a list. So its right child is the list length: a number padded with 24 zero bytes. The scratch script `verify/scripts/witness.py` walks every wrong position through every true layout:

- On a deeper true layout, a plain witness lands below `genesis_time`, a number. Every plain witness lands there on a true Gloas state.
- On a shallower true layout, it lands on an internal node whose right child is a hash. For example, 33 on a true depth 6 state is the node over `slot` and `fork`. Equality with the root needs that hash to end in 24 zero bytes.
- The Gloas witness 40 lands on `eth1_data` on a true depth 5 state. It lands above fields 16 and 17 on a true depth 6 state, and above fields 32 to 35 on a true depth 7 state.
- One case differs. Above fields 16 and 17, the right child is `justification_bits`, a small padded value and not a hash. So that case rests on the left child instead: the root of `current_epoch_participation` would have to equal the data root of the genesis validator list, which is a collision.

None of these can equal the known root under S2. The scratch run on real data confirms the honest cases. On the real PulseChain depth 5 state, node 33 equals the known root and 65, 129 and 257 lie below `genesis_time`. On the real Sepolia Gloas state, node 40 equals the known root.

**What it allows.** With the layout pinned, depth 7 becomes safe to accept. A depth 7 claim passes only on a true depth 7 state. The T1 residuals at field 41 and below fields 55 and 56 then fail on the witness.

**Attacks on the witness itself:**

- *Leaf from the input.* Suppose the program took the leaf from the prover. The attacker could then prove the node at 33 on a true depth 6 state, which is the hash of `slot` and `fork`. Defense: the leaf is `ChainSpec.genesis_validators_root` (S5).
- *Witness at another layout's position.* Defense: the position comes from the finality branch's layout, like the committee position. The witness length alone cannot decide: plain depth 5 and Gloas both have length 5.
- *Witness against the wrong root.* Defense: the witness is checked against `attested.beacon.state_root`, the same root as the finality branch.
- *Skipped in some paths.* It must run in every fold step of both programs. That includes steps without a next committee, and the fold steps of the fork observation program.

**Assumptions.** S2 and S5. For depth 7, also S6: fields 20, 22 and 23 must still be `finalized_checkpoint` and the two committees.

**Residual.**

- A future depth 7 fork that moves fields 20, 22 or 23 breaks S6. The witness pins only the depth, not the meaning of each field.
- Plain depth 8 has a finality length of 9, the same as Gloas. The length map cannot name it, so it stays refused. That is a stall, not a false head: the Gloas witness 40 lands above fields 64 to 71 of a depth 8 state.
- The wire format changes and both program keys change. The contracts are immutable, so every deployed route needs a new deployment.
- The prover needs the attested state to build the witness (T24).

**If D1 is declined.** T1's residuals stay, and depth 7 stays a stall. The test at `layout_state_depth.rs:1091` stays as it is. I recommend adopting D1, because it is the only defense here that does not rest on "no one has defined that field yet".

### T5. A plain fork that grows the state (fork, stall or false head)

**PulseChain moves to Deneb or Electra, or Ethereum adds fields within depth 6.** The finality length stays 6 or 7, or changes from 6 to 7. The program needs no change, and the prover needs only item 2. Safe.

**A fork crosses 64 fields (depth 7).**
- Without D1: honest updates have 8-entry finality branches, which are refused. The bridge stalls safely. A new route is needed. The residual of T1 applies.
- With D1: the update is accepted when the witness passes. The residual of T4 applies.

**A fork crosses 128 fields (depth 8).** Refused in both cases, so the bridge stalls. With D1 the refusal is also pinned by the witness.

### T6. Gloas activation (fork, stall)

**Attack surface.** At activation, the state becomes progressive and the header becomes compact. The execution block hash moves to `state.latest_block_hash`, at position 2947 under the state root. The first updates after the fork are "transition updates". The attested header is Gloas, but the finalized header is still Fulu.

**Defense.** The branch lengths name the anchor (`layout.rs:482-489`). The keccak check of the encoded header is mandatory (`update.rs:148`). The fold accepts steps of different layouts (`layout_fork_version.rs:338`).

**Residual.** The transition update itself is a stall today (T15). Item 3 fixes it.

### T7. Execution anchor confusion (malicious prover, false block number or false block hash)

**Attack.** The prover lies about the header form (full or compact), about the payload field list (Capella 15 fields or Deneb 17), or about the anchor (412, 812 or 2947).

**Defense.**
- The body is depth 4 in every layout. Positions 41, 668 and 1324 have no length and are refused.
- The landings are safe: 812 on a Capella payload lands below `block_number`, and 2947 on an Electra or Fulu state lands below a number.
- Two landings are caught only by the keccak check: 412 on a Deneb payload, and 2947 on a Capella or Deneb state.

**Assumptions.** S2.

**Residual.** The keccak check is the only guard for those two pairs. Removing it is the most dangerous single change in the program (mutation M-12).

### T8. A false block number in a compact header (malicious prover, false head data)

**Attack.** A compact header carries no payload header. The block number comes from the encoded execution header (Recursive Length Prefix encoding) that the prover attaches.

**Defense.** The keccak hash of the encoded header must equal the proven block hash (`update.rs:148`). The number is item 8 of that encoding.

**Assumptions.** S2.

**Residual.** None.

### T9. The attested header's execution data (malicious prover, no false head)

**Attack.** The prover puts junk in the attested header's execution part.

**Defense.**
- A compact attested header with an 11-entry branch is not checked at all (`update.rs:164-172`). Its data never reaches the output, and the node-served branch leads to the bid, which a proposer writes.
- Every other attested header gets the full branch check.

**Assumptions.** The output reads only the finalized header. Test L-6 pins this.

**Residual.**
- The skip must never spread to the finalized header.
- It must never cover any length other than 11.
- Today no test sends a compact attested header with 8 or 9 entries through a full step. Tests L-1 to L-6 close this gap.

### T10. A false fork version (malicious prover, false head or stall)

**Attack.** The prover names the fork version of each step. It could name another chain's version, a neighbouring fork's version, or an invented one.

**Defense.** The committee signs a domain that contains the version and `genesis_validators_root` (`update.rs:195`). A wrong version gives no valid signature. A different chain has a different root (S5).

**Assumptions.** S1 and S3.

**Residual.** No false head. A prover that picks the wrong version only stalls itself. Item 2 makes the honest prover pick the right one.

### T11. A forged store (malicious prover, false head)

**Attack.** The store is a private input. The prover could invent a next committee and sign with it.

**Defense.** The output binds the store's current committee (`previousSyncCommitteeHash`) and its next committee (`startNextSyncCommitteeHash`). A signature in the next period needs a crossing (`update.rs:309-314`). The contract compares both hashes.

**Assumptions.** S4.

**Residual.** None new. Layout work does not touch this rule, but tests must keep it green.

### T12. A malicious proposer (false head)

**Attack.** A proposer writes some state and body fields freely: graffiti, randao reveal, `eth1_data` votes, and in Gloas the execution bid. A proposer could try to plant a value where a wrong layout claim lands.

**Defense.**
- No allowed claim lands on a proposer-writable leaf.
- The Gloas anchor is `state.latest_block_hash`, not the bid.
- The attested bid branch is ignored (T9).
- The `eth1_data` landing of witness 40 on a depth 5 state needs a hash preimage, even though proposers vote that field.

**Assumptions.** S2 and S6.

**Residual.** A future fork that adds a proposer-writable 32-byte field at a landing spot. With D1, a wrong layout never reaches such a spot.

### T13. A minority of the sync committee (stall)

**Attack.** Fewer than a third of the members cannot sign anything alone. More than 170 members who refuse to sign leave fewer than 342 signers.

**Defense.** None is possible. This is the light client's inherent liveness limit.

**Residual.** A stall while the committee withholds. A false head needs a dishonest two-thirds majority, which is out of scope (S1). The contract refuses heads from the future (`HeadInFuture`).

### T14. A delayed Gloas or a changed schedule (fork, stall)

**Attack.** Gloas is scheduled, then delayed, or a testnet moves its fork epoch. A prover with a compiled fork table picks the old version for the delayed epochs.

**Defense.** The programs read no table. Item 2 makes the prover read `/eth/v1/config/fork_schedule` and `/eth/v1/config/spec` at run time. The prover checks each update natively before it proves (`produce`). So a wrong version stops the prover before any proof run.

**Assumptions.** S8. The beacon node tells the truth about its schedule.

**Residual.** A lying node can stall its own prover only. Its wrong version fails the signature check, so it cannot cause a false head. Running provers against different nodes removes the stall.

### T15. The transition update served in padded form (fork, stall)

**Attack surface.** The Gloas light client specification upgrades a pre-Gloas header to the Gloas form. It pads the old branch (5 payload entries plus 4 body entries) at the front with zeros up to 11 entries (`upgrade_lc_header_to_gloas` with `normalize_merkle_branch` in the Gloas light client fork document; Lodestar `upgradeLightClientHeaderToGloas`). So inside a Gloas update, the finalized pre-Gloas header has 11 entries with 2 leading zeros.

The exact rule reads length 11 as the state anchor 2947 and refuses it. The scratch run confirms this on real Sepolia data. The data is the bootstrap at slot 11296736 (epoch 353023, the last Fulu epoch) and execution block 11856305:

- The full form verifies and gives block 11856305.
- The served padded form fails today with `InvalidExecutionBranch("finalized")`.
- Stripped to 9 entries without the encoded header, it fails with `ExecutionHeaderHashMismatch`.
- Stripped to 9 with the rebuilt 640-byte encoding (keccak matches), it verifies and gives the same block.
- Stripped to 8 (the wrong anchor 412), it fails with `InvalidExecutionBranch("finalized")`.

**Defense (item 3).** The prover strips the padding, keeps 9 entries (Deneb to Fulu) or 8 (Capella), and attaches the encoded header.

- It requires exactly 11 entries and zero leading entries.
- It picks the keep count by the fork name of the header's slot.
- It fetches the encoding with `debug_getRawHeader`. If that fails, it calls `eth_getBlockByHash` and rebuilds the encoding.
- It checks the keccak hash before it proves.

**Attacks on the repair.**
- *A non-zero padding entry is stripped.* The prover refuses it. The exact program check would refuse a wrong branch anyway.
- *A wrong keep count.* The program refuses it (`InvalidExecutionBranch`).
- *The encoding of another block, from a lying execution node.* The keccak check refuses it in the prover, and again in the program.

**Assumptions.** S2 and S8.

**Residual.**
- No real served transition update is on file. Light-client endpoints serve only recent finality updates. The fixture is built from real parts by the specification's own function.
- A client that serves another form makes the prover stop. That is a stall, not a false head.

### T16. Far-future and placeholder fork entries (fork, stall)

**Attack surface.** Schedules and specifications list forks at epoch 2^64 − 1, which means "not scheduled". Sepolia lists `HEZE_FORK_EPOCH` there. PulseChain lists Deneb there with the placeholder version `0xffffffff`.

**Defense.** The prover takes the newest entry whose epoch is at or before the target epoch. A far-future entry never matches.

**Residual.** A placeholder version shared by two forks could map a name wrongly. The prover must refuse a specification where two scheduled forks share a version.

### T17. An unknown active fork (fork, stall by design)

**Attack surface.** The node reports an active fork that the prover does not know, for example Heze after activation.

**Defense.** The prover stops with a named error. It does not guess an anchor.

**Residual.** A stall until someone updates the prover. The light client stays safe. The fork observation program can still prove the new version, because it needs no layout.

### T18. A reorder fork (fork, false head)

**Attack surface.** A future plain fork keeps the depth but moves `finalized_checkpoint` (field 20) or a committee field (22 or 23). A proposer-writable field could then sit at 20.

**Defense.**
- The witness pins only field 1 and the depth, so it does not help here.
- With a version-name gate, the unknown version stops sends.
- With D4, the gate sees an allowed shape and does not stop sends.

**Assumptions.** S6.

**Residual.** This is the main cost of D4. A version-name gate is a tripwire for forks that change meaning without changing shape. A shape gate is not. I flag this for the D4 decision.

### T19. A chain split (fork, false head on one side)

**Attack surface.** A contested fork leaves two chains with the same `genesis_validators_root`. Sync committee members can sign on both sides. Sync committee equivocation is not slashable.

**Defense.**
- The light client accepts only a strictly newer head.
- Each side may use its own fork version. The observation program and the registry record the versions they see.
- Chains with different genesis roots are separated by the signing domain. Ethereum and PulseChain have different roots, and existing tests pin this.

**Assumptions.** S1 on the side the bridge should follow.

**Residual.** Inherent to every light client. If two thirds of the committee sign both sides, the bridge follows whichever update arrives first.

### T20. A false gate confirmation or a false seal (malicious user, item 4)

**Background.** The gate proves `state.fork.current_version` through the beacon roots contract. A send needs a confirmation in the current epoch. A seal stops sends for good. Anyone may confirm and anyone may seal (`src/hardened/BeaconForkGate.sol:323-349`).

Today confirmation keys on the version name. The depth comes from the configured list, never from the caller (`BeaconForkGate.sol:560-574`). A seal needs an unlisted name at an allowed seal depth.

**Under D4.** The gate accepts any version whose proof has an allowed shape. It seals on a valid proof of a disallowed shape. I computed where each gate position lands on each true layout (`layout/analysis/landing.py`). The version leaf is 4 bytes followed by 28 zero bytes, so the safety question is narrow. A wrong landing is safe unless it sits **on a basic field** that could hold such a value:

- Plain position `(2^d + 3) * 4 + 1` on a deeper true state lands below `genesis_time`, below the length of the `genesis_validators_root` list, or below `fork`. All three are safe.
- On a shallower true state it lands on `randao_mixes`, inside `state_roots`, or above fields. All three are safe, because the version leaf cannot equal a hash.
- The progressive position 169 lands below `eth1_deposit_index` on a true depth 5 state, below `finalized_checkpoint` on depth 6, and below `fork` on Gloas (the honest case).
- On a **true depth 7** state, position 169 lands **on field 41**, which no specification defines. That is the one unsafe landing.

**Defenses.**
- An exact branch at a fixed position for each shape.
- The beacon roots root and the epoch rule.
- `SealEvidenceTooOld` (`BeaconForkGate.sol:335-336`).
- The previous-version test (`test/hardened/BeaconForkGate.t.sol:456`).

**Residual.**
- *The seven-entry ambiguity.* Plain depth 5 and the Gloas form both have 7 entries. The gate must try each allowed shape at its own position. Both cross landings are safe.
- *Field 41 on depth 7.* If D1 is declined but D4 is adopted, a 7-entry proof at 169 on a true depth 7 chain could confirm the gate. That happens if field 41 ever holds a version-like value. Sends would then go on into a route that cannot deliver them. **I recommend the gate also checks the `genesis_validators_root` witness at the claimed shape (the item 1 idea),** to pin the shape the same way.
- *Seal shapes outside the meaningful range.* Depths 1 to 4 land above fields or on hashes, so a false seal there is infeasible. Still, the seal rule should accept only depths above the allowed set, and a test should pin that.
- *The registry mode carries no shape.* The PulseChain registry path gets only a version name (`ForkRegistry.sol`, 224-byte output). D4 cannot apply there. **The D4 decision must say what the registry mode does.** It could keep names, admit all, or drop the registry seal.
- *A new progressive form.* The gate has no position for it, so it cannot seal it. Confirmations fail on every allowed shape, so sends still stop each epoch. That is a stall of sends, not a loss.

### T21. A gate that disagrees with the program (configuration, stuck messages)

**Attack surface.** The gate admits a shape that the program refuses. Sends then succeed, but the other side can never deliver them.

**Defense.** A test compares the gate's set with the program's set (`BeaconForkGate.t.sol:969`, fixture `light-client/tests/fixtures/gindices.json` key `program`). Under D1 plus D4 both sets must become {plain 5, plain 6, plain 7, Gloas}.

**Residual.** Only what the test misses. It must compare shapes, not names.

### T22. Wrong keys or a wrong wire format (configuration, stall)

**Attack surface.** Item 1 changes the wire format and both keys. If the guest and the host disagree, every proof fails. If a contract pins an old key, every new proof fails.

**Defense.**
- The decoder refuses truncated input and trailing bytes.
- `light-client/scripts/test-program-keys.sh` checks the pinned keys against the source hash.
- The golden public values are pinned byte for byte (`layout_real_accepts.rs:118`).

**Residual.** Deployed routes need a new deployment.

### T23. Catch-up without old states (fork or operations, stall)

**Attack surface.** The witness needs the siblings of field 1 in the attested state. Those change every slot, so the prover needs each attested state. A long catch-up needs states from weeks ago, and normal nodes prune them. The PulseChain node also served stale old states (see "Builders" in `docs/hardened-build-contract.md`).

**Defense (item 1).** The prover computes the witness while the state is fresh and stores it with the update for catch-up.

**Assumptions.** S8.

**Residual.**
- A new prover without stored branches needs an archive node to catch up a long-stale light client.
- A corrupt stored branch only fails the proof. It cannot cause a false head.

### T24. A malicious user or token author (no false head)

**Malicious user.** A user can call `update`, `confirm`, `seal` and `observe` with any bytes. Each call checks a proof or a beacon root. A user can send an earlier valid update first. That moves the head less far, but it is still a real head.

**Token author.** A token author controls logs and contract code on the execution layer. That affects message proofs, which are out of scope here. A token author cannot touch the beacon state, the committee or the execution header hash. So a token author has no path to a false head.

---

# Part B. The test plan

## B.0 Conventions

Every test follows the rules in the testkit brief:

- A doc comment with `Claim:` and `Why it is safe` or `Why it matters`. For a wrong landing, the comment names the node, and the test computes the node where it can.
- A control: the honest case passes.
- One exact error variant.
- A check that the test can fail. Break the rule on a scratch copy and watch the test go red.

Real fixtures are under `light-client/tests/fixtures/`. The scratch verification data (`verify/data/` in the job scratch area) is not in the repository. Section B.9 says what to copy in.

### Builders that new tests need (requests for `lc-testkit/src`, not for `lc-core`)

| Builder | Purpose | Used by |
|---|---|---|
| `CraftedStateTree` (new, `synthetic.rs`) | Places chosen leaves at chosen positions under one root and fills the rest with distinct filler. Returns the root and exact branches. It models "a root that satisfies two layouts at once", which no real state does. | S-7, S-8, W-5, W-6, L-7 |
| `StateBuilder::with_field_count(fields)` or `WideStateBuilder` (new) | A plain state of any width (for example 70 fields, depth 7) with honest branches, including field 1. Today the leaves are private (`synthetic.rs:158`). | W-2, W-9, S-10 |
| `UpdateRecipe.state_shape` (new field) or `build_update_on(state, recipe)` | Signs an update over a given state instead of `spec.fork_at_slot` (`synthetic.rs:363`). | W-2, S-7, S-10 |
| `witness_branch()` on `StateBuilder`, `GloasStateBuilder` and the wide builder | The honest branch of field 1 at 33, 65, 129 or 40. | every W test |
| `served_gloas_form(full_header)` (move from `verify/lc/crates/lc-core/tests/transition.rs`) | Builds the specification's padded form of a pre-Gloas header. | P3 tests |

## B.1 State layout by finality length (T1, T5)

| ID | Status | File and name | Fixture or builder | Exact assertion | Why it encodes the intent | Mutation it must catch |
|---|---|---|---|---|---|---|
| S-1 | Exists | `lc-core/src/layout.rs:854` `the_finality_branch_length_names_the_layout` | none | 6, 7, 9 give the three layouts. Every other length in 0..=12 gives `UnsupportedStateBranchLength { length }`. The depth of each finality position equals its length. | The length is the only selector, and it must name one layout. | M-2, M-4, M-5 |
| S-1' | Change (D1) | same | none | Adds 8 giving `plain_state_layout(7)` (297, 150, 151). `ALLOWED_FINALITY_BRANCH_LENGTHS == [6, 7, 8, 9]`. Every other length in 0..=12 is refused. | D1 adds exactly one layout. | M-2 (inverse: 8 still refused), M-5 |
| S-2 | Exists | `lc-testkit/tests/layout_state_depth.rs:961` `every_other_finality_branch_length_is_refused` | none | 0..=12 except allowed, 64 and `usize::MAX` give `UnsupportedStateBranchLength { length }`. | Large and odd lengths must not wrap into a layout. | M-5 |
| S-3 | Exists, change (D1) | `layout_state_depth.rs:978` `finality_branch_length_eight_is_refused_because_it_is_depth_seven` | `plain_state_layout(7)` | Today: length 8 gives `UnsupportedStateBranchLength { length: 8 }`. Under D1: rename to `finality_branch_length_eight_names_plain_depth_seven`, and assert the layout (297, 150, 151) plus witness 129. | It pins the meaning of 8 either way. | M-2 |
| S-4 | Exists | `layout_state_depth.rs:748` `synthetic_true_depth_five_state_refuses_the_claimed_electra_and_gloas_layouts` | `StateBuilder(Capella)`, `build_update` | Claims 169, 86, 87, 735, 2945, 2946 give `InvalidFinalityBranch` or `InvalidNextSyncCommitteeBranch`. | Each wrong pair on a true depth 5 state. | M-1, M-4 |
| S-5 | Exists | `layout_state_depth.rs:770` `synthetic_true_depth_six_state_refuses_the_claimed_capella_and_gloas_layouts` | `StateBuilder(Electra)` | Claims 105, 54, 55, 735, 2945, 2946 refused, with the same two variants. | Each wrong pair on a true depth 6 state. | M-1, M-4 |
| S-6 | Exists | `layout_state_depth.rs:642` and `:663` (real Gloas plain-5 and plain-6 claims) | `sepolia/gloas_head_state.ssz` | Plain claims land on node 3 (`active_fields`) or on `fork` and `latest_block_header` children. The branches do not verify. The control verifies at 169. | Real data, with the landing node computed. | M-4 |
| S-7 | **New** (gap 1) | `layout_state_depth.rs` `an_honest_committee_branch_at_another_depth_is_refused_in_one_step` | `CraftedStateTree` with finalized root at 169 (depth 6) and committee root at 55 (depth 5) under one root. Signed by `build_update_on`. Control: the same tree with the committee at 87. | Finality length 7 plus a committee branch of length 5 that is valid at 55 gives exactly `InvalidNextSyncCommitteeBranch`. The control returns `Ok`. A second case swaps the depths: finality at 105 with length 6, committee valid at 87 with length 6. Also `InvalidNextSyncCommitteeBranch`. | Only this test fails when the committee position is taken from its own length. Every existing mixed test uses damaged branches, which fail with or without the rule (checked: `layout_state_depth.rs:1002` uses `attacker_branches` at `:102`). | **M-3** |
| S-8 | **New** (gap 1, Gloas) | `layout_state_depth.rs` `a_gloas_finality_branch_with_a_plain_committee_branch_is_refused` | `CraftedStateTree`: finality at 735, committee at 87 (length 6) and at 55 (length 5). | `InvalidNextSyncCommitteeBranch` for both. The control (committee at 2946, length 11) returns `Ok`. | The progressive and plain layouts must not mix. | M-3 |
| S-9 | Exists | `layout_state_depth.rs:1002` `mixed_branch_lengths_in_one_step_are_refused` | `build_update` | Damaged lengths give `InvalidNextSyncCommitteeBranch`. | Keep it. It covers lengths that name no layout. | M-1 |
| S-10 | Exists, change (D1) | `layout_state_depth.rs:1091` `wide_state_control_permissive_selector_accepts_a_forgery_and_the_real_rule_stops_the_bridge` | local 70-field tree | Today: the permissive selector accepts the forgery at field 41, and the real rule gives `UnsupportedStateBranchLength { length: 8 }`. Under D1, rename to `wide_state_forgery_at_field_41_fails_the_witness_and_the_honest_depth_seven_update_verifies`. Assert three things. (a) The forged 7-entry claim gives `InvalidLayoutWitness`, because witness 65 lands above fields 2..3 (`slot`, `fork`) of the depth 7 tree, and the test computes that node. (b) The honest 8-entry update returns `Ok`. (c) The output's `newHeaderRoot` is the honest root. | This is the attack that justifies D1. The test must show that the witness, and not the length map, stops it. | M-2, M-6, **M-13** |
| S-11 | **New** (D1) | `layout_state_depth.rs` `gloas_claims_on_a_true_depth_seven_state_fail_the_witness` | wide builder, 70 fields | A 9-entry claim on a true depth 7 tree (735 lands below field 55, 2946 below field 56) gives `InvalidLayoutWitness`, because 40 lands above fields 32..35. Assert the landing nodes. | It closes the residual that the design table did not list. | M-13 |
| S-12 | Exists | `layout_real_accepts.rs:142` `real_updates_name_their_layout_by_branch_length_and_verify_exactly` | real Ethereum, PulseChain and Sepolia Gloas updates | Each real update names its layout and verifies exactly against `attested.state_root`. | The honest control on real data. | M-1, M-4, M-7 |

## B.2 Exact branches (T2)

| ID | Status | File and name | Fixture | Exact assertion | Why | Mutation |
|---|---|---|---|---|---|---|
| E-1 | Exists | `layout_state_depth.rs:853` `real_pulsechain_zero_padded_finality_branch_is_refused` | `pulsechain/light_client_update.json` | A 6-entry branch padded to 7 gives `InvalidFinalityBranch`. The old normalized rule accepted it. | The exact attack of T2 on real data. | **M-1** |
| E-2 | Exists | `layout_state_depth.rs:873` real Ethereum cut and padded | `ethereum/finality_update.json` | Cut to 6 gives `InvalidFinalityBranch`. Padded to 8 gives `UnsupportedStateBranchLength { 8 }`. Under D1, padded to 8 gives `InvalidLayoutWitness` or `InvalidFinalityBranch`. Pin the one the implementation reaches first and comment the order. | Under D1, length 8 now names a layout, so the padded branch must fail on evidence, not on length. | M-1 |
| E-3 | Exists | `layout_state_depth.rs:907` real Gloas cut and padded | `sepolia/gloas_*` | Lengths 10 and 8 give `UnsupportedStateBranchLength`, and under D1 length 8 behaves as in E-2. Cut and padded branches fail at 735. | Same as E-2. | M-1 |
| E-4 | Exists | `update_rejections.rs:187` `synthetic_wrong_layout_claim_by_branch_length_is_refused` | `build_update` | 6 zero-padded to 7, and 7 cut to 6, give `InvalidFinalityBranch`. | Synthetic twin of E-1. | M-1 |
| E-5 | **New** (D1) | `layout_state_depth.rs` `a_zero_padded_witness_is_refused` | `StateBuilder(Capella)` | A witness of 5 entries padded to 6 gives `InvalidLayoutWitness`. The control (5 entries) returns `Ok`. | The witness is exact like every other branch. | M-1 (if the witness check uses the normalized function) |

## B.3 The layout witness (T4, item 1, D)

Each test below runs through `verify_step` and also through the fold of the fork observation program (`observation::verify_fork_observation` with one step), unless it says otherwise. A helper `for_each_program(step, assertion)` keeps this DRY.

| ID | Status | File and name | Fixture or builder | Exact assertion | Why | Mutation |
|---|---|---|---|---|---|---|
| W-1 | New | `lc-testkit/tests/layout_witness.rs` `honest_witnesses_verify_on_every_layout` | `StateBuilder(Capella)`, `StateBuilder(Electra)`, `GloasStateBuilder`, wide builder (70 fields) | Each honest update with its witness returns `Ok` with the expected output. Witness lengths are 5, 6, 7, 5 and positions are 33, 65, 129, 40. | The control for every W test, one per layout. | M-6, M-8 |
| W-2 | New | `layout_witness.rs` `the_real_witnesses_verify_against_the_real_states` | `sepolia/gloas_head_state.ssz` (node 40), plus a real plain state (see B.9) | The real branch of field 1 verifies exactly at 40 (Gloas) and 33 (PulseChain). The leaf equals `SEPOLIA.genesis_validators_root` and `PULSECHAIN.genesis_validators_root`. | Real data agrees with the position table. The scratch run already shows this. | M-6 |
| W-3 | New | `layout_witness.rs` `every_wrong_witness_position_lands_on_a_node_that_cannot_equal_the_root` | all four builders, plus a depth 8 wide tree for the landing walk | For each (claimed, true) pair of {5, 6, 7, Gloas} × {5, 6, 7, 8, Gloas} with claimed ≠ true, the test walks the claimed position through the true tree. It asserts the landing kind exactly as `verify/scripts/witness.py` prints it. Examples: 65 on depth 5 lies below `genesis_time`, 33 on depth 6 is the node over `slot` and `fork`, 40 on depth 5 is `eth1_data`. It also asserts that the node value differs from the known root. | It pins the reason for safety, not only the refusal. | M-6 |
| W-4 | New | `layout_witness.rs` `a_wrong_layout_claim_fails_on_the_witness` | `CraftedStateTree` with honest finality and committee at depth 5 positions under a root whose node 33 is not the known root | `InvalidLayoutWitness`. Control: node 33 set to the known root returns `Ok`. | It isolates the witness from the other two branches. If the witness check were removed, only this test would see it. | **M-8** |
| W-5 | New | `layout_witness.rs` `the_witness_leaf_comes_from_the_chain_specification` | true depth 6 state (`StateBuilder(Electra)`) and a crafted tree with honest finality and committee at 105 and 55 | The prover supplies a "witness" whose leaf is node 33 of the tree (the hash over `slot` and `fork`) with a valid branch. The result is `InvalidLayoutWitness`. | If the program read the leaf from the input, this attack would pass. Only this test catches that. | **M-9** |
| W-6 | New | `layout_witness.rs` `the_witness_position_follows_the_finality_layout_not_the_witness_length` | `CraftedStateTree`: Gloas finality (735), committee (2946), and field 1 at node 33 (length 5) instead of 40 | `InvalidLayoutWitness`. The reverse case also fails: depth 5 finality with the witness at 40. | Plain depth 5 and Gloas share witness length 5. The length must not choose the position. | **M-10** |
| W-7 | New | `layout_witness.rs` `the_witness_is_checked_against_the_attested_state_root` | `build_update` where the finalized header's state contains field 1 at 33, but the attested witness is a branch of the finalized state | `InvalidLayoutWitness`. Control: the attested witness returns `Ok`. | The witness must bind the same tree as the finality branch. | **M-11** |
| W-8 | New | `layout_witness.rs` `a_step_without_a_next_committee_still_needs_the_witness` | `build_update` with `include_next_committee: false` | An empty or damaged witness gives `InvalidLayoutWitness`. | The witness must not hide inside the committee branch block. | **M-12** |
| W-9 | New | `layout_witness.rs` `every_step_of_a_mixed_fold_checks_its_own_witness` | fold from Fulu (depth 6) to Gloas, `layout_fork_version.rs:338` builders | Swapping the two steps' witnesses gives `InvalidLayoutWitness` at the first step. A fold where only the last step is damaged also gives `InvalidLayoutWitness`. | Steps of one fold have different layouts. Each needs its own witness. | M-12, M-14 |
| W-10 | New | `layout_witness.rs` `the_observation_fold_checks_the_witness` | `fork_observation_scenarios::stale_three_period_scenario` | A damaged witness in a fold step gives `InvalidLayoutWitness`. The observation itself has no state proof, so nothing else changes. | Item 1 applies to both programs. | **M-14** |
| W-11 | New | `lc-testkit/tests/update_json.rs` or `wire` tests `the_wire_format_carries_the_witness` | real and synthetic inputs | The witness survives an encode and decode round trip. A truncated witness, an over-long count and trailing bytes all give a decode error. `run_light_client_guest` still returns 352 bytes and `run_fork_observation_guest` 224 bytes. | The format change must not open a parse gap. | M-15 |
| W-12 | Exists, stays green | `layout_real_accepts.rs:118` `real_data_keeps_the_public_values_byte_for_byte` | `golden_public_values.txt` | The hex equals the golden values. | The witness must never reach the output. | **M-16** |
| W-13 | Exists, rerun | `light-client/scripts/test-program-keys.sh` | `light-client/program-keys.json` and `program-keys.source-hash` | The rebuilt keys equal the pinned keys. | Both keys change. The pins must move with the source. | M-17 |
| W-14 | Exists, regenerate | `fork_observation.rs:469` `fork_observation_fixtures_are_current` | `fork-observation/*.json` | The files are byte-equal to the generator after the witness is added. | The Solidity tests read these. | M-15 |

## B.4 Execution anchors and the attested header (T7, T8, T9, gap 2)

| ID | Status | File and name | Fixture | Exact assertion | Why | Mutation |
|---|---|---|---|---|---|---|
| X-1 | Exists | `layout_execution.rs:140` `only_three_branch_lengths_name_an_anchor` | none | 8, 9 and 11 give 412 Body, 812 Body and 2947 State. Every other length gives `None`. | The length map. | M-18 |
| X-2 | Exists | `layout_execution.rs:248` `index_412_on_a_deneb_payload_is_caught_only_by_keccak` | Deneb proofs | The branch is `Ok`, then `ExecutionHeaderHashMismatch`. | It shows the keccak check is load-bearing. | **M-19** |
| X-3 | Exists | `layout_execution.rs:413` `index_2947_on_a_depth_five_state_is_caught_only_by_keccak` | local slashings tree | The branch is `Ok`, then `ExecutionHeaderHashMismatch`. | Same. | **M-19** |
| X-4 | Exists | `layout_execution.rs:288`, `:443`, `:468`, `:201`, `:230` | local trees | `InvalidExecutionBranch("finalized")`, with the landing named. | The safe landings. | M-18 |
| X-5 | Exists | `layout_execution.rs:330` `a_wrong_payload_form_named_by_the_prover_fails` | Capella and Deneb proofs | `InvalidExecutionBranch("finalized")`. | The blob flag lie. | M-20 |
| X-6 | Exists | `gloas.rs:243` `the_header_form_byte_must_fit_the_evidence` | `build_gloas_update` | `InvalidExecutionBranch("finalized")`. | The form byte lie. | M-20 |
| X-7 | Exists | `gloas_real.rs:124` and `layout_execution.rs:386` | real Gloas | A flipped branch gives `InvalidExecutionBranch`. A wrong or parent encoding gives `ExecutionHeaderHashMismatch`. | Real keccak binding. | M-19 |
| L-1 | Exists | `update_rejections.rs:139` `synthetic_every_branch_entry_matters` | `build_update` | Each flipped entry of a full attested header gives `InvalidExecutionBranch("attested")`. | The full attested check runs. | **M-21** |
| L-2 | **New** (gap 2) | `update_rejections.rs` `a_compact_attested_header_of_eight_or_nine_entries_is_checked` | `synthetic_compact_header` with Capella (8) and Deneb (9) body proofs, placed as the attested header of a `build_update` step | One flipped entry gives exactly `InvalidExecutionBranch("attested")` through `verify_step`. The control returns `Ok`. | The skip covers only state-anchored branches. Today no test sends 8 or 9 entries through a full step. | **M-22** |
| L-3 | **New** | same file `a_compact_attested_header_with_a_zero_hash_is_refused_unless_state_anchored` | as L-2 | Length 9 with a zero hash gives `ZeroExecutionBlockHash("attested")`. Length 11 with a zero hash returns `Ok` (the documented skip), with a comment that this is deliberate. | It pins the edge of the skip exactly. | M-22 |
| L-4 | **New** | same file `a_compact_attested_header_of_a_length_that_names_no_anchor_is_refused` | lengths 0, 7, 10, 12 | `InvalidExecutionBranch("attested")`. | A skip must not grow to "any length that is not 8 or 9". | M-22 |
| L-5 | Exists | `gloas.rs:223` `the_attested_execution_data_of_a_gloas_update_is_not_read` | `build_gloas_update` | A garbled 11-entry attested branch returns `Ok(baseline)`. A garbled finalized branch gives `InvalidExecutionBranch("finalized")`. | The skip must never reach the finalized header. | **M-23** |
| L-6 | **New** | `gloas.rs` `the_attested_execution_data_never_reaches_the_output` | `build_gloas_update` with two different attested block hashes | The two outputs are byte-equal. | This is the assumption that makes the skip safe. | M-23 |
| L-7 | **New** (gap 2) | `update_rejections.rs` `state_proofs_bind_the_attested_state_root_not_the_finalized_one` | `CraftedStateTree` as the finalized header's state, holding the next committee at 55 and field 1 at 33. The attested state lacks both. | `InvalidNextSyncCommitteeBranch` (and, under D1, `InvalidLayoutWitness` for the witness variant). The control (proofs in the attested state) returns `Ok`. | Today no test moves the root that state proofs bind. | **M-24** |
| L-8 | **New** | `update_rejections.rs` `a_changed_attested_state_root_breaks_the_state_proofs_first` | `build_update`, then replace `attested_header.beacon.state_root` | `InvalidFinalityBranch`. The signature would also fail, but the state check comes first. | It pins the order of checks and the root they use. | M-24 |

## B.5 The signing fork version (T10, T14, T16)

| ID | Status | File and name | Fixture | Exact assertion | Why | Mutation |
|---|---|---|---|---|---|---|
| V-1 | Exists | `layout_fork_version.rs:107` `real_updates_verify_only_under_the_real_fork_version` | real Ethereum and PulseChain | Every wrong version gives `SignatureVerificationFailed`. | The version is bound by the signature. | M-25 |
| V-2 | Exists | `layout_fork_version.rs:223` `the_version_is_the_one_at_the_epoch_of_the_slot_before_the_signature_slot` | `build_update`, `build_gloas_update` on shifted schedules | A neighbour version gives `SignatureVerificationFailed`. | The off-by-one rule. | **M-26** |
| V-3 | Exists | `layout_fork_version.rs:399` `in_a_mixed_fold_the_version_belongs_to_its_own_step` | mixed fold | A swapped version gives `SignatureVerificationFailed`. | It fails if the program reads the table instead of the input. | **M-25** |
| V-4 | **New** (real boundary data) | `layout_fork_version.rs` `the_real_sepolia_boundary_signs_under_the_fork_of_the_slot_before` | from `verify/data/`: `updates_1377.json` (the period 1378 update proves the period 1379 committee) and the sync aggregates of blocks 11296768 and 11296769 | Signature slot 11296768 (epoch 353024) signs slot 11296767 under Fulu `0x90000075`: `Ok` under Fulu and `SignatureVerificationFailed` under Gloas. Signature slot 11296769 signs slot 11296768 under Gloas `0x90000076`: the reverse. `table_fork_version(&SEPOLIA, slot)` gives the same versions. The scratch run gave exactly this, with 495 and 443 participants. | The only real evidence of the rule at an activation. It decides the prover rule in item 2. | M-26, M-28 |

## B.6 Prover: fork schedule and specification at run time (item 2)

The new code is pure functions over parsed answers, called through the existing `HttpGet` fake `Node` (`prover/src/beacon/http.rs:944-959`). No unit test touches the network. A suggested home is a new module `prover/src/fork_schedule.rs`, with its tests in that module. The recorded answers that exist today are:

- `light-client/tests/fixtures/sepolia/fork_schedule.json`: eight entries ending at Gloas epoch 353024, with no far-future entry.
- `sepolia/chain_spec.json`: names through Gloas, with `HEZE_FORK_EPOCH` = 2^64 − 1.
- `pulsechain/chain_spec.json`: Capella at epoch 3, Deneb at 2^64 − 1 with version `0xffffffff`.
- `pulsechain-testnet-v4/fork_schedule.json` and `chain_spec.json`.

No prover test reads them yet.

| ID | Status | Name | Fixture | Exact assertion | Why | Mutation |
|---|---|---|---|---|---|---|
| P2-1 | New | `the_sepolia_schedule_names_every_fork_by_its_version` | Sepolia schedule and specification | The parsed table equals the eight (version, epoch, name) rows. Gloas is `0x90000076` at 353024. | Name and version come from two answers, so the join must be exact. | M-27 |
| P2-2 | New | `the_signing_version_is_the_fork_of_the_slot_before_the_signature_slot` | Sepolia | `signing_version(11296768) == 0x90000075`, `signing_version(11296769) == 0x90000076`, `signing_version(0)` is genesis (saturating). | It matches V-4 on the same slots. | **M-28** |
| P2-3 | New | `far_future_entries_never_become_active` | PulseChain specification, and the Sepolia schedule with an added far-future Heze row | The version at epoch 2^64 − 2 is Capella on PulseChain and Gloas on Sepolia. `0xffffffff` is never returned. | It covers T16. | **M-29** |
| P2-4 | New | `a_schedule_that_disagrees_with_the_specification_stops_the_prover` | Sepolia schedule with Gloas moved to 353025, against the unchanged specification | One exact error variant (proposed `Error::ForkScheduleMismatch { fork, schedule_epoch, spec_epoch }`). | Two answers from one node must agree, or the prover does not guess. | M-30 |
| P2-5 | New | `a_delayed_fork_follows_the_node_not_the_compiled_table` | Sepolia schedule and specification both moved to Gloas at 353030, plus a compiled `SEPOLIA` table at 353024 | `signing_version(11296769)` is Fulu. The native check of the real period 1379 step under that version gives `VerificationRefused(SignatureVerificationFailed)` before any proof run. | It covers T14. A wrong schedule can only stop the prover. | M-31 |
| P2-6 | New | `an_unknown_active_fork_stops_the_prover` | Sepolia schedule with Heze active at 353100 | A slot after 353100 gives the proposed `Error::UnknownActiveFork { version, epoch }`. A slot before it still works. | It covers T17. | **M-32** |
| P2-7 | New | `two_forks_with_one_version_stop_the_prover` | a specification with two scheduled forks sharing a version | The proposed `Error::ForkScheduleMismatch`. | The placeholder trap of T16. | M-27 |
| P2-8 | New | `the_gloas_anchor_follows_the_fork_name_and_the_answer_form_must_agree` | `sepolia/gloas_head_finality_update.json` (true Gloas) and `ethereum/finality_update.json` (Fulu) | (Gloas name, compact answer) anchors. (Fulu name, full answer) does not anchor. (Gloas name, full answer) and (Fulu name, compact answer without padding) give the proposed `Error::HeaderFormMismatch { slot, fork, form }`. | The anchor choice and the cross-check. | **M-33** |
| P2-9 | New | `missing_config_endpoints_stop_the_prover` | `Node` without the two paths (404) | `Error::Beacon` naming the path. No fallback to the compiled table. | A silent fallback would reintroduce the table. | M-31 |
| P2-10 | Change | `http.rs:1044` `a_gloas_plan_anchors_the_finalized_header_in_the_real_state` and `tests/checkpoint.rs:357` | add the two config answers to the fake | Same assertions, with the fork taken from the answers. | The existing Gloas path keeps working. | M-33 |
| P2-11 | New | `the_synthetic_beacon_api_serves_the_specification` | `prover/src/local_network/signed_beacon/api.rs` (`:88` serves the schedule today, not the specification) | `/eth/v1/config/spec` answers with the `*_FORK_EPOCH` and `*_FORK_VERSION` keys of the synthetic chain. | The local network harness must exercise the new code. | M-30 |

## B.7 Prover: the transition update (item 3)

| ID | Status | Name | Fixture | Exact assertion | Why | Mutation |
|---|---|---|---|---|---|---|
| P3-1 | New | `the_specification_padded_header_is_stripped_to_the_deneb_anchor` | `verify/data/bootstrap_11296736.json` (real Fulu header, block 11856305) and `served_gloas_form`, which gives 11 entries with 2 leading zeros | The repaired header has 9 entries, equal to the original 4 body entries plus 5 payload entries. `verify_finalized_execution` returns block 11856305 and hash `0xf78a…a052`, equal to the full form's result. | The scratch run shows this works on real data. | **M-34**, M-35 |
| P3-2 | New | `a_capella_padded_header_is_stripped_to_eight` | synthetic Capella header with 3 leading zeros | 8 entries, `Ok`. Keeping 9 gives `VerificationRefused(InvalidExecutionBranch("finalized"))` in the native check. | The keep count follows the fork name. | **M-35** |
| P3-3 | New | `a_non_zero_padding_entry_stops_the_prover` | P3-1 with entry 0 or entry 1 set to one | The proposed `Error::HeaderFormMismatch` or `Error::Malformed`, before any node call for the encoding. | The prover must not strip real data. | **M-34** |
| P3-4 | New | `a_padded_branch_of_another_length_stops_the_prover` | P3-1 with 10 or 12 entries | Same exact error. | "Exactly 11" is the rule. | M-34 |
| P3-5 | New | `a_gloas_header_is_never_stripped` | `sepolia/gloas_head_finality_update.json` | The 11 entries stay. This holds even after setting entry 0 to zero in a copy, and the program then refuses that copy. | The strip is chosen by the fork name, not by the zeros. | M-35 |
| P3-6 | New | `the_raw_header_answer_is_checked_by_keccak` | `OneHeader` fake (`http.rs:973`) returning (a) the real encoding and (b) the parent's encoding | (a) attaches 640 bytes. (b) gives `Error::Beacon` (hash mismatch), before proving. | A lying execution node stops the prover. | **M-36** |
| P3-7 | New | `the_rebuild_fallback_is_used_when_the_raw_header_call_fails` | a fake whose `debug_getRawHeader` answers "method not found", plus `verify/data/block_11856305.json` for `eth_getBlockByHash` | The rebuilt encoding (via `rebuild_execution_header`, `prover/src/light_client.rs:347`) hashes to the block hash and is attached. A block answer with one changed field gives `Error::Beacon`. | The fallback exists for openings (`opening.rs:252`) but not for updates. | **M-37** |
| P3-8 | New | `a_transition_fold_from_fulu_to_gloas_verifies_end_to_end` | real `updates_1377.json` steps plus a synthetic transition step built from P3-1 | The fold returns `Ok`, and the guest gives 352 bytes. | The whole repair in one run. | M-34 to M-37 |
| P3-9 | New | `the_attested_header_of_a_transition_update_is_left_alone` | P3-8 | The attested Gloas header keeps its 11 entries. | Only the finalized header is repaired. | M-35 |

The two duplicate `debug_getRawHeader` implementations report a hash mismatch differently: `http.rs:269-287` gives `Error::Beacon` and `prover/src/chain.rs:251-265` gives `Error::Malformed`. Per Rule 7, pick one (I suggest `Beacon`, the newer path), share it, and flag the other for cleanup. P3-6 and P3-7 then assert the one variant.

## B.8 Prover: the witness branch and stored branches (item 1, T23)

| ID | Status | Name | Fixture | Exact assertion | Why | Mutation |
|---|---|---|---|---|---|---|
| P1-1 | New | `the_prover_builds_the_witness_from_the_attested_state` | `sepolia/gloas_head_state.ssz` through `StateView` (`light_client.rs:632`), plus the PulseChain assembled update (`http.rs:1328`) | The witness equals `ParsedState::field_branch(1)` (`lc-core/src/ssz_state.rs:371`). The update verifies natively. | The prover and the program agree on the position. | M-6, M-10 |
| P1-2 | New | `catch_up_uses_the_stored_witness_when_the_old_state_is_gone` | catch-up tests at `http.rs:1806-1955`, with a `Node` that answers 404 for old states | Catch-up succeeds from the stored branches. Without them it gives `Error::Beacon` naming the missing state. | It covers T23. | **M-38** |
| P1-3 | New | `a_corrupt_stored_witness_is_refused_before_proving` | P1-2 with one flipped entry | `VerificationRefused(InvalidLayoutWitness)`. | The store is not trusted. | M-38 |

## B.9 Fixtures to add from the verification work

Copy these into `light-client/tests/fixtures/sepolia/transition/` in the `{ source_url, fetched_on, response }` shape. Add a `fetch-fixtures.sh` target for them (it needs the network, so only that script fetches). Document them in `tests/fixtures/README.md`.

| File in `verify/data/` | Contents | Used by |
|---|---|---|
| `bootstrap_11296736.json` | A real Fulu bootstrap at slot 11296736, epoch 353023 (the last Fulu epoch). The full header names execution block 11856305. | P3-1, P3-8 |
| `bootstrap_11296704.json` | A second real Fulu bootstrap, slot 11296704. | P3 control |
| `block_11856305.json` | `eth_getBlockByHash` for the execution block. The rebuilt 640-byte encoding hashes to `0xf78a…a052`. | P3-1, P3-7 |
| `updates_1377.json` | Four real updates for periods 1377 and 1378 (Fulu: finality 7, committee 6, execution 4) and 1379 and 1380 (Gloas: 9, 11, 11). | V-4, P2-5, P3-8 |
| `block_11296767.json` to `block_11296770.json` | Real beacon blocks around the activation slot 11296768. Their sync aggregates sign the slot before. | V-4, P2-2 |

The raw header answer for block 11856305 is not on file. The rebuilt bytes can stand in for it: keccak equality with the block hash proves they are the canonical encoding (S2). A real plain state is not on file either, apart from `light-client/fetch-cache/pulsechain/attested_state.ssz`, which is a cache and not a fixture. W-2 needs one real plain depth 5 state as a fixture. A depth 6 state comes from Ethereum or Sepolia, and it is large.

## B.10 The fork gate (item 4, D)

These are Foundry tests. "Name" marks a test that keys on a version name today.

| ID | Status | File:line and name | Exact assertion under D4 | Why | Mutation |
|---|---|---|---|---|---|
| G-1 | Change | `test/hardened/BeaconForkGate.t.sol:413` `revert_unsupportedVersionCannotConfirm` becomes `unlistedVersionAtAnAllowedShapeConfirms` | `ForkConfirmed(E, UNKNOWN_FORK)` with a valid depth 6 proof. | The core of D4. | **M-39** |
| G-2 | Change | `:1113` `forkTable_excludedVersionsCannotConfirm` | Excluded names at an allowed shape confirm. The same names at depth 8 give the proposed `ShapeNotAllowed(8)`. | The flip, plus its boundary. | M-39 |
| G-3 | Change | `:567` `seal_supportedVersionRefused` becomes `sealRefusesEveryAllowedShape` | For shapes 5, 6, (7 under D1) and Gloas, `seal` with any version gives the proposed `ShapeIsAllowed(shape)`. `isSealed` stays false. | A seal needs a disallowed shape, not an unknown name. | **M-40** |
| G-4 | New | `sealAcceptsAValidProofOfADisallowedShape` | A valid depth 8 proof (and depth 7 without D1) gives `GateSealedByFork(version, slot)`. Then `admit`, `confirm` and `seal` give `GateSealed`. | The new seal trigger. | M-40 |
| G-5 | Change | `:541` `depth_sealLengthsOutsideTheSetRefused` | Depths 0 to 4 and 32 and up give `SealDepthNotAllowed`. Depths 1 to 4 are refused even with a valid-looking branch. | The landing table shows a forgery there is infeasible. The bound keeps the rule simple. | **M-41** |
| G-6 | Change | `:480` `depth_confirmRefusesEveryWrongPair` and `:510` `depth_sealRefusesEveryWrongPair` | For every (claimed, true) pair in {5, 6, 7, 8, Gloas}², claimed ≠ true: `ForkProofInvalid` on both calls, and `isSealed` false. Compare the landing comments with `layout/analysis/landing.py`. | It is the gate's own soundness table. | M-42 |
| G-7 | Change | `test/hardened/GloasGate.t.sol:86` `realGloasEvidenceConfirms` and `:111` | Real Sepolia evidence (`light-client/tests/fixtures/sepolia/gloas_fork_version.json`, 7 entries at 169) confirms with no Gloas name in the configuration. The same branch tried at 141 gives `ForkProofInvalid`. | It covers the seven-entry ambiguity on real data. | **M-42** |
| G-8 | Change | `GloasGate.t.sol:139` `progressiveSeal` and `:170` | The Gloas shape is allowed, so a Gloas proof gives `ShapeIsAllowed`. A forged plain 5 branch at 169 gives `ForkProofInvalid`. | Same. | M-40 |
| G-9 | Exists, keep | `:456` `previousVersionProofNeitherConfirmsNorSeals` | `ForkProofInvalid` on both calls. Change the trailing seal to a depth 8 proof. | The `previous_version` leaf sits next to `current_version`. | M-43 |
| G-10 | Exists, keep | `:649`, `:666`, `:693` seal age rules | The same `SealEvidenceTooOld` assertions, with depth 8 evidence instead of `UNKNOWN_FORK`. | Old evidence must not seal. | M-44 |
| G-11 | Change | `:969` `forkTable_gateDepthsEqualTheLightClientProgramAllowedSet` | The gate's allowed shapes equal the program's set from `gindices.json` key `program`: {5, 6, Gloas}, plus 7 under D1. The seal shapes are exactly the depths above that set, up to 31. | It covers T21. | **M-45** |
| G-12 | New (recommended) | `confirmRequiresTheGenesisRootWitnessAtTheClaimedShape` | Only if the gate adopts the witness. A 7-entry proof at 169 on a synthetic true depth 7 tree whose field 41 holds a version-like leaf gives the proposed `ShapeWitnessInvalid`. The control is a real Gloas proof plus witness 40. | It closes the field 41 residual of T20. | M-46 |
| G-13 | Decide | `test/hardened/ForkRegistry.t.sol:415`, `:442`, `:459` registry gate | Assert whichever registry rule the D4 decision picks. | The registry has no shape (T20). | — |
| G-14 | Change | `BeaconForkGate.t.sol:161`, `:107`, `test/hardened/DeployBridge.t.sol:213-228` | The configuration holds shapes, not names. The duplicate-name test becomes a duplicate-shape test. | The constructor follows the new model. | M-45 |
| G-15 | Exists, rerun | `test/hardened/Immutability.t.sol:172` | Still only `admit`, `confirm` and `seal`, with no owner. | D4 must not add an admin. | M-47 |
| G-16 | Exists, extend | Rust `light-client/crates/lc-core/src/gate.rs:137`, `:163` and `lc-testkit/tests/gloas_real.rs:222` | Add depth 7 (525) and depth 8 (1037) builders. The real Gloas branch fails at 1037. | The Rust fixture builder for G-4 and G-6. | M-42 |

## B.11 Regression guards that must stay green

These tests do not change, but every item could break them:

- `update_rejections.rs:61`, `:76`, `:88`, `:112`, `:231`, `:272`, `:290`, `:304`, `:482`, `:500`
- all of `fold.rs`
- all of `fork_observation.rs`
- `gloas_real.rs:160`
- `layout_fork_version.rs:338`

---

# Part C. The mutation list for the final reviewer

Apply each mutation alone on a scratch branch. Run `cd light-client && cargo test --offline` (plus `cargo test -p prover` for prover items, and `forge test --match-path 'test/hardened/*'` for gate items). Then revert. "Expected" names the tests that must go red. A mutation that leaves every listed test green is a finding. Mutations marked (D1) or (D4) apply only if that decision is adopted.

| ID | Mutation (where) | Expected result |
|---|---|---|
| M-1 | `branch_is_valid` (`update.rs:70`) calls `is_valid_normalized_merkle_branch`. | E-1, E-2, E-3, E-4 red. Under D1, also E-5. |
| M-2 | Without D1: add `8 => plain_state_layout(7)` to `state_layout_for_finality_branch_length`. With D1: remove the 8 arm. | Without D1: S-1, S-2, S-3, S-10 red. With D1: S-1', S-3, S-10(b), W-1 red. |
| M-3 | In `verify_step`, check the next committee at `plain_state_layout(next.branch.len())` instead of `layout`. | **S-7 and S-8 red.** S-9 stays green. That is expected, and it is why S-7 exists. |
| M-4 | Swap `GLOAS_STATE_LAYOUT` finality 735 for 734. | S-6, S-12, `gloas_real.rs:160`, `layout_fork_version.rs:338` red. |
| M-5 | Map length 9 to `plain_state_layout(8)` instead of Gloas. | S-1, S-12, all real Gloas tests red. |
| M-6 (D1) | Witness position for Gloas set to 33 instead of 40. | W-1, W-2, W-3, P1-1 red. |
| M-7 | Check the finality branch against `finalized.beacon.state_root`. | S-12, L-8, every honest accept red. |
| M-8 (D1) | Remove the witness check from `verify_step`. | W-4, W-6, W-7, W-8, W-9, S-10(a), S-11 red. |
| M-9 (D1) | Take the witness leaf from the input instead of `ChainSpec`. | **W-5 red.** |
| M-10 (D1) | Choose the witness position from the witness length (length 5 means 33). | W-1 (Gloas case), W-2, W-6 red. |
| M-11 (D1) | Check the witness against `finalized.beacon.state_root`. | W-7 and honest accepts red. |
| M-12 (D1) | Check the witness only when `next_sync_committee` is present. | **W-8 red**, and W-9 if one of its steps lacks a committee. |
| M-13 (D1) | Accept the witness when the claimed layout is depth 7 without checking it. | S-10(a), S-11 red. |
| M-14 (D1) | The observation fold skips the witness (a separate fold helper in `observation.rs`). | **W-10 red.** |
| M-15 (D1) | The decoder reads the witness with no count limit, or does not refuse trailing witness bytes. | W-11 red, and W-14 if the fixtures change. |
| M-16 (D1) | Put a witness-derived word into `LightClientOutput`. | W-12 red (golden bytes), plus the 352-byte length checks in `fold.rs` and `update_rejections.rs:407`. |
| M-17 | Change the guest source without rebuilding the keys. | W-13 red. |
| M-18 | Map compact length 10 to 812. | X-1, `layout.rs:874` red. |
| M-19 | Remove the keccak check (`update.rs:148`). | **X-2, X-3, X-7**, `gloas.rs:142` red. |
| M-20 | Hash the payload in Deneb form whatever the blob flag says. | X-5 red, and the Capella honest accepts. |
| M-21 | Delete the call `verify_attested_execution(attested)?`. | L-1 red. |
| M-22 | Widen the skip to every compact attested header. | **L-2, L-3, L-4 red.** |
| M-23 | Apply the state-anchored skip to the finalized header as well. | L-5, `gloas.rs:178` red. |
| M-24 | Check the next committee (and the witness) against `finalized.beacon.state_root`. | **L-7 red.** |
| M-25 | `verify_step` ignores `fork_version` and calls `table_fork_version`. | V-3 red (the swapped version now verifies), and `update_rejections.rs:407`. |
| M-26 | `table_fork_version` uses `signature_slot` instead of `signature_slot - 1`. | V-2, **V-4** red. |
| M-27 | The prover joins the schedule and specification by epoch only, not by version. | P2-1, P2-7 red. |
| M-28 | The prover's `signing_version` uses the epoch of `signature_slot`. | **P2-2** red, and V-4 if it shares the helper. |
| M-29 | The prover takes the entry with the largest epoch overall. | **P2-3** red. |
| M-30 | The prover skips the cross-check of schedule and specification. | P2-4, P2-11 red. |
| M-31 | The prover falls back to the compiled table when an endpoint fails. | P2-5, P2-9 red. |
| M-32 | An unknown active fork falls back to the newest known fork. | **P2-6** red. |
| M-33 | The prover anchors by answer form only, with no fork-name check. | **P2-8** red, and P2-10. |
| M-34 | The strip accepts non-zero leading entries, or any length of 11 or more. | **P3-3, P3-4** red. |
| M-35 | The keep count is always 9, or the strip also runs on Gloas headers. | **P3-2, P3-5** red, and P3-9. |
| M-36 | The prover attaches the raw header without the keccak check. | **P3-6** red. The program would still refuse later, so only the prover test sees this. |
| M-37 | Remove the `eth_getBlockByHash` fallback from the update path. | **P3-7** red. |
| M-38 | Catch-up refetches the state instead of using stored branches. | **P1-2** red. |
| M-39 (D4) | Restore the name check in `_confirm` (`_lookup` then `UnsupportedVersion`). | **G-1, G-2** red. |
| M-40 (D4) | Seal on an unlisted name at an allowed shape (today's rule). | **G-3, G-4, G-8** red. |
| M-41 (D4) | Allow seal depths 1 to 4. | **G-5** red. |
| M-42 (D4) | A 7-entry confirm tries only 141, or only 169. | **G-7** red, and the Gloas or plain 5 half of G-6. |
| M-43 | Verify the leaf at `(2^d + 3) * 4` (`previous_version`). | G-9 red. |
| M-44 | Drop `SealEvidenceTooOld`. | G-10 red. |
| M-45 | Allow a gate shape that the program refuses (for example 7 without D1). | **G-11** red. |
| M-46 (D4 + witness) | The gate skips the shape witness. | G-12 red. |
| M-47 | Add any owner-only setter to the gate. | G-15 red. |

## Open points for the user

1. **D1.** I recommend it. It is the only defense against wrong layouts that does not rest on "no specification defines that field". It also closes a residual the design table did not list: Gloas claims on a true depth 7 or 8 state land below undefined fields 55, 56, 111 and 112.
2. **D4.** If adopted, decide what the registry mode on PulseChain does. It carries no shape. Also consider adding the `genesis_validators_root` witness to the gate, because a 7-entry proof at 169 lands on undefined field 41 of a true depth 7 state. Note that D4 gives up the version-name tripwire for forks that reorder fields at the same depth (T18).
3. The prover has two `debug_getRawHeader` paths with different error variants. Pick one before writing P3-6 and P3-7.
4. Fixtures: one real plain depth 5 state as a committed fixture for W-2, and the `verify/data/` files for V-4 and the P3 tests.
