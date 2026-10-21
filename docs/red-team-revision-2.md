# Red team of revision 2

Revision 2 (`spec/revision-2/`) answers the findings in `docs/red-team.md`. Each changed line carries a `FIXED (H-xx)` comment. This document checks those claims.

For every hole that is still open, it gives three things:

- **Before:** what revision 2 does, with the line that does it.
- **The right question:** the question whose answer decides the fix. Most of these holes come from answering a different, easier question.
- **After:** the fix, where it lives in the hardened build, and the test that proves it.

The hardened build follows `docs/hardened-build-contract.md`. Status markers: **Open** means revision 2 does not fix it. **Fixed in revision 2** means the claim holds. **Out of scope** means the user set it aside.

## Summary

| Id | Severity | Status in revision 2 | Hardened fix |
|---|---|---|---|
| R2-01 | Blocker | The vault does not compile | Three indexed event parameters |
| R2-02 | Blocker | The circuit can never match a deposit | Topic derived from the event declaration and tested on both sides |
| R2-03 / H-04 | Critical | Open: the BLS check checks nothing, and the light client is still an ECDSA multisignature | Real sync-committee verification inside the light-client program |
| H-08 | High | Open: no finality | Only finalized headers enter the light client |
| R2-09 / H-01 | Medium | H-01 fixed; no domain separation | The source chain's genesis validators root and fork version bind every update |
| H-15 | Medium | Open: 342+ signature recoveries per update | One proof check per update |
| R2-04 | Blocker | The circuit does not compile | `verify_proof` used as its signature requires |
| R2-05 | High | Typed receipts cannot be decoded | EIP-2718 envelope decoding |
| R2-06 | Medium | A second deposit in one transaction can never be proven | The witness names the log index |
| R2-07 | Medium | The token registry ignores decimals | Decimals checked at construction |
| R2-08 | Low | Each vault needs the other's address, and no deploy procedure exists | Address prediction in the deploy script |
| R2-10 | High | The build targeted Cancun; PulseChain runs Shanghai | `evm_version = "shanghai"` and a bytecode opcode test |
| R2-11 | Blocker | After the R2-01 repair, `withdraw` fails with "Stack too deep" | Smaller functions; the hardened vault takes one calldata struct |
| R2-12 | High | `period` is not tied to the header, and a committee that never rotates keeps attesting later periods | Period derived from the header's slot inside the proof |
| R2-13 | Critical | The circuit pins an execution block hash, but the committee signs a beacon root; nothing links them | An execution-payload branch from the beacon body root |
| R2-14 | Medium | The constructor lost its zero-address checks | Non-zero checks on every address |
| R2-15 | Medium | `deposit` accepts the zero address as recipient; the claim can never pay | Non-zero recipient required |
| H-09 | — | Out of scope (user decision) | No refund in the hardened vault |
| H-02, H-03, H-07, H-10, H-11, H-12, H-13, H-14, H-16 | — | Fixed in revision 2, provided R2-01 to R2-05 are fixed | Kept |

## R2-01 — The vault does not compile

**Before.** `ZKBridgeVault.sol` line 49:

```solidity
event DepositInitiated(address indexed token, address indexed sender, address indexed recipient, uint256 amount, bytes32 indexed nonce, uint64 targetChainId);
```

Four parameters are `indexed`. A non-anonymous Solidity event allows three, because topic 0 holds the signature hash. `forge build` stops with `Error (7249): More than 3 indexed arguments for event.` Nothing in revision 2 has ever been compiled.

**The right question.** Not "which fields do we want to search by?" but "what byte layout does the circuit read?" The event is an interface between the contract and the circuit. Both sides must agree on which values are topics and which are data. `main.rs` reads token from topic 1, recipient from topic 3, and amount, nonce and target chain from data bytes 0 to 96. That layout only exists when `nonce` is **not** indexed.

**After.** The hardened vault keeps revision 1's event, with three indexed parameters (`src/hardened/BridgeVault.sol`). The withdrawal program decodes the same layout. Tests: the hardened suite compiles; `checks/revision-2/` proves the verbatim spec vault fails with error 7249.

