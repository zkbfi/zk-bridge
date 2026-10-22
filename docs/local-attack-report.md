# Local attack report

This report lists every attack that I ran against the local two-chain bridge of `docs/local-network.md`. The bots ran in the background. They paused only while a script needed an empty prover queue.

Result words: **BLOCKED** means the contract or the prover refused the attack. **SUCCEEDED** means the attack did what the attacker wanted, or the check did not fire. Each SUCCEEDED line is explained in the section "Items that succeeded".

**Summary: I found no hole in the contracts or in the prover that works on a real chain.** Every SUCCEEDED result comes from the local setup (a public oracle key, the development beacon source), or it is a control, or it is an accepted input (a user error). I found two weaknesses of the prover that do not lose funds: it works one deposit at a time, and a deposit can become `failed` for good (see "Observations").

## How to run

The code is in `attacks/local/`. Each script prints `ATTACK name: BLOCKED (reason)` or `ATTACK name: SUCCEEDED (evidence)`.

| File | What it does |
|---|---|
| `lib.sh` | Shared helpers. Reads `deployment.json` from the prover container. Decodes revert reasons by name. |
| `src/main.rs` | The program `attack-evidence` (cargo feature `dev-source`, built from `prover/Cargo.toml`). It builds the calldata of `withdraw` for a deposit, and the tampered variants. It sends nothing and holds no key. |
| `10-withdrawal-evidence.sh` | Replay, wrong vault, fake emitter, tampered evidence, front-running. |
| `20-light-client.sh` | Attacks on `BeaconLightClient.update`. |
| `30-gate.sh` | Attacks on `BeaconForkGate`. |
| `40-deposits.sh` | Deposit inputs, privileged functions, bogus layout rows. |
| `50-griefing.sh` | Burst of 1-wei deposits. |
| `60-crash-safety.sh` | Prover kill at three points, and a deleted prover database. |
| `65-frontrun-claimed.sh` | The attacker wins the race. The prover finds the nonce claimed. |
| `70-reorg.sh` | Reverts of chain A with `evm_snapshot` and `evm_revert`. |
| `90-books.sh` | Token balance of each vault against its events. |

Run the scripts with `ATTACK_SCRATCH` set to a scratch directory. Build the program first: `cargo build --offline --bin attack-evidence` in `prover/`.

Method notes:

- The attacker is Anvil account 9. Anvil unlocks the account, so the scripts hold no key. The only signature that a script makes is the oracle signature in `20-light-client.sh`.
- Attacks that only need a read use `eth_call`. They change nothing.
- The tampered evidence runs against a deposit that is already paid. The control (the honest evidence) then reverts with `AlreadyClaimed`. That is the last check before the transfer. So the evidence passed every other check, and a tampered variant that reverts with another reason was stopped earlier by that reason.
- The tamper variants of the log (amount, nonce, target chain, destination vault, destination token, recipient, token, emitter, topic) rebuild the receipts trie and the block header around the forged log. The header is then consistent with itself. Only the link to the beacon block can stop it.
- The fork registry is not deployed in the local network. The gates run in modes `Enforcing` (chain A) and `DetectBeaconRoots` (chain B). So I did not attack the registry.

## Results

### Withdrawal evidence (`10-withdrawal-evidence.sh`, `65-frontrun-claimed.sh`)

