# zkBridge paper: compression techniques for this bridge

Source: Xie, Zhang, Cheng, Zhang, Zhang, Jia, Boneh, Song, "zkBridge: Trustless Cross-chain Bridges Made Practical" (Association for Computing Machinery Conference on Computer and Communications Security, 2022). Fetched from https://rdi.berkeley.edu/zkp/uploads/paper.pdf on 2026-10-20.

## Summary

The paper has four compression ideas. Two of them we already have, one is obsolete for us, and two of the questions it raises give us real gains.

| Paper technique | Status for this bridge |
|---|---|
| Two-layer recursion: a fast prover, then a Groth16 wrap for a constant on-chain check (about 227,000 gas, 131-byte proof) | Already have. SP1 does the same thing: it proves in shards, folds them with recursion, then wraps the result in Groth16 on the BN254 curve. |
| deVirgo: split a circuit of N identical signature checks across N machines | Does not apply. See below. |
| Batching: store one Merkle root for B consecutive headers | Already have, from the chain itself. Each stored anchor commits to `state.block_roots`, a Merkle vector of the last 8192 block roots. |
| Lazy, user-paid proof submission (Appendix G) | Worth adopting as an option for H-15 (who pays for proving), with one fix. |
| Ethereum direction (proof-of-work Ethash circuit) | Obsolete. Ethereum and PulseChain are both proof of stake. |

The paper does not name the two gains below. Its batching and lazy-submission ideas led me to them.

1. **Prove old deposits through `state.historical_summaries`.** This removes the 8192-slot cap on head jumps.
2. **Fold many committee handoffs into one proof.** This lets anyone catch up a stale light client with one on-chain check.

## Gain 1: reach any deposit since Capella from one anchor

**Before.** The vault proves a deposit block through `anchorState.block_roots[slot % 8192]`, so a deposit must be within 8192 slots of a stored anchor. That is about 22.8 hours on PulseChain and 27.3 hours on Ethereum. To keep every slot reachable, `update()` caps a head jump at 8192 slots. So someone must post an update at least once per 8192 slots, forever. If nobody does, deposits in the gap can never be withdrawn.

**Right question.** Does the beacon state already commit to block roots older than 8192 slots?

**Answer.** Yes. Capella added `historical_summaries` (Capella beacon state field 27). Every 8192 slots the chain appends `HistoricalSummary { block_summary_root, state_summary_root }`. `block_summary_root` is the hash tree root of that era's full `block_roots` vector. The list limit is 2^24 entries, so it never fills in practice.

**After.** The vault accepts a second proof path for a deposit in a completed era:

```
anchorHeader.stateRoot
  -> state.historical_summaries[eraIndex].block_summary_root   (field branch + list length mix-in + 24 levels + 1 level)
  -> block_roots[depositSlot % 8192]                            (13 levels)
  -> hashTreeRoot(depositHeader)
```

- Branch length: about 44 hashes in the Capella and Deneb layouts, and one more in Electra, where the state has 37 fields. Each hash is one call to the SHA-256 precompile. The calldata grows by about 26 × 32 = 832 bytes over the `block_roots` path. That costs a few thousand gas for hashing plus about 13,000 gas for calldata. This is small next to a token transfer.
- `eraIndex = depositSlot / 8192 - capellaSlot / 8192`, where `capellaSlot` is the source chain's Capella fork slot. On Ethereum that is 6209536 / 8192 = 758, exactly. On PulseChain, Capella is at epoch 3 (slot 96), so the offset is 0.
- I have not checked this formula against real data. A real fixture must pin it on each chain before anyone relies on it, because an off-by-one here makes a whole era unreachable or wrongly reachable.
- A deposit in the anchor's current, unfinished era still uses `block_roots`. The vault needs both paths.
- The fork-layout table gains one generalized index: the `historical_summaries` field position per layout. The self-validating `addForkLayout` check must cover it the same way it covers `block_roots`.

**Effect.**
- The 8192-slot head-jump cap is no longer needed. The griefing it blocks, where an update jumps the head so far that old deposits become unreachable, stops working: every block since Capella stays reachable from any later anchor.
- Updates become a liveness and latency concern, not a safety concern. A deposit waits for the next update, but it cannot be stranded.
- Trade-off: the vault gets one more Merkle path to verify and test. The withdrawal reject tests must cover both paths, plus the boundary at an era edge.

## Gain 2: one proof for many committee handoffs

**Before.** A light client cannot skip a sync committee period. The committee for period p+2 is only known from an update signed in period p+1. So after k idle periods, the next user must post k separate proofs, and each one pays for a Groth16 check on-chain.

**Right question.** Must each handoff be checked on-chain, or only the chain of handoffs as a whole?

**Answer.** Only the whole chain. The vault needs the start (the stored committee hash) and the end (the new head and the new committee hashes). The steps in between are private.

**After.** The program takes a list of updates and loops over them. It checks each signature against the committee it got from the step before. Then it outputs one `LightClientOutput` whose `previous*` fields match the stored state and whose `new*` fields describe the end.
- On-chain cost: one Groth16 check, whatever k is.
- Prover cost: about 49 million cycles per BLS check, so it grows linearly with k. Each update in the list is one BLS check.
- The simple loop needs no recursion. SP1 can also verify SP1 proofs inside a program. That would let separate machines prove the steps in parallel and fold the results later. We only need it if catch-up latency matters.
- The output stays one tuple, so the vault interface does not change. `LightClientOutput` has no step count, so the stored committee for every skipped period stays unknown on-chain. That is fine: the vault only needs the newest committee to accept the next update.

Together with Gain 1, a single user can revive a light client that was idle for months, with one proof and one withdrawal.

## Lazy, user-paid submission (paper Appendix G)

**Paper idea.** Provers publish proofs off-chain. A user who needs block b posts the missing proofs on-chain and becomes the "owner" of them. Later users who rely on those blocks pay the owner a fee.

**Hole.** On-chain ownership goes to whoever submits first. A copier can take a proof from the public mempool, resubmit it with a higher fee, and become the owner. This is the same problem we found with relayer fees.

**Fix.** The proof must commit to the owner's address in its public values, and the vault must pay only that address. Then a copied proof still pays the original prover.

**Fit for us.** This is one answer to H-15, the open question of who pays for proving. With Gains 1 and 2, nobody has to pay for an update in every period. The first user after a quiet stretch pays for one catch-up proof. Whether to add a fee, and who sets it, is still your decision. The design works without one, because anyone can run the shared prover.

## Why deVirgo does not apply

deVirgo speeds up a circuit made of N identical, independent sub-circuits, such as N EdDSA checks for Cosmos. That proving work splits cleanly across N machines.

The sync committee uses BLS aggregation instead. The 512 signatures are already one aggregate signature. The program sums the participating public keys and runs one pairing check. Only the key sum and the committee hash are data-parallel, and they are a small part of the 49 million cycles.

SP1 already splits execution into shards and can prove them on many machines. deVirgo is a research prototype in C++ built for Virgo's proof system. Adopting it would add a second proof system to build, audit and keep up to date, for little gain.

## Next steps

- Add the `historical_summaries` path to the vault and to `lc-core::withdrawal`. Pin `eraIndex` with a real fixture from each chain. Then remove the 8192-slot head-jump cap and its tests, replacing them with era-boundary tests.
- Let the light-client program accept a list of updates, with tests that a broken link anywhere in the list rejects the whole proof.
- Decide H-15: no fee, or a fee paid to an address that the proof commits to.