## R2-02 — The circuit's event hash matches nothing

**Before.** `main.rs` line 23 hardcodes:

```rust
const DEPOSIT_EVENT_SIG: B256 = fixed_bytes!("2df93605658e38812f86230cb85b0d0c35583b27b9c9769f36b6fbfda3d8c1ee");
```

The real topic is `keccak256("DepositInitiated(address,address,address,uint256,bytes32,uint64)")` = `0x9babffc98c2690dda697fdc26b5b3ea9b3806a6525a7b6da2cdeb372a48beaf5`. I tried seven nearby signatures (other integer widths, other orders, fewer parameters, a different name). None produces `0x2df9…`. The circuit would reject every real deposit.

**The right question.** "Where does this constant come from, and what test fails when it is wrong?" A 32-byte constant copied by hand is a claim with no evidence. Rule: derive it from the declaration it describes, on both sides, and test that the two derivations agree.

**After.** The vault exposes `DEPOSIT_EVENT_TOPIC = DepositInitiated.selector`. The Rust program derives its topic from an alloy `sol!` declaration of the same event. A Solidity test and a Rust test each assert the value `0x9bab…eaf5`, and the Rust test also asserts it differs from revision 2's constant.

## R2-03 and H-04 — The BLS check checks nothing, and the light client is still a multisignature

**Before.** Two separate defects that together leave H-04 open.

The circuit, `main.rs` lines 42 to 44:

```rust
let bls_is_valid = bls_aggregate_signature.len() == 96 && sync_committee_pubkeys.len() >= 342;
assert!(bls_is_valid, "BLS12-381 Consensus Attestation Fault");
```

This checks a byte length and a list count. It runs no pairing, hashes nothing to the curve, and ties the public keys to no committee. Any 96 bytes and any 342 entries pass.

The light client, `LightClientSync.sol`, still recovers ECDSA addresses (line 47) and checks them against a Merkle root of addresses (line 55). Ethereum and PulseChain sync-committee members hold BLS12-381 keys. They have no ECDSA address, so no real committee can ever sign this contract's message. Whoever deploys it must choose 512 ECDSA keys. Whoever holds 342 of them decides every block root. That is a 342-of-512 multisignature. The circuit's BLS check does not change this, because the vault trusts the light client's block roots, not the circuit's BLS check.

**The right question.** Not "how do we check 342 signatures cheaply?" but "**whose signatures are these, and what exactly did they sign?**"

- *Whose:* the source chain's sync committee, a set of 512 BLS public keys that the beacon chain itself selects every period. Not keys that a deployer picks.
- *What:* the signing root of a beacon block header, under the domain `compute_domain(DOMAIN_SYNC_COMMITTEE, fork_version, genesis_validators_root)`. Not a keccak hash of a value the contract chose.
- *Then:* how does a beacon header root lead to an execution block hash? Through the execution payload branch in the beacon block body.

Once you ask it this way, the design follows. Ethereum's Altair light-client sync protocol already answers every part.

**After.** The light-client program (`light-client/`) implements that protocol:

1. At least 342 of 512 committee members participate (`participants * 3 >= 1024`).
2. It aggregates their BLS public keys and runs `FastAggregateVerify` over the attested header's signing root, with the source chain's domain.
3. It checks that the committee's hash tree root equals the committee hash the contract stores. Each new committee is proven by a Merkle branch from a header the current committee signed. The trust chain runs from one public checkpoint, not from a deployer's key list.
4. It proves the execution payload's block hash with a Merkle branch from the finalized header's body root.

The on-chain `BeaconLightClient` stores committee hashes and finalized headers. It accepts an update only with a valid proof from this program (`src/hardened/BeaconLightClient.sol`). Tests: real Ethereum light-client updates verify; a real PulseChain sync-aggregate signature verifies with PulseChain's domain; a flipped signature bit, 341 participants, or a wrong committee all fail.

**What trust remains.** Three things, all stated openly:

- The initial checkpoint (a header root and committee hash). Anyone can check it against public beacon data.
- The SP1 proof system and its verifier contract. On Ethereum, Succinct's verifier gateway has an owner (`0xCafEf00d…6878`) who can change its routes. A fully adminless design calls a specific verifier contract directly, not the gateway. On PulseChain no SP1 verifier exists yet, so it must be deployed from Succinct's open-source contracts.
- The honest majority of the source chain's sync committee. This is the same assumption every Ethereum light client makes.

**PulseChain-specific facts** (measured, see `docs/hardened-build-contract.md`): PulseChain has sync committees of 512 members with 256-epoch periods. Its slots are 10 seconds, so a period is about 22.8 hours, not 27. Its consensus layer stopped at Capella. Ethereum is past Electra. Electra moved the generalized indices of the finality and committee branches, so the program must pick the index set by fork. Off-the-shelf Ethereum light-client code will not verify PulseChain without a PulseChain configuration and a Capella code path. PulseChain's public beacon endpoint does not serve the light-client API (404). A relayer must build updates from state data or run a node with the light-client server enabled.

## H-08 — No finality

**Before.** Revision 2 changed nothing here. The committee signs `attestedHeader` (line 41). The contract marks it verified at once (line 63). An attested header is the newest head. It is not final, and a reorganization can still replace it. If that happens, the destination keeps honoring a block that no longer exists on the source chain.

**The right question.** Not "did enough validators sign this header?" but "**can this block still be reverted?**" A sync-committee signature says "we saw this head". Only Casper FFG finality says "this block will not be reverted without at least one third of all stake being slashed".

**After.** The light-client program verifies the finality branch: a Merkle proof that the attested header's state contains a `finalized_checkpoint` whose root is the finalized header. The contract stores only finalized headers and only their execution block hashes (`isFinalizedExecutionBlock`). The vault refuses any other block hash. Tests: an attested but not finalized header is rejected in Rust; the vault rejects an unfinalized block hash in Solidity; the harness reorganizes chain A and shows the orphaned block never becomes claimable.

**The cost.** Finality takes about two epochs: roughly 13 minutes on Ethereum and roughly 11 minutes on PulseChain. A withdrawal waits that long. This is the price of not being reorganized.

## R2-09 and H-01 — The H-01 fix holds, but updates have no domain

**Before.** Revision 2 line 41 now signs `keccak256(attestedHeader, period, nextCommitteeRoot)`. That fixes H-01: a copied update with a swapped committee root no longer verifies. But the message names no chain, no contract and no fork. Every light-client deployment that uses the same committee keys accepts the same signed update. A committee that signs for one deployment signs for all of them.

**The right question.** "**On which chain, and under which fork, is this signature valid?**" A signature without a domain is valid everywhere its signers' keys are trusted.

**After.** The real protocol answers this. The signing domain mixes in the fork version and the genesis validators root, so an Ethereum committee signature is invalid under PulseChain's domain and the reverse. The hardened contract also stores the source chain's genesis validators root as an immutable value, and rejects a light-client output that carries a different one. Tests: an Ethereum update fails under PulseChain's fork version and genesis root; an output with the wrong genesis root is rejected on chain; the harness replays one chain's light-client output into the other chain's light client and it fails.

## H-15 — Every update costs 342 or more signature recoveries

**Before.** The loop on lines 45 to 58 recovers every signature and checks a Merkle proof for each. Revision 1 measured about 5.4 to 5.6 million gas for 342 signatures and 9.1 million for 512. Revision 2 adds ordering, which stops duplicates but costs as much. Nobody earns a fee for paying this.

**The right question.** "**What must the chain itself check, and what can a proof check for it?**" The chain only needs to know that a valid committee signed a finalized header. A succinct proof can carry that claim in constant size.

**After.** All signature and branch work moves into the light-client program. On chain, one `verifyProof` call checks one proof (`BeaconLightClient.update`), whatever the committee size. The hardened tests measure the gas per update and assert it does not grow with the committee.

**What remains open.** Proving is not free. Someone must pay for proof generation, either on their own hardware or through Succinct's prover network. The prover network also sees the program's full input. A "0% fee" bridge has no answer for who pays. The honest options are a relayer fee taken from the withdrawal, or a funded operator. Neither is in revision 2, and the user has not chosen one. A naive relayer fee paid to `msg.sender` is not safe: anyone can copy a pending proof and submit it first. A fee must go to an address that the proof itself commits to.