| Attack | Result | Evidence |
|---|---|---|
| Replay of a paid withdrawal, `eth_call` | BLOCKED | `AlreadyClaimed` |
| Replay of a paid withdrawal, real transaction | BLOCKED | Mined with status 0. Vault, recipient and attacker balances unchanged. |
| Chain A deposit evidence sent to vault A (same chain) | BLOCKED | `AnchorNotStored`. Light client A tracks chain B, so it stores no header of chain A. |
| Chain A deposit evidence sent to a sibling vault on chain B (same light client, same remote vault, same token pair) | BLOCKED | `WrongDestinationVault`. The deposit names vault B. |
| Chain B deposit evidence sent to vault B (its own source vault) | BLOCKED | `AnchorNotStored` |
| Fake emitter on chain A with a byte-identical event (same topic, same 160 data bytes), `eth_call` | BLOCKED | `WrongEmitter` (expected vault A) |
| Fake emitter, real transaction | BLOCKED | Status 0. Attacker balance unchanged. Nonce unclaimed. |
| Anchor header: slot, proposer, parent root, state root or body root changed (5 attacks) | BLOCKED | `AnchorNotStored` |
| Deposit header: slot plus one | BLOCKED | `DepositNotBeforeAnchor` |
| Deposit header: state root or body root flipped (2 attacks) | BLOCKED | `AncestryBranchInvalid` |
| Deposit header swapped with the anchor | BLOCKED | `AnchorNotStored` |
| Ancestry branch: first node flipped | BLOCKED | `AncestryBranchInvalid` |
| Ancestry branch: shorter, longer or empty (3 attacks) | BLOCKED | `BranchLengthMismatch` |
| Block hash branch: first node flipped | BLOCKED | `BlockHashBranchInvalid` |
| Block hash branch: shorter or empty (2 attacks) | BLOCKED | `BranchLengthMismatch` |
| Execution header: first byte, middle byte, truncated, empty (4 attacks) | BLOCKED | `BlockHashBranchInvalid` |
| Receipt proof: node flipped, node dropped, reversed, empty (5 attacks) | BLOCKED | Revert in the trie library (an empty string or error 0x66c94485) |
| Transaction index plus one, or the largest number (2 attacks) | BLOCKED | Revert in the trie library |
| Log index plus one, 9999, the largest number (3 attacks) | BLOCKED | `LogIndexOutOfRange` |
| Forged log: amount plus one, amount maximum, nonce, target chain, destination vault, destination token, recipient, token, emitter, topic (10 attacks, consistent forged receipts) | BLOCKED | `BlockHashBranchInvalid` for all ten |
| Withdraw before the light client covers the block (anchor of the next block, never stored) | BLOCKED | `AnchorNotStored` |
| Withdraw with the all-zero proof and with empty calldata | BLOCKED | `AnchorNotStored` and a revert with no data |
| Front-run, rounds 1 to 3: the attacker sends a prepared proof 100 gwei above the prover as soon as the anchor is stored | BLOCKED | The prover's transaction was mined first each time. The attacker's transaction reverted. The victim was paid once. The attacker gained nothing. |
| Front-run, the attacker wins: the prover is frozen after the light client update, the attacker withdraws, the prover resumes | BLOCKED | The victim got the 4 tokens once. The attacker balance did not change. The prover logged `proven to confirmed, reason "the vault reports the nonce as claimed"`. One payment event. No failure. |

The recipient sits inside the proven log, so whoever sends the withdrawal, the payout goes to the recipient that the depositor named. A front-runner pays the gas and gains nothing.

### Light client (`20-light-client.sh`)

All attacks are `eth_call` on light client B. The oracle key is public (see below), so the script can sign a valid statement. That makes it possible to test the contract checks one by one.

