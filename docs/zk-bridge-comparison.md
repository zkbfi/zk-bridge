# Comparison with other zero-knowledge light-client bridges

Date: 2026-10-21. This document compares the hardened bridge with other zero-knowledge light-client bridges and with public bridge exploits. It ends with a gap list: each defense that another project has and we lack or do differently, with a judgement.

Read `docs/hardened-build-contract.md` and `docs/red-team-revision-2.md` first. They define our design. In short:

- An Altair sync committee light client, proved with SP1 (Succinct's zero-knowledge virtual machine) and wrapped in a Groth16 proof.
- `update()` is open to anyone. One proof folds 1 to 64 updates.
- The vault checks each deposit directly. The Merkle path runs from a stored finalized header through `block_roots` or `historical_summaries` down to the receipt log.
- A fork registry and execution canaries protect against source-chain forks.
- No admin, no upgrade path, no pause, no timelock. An optional deposit fee with an immutable 1% ceiling is specified, but `src/hardened/BridgeVault.sol` does not implement it yet.

Each claim below cites a URL or a file and line in this repository. "Not confirmed" means I could not find a primary source.

## Measured on 2026-10-21: PulseChain committee concentration

I read these values from the public PulseChain beacon API (`https://rpc-pulsechain.g4mm4.io/beacon-api`) at head slot 10881537. They matter more than any other fact in this document.

| Fact | Value | Endpoint |
|---|---|---|
| Active validators | 47,244 | `/eth/v1/beacon/states/finalized/committees` (sum of all committee members in one epoch) |
| Stake per validator (`MAX_EFFECTIVE_BALANCE`) | 32,000,000 PLS | `/eth/v1/config/spec` |
| Distinct withdrawal credentials among active validators | 544 | `/eth/v1/beacon/states/head/validators?status=active_ongoing` |
| Credentials that hold one third / one half / two thirds of all active validators | 5 / 11 / 19 | same |
| Distinct withdrawal credentials in the current sync committee (512 seats) | 100 | `/eth/v1/beacon/states/head/sync_committees`, then the validators by index |
| Credentials needed for 342 seats (our threshold) | 18 | same |
| Credentials needed for 171 seats (enough to stop finality updates) | 5 | same |
| Credentials needed for 384 / 410 / 435 / 461 seats | 24 / 29 / 39 / 52 | same |
| Largest single credential in the committee | 62 seats | same |
| Sync committee participation in 10 sampled blocks | 495 to 500 of 512 | `/eth/v2/beacon/blocks/{slot}` |

A withdrawal credential is not proof of one operator. One staking service can use many credentials, and one credential can belong to a pool. So 18 is an estimate of the collusion size, not a measured fact. Treat it as an upper bound on independence: the true number of independent parties is probably smaller, not larger.

Sync committee signatures are not slashable on Ethereum or PulseChain. Ethereum Improvement Proposal 7657 proposes slashing for them, and its status is "Stagnant" ([EIP-7657](https://eips.ethereum.org/EIPS/eip-7657)). So a committee that signs a forged header loses nothing on chain. The only cost is the bribe and the reputation of the signers.

**What this means for us.** A forged PulseChain header needs about 18 colluding withdrawal-credential holders for one period of about 22.8 hours. With it they can forge a deposit and drain the Ethereum vault in one transaction. Today nothing on chain slows that down. The same 19 holders also control Casper finality on PulseChain, so proving the full validator set instead of the sync committee (the Polyhedra approach, below) would not raise the bar much on PulseChain. It would raise the bar on Ethereum.

## Projects

### Succinct SP1 Helios (Ethereum light client in SP1)

Our light client follows its contract shape. Sources: the contract ([SP1Helios.sol](https://raw.githubusercontent.com/succinctlabs/sp1-helios/main/contracts/src/SP1Helios.sol)), the program ([light_client.rs](https://github.com/succinctlabs/sp1-helios/blob/main/program/src/light_client.rs)), and the a16z Helios consensus code it calls ([consensus_core.rs](https://github.com/a16z/helios/blob/master/ethereum/consensus-core/src/consensus_core.rs)).

- **Trust model:** the sync committee's honest two-thirds majority, the SP1 proof system, and a guardian.
- **Finality:** the program applies a finality update and asserts that the finalized slot grew. It also asserts that the new head is a multiple of 32.
- **Participation:** `verify_generic_update` refuses only zero signers. `apply_generic_update` applies an update only when `committee_bits * 3 >= 512 * 2`. Because the program asserts that the head moved, an update below two thirds fails. So the effective threshold is two thirds, the same as ours.
- **Committee rotation and skipping:** an update's signature period must equal the store period, or the next period when the next committee is known. The program loops over a list of updates, so one proof can cross many periods.
- **Next committee binding:** the program sets `store.next_sync_committee = None` before it applies any update. Its comment explains that a prover-chosen next committee would allow "outright beacon-header / execution-state-root forgery in a single proof". This is the same hole as our HB-01.
- **Genesis validators root and fork:** `genesis_root` and `forks` are private program inputs. The contract stores `GENESIS_VALIDATORS_ROOT` but does not check it in contract logic. The output does not carry it.
- **Slot monotonicity:** `newHead > head` in `_applyUpdate`, and the proof's previous head and header must match stored state.
- **Staleness:** none in Succinct's contract. A fork by Risk Labs (Across) adds `MAX_SLOT_AGE = 1 week` and an immutable updater role ([OpenZeppelin audit](https://www.openzeppelin.com/news/sp1-helios-audit)).
- **Admin powers:** a guardian can replace the three program verification keys. It can hand the role over or give it up for good ([Zellic report section](https://reports.zellic.io/publications/sp1-helios/sections/loss-of-the-guardian-role-after-calling-the-relinquishguardian-function-relinquishguardian)). The verifier address is fixed at construction.
- **Known bugs:**
  - OpenZeppelin, client-reported finding 17: the program did not bind `fromHead` to the previous head, so an update at the stored slot could leave the execution payload stale. Fixed ([OpenZeppelin audit](https://www.openzeppelin.com/news/sp1-helios-audit)).
  - OpenZeppelin, low finding 1: the Risk Labs fork can become permanently unupdatable after a week without updates. Acknowledged, not fixed.
  - Zellic reported one critical and one medium finding (assessment of 18 to 29 July 2025). The Zellic site returned HTTP 403 to my fetches, so I cannot confirm their content. The next-committee comment in the program suggests the critical one was the next-committee hole, but that is my inference.

### RISC Zero Helios (same design, other virtual machine)

Source: [zkSecurity audit, 2 April 2025](https://reports.zksecurity.xyz/reports/risc0-helios.md).

- Medium: "Lack of Assurance on Verified Chain Identity". The genesis root and fork list were private inputs, never exposed, so the contract could not tell which chain a proof covered.
- Medium: "Next Sync Committee Might Be Arbitrarily Set". The prover chose the initial store, including its next committee.
- Low: "Contract Lacks Recovery Mechanism". `MAX_SLOT_AGE = 1 weeks` can strand the contract.
- Informational: updates did not have to start from the latest head, and the constructor did not check that the checkpoint fields belong together.

### Succinct Telepathy (Ethereum sync committee light client, circuits in Circom)

Sources: [LightClient.sol](https://github.com/succinctlabs/telepathy-contracts/blob/main/src/lightclient/LightClient.sol), [TargetAMB.sol](https://github.com/succinctlabs/telepathy-contracts/blob/main/src/amb/TargetAMB.sol), [TelepathyAccess.sol](https://github.com/succinctlabs/telepathy-contracts/blob/main/src/amb/TelepathyAccess.sol), [TelepathyRouter.sol](https://github.com/succinctlabs/telepathy-contracts/blob/main/src/amb/TelepathyRouter.sol).

- **Trust model:** the sync committee, the Groth16 circuits, a guardian, and a timelock.
- **Participation:** `MIN_SYNC_COMMITTEE_PARTICIPANTS = 10` to process a step at all. A header is stored only when `participation > FINALITY_THRESHOLD`, an immutable constructor value. I could not confirm the deployed threshold.
- **Finality:** `step` stores only the finalized slot, root and execution state root.
- **Future slots:** `step` reverts when the attested slot is after the current slot computed from `block.timestamp`, `GENESIS_TIME` and `SECONDS_PER_SLOT`.
- **Rotation:** `rotate` stores the next period's committee commitment from a finalized step. It never overwrites a stored value.
- **Equivocation tripwire:** `setSlotRoots` and `setSyncCommitteePoseidon` set `consistent = false` when a proof gives a different root for a stored slot or period. The router then refuses every message ("Light client is inconsistent.").
- **Delay:** the router refuses to use a header until `MIN_LIGHT_CLIENT_DELAY = 2 minutes` after it was stored. This gives the guardian time to freeze.
- **Admin powers:** a guardian can freeze any source chain and turn sending off. A timelock can upgrade the router (a Universal Upgradeable Proxy Standard proxy) and set light clients.
- **Message binding:** a message carries a version, a nonce, a source and a destination chain. The router refuses a wrong `destinationChainId` or version, and a message already executed.
- **Known bugs:** Veridise's audit for Succinct found that the `circom-pairing` library's `CoreVerifyPubkeyG1` was missing range checks, which "could allow attackers to forge signatures". It was fixed upstream before launch ([Veridise write-up](https://hackmd.io/@Veridise/blog-circom-pairing), [0xPARC bug tracker](https://github.com/0xPARC/zk-bug-tracker)).

### Succinct Tendermint X and Blobstream X

- Informal Systems found no check of the Tendermint trusting period, and no logic to freeze the client after a light-client attack ([Informal Systems audit](https://docs.celestia.org/audits/Blobstream_X-Informal_Systems_Audit.pdf)).
- Zellic found a critical issue: the skip circuit's output did not need to relate to its trusted height and header inputs. Fixed ([Zellic finding](https://reports.zellic.io/publications/blobstream-x/findings/critical-combinedskipcircuit-tendermint-x-tendermintskipcircuit-skip-functions-return-value-need-not-be-related-to-parameters)).
- Veridise reported a finding titled as a trusted validator forging headers during skip verification ([Veridise audit](https://docs.celestia.org/audits/Blobstream_X-Veridise_Audit.pdf)). I have only the title.
- I did not research Vector X further. It follows the same pattern for Avail and has no part in an Ethereum or PulseChain route.

### SP1 itself (our proof system)

- **January 2025:** three soundness bugs, two in SP1 version 3 and one in its Plonky3 dependency. One let partial-execution proofs pass as complete in the recursive verifier. Succinct "froze the routers to the SP1 verifier contracts deployed on mainnets" and told users to move to SP1 Turbo, version 4 ([SP1 security update](https://blog.succinct.xyz/sp1-security-update-1-27-25/), [GHSA-c873-wfhp-wx5m](https://osv.dev/vulnerability/GHSA-c873-wfhp-wx5m)).
- **April 2026:** CVE-2026-40323, a soundness bug in the version 6 recursive shard verifier, versions 6.0.0 to 6.0.2, fixed in 6.1.0. Version 5 is listed as not affected. The record does not say whether on-chain Groth16 verification is affected ([vuln.today record](https://vuln.today/cve/CVE-2026-40323)).
- **Gateway freezes:** the gateway owner can `freezeRoute()` for a verifier version with a known issue ([Succinct contract addresses](https://docs.succinct.xyz/docs/sp1/verification/contract-addresses)). Deploying a verifier is permissionless.
- **Proof format:** an SP1 Groth16 proof starts with a 4-byte prefix that must match the verifier's key hash ([Celestia Improvement Proposal 46](https://cips.celestia.org/cip-046.html)).
- **Second factor:** Succinct also offers separate gateways for proofs that need both a trusted execution environment attestation and a Groth16 proof ("SP1-2FA") ([Succinct contract addresses](https://docs.succinct.xyz/docs/sp1/verification/contract-addresses)). I did not check its trust model.

### Polyhedra zkBridge

- **Design:** the paper's version has a relay network, the deVirgo distributed prover, a recursive Groth16 wrap, and an updater contract that stores batches of headers ([zkBridge paper](https://arxiv.org/pdf/2210.00264)). The paper claims safety when the chains are secure and at least one relay node is honest.
- **Ethereum source:** Polyhedra calls the sync committee "insufficient", because 512 times 32 ETH is small next to bridge volume. It says it proves the full proof-of-stake consensus instead, more than 20,000 signatures per block ([The Block, sponsored](https://www.theblock.co/sponsored/2023-07-24-proving-full-node-of-ethereum-in-zk-241003)). This is a vendor claim. The article does not say how it checks finality or a two-thirds stake rule.
- **Admin powers:** Zellic found, in two reports, that the owner of `ZkBridgeOracle` can replace the block updater for any source chain and so bypass the bridge's security. Polyhedra said it planned to make the contract non-adjustable later ([Zellic, LayerZero light client](https://reports.zellic.io/publications/polyhedra-zk-light-client-on-layerzero/findings/informational-zkbridgeoracle-centralization-risk-in-setblockupdater), [Zellic, DVN](https://reports.zellic.io/publications/polyhedra-dvn/findings/informational-zkbridgeoraclev2-centralization-risk-in-setblockupdater)). I could not confirm whether that happened.
- **Restaking:** Polyhedra announced use of Lagrange State Committees for extra restaked security ([Lagrange announcement](https://www.lagrange.dev/blog/announcing-polyhedra-networks-lagrange-labs-partnership-zkbridge-fast-finality-for-rollups-with-lagrange-state-committees)).
- **Incidents:** I found no public exploit of zkBridge.

### Wormhole and zero-knowledge light clients

- In February 2024 the Wormhole Foundation announced work with Succinct on an Ethereum zero-knowledge light client, "to secure all messages from Ethereum to other EVM [Ethereum Virtual Machine] chains" ([The Block](https://www.theblock.co/post/278338/wormhole-amd-fpga-scaling)). I could not confirm that it reached mainnet, or how it combines with guardian signatures.
- Wormhole's production trust is 13 of 19 guardians. It adds a Governor, a 24-hour cap on each chain's outflow in US dollars, with net-flow cancelling. It also adds a Global Accountant that refuses transfers that would move more tokens off a chain than were minted there ([Governor](https://wormhole.com/blog/understanding-the-flow-canceling-governor-in-wormhole), [Global Accountant](https://wormhole.com/docs/learn/messaging/native-token-transfers/security)).
- **February 2022 exploit, about 320 million dollars:** the Solana program used a deprecated instruction-loading function that did not check that the account was the real instructions system variable. The attacker passed a fake one and minted 120,000 wrapped ETH ([Kudelski](https://kudelskisecurity.com/research/quick-analysis-of-the-wormhole-attack), [CertiK](https://www.certik.com/blog/wormhole-bridge-exploit-incident-analysis)). The fix was public in the repository hours before deployment ([Ackee](https://ackee.xyz/blog/2022-solana-hacks-explained-wormhole/)).

### Others, briefly

- **Electron Labs:** Circom proofs of batched Ed25519 signatures for a Tendermint light client on Ethereum, and proofs of NEAR headers for the Rainbow Bridge. Research and prototypes from 2022. Current status not confirmed ([ethresear.ch post](https://ethresear.ch/t/bringing-ibc-to-ethereum-using-zk-snarks/13634)).
- **Herodotus and Axiom:** same-chain historical proofs. They anchor to the `BLOCKHASH` opcode of the Ethereum Virtual Machine and extend back with an accumulator of proven header chains ([Herodotus accumulator](https://docs.herodotus.dev/herodotus-docs/historical-block-hash-accumulator), [Axiom caching](https://docs.axiom.xyz/protocol-design/caching-block-hashes)). No cross-chain consensus is involved.
- **Lagrange State Committees:** restaked operators attest to optimistic rollup state. Their documents put the sync committee's economic security at about 26 million dollars and offer restaking as a larger bound ([Lagrange documents](https://docs.lagrange.dev/state-committees/overview)).
- **zkLink Nova:** L2BEAT reports a 5 of 8 multisignature that can upgrade the main contract and "fast" relay messages that could mint tokens ([L2BEAT](https://l2beat.com/scaling/projects/zklinknova)). Not a light-client trust model.
- **Nil Foundation:** verification of Mina state inside the Ethereum Virtual Machine, tested on Ropsten in 2022 ([Mina ecosystem update](https://minaprotocol.com/blog/ecosystem-updates-march-2022)). Current status not confirmed.
- **Hyperlane:** Celestia Improvement Proposal 46 (CIP-46) specifies a zero-knowledge interchain security module that checks SP1 Groth16 proofs and consumes each message identifier once ([CIP-46](https://cips.celestia.org/cip-046.html)).
- **NEAR Rainbow Bridge:** an optimistic light client with watchdogs and a challenge period. Watchdogs stopped fabricated NEAR blocks in May and August 2022. In May, a bot that front-ran the challenge took the bond ([Infura blog](https://www.infura.io/blog/post/rainbow-bridge-fraud-proofs-and-the-dark-forest), [DappRadar](https://dappradar.com/blog/failed-near-rainbow-bridge-exploit-cost-hacker-7000)).
- **Snowbridge (Polkadot and Ethereum):** uses the sync committee and launched without an extra committee, relying on Polkadot governance to respond. Its analysis lists equivocation, withholding, and both together as attacks, and estimates the unslashed stake of two thirds of the committee at about 10,923 ETH ([Snowfork analysis](https://forum.polkadot.network/t/snowforks-analysis-of-sync-committee-security/2712)).
- **Research:** "Unconditionally Safe Light Client" proposes staked data providers, watchers and a challenge period, because "a dishonest supermajority within the sync committee could mislead light clients to accept invalid data without facing any penalties" ([arXiv 2405.01459](https://arxiv.org/html/2405.01459v1)).

### Exploit post-mortems

| Exploit | Root cause | Lesson for us |
|---|---|---|
| Nomad, August 2022, about 190 million dollars | An upgrade initialized the trusted root to zero. An unproven message also has root zero, so every message passed ([CertiK](https://www.certik.com/blog/nomad-bridge-exploit-incident-analysis), [Coinbase](https://www.coinbase.com/blog/nomad-bridge-incident-analysis)) | Never let a zero value stand for "trusted" |
| BNB Bridge, October 2022, about 2 million BNB | The IAVL Merkle proof verifier accepted a forged, short proof ([Immunefi](https://immunefi.com/blog/bug-fix-reviews/hack-analysis-binance-bridge-october-2022/), [Zellic](https://www.zellic.io/blog/binance-bridge-hack-in-laymans-terms)) | Fix the proof shape: exact length and a position the verifier computes |
| Ronin, March 2022, more than 600 million dollars | 5 of 9 validator keys, one through a delegation that was never revoked ([LimeChain](https://limechain.tech/blog/biggest-blockchain-bridge-hacks/)) | Committees of known operators fail together |
| Harmony Horizon, June 2022, about 100 million dollars | 2 of 5 multisignature keys stolen ([Halborn](https://www.halborn.com/blog/post/explained-the-harmony-horizon-bridge-hack)) | Same |
| Wormhole, February 2022 | Signature check bypassed with a fake system account (above) | Bind the verifier to an exact contract |
| FoomCash and Veil Cash, February 2026, about 2.26 million dollars | The Groth16 verifier had gamma equal to delta. The trusted setup's second phase never ran, so anyone could forge proofs from public inputs ([rekt.news](https://rekt.news/the-unfinished-proof)) | Check the verifying key constants of the verifier we deploy, not only its source |

## What we already do, with the file and line

| Defense | Where other projects stand | Our code |
|---|---|---|
| Only finalized headers enter the light client | SP1 Helios, Telepathy: same | Finality branch in `light-client/crates/lc-core/src/update.rs` lines 212 to 218. The contract stores only the proven finalized header (`src/hardened/BeaconLightClient.sol` lines 145 to 149) |
| Two-thirds participation | Helios applies at two thirds; Telepathy uses a constructor threshold | `MIN_PARTICIPANTS` = 342 in `light-client/crates/lc-core/src/chain.rs` line 21, checked at `update.rs` line 165 |
| Signature slot after attested slot, attested at or after finalized | Helios `valid_time` | `update.rs` lines 170 to 175 |
| Period from the slot, at most one period per step, a next-period signature needs a crossing | Helios `valid_period` | `update.rs` lines 192 to 206; fold of up to 64 steps (`MAX_FOLD_UPDATES`, line 41) |
| Next committee bound to a public value | SP1 Helios resets it to none; RISC Zero Helios had the hole | `startNextSyncCommitteeHash` check, `BeaconLightClient.sol` lines 197 to 200; HB-01 |
| Chain identity in the output | Missing in RISC Zero Helios (zkSecurity medium) and not checked in SP1 Helios | Genesis validators root in the output, checked at `BeaconLightClient.sol` line 183. The signing domain also uses it |
| The update starts from the stored head | OpenZeppelin finding 17 in SP1 Helios | `BeaconLightClient.sol` lines 187 to 191 |
| Head only moves forward | All | `BeaconLightClient.sol` line 208 |
| No zero value counts as stored | Nomad | `BridgeVault.sol` line 568 refuses a zero stored root; `BeaconLightClient.sol` lines 209, 210 and 226 refuse zero roots and committees |
| Merkle proof shape fixed | BNB Bridge | `SSZ.sol` line 59 refuses any branch whose length differs from the depth of the computed position. The vault computes every position itself (`BridgeVault.sol` lines 590 to 633) and accepts only fixed field positions (HB-03, HB-04) |
| Verification key pinned and immutable | SP1 Helios guardian can change it; Polyhedra owner can change the updater | `programVKey` immutable (`BeaconLightClient.sol` line 76). The fork registry refuses the light-client key (`ForkRegistry.sol` line 87) |
| A specific verifier, not the ownable gateway | Most integrators use the gateway | `BeaconLightClient.sol` lines 71 to 74 |
| Proof malleability cannot replay | Groth16 proofs are malleable ([ethresear.ch](https://ethresear.ch/t/transaction-malleability-attack-of-groth16-proof/15881)) | No contract keys anything on proof bytes. Light-client replay fails on `previousHeadSlot == head` and `newHeadSlot > head` (lines 187 and 208). Withdrawal replay fails on `claimed[nonce]` (`BridgeVault.sol` lines 406 to 408) |
| Fake deposit: other emitter, other event, failed transaction | All message bridges check the emitter | Emitter, topic and status at `BridgeVault.sol` lines 700, 705 and 685 |
| Cross-chain and cross-vault withdrawal replay | Telepathy checks destination chain and version | Nonce binds the source chain, source vault and counter (`BridgeVault.sol` line 380). Withdrawal requires target chain and destination vault (lines 402 and 403) |
| Reorganization | All use finality | Finalized anchors only (`BridgeVault.sol` line 561) |
| Committee size and genesis root per chain | Helios per network | `ChainSpec` per chain in `chain.rs` |

## Gap list

Severity is for our bridge, holding the PulseChain measurements above in mind. "Adopt" means I recommend the change. "Consider" means the trade-off is real and the decision is yours.

### G-01. No limit, delay or halt on a forged header. Severity: high. Judgement: adopt a rate limit; consider a delay with an equivocation halt.

**They have:** Wormhole's Governor caps each chain's outflow per 24 hours. Telepathy waits 2 minutes before it uses a header, and turns itself off for good when two proofs disagree about a slot or a period (`consistent = false`). Snowfork lists halting on a conflicting header as the defense against equivocation.

**We have:** none of these. A forged finalized header and a forged withdrawal can land in one transaction. On PulseChain about 18 withdrawal-credential holders can sign that header, with no slashing.

**Recommendation:**
- **Adopt: an immutable outflow cap per token per window in each vault.** A withdrawal over the cap waits in a queue and pays out later. It is not refused, so no deposit is stranded. This needs no admin: the cap and the window are constructor values. It bounds a committee forgery to one window's cap, instead of the whole vault.
- **Consider: a withdrawal delay plus a permissionless equivocation halt.**
  - The vault pays only from anchors stored at least N minutes ago.
  - Anyone can submit a valid light-client proof that starts from any stored header, not only the head. If it proves a different header root for a stored slot, or a different committee for a stored period, the light client marks itself inconsistent.
  - An inconsistent light client stores no more heads, and the vault pays only from anchors stored before the conflict.
  - Trade-off: with no admin, the halt is permanent for that route. Deposits not yet anchored stay locked. That is a loss, but a smaller one than a drain.
  - It only stops equivocation. It does not stop withholding plus fraud, where the committee never signs the honest header.

### G-02. No answer to a soundness bug in the pinned SP1 version. Severity: high. Judgement: consider a second proof system; adopt a version policy.

**They have:** Succinct froze the gateway routes for SP1 version 3 and earlier in January 2025, and SP1 version 6.0.0 to 6.0.2 had another soundness bug in April 2026. Gateway users were protected by the freeze. Succinct also offers a trusted execution environment as a second factor.

**We have:** an immutable, specific verifier (`BeaconLightClient.sol` line 74) and no admin. If our pinned version turns out unsound, anyone can forge a light-client update forever, and nobody can stop it. G-01's cap bounds the loss per window, but does not end it.

**Recommendation:**
- **Adopt: a version policy.** Pin a verifier version with no open advisory, record the version, the release tag and the advisory search in the deploy configuration, and re-check before every deployment.
- **Consider: two independent proof systems.** `update()` requires one SP1 proof and one proof from a second virtual machine (for example RISC Zero) over the same public values. A soundness bug in one is then not enough. This doubles proving cost and on-chain verification gas.
- **Consider: a permissionless soundness halt.** If anyone can submit two valid proofs that contradict each other, the system can halt itself. Today the light client refuses any proof for a stored slot, so no contradiction can be shown on chain. G-01's equivocation halt covers this case as well.

### G-03. The deploy script does not check the verifier's code or key. Severity: medium-high. Judgement: adopt.

**They have:** nothing public, but FoomCash and Veil Cash lost about 2.26 million dollars to a Groth16 verifier whose gamma equalled delta.

**We have:** `script/hardened/DeployBridge.s.sol` line 323 refuses a verifier with no code. It does not check which code. PulseChain has no SP1 verifier today, so we deploy our own from Succinct's sources (`docs/hardened-build-contract.md`, "Facts measured").

**Recommendation:** in the deploy script, require the verifier's code hash to equal the hash of the audited release build, and require its `VERIFIER_HASH()` to equal the value for that release. Add a test that a real proof from the pinned SP1 version passes and a proof with one flipped bit fails. Publish the program build command with a pinned toolchain, so anyone can rebuild `programVKey` from the source and compare.

### G-04. No check against future slots. Severity: medium. Judgement: adopt.

**They have:** Telepathy reverts when the attested slot is after the slot that `block.timestamp` implies. Helios checks `expected_current_slot >= signature_slot`.

**We have:** no wall-clock check in `BeaconLightClient.update`. A forged head far in the future would also block every honest update, because the head only moves forward (line 208). That bricks the route, and it writes a forged committee for that far period.

**Recommendation:** add immutable `genesisTime` and `secondsPerSlot` to the light client, and require `newHeadSlot <= (block.timestamp - genesisTime) / secondsPerSlot`. Cost: two immutables and a few hundred gas. It does not stop a forgery at a current slot, so it is a cheap bound, not a fix.

### G-05. No staleness limit on the starting head. Severity: medium. Judgement: consider.

**They have:** the Risk Labs fork of SP1 Helios and RISC Zero Helios refuse an update whose starting head is more than one week old. Both audits then flagged that the contract can get stuck. Informal Systems flagged that Tendermint X does not check the trusting period.

**We have:** a fold from any old store, as long as it starts at the stored head. After months of no updates, the old committee members may have exited and withdrawn. Their keys then carry no stake at all, so a bribe is cheaper.

**Recommendation:** keep the funded operator, and add a monitor that alerts when the head is older than one period. A hard on-chain limit would strand deposits when it fires, because there is no admin to restart from a new checkpoint. So I do not recommend a hard limit unless G-01's rate limit is also in place.

### G-06. Participation threshold. Severity: low-medium. Judgement: consider for PulseChain only.

**They have:** two thirds (Helios) or a constructor threshold (Telepathy). Nobody I found requires more.

**We have:** 342 of 512, as the protocol does.

**Measured trade-off on PulseChain:** participation is 495 to 500 of 512, so a higher threshold rarely stops an honest update. Raising it to 410 raises the collusion size from 18 to 29 credentials. But it lowers the number of seats that can stop updates from 171 to 103, which fewer than 5 credentials hold. Stopped updates cost latency, not funds, because folds and `historical_summaries` catch up. If participation falls for good, the route stalls.

**Recommendation:** if you raise it, raise it only in the PulseChain chain specification, to about 410, and record the measurement. Do not raise it for Ethereum, where the sample comes from a far larger set.

### G-07. Full-consensus proving. Severity: low for PulseChain, medium for Ethereum. Judgement: not now.

Polyhedra proves the full validator set instead of the sync committee. On PulseChain the full set is about as concentrated as the committee (19 credentials for two thirds against 18), so the gain is small. On Ethereum the gain is real, but the proving cost grows with tens of thousands of signatures per epoch. Revisit if the Ethereum-to-PulseChain direction holds large value.

### G-08. The fork observation uses an attested header, not a finalized one. Severity: low. Judgement: already covered.

`observe` accepts a committee signature over an attested header (`light-client/crates/lc-core/src/observation.rs` lines 62 to 99) with freshness against the head (`ForkRegistry.sol` line 128). A corrupt committee could sign a fake version and seal a gate. That only stops deposits. It cannot move funds. This is acceptable.

### Not applicable, and why

| Their check | Why it does not apply |
|---|---|
| Helios: the new head must be a multiple of 32 | Our finality branch proves the checkpoint block root directly. A checkpoint block can sit before the epoch start when slots are missed, so the rule would only cost liveness |
| Guardian, timelock, upgradeable proxy (Telepathy, SP1 Helios, Polyhedra, zkLink) | You chose no admin. Every admin power above is also an attack surface, as the Polyhedra and zkLink findings show |
| Updater role (Risk Labs fork, RISC Zero Helios) | `update()` is open to anyone, so a lost key cannot stop the route |
| Telepathy's minimum of 10 signers before checking the threshold | Our 342 check comes first |
| Optimistic watchers and challenge bonds (Rainbow Bridge, the arXiv design) | Our updates are proven, not claimed. The May 2022 Rainbow front-running also shows that challenge bounties need care |
| Lagrange restaking | Adds a new trust party and token. Out of scope |
| Herodotus and Axiom accumulators | Same-chain history. Our `historical_summaries` path does this job across chains |
| deVirgo | See `docs/zkbridge-paper-review.md` |
| Wormhole's Solana system-account check | No Solana program. The equivalent lesson, bind the verifier to exact code, is G-03 |

## Faking a deposit or replaying a withdrawal

I looked for any path that lets a scammer fake a deposit or replay a withdrawal across chains. I found none in the code beyond G-01 to G-04.

- **A forged header** needs the committee (G-01) or a proof system bug (G-02, G-03).
- **A log from another contract** fails the emitter check (`BridgeVault.sol` line 700).
- **A failed or reverted deposit** fails the status check (line 685).
- **A proposer-written leaf** (graffiti, `eth1_data_votes`) fails the fixed positions (HB-03, HB-04).
- **A reorganized block** cannot be an anchor, because only finalized headers are stored.
- **A replay on another chain or vault** fails the target chain, destination vault and per-vault `claimed` checks (lines 402 to 408).
- **A replay of a light-client proof** fails the start-state and monotonic checks.
- **A copy of Ethereum state on PulseChain** (the fork copied every pre-2023 contract) cannot hold our vaults, because we deploy them after the fork from a nonce-checked deployer. Copied tokens at the same address are the H-03 case, which the explicit token pairs cover.

## Open questions I could not answer

- Whether the Wormhole and Succinct Ethereum light client reached mainnet, and how it combines with the guardians.
- The content of Zellic's critical and medium findings in SP1 Helios, and the deployed `FINALITY_THRESHOLD` of Telepathy.
- Whether CVE-2026-40323 affects on-chain Groth16 verification of SP1 version 6.0.x proofs.
- How many independent operators stand behind the 18 PulseChain withdrawal credentials.
- The dollar value of the PulseChain committee's stake. Multiply 342 by 32,000,000 PLS by the current PLS price.