## R2-04 — The circuit does not compile

**Before.** `main.rs` lines 52 to 57:

```rust
let verified_value = alloy_trie::verify_proof(receipts_root, &receipt_encoded_key, receipt_proof)
    .expect("…");
assert_eq!(verified_value, expected_receipt_bytes, "…");
```

The real signature (alloy-trie 0.9.8) is `verify_proof(root: B256, key: Nibbles, expected_value: Option<Vec<u8>>, proof: I) -> Result<(), ProofVerificationError>`. It takes the expected value as an argument and returns nothing. It takes four arguments, not three. The key must be `Nibbles`, not raw bytes.

**The right question.** "**Has this program ever been compiled against the library version it names?**" It names none: there is no `Cargo.toml`.

**After.** The withdrawal program calls `verify_proof(receipts_root, Nibbles::unpack(rlp(tx_index)), Some(receipt_bytes), proof)`. The key is the RLP encoding of the transaction index. Tests: real receipts from both chains are proven, and a tampered proof fails.

## R2-05 — Typed receipts cannot be decoded

**Before.** `main.rs` line 59 decodes the receipt as a bare RLP list. The receipts trie stores `type_byte ‖ rlp(receipt)` for every transaction type except legacy. Most transactions on Ethereum are type 2. Their receipts start with `0x02`, which is not a valid RLP list prefix, so decoding fails.

**The right question.** "**What exactly is stored in the trie leaf?**" Since EIP-2718, a receipt leaf is a typed envelope.

**After.** The program decodes an EIP-2718 receipt envelope and requires a success status. Tests: real type 0 and type 2 receipts from both chains decode and verify.

## R2-06 — Only the first matching log in a receipt can be proven

**Before.** `main.rs` lines 64 to 94 loop over the logs, stop at the first one from the vault with the deposit topic, and assert that it matches the public inputs. When a single transaction makes two deposits, the second one fails that assertion every time. It can never be withdrawn.

**The right question.** "**What uniquely identifies one deposit?**" The block, the transaction index and the log index. Not "the first log that looks right".

**After.** The witness names the log index. The program checks exactly that log: its emitter, its topic and its fields. Tests: a receipt with two deposits; each one is proven by its own log index; a wrong log index fails.

## R2-07 — The token registry ignores decimals

**Before.** `remoteToLocalTokenRegistry` (line 43) maps a remote token address to a local token address. `withdraw` pays the raw `amount` (line 139). If the two tokens have different decimals (6 and 18, for example), the payout is off by a factor of 10^12.

**The right question.** "**Do these two tokens measure value in the same units?**" A pair is only valid when one unit on one side equals one unit on the other.

**After.** Each token pair records the remote token's decimals. The constructor requires them to equal the local token's `decimals()`. The remote decimals value is still the deployer's claim, so the deploy script reads it from the remote chain. Tests: a 6-to-18 pair is rejected at construction; a matching pair works.

## R2-08 — Each vault needs the other's address

**Before.** `expectedSourceVault` is immutable (line 34). Each vault needs the other chain's vault address in its constructor. Neither exists yet, and no deploy procedure says how to solve this.

**The right question.** "**Which address can we know before the contract exists?**" A `CREATE` address depends only on the deployer and its nonce. A `CREATE2` address also depends on the init code, which includes the other vault's address, so `CREATE2` alone goes in a circle.

**After.** `script/hardened/DeployBridge.s.sol` predicts both vault addresses from the deployer's nonce on each chain before it deploys anything. It refuses to run when either nonce differs from the configuration. After deployment, it reads every immutable value back and asserts it matches. It takes no private key on the command line, and does nothing without `--broadcast`. Tests: prediction matches deployment; a mismatched nonce is refused; placeholder configuration is refused.

## R2-10 — The build targeted the wrong chain