| Attack | Result | Evidence |
|---|---|---|
| Garbage proof: empty, 64 bytes, 65 random bytes, 65 zero bytes (4 attacks) | BLOCKED | `InvalidProof` |
| Signature by a key that is not the oracle | BLOCKED | `InvalidProof` |
| Valid signature for other public values | BLOCKED | `InvalidProof` |
| Public values of the wrong length, and empty | BLOCKED | `InvalidPublicValuesLength` |
| New head equal to the stored head | BLOCKED | `HeadNotAdvancing` |
| Head 1000 slots in the future, and 1 slot in the future | BLOCKED | `HeadInFuture` |
| Stale previous head slot | BLOCKED | `PreviousHeadSlotMismatch` |
| Wrong previous header root | BLOCKED | `PreviousHeaderRootMismatch` |
| Wrong previous committee | BLOCKED | `PreviousSyncCommitteeMismatch` |
| Wrong start-next committee | BLOCKED | `StartNextSyncCommitteeMismatch` |
| Update signed for the other chain (genesis root of light client A) | BLOCKED | `GenesisValidatorsRootMismatch` |
| Zero header root, zero execution block hash, zero committee (3 attacks) | BLOCKED | `EmptyHeaderRoot`, `EmptyExecutionBlockHash`, `EmptySyncCommitteeHash` |
| Other committee in the same period | BLOCKED | `SyncCommitteeMismatch` |
| Forged next committee | BLOCKED | `NextSyncCommitteeMismatch` |
| Replay of the earliest and of the latest real update (2 attacks) | BLOCKED | `PreviousHeadSlotMismatch` |
| Replay of a real update of light client A on light client B | BLOCKED | `GenesisValidatorsRootMismatch` |
| Forged committee one period ahead (next committee is stored) | BLOCKED | `SyncCommitteeMismatch` |
| Forged head with a valid oracle signature | SUCCEEDED (artefact) | `eth_call` success. See "Items that succeeded". |
| Forged committee two periods ahead with a valid oracle signature | SUCCEEDED (artefact) | `eth_call` success. See "Items that succeeded". |

### Gate (`30-gate.sh`)

The suite deploys a probe gate on chain A with the configuration of the real gate. Nobody confirms the probe gate, so it shows the refusals at any time.

| Attack | Result | Evidence |
|---|---|---|
| Deposit with no evidence in an unconfirmed epoch (probe gate) | BLOCKED | `ForkNotConfirmed` |
| Stale evidence of an older epoch | BLOCKED | `HeaderNotInCurrentEpoch` |
| Forged version `0x0000036d` (not supported) | BLOCKED | `UnsupportedVersion` |
| Forged version `0x0000036b` (the version before Capella) | BLOCKED | `UnsupportedVersion` |
| Branch node flipped, supported version | BLOCKED | `ForkProofInvalid` |
| Header slot forged | BLOCKED | `HeaderRootMismatch` |
| Timestamp with no beacon root | BLOCKED | `BeaconRootUnavailable` |
| Garbage evidence | BLOCKED | Revert with no data |
| `seal` with genuine evidence of a supported version, and with an old header | BLOCKED | `VersionIsSupported` |
| `seal` with a forged unsupported version, new header | BLOCKED | `ForkProofInvalid` |
| `seal` with a forged unsupported version, old header (real gate and probe gate) | BLOCKED | `SealEvidenceTooOld` |
| `seal` with empty evidence | BLOCKED | Revert with no data |
| `seal` and `confirm` on the chain B gate | BLOCKED | `BeaconRootsAbsent` |

Control: genuine evidence of the current epoch confirms the probe gate. The evidence is public, and anyone may confirm a gate, so this is by design.

Not tested: a real seal. A seal needs a beacon root in the ring buffer of the beacon roots contract for a header with an unsupported version. Only the chain writes that buffer, and I did not forge it.

The chain B gate admits every deposit while the beacon roots contract is absent (mode `DetectBeaconRoots`). That is the design for PulseChain.

### Deposits and open functions (`40-deposits.sh`)

| Attack | Result | Evidence |
|---|---|---|
| Unpaired token | BLOCKED | `UnsupportedToken` |
| Fee-on-transfer token (the mock exists, but no vault registers it) | BLOCKED | `UnsupportedToken` |
| Zero amount | BLOCKED | `ZeroAmount` |
| Zero recipient | BLOCKED | `ZeroRecipient` |
| Amount above the balance | BLOCKED | `ERC20InsufficientBalance` |
| No allowance | BLOCKED | `ERC20InsufficientAllowance` |
| `setFee`, `nullifyFee` by the attacker | BLOCKED | `NotFeeAuthority` |
| `collectFees` with nothing accrued | BLOCKED | `NoFeesAccrued` |
| `detachFlowLimiter` by the attacker | BLOCKED | `NotFlowLimiter` |
| Bogus `block_roots` layout rows (gindex 1, 2, 36, 100, 2^32, and 37) | BLOCKED | `LayoutPositionInvalid`, `LayoutOutOfBounds`, `AnchorNotStored` |
| Bogus block hash layout row and historical layout row | BLOCKED | `LayoutPositionInvalid`, `LayoutOutOfBounds` |
| Maximum fee below the fee | Not testable | The fee is zero and the fee authority is the zero address. Nobody can set a fee. |
| Recipient is the token, the source vault or the destination vault | SUCCEEDED (accepted input) | The deposit is accepted. A user who does this sends tokens to a contract. This is a user error. The vault cannot know the recipient contract on the other chain. |
| Maximum fee 0 with fee 0 | SUCCEEDED (control) | The honest path works. |

