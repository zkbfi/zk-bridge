# Findings in the hardened design (HB-01 to HB-06)

These are findings of our red team against the hardened design, the design that zkb.fi deploys (`src/hardened/`, `light-client/`, `prover/`). They were found after the red team had finished with proposal v0, the specification this project started from, and they were held to the same standard. Each finding says what the hole was, the right question behind it, and what changed.

The table below gives the status of each one. `known-issues.md` lists what is still open. The R2-xx and H-xx identifiers in the text are findings of the red team of proposal v0. That material was removed from the tree on 2026-11-20 and lives at commit `e25337322e0004fee8f033a993a3b3e052cc382c`: [the findings of revision 1](https://github.com/zkbfi/zk-bridge/blob/e25337322e0004fee8f033a993a3b3e052cc382c/docs/red-team.md) and [of revision 2](https://github.com/zkbfi/zk-bridge/blob/e25337322e0004fee8f033a993a3b3e052cc382c/docs/red-team-revision-2.md).

| Id | Severity | Status | Fix |
|---|---|---|---|
| HB-01 | Critical | Fixed (light client `628e30a`, contracts `0aa1d0a`) | Every signing committee is bound to a public value; an empty committee slot is never filled from an unproven value |
| HB-02 | High | Built (gate, canaries, fork registry); not audited. A route that meets an unsupported fork still needs a cutover, and deposits just before the fork stay locked (refunds, H-09, are out of scope) | Fork gate on both vaults (enforcing on Ethereum; on PulseChain it detects EIP-4788 itself, with no admin key); interface cutover before activation; a liveness gate for PulseChain forks without EIP-4788 later |
| HB-03 | Critical | Fixed (`2119d5d`) | A block-roots layout row may name only the field's own position; `eth1_data_votes` has the same shape and proposers fill it |
| HB-04 | Critical | Fixed (`2119d5d`) | A block-hash layout row may name only the execution payload's `block_hash` position; graffiti and `eth1_data` hold proposer-chosen values |
| HB-05 | High | Fixed (`2119d5d`) | The receipt logs walker has no 32-item limit, so a deposit in a busy transaction can still be withdrawn |
| HB-06 | Medium | Fixed (`2119d5d`) | Each deposit names its destination vault, so a second vault for the same source cannot pay it again |

## HB-01 — An unbound next committee could sign a forged head

**Before.** The light-client program takes its store as private input. The public output bound the store's header and its current committee, but not its next committee. Two paths used the unbound value:

- An update signed in the next period, but finalized in the stored period, was verified against `store.next_sync_committee`, and no output named it.
- `nextSyncCommitteeHash` carried the stored next committee even when the update did not prove it.

The contract compared committee hashes only when a value was already stored. The slot for the next committee is often empty: the constructor allows an empty value, and so does any crossing that does not prove the next committee. An attacker could invent a committee, sign a forged header with it, and have the contract store the fake committee and accept the forged head. That is a full drain.

**The right question.** "**Which public value names the committee that signed?**" Every key the program trusts must be either proven inside the proof or bound to a value the contract already holds. A private input that no output names is an input the attacker chooses.

**After.**
- **Program:** it refuses a next-period signature unless the finalized header also crosses into that period, so the signer is always the committee named by `previousSyncCommitteeHash` or `syncCommitteeHash`. It outputs `nextSyncCommitteeHash` only when the update proves it.
- **Contract:** a crossing needs a stored, non-zero committee for the new period, and the contract writes an empty next slot only from a proven value.
- **Tests:** both attack paths are tested on both sides, with controls, and each attack test fails on the old code.
- **Folded updates:** they add `startNextSyncCommitteeHash` for the same reason. A fold may start by crossing, so the starting next committee must be named too.

## HB-02 — Deposits into a route that cannot follow a fork are stuck forever

**Before.** A route is a light client plus a pair of vaults. Its program knows a fixed set of source-chain fork versions. When the source chain activates a fork that the program does not know, the light client can no longer advance. Every deposit the old light client never anchored can never be withdrawn, and with H-09 out of scope there is no refund. The immutable `depositCutoffTimestamp` cannot help: it is set at deployment, before anyone knows the fork's date.

Two windows lose funds:

1. **After activation.** Users and scripts keep calling the old vault's `deposit`, and nothing on chain refuses them.
2. **Just before activation.** A withdrawal needs a finalized anchor at or after the deposit slot, and finality trails the attested head by about two epochs.
   - To finalize the last two epochs before the fork, an update must be attested and signed after the fork. The old program rejects it.
   - So deposits in roughly the last two or three epochs before activation pass every check and are still stranded. That is about 13 to 19 minutes on Ethereum, and 11 to 16 minutes on PulseChain.

**The right question.** "**Can this route still deliver a deposit made now?**" A vault must refuse a deposit it can no longer deliver, as R2-15 of [the red team of proposal v0, revision 2](https://github.com/zkbfi/zk-bridge/blob/e25337322e0004fee8f033a993a3b3e052cc382c/docs/red-team-revision-2.md) says. The harder part is how the vault learns that the route can no longer deliver.
- After activation, the fact is on chain: the source chain's beacon state says which fork version is current.
- Before activation, it is not. The fork schedule lives in client configuration, not in the state, so only off-chain tools can see the fork coming.

**After.**
- **Ethereum vault: a fork gate** (window 1). Through EIP-4788, the vault can read its own chain's recent beacon block roots. A deposit needs proof that `state.fork.current_version` is one of the route's supported versions, in the current epoch. Fork versions change only at an epoch boundary, so a proof from the current epoch covers the deposit itself. After activation no such proof exists, and deposits revert with the tokens still in the user's wallet. Anyone may also seal the gate for good with proof of an unsupported version. The spec is in `docs/hardened-build-contract.md`, "Fork gate on the Ethereum vault".
- **Interface cutover** (window 2, both chains). The interface, and any deposit tool we publish, reads the fork schedule from the beacon API. It stops offering a route one hour before the activation of any fork the route does not support. The minimum margin is three epochs. Pushing deposits to the new route only works if that route is live before activation, so the next route ships early.
  - This is advisory: a direct contract call skips it. Window 2 is the only place where the bridge relies on the interface for safety, and the documentation must say so plainly.
- **PulseChain vault** (window 1). PulseChain has no EIP-4788 today, so its gate starts in detection mode and admits deposits. The user proposed a self-destructing admin key to turn the gate on later. The gate does this with no key: it probes the beacon-root contract on each deposit and enforces from the first block where the protocol serves roots. EIP-4788 can only reach PulseChain through a fork the route does not know, so the gate refuses deposits from that fork onward, and anyone can seal it. A PulseChain fork without EIP-4788 is covered by a fork observation registry, specified in `docs/hardened-build-contract.md`. One proof that the bound sync committee signed under a new version shows the chain now runs that version. This needs no state layout and no admin. With that proof recorded on PulseChain, the gate refuses deposits and anyone can seal it. The remaining gap is the time to produce that proof, minutes when a watcher runs. An optional liveness rule closes the rest, at a keeper cost. A liveness gate would read the remote light client's head through the local light client and a storage proof, and refuse deposits when the head stalls. Its gap is the stall window plus finality on both chains, so it bounds losses but does not remove them.
- **Rejected: a permissionless "fork announced" pause.** The schedule is not on chain, so nothing can validate an announcement. Anyone could pause deposits at will. The pause would only delay deposits, never take funds, but it is still a griefing lever, and we do not need it.

## HB-03 — A layout row can point at votes that proposers write

**Before.** `addBlockRootsLayout` accepted any generalized index G, at depth 8 or less, when two stored header roots appeared at `G * 8192 + slot % 8192`. We called the table self-validating because "a wrong position cannot match". That is false. `state.eth1_data_votes` is a list of 2048 entries with 4 leaves each, so it has the same shape at G = 82 (Capella, Deneb) and G = 146 (Electra, Fulu). A proposer writes any value into a vote, and the state transition does not check it.

An attacker proposes two blocks in one voting period. The votes hold two past finalized header roots, at the right offsets, and the root of an invented deposit header. The attacker adds the row and withdraws in one transaction. That is a full drain.

**The right question.** "**Who can write the leaves this evidence points at?**" Evidence that a value matches proves only that someone wrote it. It does not prove the chain computed it.

**After.** The vault accepts only the field's own position: `2**d + 5` for `block_roots` and `2**d + 27` for `historical_summaries`, with d in {5, 6, 7}. The evidence then only picks the depth. Reject tests cover positions 82 and 146 with evidence that would have passed before.

## HB-04 — A block-hash row can point at graffiti

**Before.** `addBlockHashLayout` accepted any body position where a stored header's leaf equalled that block's own execution block hash. A proposer can copy the hash into `graffiti` (position 18) or `eth1_data.block_hash` (position 70) of the same block. With two such checkpoint blocks and a third block between them, the third block's graffiti names an invented execution header, and the vault pays an invented deposit. This works wherever no honest row already covers that slot.

**The right question.** The same as HB-03.

**After.** The vault accepts only `(2**db + 9) * 2**dp + 12`, with db and dp in {4, 5}: the `block_hash` field of the execution payload. Today that is 412 or 812. The Rust reference already used these fixed positions, so the two now agree again.

## HB-05 — A deposit in a transaction with more than 32 logs is stuck

**Before.** The vault read the receipt's logs with the vendored `RLPReader.readList`, which reverts on more than 32 items. The Rust reference accepts any count, so a prover builds a valid proof and the vault reverts. With no refund, the tokens stay locked. Batching contracts and busy decentralized-finance transactions produce such receipts.

**The right question.** "**Does every deposit the source vault accepts have a withdrawal the destination vault accepts?**"

**After.** A small walker steps to item `logIndex` without building the whole list. The vendored files stay unchanged. Tests cover 0, 31, 32, 33 and 200 items and a deposit at log 40 of 64.

## HB-06 — Nothing names the destination vault

**Before.** The deposit nonce binds the source chain, the source vault and a counter. `claimed` is stored per vault. If a second vault on the same chain names the same source vault, for example after only one side of a route is redeployed, its `claimed` map is empty and it pays every deposit again.

**The right question.** "**Which vault may pay this deposit?**" Only the deposit itself can answer that, because anyone can deploy a vault.

**After.** `DepositInitiated` carries the destination vault, and `withdraw` requires it to equal `address(this)`.
