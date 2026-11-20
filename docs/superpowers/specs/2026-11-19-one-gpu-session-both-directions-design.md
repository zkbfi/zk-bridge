# One GPU session for both directions, and no warm-ups

Date: 2026-11-19. Status: approved for implementation.

## The owner's words

- "can we get the spend rate back down to ~$1?"
- "do we no longer need the warm up? and yeah, doing both directions in one session sounds like a great idea"

## What the money buys today (measured 2026-11-18 00:00 to 2026-11-20 04:40 UTC, 52.5 hours)

| Item | Count | GPU time each | Total |
|---|---|---|---|
| Light-client updates, both directions of `sepolia-pls943` | 91 (~42 a day), every one triggered by a waiting message | 62 s on the worker (RTX 4090, gpu-24gb) | 5,640 s |
| Warm-ups (`warmup_sessions`) | 80 | boot ~31 s, then ~38 s ready and waiting for the proof | 5,918 s billed |

RunPod billed $4.58 for the period (per-endpoint v2 billing), about $2.10 a day, about $0.000396 a GPU-second.

A warm-up does not save GPU time: the boot it pays for (~31 s) is billed to the proof when there is no warm-up. What it adds is the wait between a ready worker and the proof (~38 s a session) and the sessions that reach their cap unused (5 sessions, 832 s). Its only gain is ~31 s less latency for a proof, which no one sees on an hourly testnet and which is small next to the finality wait on mainnet.

The two directions prove at different minutes of the hour, so each pays its own boot and its own idle timeout.

## Decision 1: warm-ups are off

- The server config sets `watch.warmup.enabled: false`. The code default stays `true` for now (so a config without the key behaves as before); the deploy runbook and the example config name the setting.
- Expected saving: ~3,400 GPU-seconds over the 52.5 hours, about $0.60 a day.
- Without a warm-up the proof pays the cold start, and the first tier's start wait must cover it: after
  `startWaitSeconds` the prover also pings the next tier, which boots a second worker that is billed until it idles.
  Cold starts measured 2026-11-13 to 2026-11-20 (129): median 28 s, p90 41 s, p99 56 s, max 151 s; 41% were over the
  old 30 s. The gpu-24gb tier's `startWaitSeconds` is 60 on the server (set 2026-11-20 05:22 UTC) and in the example.

## Decision 2: when one direction proves, the other proves in the same session

When the watcher starts a proof for one direction of a pair (any reason: batch due, minimum interval passed, keep-alive, urgent), it looks at the other direction of the same pair in the same tick. The other direction is a **companion** when it would start a proof now if its minimum interval had passed:

- it has at least one waiting message that the light client can cover now (final, past the head), or its keep-alive is due within its `minIntervalSeconds`;
- nothing else would stop it: no proof already queued, proving or pending for it, its participation rules hold, the GPU guard has not zeroed the tiers, the daily budget allows it.

A companion starts at once, right after the first proof is handed to the prover, and skips only the minimum-interval wait. Both requests go to the same endpoint, one after the other, so RunPod gives the second to the worker the first one started (the tier holds at most one worker): one boot for both.

- Config: `watch.pairs.<pair>.companionProofs` (boolean, default `true`); a direction entry may turn it off for itself.
- Log: `proof_companion` with the direction that triggered it, the companion direction and why the companion was eligible (`messages` or `keep-alive`); and `proof_companion_skipped` with the reason when the other direction was looked at and not started (only when it had waiting messages).
- The companion's job is an ordinary job (same table, same timings), so `job_timings.wait_worker_ms` shows whether it found a warm worker.

Expected effect: about one session an hour instead of two. With warm-ups off, a session costs one boot (~31 s) plus two proofs (~124 s) plus the idle timeout (5 s), against ~2 x (31 + 62 + 5) s today: about $1.20–1.35 a day. Proving every two hours on testnet (`minIntervalSeconds: 7200`) would take that to about $0.65; that is the owner's call and is not part of this change.

## Not in scope

- Changing the testnet interval (stays 3600 s).
- Removing the warm-up code. It stays behind the flag until mainnet shows whether latency matters there.
- Proving both directions in one request to the worker (one job, two proofs). Two jobs on one warm worker get the same saving without a change to the prover image.

## Checks

- Unit tests: a due proof in one direction starts a companion when the other has a coverable waiting message or a keep-alive due within its interval; no companion when the other direction is proving, pending, blocked by participation, zeroed by the guard, over budget, or has `companionProofs: false`; a companion never starts a third job; the companion skips only the interval. Backend coverage stays 100%, `tsc` clean.
- Live, the 24 hours after the deploy: count sessions (jobs of both directions starting within 2 minutes of each other count as one), `wait_worker_ms` of companions (expect near 0), no `warmup_*` events, and the per-endpoint bill. Target: at most ~$1.35 for the day; report the real figure.
