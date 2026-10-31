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
