# Mainnet readiness: plan

Date: 2026-11-10. Status: draft for the owner's review. Internal; not for the public docs.

Owner, approving this as the next step: "your suggested next steps seem fine".

Every item below cites the file it rests on. A figure or a claim that is not read from the repository or measured is
marked **(guess)**. Owner decisions are marked **D1** to **D16** and collected in "Decisions" at the end.

## Intent, and why

The bridge runs end to end on Sepolia and PulseChain testnet v4. This plan lists what stands between that and the pair
`eth-pls` (Ethereum chain 1, PulseChain chain 369; `explorer/data/src/pairs.ts`, `PAIR_DEFINITIONS`) holding real
money, and the order to close it in.

Why a plan before code: layers 1 and 2 have no admin, no upgrade and no pause (`docs/audit/known-issues.md` 1.4). What
is deployed on mainnet stays. Every contract change (gate evidence in sends, a flow limiter, anything the audit finds)
must land before the mainnet deployment, not after. The off-chain parts can change after launch; the contracts cannot.

The owner's layer rule, verbatim (`docs/superpowers/specs/2026-11-01-gas-revert-up.md`):

> so here is the thing, the first layer is neutral, anyone can use it. what likely happens in the second layer is that
> many people use it so it needs to be mosty trusted / immutable as well. the 3rd layer (deliveryrouter) can be swapped
> out at the will of the frontends that point to it

So: layers 1 and 2 (`MessageBridge`, `TokenMediator`, `TokenFactory`) and everything under them (light clients, gates,
fork registry, verifiers) are deployed once and must be audited first. Layer 3 (`DeliveryRouter`) can follow later and be
replaced (`docs/redeploy-2026-11-gas.md`, "Layer 3 later, alone").

## Goals

1. Layers 1 and 2, the light clients, the gates and the verifiers on Ethereum and PulseChain, audited, from a commit
   the audit names.
2. One delivery router per chain, with a zkb.fi reward address, deployed with them or right after.
3. The backend, the indexer, the runner and the status page running the mainnet pair on the app server, with mainnet
   values for every setting that differs from testnet.
4. A signed stable release of the dapp, the docs and the terminal that knows the mainnet deployment.
5. A launch in two steps: limited (caps, watched), then open.
6. Every key used on mainnet fresh, made for mainnet, held in the zkb.fi 1Password vault.

## Non-goals

- New features beyond what mainnet needs. Anything not listed here waits.
- Our own chain nodes. Providers first (`docs/deployment-plan.md`, "Chain access").
- A second proof system (`docs/audit/known-issues.md` 1.8, G-02: not adopted).
- Other pairs or chains.

## Anti-goals (failure even if it works)

- A testnet key, address or wallet used on mainnet: the deployer `0xF71cBAA5a165fad2FfFf6B0D68E84D67b1f75eAc`, the
  testnet reward address `0xE73c...2DB4`, the testnet runner, traffic or RunPod keys. The owner's rule: zkb.fi accounts
  only.
- An admin, pause or upgrade path added "for launch" (`docs/audit/known-issues.md` 1.4).
- Real money on contracts the audit has not seen, or on a commit other than the one it saw.
- A secret in a browser page or a static build (`docs/superpowers/specs/2026-10-28-finish-the-system-design.md`,
  "Anti-goals").
- User-facing copy that promises a delivery time the mainnet configuration does not keep (see F3).
- A server config URL or key printed in a log, a doc or a report (memory: never print config URLs).

## Current state (testnet)