### Griefing, crash safety, reorg

| Attack | Result | Evidence |
|---|---|---|
| Burst of 25 deposits of 1 wei (`50-griefing.sh`) | BLOCKED for loss, but it delays | Every deposit was paid. Honest deposits made right after the burst took 104 seconds on average (worst 122 seconds). Before the burst the average was 18 seconds. |
| Prover killed after the light client update (`60-crash-safety.sh`) | BLOCKED | After the restart: one payment event. |
| Prover killed after the proof | BLOCKED | One payment event. The withdrawal was already mined. |
| Prover killed after the withdrawal was sent | BLOCKED | One payment event. |
| Prover killed and its database deleted | BLOCKED | One payment event. The prover scanned again, found the nonces claimed and set them to `confirmed`. No nonce has two payment events (checked over the whole history). |
| Revert of chain A before finality (`70-reorg.sh`, round 1) | BLOCKED | The deposit vanished before the prover saw it. Nothing was paid. |
| Revert of chain A after the payment on chain B (round 2) | SUCCEEDED (artefact) | See "Items that succeeded". |
| Deposit after that revert (round 3) | SUCCEEDED (artefact) | The nonce repeats. See "Items that succeeded". |

## Items that succeeded

**1. A forged light client head with a valid oracle signature** (`lc_oracle_signed_forged_head_artefact`, `lc_oracle_signed_forged_committee_two_periods_ahead_artefact`). Artefact of the local setup. The oracle verifier accepts a signature by Anvil account 1. That key is public: it is in `docker/compose.yaml`. Anyone can sign any statement, so anyone can move the head to a forged header. With a forged head an attacker can then build a matching beacon chain and withdraw a deposit that never happened. The oracle stands in for a proof system where no proof of a false statement exists. The real verifier has no such key. The contract checks around the proof are the part that this test measures, and all of them held (see the light client table). Two periods ahead, the contract writes the committee of the output, so only the proof system stops a forged committee there. That is by design (rule 4 of the build contract). I only ran `eth_call`, so the light client was not changed.

**2. Revert of chain A after payment** (`reorg_after_payment_double_spend_artefact`). Artefact of the development beacon source. The source treats a block as final once the chain head is 2 blocks above it (`finality_depth = 2`). It re-reads no block that it used. I reverted chain A with `evm_revert` after chain B paid the deposit. The deposit vanished from chain A: the attacker kept the tokens. Chain B kept the payout of 2 tokens. The result is a double spend of 2 tokens. On a real beacon chain, the light client stores only finalized headers. Finality needs two thirds of the stake, so a block that the light client stored does not revert. So this is not a hole of the contracts. It does show what happens if finality fails: the vault has no way to undo a payment, and it has no refund by decision (H-09).

**3. Nonce repeat after the revert** (round 3 of the same script). Artefact of the same revert. The nonce is `keccak256(chain id, vault, depositCount)`. The revert reset `depositCount`, so the next deposit got the nonce that chain B had already claimed. Chain B never paid the new deposit. The prover set it to `confirmed`, because the vault reports the nonce as claimed. So that deposit (1 token) is locked in vault A for good. This needs a revert of a final block, so it is an artefact. It is also a reason to keep the finality rule strict.

**4. The deposit inputs that were accepted** (recipient is a contract, maximum fee 0 with fee 0). Not holes. See the deposit table.