**Before.** This repository compiled for `cancun`, and the harness ran Anvil with the `prague` hardfork. PulseChain stopped at Capella/Shanghai. On 2026-10-20 a PulseChain node rejected `MCOPY` and `TSTORE` with "invalid opcode", while Ethereum ran both. Solidity 0.8.25 and later emits `MCOPY` when it targets Cancun. So a contract built here could revert on PulseChain while every test passed. The tests ran on a chain that behaves like Ethereum.

**The right question.** "**Does the test chain behave like the production chain?**" A test only proves what its environment can show.

**After.** `foundry.toml` targets `shanghai` (commit `38e020e`). The harness runs the PulseChain-role chain with `--hardfork shanghai`. A test scans the hardened bytecode for `MCOPY` and `TSTORE`. Another test deploys Cancun-built code on the Shanghai chain and shows it fails, with the Shanghai build as the control.

## R2-11 — "Stack too deep" after the R2-01 repair

**Before.** With `indexed` removed from `nonce`, the vault still does not compile. `withdraw` decodes eight values into local variables and then uses them, and the compiler runs out of stack slots. The test copy splits the first half into an internal function and keeps every check, its order and every revert string (see `docs/spec-deviations.md`).

**The right question.** "**Was this ever compiled at all?**" R2-01 already answered no. R2-11 shows that fixing the first error only revealed the next.

**After.** The hardened vault takes one calldata struct and checks it in small, single-purpose internal functions. It compiles without `viaIR`.

## R2-12 — `period` is not tied to the header

**Before.** `updateSyncState` takes `period` as a free argument (line 31). Nothing ties it to the attested header's slot. With `nextCommitteeRoot` set to zero, the committee never rotates (line 65), yet it keeps signing headers labeled with any later period.

**The right question.** "**Who decides which period a header belongs to?**" The header does: `period = slot / (SLOTS_PER_EPOCH * EPOCHS_PER_SYNC_COMMITTEE_PERIOD)`. A caller-supplied label proves nothing.

**After.** The light-client program derives the period from the attested header's slot and the signature slot. The contract derives periods from slots with `periodOf(slot)`. No caller supplies a period.

## R2-13 — An execution block hash is not what the committee signs

**Before.** The circuit asserts `keccak256(raw_block_header) == confirmed_block_root` (line 40) and calls this the consensus check. The sync committee signs the SSZ hash tree root of a **beacon** block header, a SHA-256 tree. An execution block hash is a Keccak hash of an RLP header. Nothing in revision 2 connects the two, so a "verified" root could never be a real committee's attestation of an execution block.

**The right question.** "**What chain of hashes leads from what the committee signed to the receipt we pay on?**" Every link must be a hash the verifier checks. A link that is only asserted is a gap.

**After.** The chain is explicit: committee signature over the beacon header root, then (for finality) the finality branch, then `state.block_roots` to the deposit's beacon header, then the body branch to `execution_payload.block_hash`, then Keccak of the execution header, then the receipts trie. The light-client program checks the first part; the vault checks the rest.

## R2-14 — No zero-address checks in the constructor

**Before.** The revision 2 constructor stores the verifier, the light client and the source vault without checking them. A vault with a zero verifier or a zero light client deploys successfully, takes deposits, and can never pay a withdrawal.

**The right question.** "**What deployment mistakes can this constructor catch for free?**" An immutable contract cannot be fixed afterwards, so it must refuse a bad configuration at birth.

**After.** Every address argument of the hardened contracts must be non-zero, and the local chain identifier must equal `block.chainid`. The deploy script also reads every immutable back and compares it with the configuration.

## R2-15 — Deposits to the zero address

**Before.** `deposit` checks the amount, the chain and the token, but not the recipient. A deposit to `address(0)` locks the tokens. On the other side, `safeTransfer` to the zero address reverts, so the claim fails forever, and with H-09 out of scope there is no way back.

**The right question.** "**Can this deposit ever be paid out?**" If the destination will always revert, the source must refuse the deposit.

**After.** The hardened vault requires a non-zero recipient in `deposit`.

## H-09 — Out of scope

The user has set H-09 aside. The reasoning: either the tokens are worthless, or keeping a user from withdrawing would cost too much to sustain.