| What | State, with date | Source |
|---|---|---|
| Contracts on testnet | First deployment 2026-10-26. Layers 1 to 3 redeployed 2026-11-08: eight creations per chain, 16 receipts with status 1; Sepolia 98,325,040 gas, largest creation (`MessageBridge`) 14,587,871 gas (87% of the EIP-7825 cap of 16,777,216); chain 943 13,996,582 gas. Read-backs passed on forks of both chains. | `docs/redeploy-2026-11-gas.md`, "What happened on 2026-11-08"; `broadcast/multi/RedeployLayers.s.sol-latest/run.json` |
| Router that emits `Delivered` | Deployed 2026-11-08 night (layer 3 alone). | `docs/redeploy-2026-11-gas.md`; commit `f2d3e6ba` |
| Gas rule | "Gas reverts up" in all three layers; `callbackGas` in layer 2, `callGas` in layer 3. | `docs/superpowers/specs/2026-11-01-gas-revert-up.md` |
| Creation size guard | `test/hardened/CreationGasCap.t.sol` keeps every creation under 90% of the cap at 1,600 gas per runtime byte (Sepolia's price). | same file |
| Gate | Sepolia gate `Enforcing`; 943 gate `DetectBeaconRootsAndRegistry`. Confirm-then-send in the dapp and the traffic bot, same epoch (commit `dfbc44e7`). | `src/hardened/BeaconForkGate.sol`; `docs/hardened-build-contract.md`, "Gate evidence: confirm, then send" |
| Light clients | The backend's watcher owns keep-alive since 2026-11-06; every period's handoff archived; "stranded" only when every source lacks a handoff; deadline warning on the status page and the dapp (commit `c728891a`). | `docs/testnet-run.md`, "Keeping the light clients alive" |
| Proving | Prove on finality (2026-10-31), adaptive warm-up, batching, profit rule, deduplication, minimum interval from the last proof (2026-11-01); one job per finality and a GPU budget per direction (commit `149469e1`); the idle timeout owned by the backend (`feat/idle-timeout-sync`). | `docs/superpowers/specs/2026-10-31-prove-on-finality.md`; `explorer/backend/README.md` |
| GPU | RTX 5090 on the RunPod serverless endpoint: warm proof about 36 s, first proof on a worker about 51 s, cold start 24 s to 412 s. Image v6 on the template; v7 did not start (cause unknown). MIG slices are handed out even when only whole GPUs are listed. | `docs/gpu-trial-2026-11-01.md` |
| Delivery | Runner delivers paying items; since 2026-11-09 also a covered item with no paying offer after `deliverUnpaidAfterSeconds` (3600), within a daily spend cap per chain (Sepolia 0.05 ETH, 943 one million PLS). | `explorer/bots/README.md`; commit `2d3ea3e9` |
| RPC in the dapp | One pool per chain (valve.city, pulsechain.com, publicnode), round robin, 30 s bench on 429/5xx. Beacon default `one.valve.city/beacon/vk_demo/<chain>`. | commit `90d56b05`; `explorer/web/docs/pages/08-settings-and-explore.md` |
| Off-chain red team | 2026-10-29: 13 findings fixed in two rounds, none high or critical. | `docs/red-team-2026-10-29-offchain.md`, "Status" |
| Release | Channels `next` (staging key) and `stable` (production key); stable zkb.fi is 0.1.1; `promote.sh` requires the commit on `origin/main`. | `docs/release.md` |
| Costs, measured | GPU about $0.65 to $1.2 a day on testnet; app server €12.49 a month. | owner context, `GET /billing` (`explorer/backend/README.md`) |

Not counted here: how many transfers testnet has delivered and their delivery times. Read `/api/counts` and
`GET /benchmarks?window=24h` before the review meeting rather than trust a number written today.

## The gaps

Size: S (a day or less), M (a few days), L (a week or more). All sizes are **(guess)**.

### A. Contracts

**A1. Freeze layers 1 and 2 (and decide what goes in first).** Every change below that touches layers 1 or 2 must be
decided before the audit starts. Size: depends on D1 and D2. Blocks: the audit.

**A2. Gate evidence carried by a send.** Today `MessageBridge` calls `depositGate.admit("")` (`src/hardened/MessageBridge.sol`
line 228); a send in an epoch nobody confirmed reverts with `ForkNotConfirmed` (`src/hardened/BeaconForkGate.sol`,
`admit`). On Ethereum (gate `Enforcing`) an epoch is 6.4 minutes, about 225 a day, so most low-traffic sends pay a
`confirm` first (about 42,748 gas of call, `docs/hardened-build-contract.md`) and race the epoch border (the bug fixed
in `dfbc44e7`). A send that carries its own evidence removes the race and the second transaction. It changes layer 1
(a send method that passes evidence), layer 2 (the mediator's relay entry points pass it through) and layer 3 (the
router's source entry points). This reverses the user decision of 2026-10-24 ("A send carries no gate evidence").
- **D1.** Build sends with gate evidence before mainnet, or launch with confirm-then-send? **Decided 2026-11-10, owner:
  "go ahead with your choice for d1": sends carry their own gate evidence.** Built in the same layer 1 and 2 freeze as
  A6 (A1), test-first.
- **Design, 2026-11-10.** Owner: "yes, write it up and start building. keep the contracts simple. just check if the
  proof has already been provided and then make sure it is provided. you should be able to do this with just a basic
  multicall, right?" The gate already does the check: `admit` returns when the current epoch is confirmed, confirms with
  the evidence it is given otherwise, and reverts with `ForkNotConfirmed` on empty evidence; `confirm` does nothing in a
  confirmed epoch. A confirmation covers its epoch only (`HeaderNotInCurrentEpoch`), and a fork starts at an epoch's
  first slot, so no admitted send is unproven. What is missing is the evidence and the send in one transaction. A
  generic multicall contract (Multicall3) cannot do it: the bridge would see Multicall3 as the sender. A self-multicall
  by delegatecall reuses `msg.value` across calls. So the "multicall" is two lines in the router: every send entry of
  `DeliveryRouter` (layer 3) takes `bytes gateEvidence` and, when it is not empty, calls `gate.confirm(gateEvidence)`
  before it sends as today. Layers 1 and 2 do not change. Sends straight to the mediator keep confirm-then-send.
  The frontends attach evidence when the current epoch is unconfirmed or ends within 60 s, otherwise empty; a late empty
  send fails with `ForkNotConfirmed`, never passes unproven.
- Size: M for the contracts and tests, M for `@zkb/data`, the dapp, the terminal and the traffic bot.

**A3. Caps for a limited launch.** The contracts cannot be capped after deployment. Two on-chain options exist in the
code: the mediator's `IFlowLimiter` hook (`src/hardened/IFlowLimiter.sol`, used in `TokenMediator.sol` and
`MediatorPayloads.sol`; empty, nothing attached, by the user decision of 2026-10-22, `known-issues.md` 1.3), and the
bridge's immutable `sendCutoffTimestamp` (`script/hardened/DeployBridge.s.sol`, `depositCutoffTimestamp`). The removed
`SupplyShareFlowLimiter` design is in `docs/hardened-build-contract.md`, "Supply-share flow limiter (removed)". Without
either, caps live only in frontends and the runner, which anyone can bypass with a direct call.
- **D2.** For the limited launch: (a) frontend and runner caps only; (b) attach an immutable flow limiter with a sunset
  (a new contract in the audit); (c) a first route with a `sendCutoffTimestamp` (a trial route that closes on a date,
  followed by an open route)? (c) needs no new contract **(guess: it moves users once, and the old route keeps paying
  out)**.
- Size: (a) S; (b) M plus audit scope; (c) S plus a second deployment.
- **Decided 2026-11-10, owner: "no to the trial route"**, then: "no, no caps in the uis. otherwise you are just shackling
  the user". No trial route and no send caps in the dapp or the terminal: the permanent route launches open. The only
  limits on a launch are the audit and the accepted risks (1.3, 1.4). The runner's daily cap on what it spends
  delivering unpaid items stays: it limits our spending, not the user's sends.

**A4. Mainnet deployment config and dry run.** There is no mainnet bridge config and no `deploy/deployments/eth-pls.json`;
only `script/hardened/bridge.config.example.json` and the testnet files. Fill: verifier and `verifierCodeHash` per
chain (`known-issues.md` 1.21: our code hash differs from Succinct's deployed copy; we deploy the vendored verifier),
program keys from `light-client/program-keys.json`, checkpoints, wrapped native tokens (WETH, WPLS), gate modes
(`Enforcing` on Ethereum, `DetectBeaconRootsAndRegistry` on PulseChain), reward and failed-delivery addresses (E6).
Dry run with `DeployBridge.s.sol` against forks of both mainnets; read every value back. Size: M.

**A5. Mainnet gas and the EIP-7825 cap.** The split was measured against Sepolia, which runs Amsterdam and charges about
1,580 to 1,600 gas per byte of new code (`test/hardened/CreationGasCap.t.sol`). On Ethereum mainnet, code is charged
200 gas per byte today **(guess: until the same repricing reaches mainnet)**, so each creation needs about 1.6 to 2.7
million gas, far under the cap; the test's 1,600 per byte already covers the repriced case. Re-run `eth_estimateGas` of
every creation on mainnet the week of the deployment (`docs/redeploy-2026-11-gas.md` did the same for Sepolia).
`known-issues.md` 2.10 is stale (pre-split figures) and should be closed with the measurement. Size: S.

**A6. Forks we cannot predict.** Owner, 2026-11-10: "i thought we already had upgrade code available. you are saying
that we do not? lets assume that we cannot know what the structure will be updated to nor when". There is no upgrade
code, by the decision of 2026-10-22 (`known-issues.md` 1.4: no admin, no upgrade, no pause). What exists is fork
tolerance: the light-client program takes the fork version and the state layout from the evidence
(`light-client/crates/lc-core/src/update.rs`, `verify_light_client_update_with_fork_version`; `docs/hardened-build-contract.md`,
"Change: the layout comes from the evidence"), so a fork that keeps an accepted layout (plain depth 5 or 6, or the Gloas
progressive form) needs no new program. Earlier text here said the program key fixes the fork schedule; that was wrong.
Two parts still read a date or a fixed list, and both must change before the audit:
1. `BeaconProofVerifier.gloasForkSlot` is immutable (`src/hardened/BeaconProofVerifier.sol`). A mainnet deployment today
   gets `NO_GLOAS_FORK`, because Ethereum has no Gloas epoch. When Gloas activates, the gate on Ethereum still admits
   deposits (Gloas is an allowed shape in `src/hardened/ForkShape.sol`), but the verifier on PulseChain reads those blocks
   with the pre-Gloas rule and refuses them: the deposits lock. Fix: choose the Gloas rule from the evidence (the proven
   shape of the source state), not from a slot. The off-chain twin is `trie_roots` in
   `light-client/crates/lc-core/src/message.rs`, which reads `fork_at_slot`.
2. The gate's allowed shapes and the shapes the message verifier can prove are two lists. Fix: one list, so any fork the
   verifier cannot follow seals deposits instead of admitting them. A test compares them.
Residual, accepted under 1.4 unless the owner asks for an upgrade path: after a fork of unknown shape on chain X, sends
from X stop (the gate seals), messages from X can no longer be proven, and copies held on X of tokens native to the
other chain cannot go home; their originals stay locked. Messages into X keep working. Sends in the last two or three
epochs before the fork strand (1.6). A new route serves new transfers.
Owner, 2026-11-10: "why wouldn't it just be a matter of telling pulsechain that gloas is ready to be accepted as well?
and can't we add some of these checks and function calls to something like the explorer page? i think the frontend can
help a lot in this regard, prevent bridges when we are near a fork for example". Then: "yes, start part 1 and 2".
- **Part 1 (frontend, testnet now, no contract change).** The dapp and the terminal read each chain's fork schedule
  (`/eth/v1/config/fork_schedule`) and refuse sends from a chain from one hour (at least three epochs) before its next
  scheduled fork until the other side is shown to follow it. The explorer and status pages show, per route, the next
  fork with a countdown, the gate state and the registry's latest observation, with buttons anyone can press to post an
  observation and to seal a gate. This builds the cutover that `known-issues.md` 1.5 already claims; nothing in
  `explorer/` implemented it on 2026-11-10.
- **Part 2 (contracts, layer 1 and 2 freeze).** "Telling PulseChain" is a proof, never a trusted call: the verifier takes
  the Gloas rule from proven fork data (the `ForkRegistry` observation, or the source state's own proven shape) instead
  of the immutable `gloasForkSlot`; the gate's allowed shapes and the verifier's provable shapes come from one list.
  Status 2026-11-10: built on branch `feat/fork-rule-from-proof`, not merged, not deployed. The source state's own
  proof was chosen: the registry records the first OBSERVED slot (later than the activation, so blocks in between
  would be misjudged), and the exact `fork.epoch` would need a change to the observation program (new program key).
  `MessageProof.sourceFork` carries `fork.current_version` and `genesis_validators_root` under the source state root,
  judged by `ForkShape.judge`; `gloasForkSlot` and the config key `gloasForkEpoch` are gone; block hash layout evidence
  proves a plain state; the position rules read `ForkShape.allowedShapes` (`test/hardened/ForkRuleFromProof.t.sol`).
  The program keys are expected to stay: the guests do not reach the changed `lc-core` code. Not yet confirmed by a
  Docker build: `light-client/program-keys.source-hash` no longer matches the sources, so `scripts/program-keys.sh`
  rebuilds both guests and compares them with `program-keys.json`. Run it before the merge. Cost: about 20,000 gas per
  delivery, and the prover reads the post-state of each source block (`known-issues.md` 1.22).
  Status 2026-11-10 (branch `feat/save-fork-proofs`): owner, "yes, and save fork proofs in the watcher too". The backend
  saves the fork proof of each source block that carries a message once the block is final (`zk-bridge-prover
  fork-proof`, about 1 KB), the proof archive keeps and publishes it, and `evidence` asks it, checked against the source state
  root, after a held state and the Lodestar multiproof route and before it downloads a whole state. Residual 1.22 (a) reduced; mainnet needs a beacon endpoint with that route for the capture to stay cheap.
- **D3.** Replaced by the owner's assumption above: no deploy date counts as safe, so the deployment waits for nothing.
  The two fixes go into the layer 1 and 2 freeze with D1.
- Size: M for the two fixes and their tests.

**A7. Real-data gaps the audit will ask about** (`docs/audit/known-issues.md`, section 2):
- 2.1 the real Ethereum mainnet genesis validators root branch fixture is missing;
- 2.2 no real Groth16 proof of the current program keys in the tests **(guess: testnet has produced such proofs since
  2026-10-26; regenerate the fixture from one and un-ignore the 13 tests)**;
- 2.7 real fixtures stop before the transaction proof;
- 2.8 no real Ethereum historical-path check (messages older than the `block_roots` window, about 27 hours, go through
  it).
Size: M together. Needs a node that keeps old states (2.1) and serves `eth_getRawTransactionByHash` (2.7).

**A8. Audit documents are stale.** `docs/audit/README.md` section 2 names branch `wip/layout-genesis-root`, "no remote",
"no deployment"; `known-issues.md` 2.4 says nothing is deployed; tier line counts predate the split libraries and the
gas rule. Refresh before sending. No `LICENSE` file exists (`known-issues.md` 2.11).
- **D4.** The licence. **Decided 2026-11-10, owner: "do unlicensed for the license".** `LICENSE` reads "Copyright (c) 2026 zkb.fi. All rights reserved."; the SDK packages say UNLICENSED. Open: 59 Solidity files under `src/` still carry `SPDX-License-Identifier: MIT`; changing them alters the compiled metadata, so it is done with the next contract change (mainnet deploy), not against deployed testnet code.
- Size: S.

### B. Proving and light clients

**B1. Light-client periods on mainnet.** Ethereum: 8,192 slots of 12 s, 27.3 hours a period. PulseChain: 8,192 slots of
10 s, 22.75 hours (`docs/testnet-run.md`, "Why a light client strands"). A light client strands at most about two periods
after its last update. Keep-alive is `limits.keepAliveSeconds` 43,200 (12 h) in
`deploy/app-server/config/backend/backend.json.example`; the 2026-11-01 spec names 7 days on the server (it was later
lowered **(guess: check the live value, read the number only)**). On mainnet each keep-alive of the light client that
lives on Ethereum is an Ethereum transaction (B4).
- **D5.** Keep-alive age on mainnet: 12 h for both, or longer for the light client on Ethereum (it tracks PulseChain,
  deadline at least 22.75 h after a head) to save Ethereum gas?

**B2. Beacon and state sources for mainnet.** PulseChain's public beacon node serves no light-client routes (404,
`docs/testnet-run.md` "Endpoints"), so 369 updates are assembled from debug states, which PulseChain nodes prune. The
handoff archive (`docs/proof-archive.md`, "handoff updates") must run from the first mainnet period, and a second copy
must exist off the server (the IPFS export). Ethereum: a node that serves `light_client/updates` and recent states;
`state_cache_dir` on each route. `eth_getProof` depth matters for opening proofs (memory: RPC proof windows; valve.city
refused every depth on testnet). Check each mainnet provider for these before launch (`docs/deployment-plan.md`, "Chain
access"). Size: M.

**B3. GPU prover.** One RunPod endpoint serves both directions; template on image v6; v7 never started; MIG slices
were assigned against the type list (`docs/gpu-trial-2026-11-01.md`). Mainnet needs: the worker image built from the
audited commit's program files (`known-issues.md` 2.6), its `VERIFIER_HASH` check, the cause of the v7 failure or a v6
rebuild, a mainnet endpoint (or the same one with a mainnet route; **D6**), `idleTimeoutSeconds` (default 5,
`explorer/backend/README.md`), `gpuBudgetUsdPerDirectionPerDay` (5 in the template), and one job per finality (in
place). A fallback when RunPod has no GPU: local proving in the terminal (16 GB memory, `prover/tests/sp1_execute.rs`)
or a CPU server (`docs/server-prover.md`), both slow.
- **D6.** A separate RunPod endpoint and API key for mainnet, or share the testnet endpoint?
- Size: M.

**B4. Who pays light-client updates on Ethereum.** Each proof for the PulseChain-to-Ethereum direction lands as an
`update` on Ethereum (about 337,000 gas for the proof check, `known-issues.md` 3.1 H-15, plus storage), plus layout rows
on a new bridge. The runner posts it from its hot wallet. At 2 gwei and $3,000 per ETH that is about $2 to $3 per
update **(guess)**; two keep-alives a day are about $150 a month before any message proof **(guess)**.

### C. Delivery and pricing

**C1. The proving cadence on mainnet.** Testnet runs `watch.minIntervalSeconds` 3600 with the profit rule (nothing pays
on testnet, so at most one message proof an hour per direction). The prove-on-finality spec names 300 for mainnet; the
backend README names 0 (`explorer/backend/README.md`, "minIntervalSeconds"). The owner's words:
> "the proof should start running within seconds of the finalization/ sufficient signatures"
> "3600 is fine for a minimum, but we should have code in place that can say, oh, yes, we should create a proof for
> this situation"

The profit rule is that code (`explorer/backend/src/watch/economics.ts`, `batch.ts`): a batch whose fees cover
`PROOF_COST_USD` ($0.025) plus the delivery gas proves at once, inside the interval. It needs prices (C3), or every
mainnet batch waits for the interval.
- **D7.** Mainnet `minIntervalSeconds`: 0, 300 or 3600? (Each value is per pair and direction in `watch.pairs`.)

**C2. The runner on mainnet.** Settings that differ (`explorer/bots/README.md`; template
`deploy/app-server/config/runner/bots.json.example`, which still carries the old `proofCheckGas` name):
- `deliverUnpaidAfterSeconds` (3600) and `maximumUnpaidSpendPerDayWei`: there is no default for chains 1 and 369, so
  no unpaid delivery happens on mainnet until set. **D8**: the mainnet values (guess: Ethereum 0.01 ETH a day,
  PulseChain the PLS of about $10 a day).
- `maximumLossPercent` (20), `maximumBatchGas` (6,000,000), the prerequisite spend caps (0.05 and 0.2 of the native
  coin per sweep and per day: fine in PLS, large in ETH), `minimumPriorityFeeWei` for 369 (0.01 gwei in the template;
  chain 943 needed more than 0.001 gwei, memory: PulseChain testnet min tip; the mainnet floor is **(guess)** the same
  and must be checked).
- The `deliveryRouter` allowlist: the mainnet routers only.
- `tokenValuationsWei` is a static map; "no price means skip" (`explorer/bots/README.md`, step 3). Replace with the
  shared pricing module (C3).

**C3. Pricing.** `explorer/core/src/pulsex-pricing.ts` (PulseX v1 and v2, PLS/USD as the depth-weighted median against
the Omnibridge stablecoins, $10k minimum depth, Ethereum tokens through their Omnibridge copy) is in the dapp and the
backend's profit rule; the shared module is in progress (`refactor/shared-pricing`, no commits yet). Needed for mainnet:
the runner reads the same prices; Ethereum gas in USD (ETH through the WETH copy on PulseChain); one named block per
quote; behaviour when a pool is thin or manipulated (a price only feeds a decision to deliver, never an amount, so the
risk is a wrong delivery decision, **(guess)** bounded by the spend caps).

The owner's pricing rules, verbatim:
> "we should use 1% - the frontend's auto maximum whenever the frontend cannot determine the price"

Built in the dapp (commit `2c721e8e`, `explorer/core/src/fee-rules.ts`). And: an unpriced tip at or above the 1% maximum
should "deliver straight away". The runner does not do this today: an unpriced token is skipped until
`deliverUnpaidAfterSeconds`. Size: S to M, test-first, in the runner.

**Note (2026-11-10, security review): the unpaid cap also bounds unpriced 1% tips.** Anyone can mint a worthless token,
bridge it with a 1% tip in that token, and have the runner pay real gas to deliver it straight away; repeated, that
drains the runner wallet. The runner now delivers such a tip straight away (owner's rule kept) only while the
destination's `maximumUnpaidSpendPerDayWei` has room, charges its gas and layout calls to that cap (log
`delivered_unpriced`), and skips it with `unpaid-spend-cap` when the cap is full. A token that does not answer
`decimals()` never counts as paying. On the backend such a message still proves its batch at finality, inside the $5 a
day GPU budget per direction (`gpuBudgetUsdPerDirectionPerDay`; no liveness bypass) and one job per finality. So on
mainnet the unpaid caps are shared by the hourly unpaid rule and by every unpriced 1% tip: **decision input for D8**,
size them for both (a cap that one attacker fills also holds back honest unpriced tips and hourly deliveries for the
rest of the day; a chain with no cap delivers neither).

**C4. Gas on PulseChain.** The tip floor (C2), the base fee in PLS, and `requiredDeliveryGas` with the split's extra
13,400 gas per token delivery (`docs/redeploy-2026-11-gas.md`, "What the split costs a delivery"). Ethereum-bound
deliveries cost about 536,000 gas each **(guess at mainnet prices: $3 a delivery at 2 gwei)**, so the 1% maximum covers
an Ethereum delivery only above about $300 sent **(guess)**; below that the runner relies on the unpaid rule (C2) or
leaves it to the user.
- **D9.** Accept that small Ethereum-bound transfers wait for the unpaid rule (within its cap) or for the user, and say
  so in the dapp?

### D. Frontend

**F1. Mainnet deployment in the release.** `DEFAULT_PAIR_NAME` is already `eth-pls` (`explorer/data/src/pairs.ts`), with
no deployment file behind it. The release must carry `deploy/deployments/eth-pls.json` and the ABIs of the audited
commit (`pnpm abis`).
- **D10.** Does stable zkb.fi show mainnet only, or both pairs with a testnet switch? Does `next.zkb.fi` get mainnet
  first?

**F2. RPCs.** The dapp's defaults use the valve.city demo key (`vk_demo`) in its RPC and beacon pools; the servers use
their own keys (`EXPLORER_RPC_URL_<id>`). Mainnet traffic on a demo key will hit limits **(guess)**. Keep the public
endpoints in the pool; never ship a paid key in a static build (anti-goal).
- **D11.** Ask valve.city for a mainnet arrangement, or rely on public RPCs plus the pool for the dapp?

**F3. Copy that depends on mainnet settings.** "a low tip says the zkb.fi runner delivers it after an hour" (commit
`d225c8ec`) is true only while `deliverUnpaidAfterSeconds` is 3600 and the cap is not spent. On mainnet: tie the text to
the release's configured value, or reword. Also the wait-time timeline (`feat/wait-timeline`) uses testnet
measurements; it must read mainnet benchmarks after launch. The gate confirm step in the review (`fix/dapp-gate-confirm`)
goes away if D1 is yes. Size: S each.

**F4. Limited-launch caps in the dapp and the terminal** (if D2 is (a) or alongside it): a per-send value cap and a token
allowlist, with plain copy that says the cap is the frontend's, not the contract's. Size: S to M. **Dropped 2026-11-10 (D2): no caps in
the UIs.**

### E. Ops and keys

**E1. Fresh mainnet keys, all in the zkb.fi 1Password vault, never testnet ones:** the mainnet deployer (one key, used
for nothing else, so the predicted addresses hold), the runner hot wallet (small balance, topped up;
`docs/deployment-plan.md`, "The bots on the same server"), the RunPod key (D6), the webhook bearer, provider RPC keys.
The release production key exists (one public key in `explorer/landing/landing.config.json`) and stays.

**E2. Reward and failed-delivery addresses.** On testnet the failed-delivery address is the deployer
(`docs/redeploy-2026-11-gas.md`, "Checked on the live chains"). On mainnet the failed-delivery address receives users'
tokens that the router cannot deliver (`known-issues.md` 1.20), so it holds user money.
- **D12.** Who holds the mainnet reward address and the failed-delivery address (a hardware wallet, a multisig), and
  what is the written policy for returning tokens that land at the failed-delivery address?

**E3. Server.** One Hetzner CAX21 runs everything (`docs/deployment-plan.md`). Mainnet adds a second pair to the
indexer, the backend and the runner, or a second set of services. Indexer memory grows with history (817 MB on two test
chains). Blue/green playbooks (`docs/deploy-blue-green.md`) are "not verified" on the server.
- **D13.** Run mainnet on the same server as testnet, or a second server (about €12.49 a month more, measured price of
  the current one)?

**E4. Alerts.** The status alert webhook is off; owner: "leave it nooping for now". Mainnet's light-client deadline,
the runner's balance and the GPU budget have no one to tell. Revisit before the open launch (D14 in "Decisions").

**E5. Backups.** The backend SQLite (job history, handoff archive, warm-up observations) and the proofs mirror
(`docs/proof-archive.md`, "Copies off the server"). The handoff archive is what keeps a PulseChain light client from
stranding (B2). Size: S to check.

### F. Security and audit

**S1. External audit before real money.** Scope candidates (`docs/audit/README.md`, section 3): tier 1 (4,833 lines:
contracts that can lose funds, and the guest programs), tier 2 (deploy script, config checks, router: 1,432), tier 3
(prover and off-chain Rust: 8,409). Plus whatever D1 and D2 add.
- **D15.** Which firm, which tiers, and the budget. Does the launch wait for the final report, or for the fix review?
- Size: L (the audit itself several weeks **(guess)**, plus fixes and a re-review).

**S2. Internal history the auditor gets:** `docs/red-team.md`, `docs/red-team-revision-2.md`,
`docs/red-team-2026-10-29-offchain.md`, `docs/local-attack-report.md`, `docs/audit/known-issues.md`,
`docs/audit/invariants.md`, `docs/spec-deviations.md`, `docs/zkbridge-paper-review.md`.

**S3. One more internal pass on what changed since the red teams:** the split libraries, the gas rule, the router's
`Delivered` event, the runner's unpaid rule and layout calls (commit `657e0336`). Size: M.

**S4. Accepted risks to confirm for real money:** no refunds (1.1), a failed release is final (1.2), no outflow cap
(1.3, see D2), no admin (1.4), sync committee concentration on PulseChain (1.7), SP1 as the only proof system (1.8). The
owner accepted each for the design; confirm each again for mainnet in writing (D16).

### G. Release

**R1.** Build stable from the audited commit: `script/release/release.sh` on `next`, try it, then `promote.sh` (needs the
commit on `origin/main`; `docs/release.md`, "Promotion"). The version after 0.1.1 that first carries mainnet is a
number the owner picks **(guess: 0.2.0)**.
**R2.** Reproducible builds checked by a second machine before the stable promotion (`docs/release.md`, "Reproducible
builds").
**R3.** The terminal and prover downloads for mainnet: the GPU image and the prover binaries from the audited commit,
with their hashes in the signed manifest.

## Phased plan

Each phase ends with a check the owner can read. Durations are **(guess)**.

**Phase 0: decisions (days).** D1, D2, D3, D15 first: they decide the audit scope. The rest can follow.

**Phase 1: pre-audit hardening (2 to 4 weeks).** Order:
1. A2 and A3 if chosen (contracts, test-first, mutation checks as before).
2. A7 fixtures; A5 creation sizes against the final code; A6 fork check.
3. A8 audit docs refreshed; LICENSE (D4).
4. S3 internal pass.
5. Freeze: tag the commit. Nothing in layers 1 and 2 changes after this except audit fixes.
In parallel (off-chain, not blocking the audit): C3 pricing in the runner, C2 settings, F3 copy, B2 provider checks,
E1 keys.

**Phase 2: audit (4 to 8 weeks).** Send the tagged commit and the docs. Fix findings test-first; each fix gets its own
commit and a note in `known-issues.md`. Fix review by the auditor. The testnet redeploys the audited commit (the
`RedeployLayers.s.sol` path) so testnet runs exactly what mainnet will.

**Phase 3: mainnet dry run on forks (1 week).**
1. `DeployBridge.s.sol` dry run against forks of Ethereum and PulseChain mainnet, from the mainnet deployer and its real
   nonces; every read-back passes.
2. On the forks: a real Groth16 update of each light client from real mainnet beacon data, posted to the forked light
   client; `openDeposits`; a gate `confirm` on the Ethereum fork from real evidence (`GateEvidenceSepolia.t.sol` is the
   pattern).
3. Limit: a fork's transactions are not in the real beacon chain, so a message sent on a fork cannot be proven. The
   message path stays covered by the testnet run of the audited commit.
4. Measure: creation gas, update gas, delivery gas at that week's fees (feeds B4 and C4).

**Phase 4: limited launch (2 to 4 weeks).**
1. Deploy (Ethereum first, then PulseChain; one deployer, nonces fixed between dry run and run; on PulseChain pass
   `--with-gas-price` with the priority fee from the start, `docs/redeploy-2026-11-gas.md`).
2. Deployment file, indexer, backend, runner, status page on the mainnet pair; the runner opens both bridges.
3. Release to `next.zkb.fi` with mainnet; team transfers both ways, small amounts, every direction and
   token kind (native, ERC-20, a copy's first deployment, a relay with a call).
4. Watch: light-client deadlines, GPU spend (`/billing`), runner spend, delivery times (`/benchmarks`).
5. Promote to stable when a set of checks holds for a period the owner names **(guess: 14 days with no strand, no
   failed paid proof, no stuck message)**.

**Phase 5: open.** The route is open from deployment (D2: no caps); this phase is the public announcement.
Turn on alerts (E4). Revisit `minIntervalSeconds`, the unpaid caps and the keep-alive age from measured mainnet traffic.

## Costs (estimate)

| Item | Testnet, measured | Mainnet, estimate |
|---|---|---|
| App server | €12.49 a month | same, or twice that with a second server (D13) |
| GPU | about $0.65 to $1.2 a day | keep-alives about 4 proofs a day plus message proofs; capped at $5 per direction per day by `gpuBudgetUsdPerDirectionPerDay` (keep-alives may pass it); **(guess)** $1 to $5 a day at low traffic |
| Light-client updates on Ethereum | none (Sepolia gas is free in practice) | **(guess)** $2 to $3 each; $150 a month for keep-alives alone at 12 h (B4, D5) |
| Unpaid deliveries | testnet caps | the D8 caps, at most |
| Deployment | under 0.01 ETH on Sepolia | **(guess)** 20 to 30 million gas on Ethereum for all contracts at mainnet code prices: 0.04 to 0.15 ETH at 2 to 5 gwei; negligible in dollars on PulseChain |
| RPC providers | public and valve.city | **(guess)** $0 to $50 a month |
| Audit | none | quote needed (D15) |

Measure each billed item in the first week of Phase 4 before reporting a monthly figure (memory: measure spend).

## Risks

| Risk | Mitigation |
|---|---|
| A contract bug after deployment (no admin, no pause) | Audit (S1); no caps (D2); the route can be replaced, users move; accepted risk 1.4 |
| A forged header drains a mediator (committee or SP1 soundness) | Accepted (1.3, 1.8); a flow limiter (D2 (b)) bounds it; SP1 version policy (`docs/sp1-version-policy.md`) |
| A PulseChain light client strands because nodes pruned the states | Handoff archive from period one, exported to IPFS (B2); deadline check on the status page; alerts (E4) |
| A fork of unknown shape on either chain | The gate seals sends from that chain; copies held there of the other chain's tokens stay stuck (A6, 1.4); a new route serves new transfers |
| RunPod has no GPU, or the image does not start (v7, MIG slices) | Pin a working image from the audited commit; local and CPU proving as slow fallbacks (B3); messages wait, nothing is lost |
| Ethereum gas spikes make updates and deliveries expensive | Runner loss limit and spend caps (C2); keep-alive age (D5); a delivery that is not sent stays deliverable by anyone |
| A thin or manipulated PulseX pool misprices a tip | $10k minimum depth; prices decide only whether to deliver, never an amount; spend caps (C3) |
| The runner's hot wallet on the public server is stolen | Small balance, own system user (`docs/deployment-plan.md`); fresh mainnet key (E1) |
| A testnet key or address slips into the mainnet config | The deploy script refuses any signer but the configured deployer; checklist item; config review before the run |
| Dapp RPC limits on the demo key under mainnet load | RPC pool with public endpoints (F2); D11 |
| Copy promises a delivery the mainnet settings do not keep | F3 |

## Decisions

| Id | Question | Blocks |
|---|---|---|
| D1 | Sends carry their own gate evidence (layers 1 to 3 change) before mainnet, or confirm-then-send? Decided: evidence. | audit scope |
| D2 | Limited-launch caps: frontend and runner only, an immutable flow limiter, or a first route with a send cutoff? Decided: no caps and no trial route; the route launches open. | audit scope |
| D3 | Replaced: forks are unpredictable; Gloas chosen by evidence, one shape list for gate and verifier (A6) | audit scope |
| D4 | The licence | audit docs |
| D5 | Keep-alive age on mainnet, per light client | Ethereum gas spend |
| D6 | Separate RunPod endpoint and key for mainnet? | B3 |
| D7 | Mainnet `minIntervalSeconds`: 0, 300 or 3600 | backend config |
| D8 | Mainnet unpaid-delivery wait and daily caps per chain | runner config |
| D9 | Small Ethereum-bound transfers wait for the unpaid rule or the user; say so in the dapp? | copy, runner |
| D10 | Stable zkb.fi: mainnet only, or both pairs? | release |
| D11 | Dapp RPCs on mainnet: valve.city arrangement or public pool | release |
| D12 | Who holds the reward and failed-delivery addresses, and the return policy | deployment config |
| D13 | Same server for mainnet and testnet, or a second one | ops |
| D14 | When alerts stop nooping (owner: "leave it nooping for now") | open launch |
| D15 | Audit firm, scope (tiers), budget; launch after report or after fix review | Phase 2 |
| D16 | Re-confirm the accepted risks (known-issues 1.1 to 1.21) for real money | Phase 4 |

## Checklist

Contracts
- [ ] D1, D2 decided; changes built test-first; mutation checks run
- [ ] `CreationGasCap.t.sol` passes on the final code; mainnet `eth_estimateGas` of every creation the week of the deploy
- [ ] Gloas rule chosen by evidence, not `gloasForkSlot`; gate shapes and verifier shapes from one list (A6)
- [ ] Fixtures for `known-issues.md` 2.1, 2.2, 2.7, 2.8
- [ ] Audit docs refreshed; LICENSE added
- [ ] Commit tagged and frozen; audit done; fixes reviewed; testnet redeployed from the audited commit

Mainnet config
- [ ] Mainnet bridge config filled from the audited build (program keys, verifier code hashes, checkpoints, gate modes, WETH, WPLS)
- [ ] Fresh deployer; its nonces read; nothing else sends from it
- [ ] Reward and failed-delivery addresses are mainnet ones (D12), never `0xF71c...5eAc` or `0xE73c...2DB4`
- [ ] Fork dry run of both chains; all read-backs pass; real update posted on the forks

Services
- [ ] Providers checked: light-client routes, old states, `eth_getProof` depth, receipts, rate limits
- [ ] Handoff archive running for 369 and 1 from the first period; IPFS export
- [ ] GPU image from the audited commit; `VERIFIER_HASH` check; endpoint per D6; idle timeout and budget set
- [ ] Backend: `minIntervalSeconds` (D7), `keepAliveSeconds` (D5), profit rule with prices
- [ ] Runner: unpaid rule and caps (D8), priority-fee floors, router allowlist, prices from the shared module, "deliver straight away" for unpriced tips at or above 1%
- [ ] Runner hot wallet funded with a small balance on both chains
- [ ] Status page and indexer on the mainnet deployment file; backups of the backend database

Release
- [ ] Deployment file and ABIs in the release; D10 and D11 applied; copy checked against mainnet settings (F3)
- [ ] `next.zkb.fi` first; reproducible build checked; `promote.sh` to stable

Launch
- [ ] Team transfers both ways, every token kind, small amounts
- [ ] Watch period passed (light clients, GPU and runner spend, delivery times)
- [ ] Accepted risks re-confirmed (D16); caps lifted; alerts on (D14)
