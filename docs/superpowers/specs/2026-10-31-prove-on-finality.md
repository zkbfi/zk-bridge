# Prove on finality: design

Date: 2026-10-31. Status: built on branch `feat/backend-prove-on-finality`, not deployed.

## The owner's words

- "the proof should start running within seconds of the finalization/ sufficient signatures"
- "we need to not be wasting time with the runpod proving. we need it to work and work quickly and get out of there asap"

## Before

A proof started only when someone called `POST /requests`. The publisher bot (polls every 30 s) is not running on the
server, and the keep-alive timer runs every three hours. A message could wait hours for its proof, and the RunPod
worker (min workers 0) started cold, about 24 s, only once the prover asked.

## Design

- **Where:** a `watch` part of the backend's `requests` module (`explorer/backend/src/watch/`). It starts jobs through
  the same request service as `POST /requests`, with the reason `finality` and the caller `watch`, so every gate
  applies: the indexer must show a need, 120 s between jobs, 96 jobs per direction per day, one active job per direction.
- **Learn of finality within seconds (`feed.ts`):** per direction, the source beacon node's event stream
  (`/eth/v1/events?topics=head,finalized_checkpoint[,light_client_finality_update]`). When the stream fails, closes,
  holds its headers 10 s, or is silent for three slots, the feed polls every slot (12 s Ethereum and Sepolia, 10 s
  PulseChain) and tries the stream again after 5 s, doubling to 5 minutes. Log: `watch_transport` (sse or poll).
- **Read what the prover will prove:** a node that serves `/eth/v1/beacon/light_client/finality_update` is read through
  it (the update the prover takes). A node that does not (the PulseChain nodes) is read the way the prover builds its
  update: the newest block with a child, signed by the child's sync aggregate. So a new finalized slot counts once a
  block after it exists.
- **Sufficient signatures:** the update's `sync_committee_bits` must hold at least 342 of 512: the program's two-thirds
  rule (`lc_core::chain::MIN_PARTICIPANTS`; the contract trusts the program's proof). A test reads lc-core to keep the
  number equal. Fewer: no job; the next block's signatures are read.
- **Due (`decide.ts`, pure, tested):** a waiting message lies after the light client head (or after a posted proof that
  still starts at the head) and at or before the new finalized slot; or the keep-alive planner (`keepalive/plan.ts`)
  calls for a keep-alive or handoff steps. Nothing while the source signs in a period that finality has not reached, or
  when the light client is stranded.
- **No duplicates:** one finalized slot starts at most one job; a running job is never joined; a refusal is retried once
  per wait (rate limit up to 10 minutes; "nothing to prove" three times 15 s apart, the indexer may lag a block).
- **Warm the GPU (`ping` on a 15 s scan):** `GET <remote.endpoint>/ping` from 45 s before the expected finality of each
  sent message (start of epoch e + 3, plus one slot) or of a keep-alive the next finality makes due, every 30 s until
  90 s after it, at most one session per direction per 5 minutes, never while a job runs. The URL and key never reach
  the log.
- **Metrics in the log:** `finality_seen` (slot, source sse or poll, latency from the signature slot's start),
  `proof_due` (why), `job_started` (reason `finality`, `latencyMs` from the finality event; target under 5 s),
  `warmup_ping` (status only).
- **Config:** `watch` in backend.json; on by default when `indexerUrl` and the source beacon endpoints are set. The
  three-hour keep-alive timer stays as the backstop.

## Correction, 2026-11-01

Owner, verbatim: "it looks like half of the runpod runs are failing. it is wasting a lot of usage."

The rule above let a keep-alive start at every finality while the committee deadline sat inside the planner's margin.
A proof inside the head's own period cannot hand off to the next committee, so on 2026-10-31 the watcher paid for 47
proofs in six hours that changed nothing, and 32 warm-up pings timed out on our side while RunPod still counted and
started a worker for each. The rule now (commit c8663d76):

- **Keep-alive due** only when a proof can make progress: the source has finalized a later period than the head's (or
  the planner needs handoff steps), the head is older than `keepAliveSeconds`, or there is no head. A young head in the
  source's finalized period is not due, however close the deadline. At most one keep-alive per direction per period.
- **The request service** takes the watcher's word only for a handoff (`plannedHandoff`); everything else goes through
  the indexer's check.
- **Warm-up:** one ping at a time per direction, waiting up to 300 s (`warmup.pingTimeoutSeconds`), only before a sent
  message's finality or a due handoff; a 200 ends the session, a timeout is logged at info and not repeated at once.

## Adaptive warm-up, 2026-11-01

Owner, verbatim:

- "it also seems to me that we should be able to "warm" a prover before the finalization actually occurs. if we have known cold starts or we can see ahead of time that the indexer has bridges that will be ready to prove upon, then we should be able to time that fairly well, right?"
- "the proof should start running within seconds of the finalization/ sufficient signatures"
- "try to reduce costs wherever you can"

Before: one ping 45 s before the expected finality. Measured cold starts run from about 24 s (image cached) to about
400 s (a 20 GB image pull), and the endpoint's 60 s idle timeout stops a worker woken more than a minute early, so a
fixed lead was either too short for a pull or too long to hold. A warm RTX 5090 proves in about 36 s.

The rule now (branch `feat/adaptive-warmup`; code in `explorer/backend/src/watch/warmup.ts`, `warmup-store.ts`,
`decide.ts` `warmupPlan`, `watcher.ts`):

- **Learn the cold start.** The backend database keeps observed times to a ready worker (`warmup_observations`): a
  warm-up session's first ping to its first 200 when that took 5 s or more; the wait of a ping that timed out (a lower
  bound); and the prover's `wait_worker_ms` (`prove_timing`, returned with the proof) of a job with `not_ready_count`
  above 0 while no warm-up session ran. Lead time = p90 (nearest rank) of the newest 20, clamped to [30 s, 600 s];
  90 s until there is one. Both directions share the observations: one endpoint serves both.