## Observations that are not attacks

- **The prover works one deposit at a time.** `Service::run_once` walks route `a_to_b` first and then `b_to_a`. Each deposit takes about 14 seconds from first sight to payment (the chains mine a block every 2 seconds, and each step waits for a block). The bots deposit about once every 8 seconds, and the attacker added more. The queue grew during the run, and a burst delays honest deposits in both directions (griefing result above). Nothing is lost, but the delay is proportional to the number of queued deposits. An attacker pays about the same gas as the prover per 1-wei deposit, so the cost is not lopsided. The prover account spent 0.0128 test ether on chain B during the burst window, including the traffic of the bots.
- **A deposit can end in the terminal state `failed`.** After my chain A reverts, one honest bot deposit on chain B (0.95 tokens, block 1760) went to `failed` after 5 attempts. The reason was `the light client head 8067 is past block 1760 but holds no anchor for it; the dev chain skipped this block`. The cause was that my revert of chain A removed a light client update transaction while the prover waited for it. This is specific to the development source, which builds one anchor per deposit block. A real beacon source does not skip blocks. I left the deposit as it is. The prover has no command to retry a `failed` deposit. On a real chain a retry command would be a useful safety net.
- **The deposit gate wants evidence for the first deposit of every epoch (every 384 seconds).** While the bots are paused, an attacker deposit fails with `ForkNotConfirmed` in a new epoch until someone supplies evidence. The scripts let the bots run for that moment. This is the design.
- **A fresh vault needs layout rows before it accepts any withdrawal.** Anyone may add them. The vault checks them against the stored headers. My attempts to add bogus rows failed. The prover adds rows just before its first withdrawal.
- **Chain B restarted once by itself** (about one hour after the start, exit code 0, restart count 1) and lost its state, as `docs/local-network.md` warns. I do not know why Anvil stopped. I rebuilt the stack with `down -v` and ran the scripts again. The results above are from the second stack.

## Books

Checked with `90-books.sh`. The scripts count the events of each vault. The initial liquidity is 1,000,000 tokens for each vault.

**After all attacks except the reorg** (bots paused, prover queue empty):

| Vault | Deposits into the vault | Withdrawals paid | Expected balance | Actual balance |
|---|---|---|---|---|
| Vault A | 131.01 | 30.04 | 1,000,100.97 | 1,000,100.97 (match) |
| Vault B | 30.04 | 131.01 | 999,899.03 | 999,899.03 (match) |

Every deposit on both chains was paid exactly once: 104 deposits on chain A and 60 on chain B, none unpaid, none paid twice. The numbers mix the bots and the attacker (the 1-wei burst deposits and the crash test deposits count).

**After the reorg round:**

| Vault | Deposits into the vault | Withdrawals paid | Expected balance | Actual balance |
|---|---|---|---|---|
| Vault A | 134.58 | 30.04 | 1,000,104.54 | 1,000,104.54 (match) |
| Vault B | 30.99 | 135.58 | 999,895.41 | 999,895.41 (match) |

Each vault still matches its own events. Across the two chains the books no longer close, as expected from the reverts: vault B paid 135.58 tokens against 134.58 tokens of deposits on chain A. The difference of 1 token is the 2-token deposit that vanished (paid on chain B) less the 1-token deposit that was never paid because its nonce repeated. No nonce has two payment events. One honest deposit (0.95 tokens, on chain B) is unpaid because it is `failed` (see above).

## Gotchas for the next run

- The Anvil nonces of the vault deposits are deterministic. After `down -v` and a new deploy, the same nonces repeat on the new chains.
- The prover and the bots log in plain lines, so `docker compose logs` is the fastest way to follow a deposit.
- `cargo clippy --offline --all-targets --all-features -- -D warnings` fails in `prover/` on this machine. The only finding is in `src/route_health.rs` line 427 (`unnecessary_sort_by`, new in clippy 0.1.99). I did not change that file. `attacks/local/src/main.rs` has no finding. `cargo test --offline --bin attack-evidence` passes (3 tests).