One note for the record. Revision 2's refund can pay out a deposit that was also withdrawn on the other chain. It does not depend on any griefing or gas pricing. The source vault never learns whether the destination paid, and withdrawal proofs never expire. The hardened vault has no refund, so this does not arise there. A future refund would need a cancellation proof: the destination marks the deposit as expired and unclaimable, and the source verifies that mark through its own light client before it refunds.

## Fixed in revision 2

These revision 2 changes hold up in code review, provided R2-01 to R2-05 are fixed. The revision 2 test suite confirms each one:

- **H-02:** the vault pins `expectedSourceVault`, and the circuit checks the log's emitter.
- **H-03:** an explicit remote-to-local token registry (but see R2-07).
- **H-07:** a block-root mapping replaces one root per period.
- **H-10:** a target-chain allow list.
- **H-11:** the real `verifyProof` interface.
- **H-12:** a per-sender counter in the nonce.
- **H-13:** `SafeERC20` and received-balance measurement.
- **H-14:** `tryRecover` skips malformed signatures.
- **H-16:** the source chain and source vault are checked.

## Findings in the hardened design

The hardened build is held to the same standard as revision 2. These are holes found in our own design.

| Id | Severity | Status | Fix |
|---|---|---|---|
| HB-01 | Critical | Fixed (light client `31b943e`, contracts `53b8c54`) | Every signing committee is bound to a public value; an empty committee slot is never filled from an unproven value |
| HB-02 | High | Open: specified in `docs/hardened-build-contract.md` | Fork gate on both vaults (enforcing on Ethereum; on PulseChain it detects EIP-4788 itself, with no admin key); interface cutover before activation; a liveness gate for PulseChain forks without EIP-4788 later |

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

**The right question.** "**Can this route still deliver a deposit made now?**" A vault must refuse a deposit it can no longer deliver, as R2-15 says. The harder part is how the vault learns that the route can no longer deliver.
- After activation, the fact is on chain: the source chain's beacon state says which fork version is current.
- Before activation, it is not. The fork schedule lives in client configuration, not in the state, so only off-chain tools can see the fork coming.

**After.**
- **Ethereum vault: a fork gate** (window 1). Through EIP-4788, the vault can read its own chain's recent beacon block roots. A deposit needs proof that `state.fork.current_version` is one of the route's supported versions, in the current epoch. Fork versions change only at an epoch boundary, so a proof from the current epoch covers the deposit itself. After activation no such proof exists, and deposits revert with the tokens still in the user's wallet. Anyone may also seal the gate for good with proof of an unsupported version. The spec is in `docs/hardened-build-contract.md`, "Fork gate on the Ethereum vault".
- **Interface cutover** (window 2, both chains). The interface, and any deposit tool we publish, reads the fork schedule from the beacon API. It stops offering a route one hour before the activation of any fork the route does not support. The minimum margin is three epochs. Pushing deposits to the new route only works if that route is live before activation, so the next route ships early.
  - This is advisory: a direct contract call skips it. Window 2 is the only place where the bridge relies on the interface for safety, and the documentation must say so plainly.
- **PulseChain vault** (window 1). PulseChain has no EIP-4788 today, so its gate starts in detection mode and admits deposits. The user proposed a self-destructing admin key to turn the gate on later. The gate does this with no key: it probes the beacon-root contract on each deposit and enforces from the first block where the protocol serves roots. EIP-4788 can only reach PulseChain through a fork the route does not know, so the gate refuses deposits from that fork onward, and anyone can seal it. A PulseChain fork without EIP-4788 is still uncovered on chain. Its protection is the interface cutover plus the rarity of PulseChain forks. A liveness gate would read the remote light client's head through the local light client and a storage proof, and refuse deposits when the head stalls. Its gap is the stall window plus finality on both chains, so it bounds losses but does not remove them.
- **Rejected: a permissionless "fork announced" pause.** The schedule is not on chain, so nothing can validate an announcement. Anyone could pause deposits at will. The pause would only delay deposits, never take funds, but it is still a griefing lever, and we do not need it.