- **Look ahead.** Due times: each sent message's expected finality (start of epoch e + 3, plus one slot), and the
  finality that carries the source into the next period for a handoff, looked for as far ahead as the lead time. The
  handoff target is when finality crosses the border (about two epochs after it), not when the clock does: before
  this change the target sat at the border, about 11 to 13 minutes before the prover could take the handoff. A session
  starts at due time minus lead time.
- **Hold it warm.** After the first 200 the worker is kept with a ping `holdIntervalSeconds` (40 s) after the last 200,
  on its own timer, below the 60 s idle timeout (after a hold not answered ready, the next waits 30 s). One ping outstanding per direction at most; one session per
  direction. The session ends when the job starts (`warmup_used`), when its messages are delivered or covered, when the
  due time is past by `graceSeconds` (90 s), or at the daily cap (`warmup_wasted` with the reason).
- **Cost guard.** `dailyCapSeconds` (3600) of sessions in any 24 hours, both directions together; over it no session
  starts (`warmup_capped`) and a warm one stops at its next hold. No warm-up for a keep-alive that is not a handoff
  (unchanged). Every session is a row in `warmup_sessions` (lead, due, start, ready, end, outcome), and the log carries
  `warmup_scheduled`, `warmup_ready`, `warmup_held`, `warmup_used`, `warmup_wasted`, `warmup_observed`,
  `warmup_missed`, so the warm seconds and their use can be audited.
- **Not done, and the trade-off.** The backend does not raise the endpoint's `workersMin` ahead of a proof: the server
  holds no RunPod management key, only the key that calls the endpoint. A warm worker held by `workersMin` would cost
  less in pings but bills for every idle second until something lowers it again. So a 400 s image pull is covered only by a lead time learned from it (up to 600 s), and a
  held worker is kept by pings alone. The one assumption to check on the server: that a `/ping` through the
  load-balancing endpoint counts as a request for the worker's idle timeout. `warmup_used` followed by a job with
  `not_ready_count` above 0 (`warmup_missed`) would show it does not; then the hold needs a cheap real request instead.
- **Config:** `watch.warmup` in backend.json: `enabled`, `leadP`, `leadObservations`, `defaultLeadSeconds`,
  `minLeadSeconds`, `maxLeadSeconds`, `holdIntervalSeconds`, `intervalSeconds`, `graceSeconds`, `minGapSeconds`,
  `dailyCapSeconds`, `pingTimeoutSeconds`. The old `leadSeconds` still loads and does nothing (`config_ignored`).

## Batching, profit and deduplication, 2026-11-01

Owner, verbatim:

- "seems like it would be best to have these proofs be posted if and only if they have erc20s moving across the bridge. otherwise they are useless."
- "add a configurable wait up to n minutes to the watcher. lets make it scoped to chains/pairs as well. that way we can say, for testnet, only do 1 per hour, and for mainnet's do on demand"
- "or, perhaps the more reasonable thing to do is to just calculate the profit (0 on testnets) and when it is profitable to do it then do it, otherwise fallback to a min wait time"
- "*prove as soon as the fees of finalized or soon to be finalized bridges covers the cost"
- "you should also have deduplication logic in place so that you are never re-proving some proof you already have"

The default stays as before ("the proof should start running within seconds of the finalization/ sufficient
signatures"): `maxWaitSeconds` 0 proves at the first finality that covers a waiting message.

The rule now (branch `feat/watch-batch-window`; code in `explorer/backend/src/watch/batch.ts`, `economics.ts`,
`decide.ts`, `watcher.ts`, `src/requests/held-proofs.ts`, `service.ts`):

- **Config.** `watch.maxWaitSeconds` (the fallback), `watch.lookaheadSeconds` (default one epoch of the source chain),
  `watch.profitMargin` (1.0), overridable per pair and per direction in `watch.pairs`, e.g.
  `{ "sepolia-pls943": { "maxWaitSeconds": 3600, "directions": { "first-to-second": { "maxWaitSeconds": 1800 } } } }`.
  A direction beats its pair, a pair beats the global value. Pair names must be in `PAIR_DEFINITIONS`, directions in
  `PROOF_DIRECTIONS`, and numbers must not be negative. `limits.pendingProofStaleSeconds` (600) for the dedup rule.
- **Profit.** The batch is every waiting message the head does not cover. Fees: what the fee address receives, the
  delivery router's `expectedFee` for each message's director, valued with the PulseX price rules at one named PulseChain
  block (testnet tokens have no price, so 0). Cost: `PROOF_COST_USD` plus `deliveryGasUsd` per message on the
  destination (newest base fee, the chain's minimum tip, `requiredDeliveryGas` of a release), times the margin. Integer
  USD × 1e18. The runner is not paid; profit means the fee address's take covers our costs.
- **Due.** A message proof is due at a finality when the fees of the messages final by that slot cover the cost, or when
  the oldest of them has been final for `maxWaitSeconds` (from its expected finality). The proof covers every message
  final by that slot. Unknown prices (no route, an RPC error, no PulseChain endpoint) never prove early.
- **Soon to be final.** Messages that will be final within `lookaheadSeconds` count toward the expected start: the first
  expected finality at which the cumulative fees (ordered by expected finality) cover the cost. The watcher waits for it
  rather than proving part of the batch, unless the fallback comes first. A proof only ever targets a finalized header.
- **Liveness first.** A handoff and a keep-alive of the age rule are never delayed; waiting messages ride along.
- **Warm-up.** One session per batch, at its expected start (now if due, else when it pays, else the fallback),
  worked out again on every scan.
- **Testnet and mainnet.** Testnet `maxWaitSeconds: 3600`: nothing pays there, so under steady traffic a direction
  gets at most about one message proof per hour. That is at most one per window per direction, not a schedule. Mainnet
  `maxWaitSeconds: 300` with the profit rule: a paying batch proves at once ("on demand"), others within five minutes.
- **Deduplication.** Before any job starts (watcher, `POST /requests`, the keep-alive march), the backend reads the
  proofs it has: the board's (`proofs`), the webhook's (`webhook_proofs`) and the newest job's slots. One that starts
  at the head can still land: no new proof starts from that head, for messages inside it or after it, and a pending
  handoff counts too (`proof_pending`). After `pendingProofStaleSeconds` it no longer holds a new proof back
  (`proof_pending_stale`). The watcher's target (direction, head, finalized slot) gets one job ever (unique in SQLite,
  across restarts and failures; `duplicate`), and a webhook proof with the slots of an earlier one is not stored
  (`proof_duplicate`).
- **Logs.** `proof_not_due` why `waiting-for-profit` (fees, cost, `startAt`, `maxWaitAt`); `proof_due` why `message`
  with `trigger` (profit or max-wait), `batch`, `waitedSeconds`, `feesUsd`, `costUsd`; `riders` on a handoff.
