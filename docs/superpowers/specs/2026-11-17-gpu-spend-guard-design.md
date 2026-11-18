# GPU spend guard

Date: 2026-11-17. Builds on the RunPod REST v2 migration (`2026-11-16-runpod-api-v2-design.md`, same branch).

## Owner's words (verbatim)

- "mother fucker you have 3 gpus running for literally zero apparent reason. costing me $50/day"
- "please also set a spend rate limit of $0.50/hr?"
- "correct, we need to be using its v2. and we need ot figure out what was running to make sure weare not experiencing a leak in our gpu usage"
- On the plan (guard on the backend, trips on spend over $0.50/hr per tier or a worker stuck `running`; stop the tier,
  not everything): "do it"

## What happened (measured 2026-11-17 from RunPod v2)

From 2026-11-14 18:00 UTC to 2026-11-17 12:00 UTC the account spent ~$143 more than normal. Per endpoint
(`GET /v2/billing/serverless`, 11-14 12:00 → 11-17 16:00): gpu-24gb $77.21, gpu-48gb $61.39, gpu-32gb $4.44.

- gpu-48gb billed one worker at its full rate ($1.90/h) 11-14 18:00 → 11-15 10:00, 11-16 16:00 → 22:00,
  11-17 02:00 → 12:00. gpu-24gb billed one worker ($1.34/h) 11-15 03:00 → 11-17 12:00 without a break. Both ended only
  when the balance went below zero.
- Each began during a proof whose `wait_worker_ms` was ~125 s: the prover pings every tier in the race
  (`prover/src/remote.rs`), so the losing tiers start a worker too. gpu-32gb got the job each time.
- RunPod's worker metrics (`GET /v2/serverless/{id}/metrics/workers`) show that worker as `running` every hour, so the
  5 s idle timeout never applied. RunPod's request metrics for gpu-24gb in those hours: 5–12 requests an hour, every one
  `failed`, none `completed`, execution time 0, delays ~10 s (the prover's ping timeout) and ~300 s (the warm-up ping
  timeout). The worker was billed as busy and answered nothing.
- Not known: whether the container hung or RunPod's proxy lost it. The leaked workers are gone and the log API returns
  only RunPod's system lines. Workers started on 2026-11-17 stopped normally.
- The backend did not see any of it: its spend read used REST v1, retired 2026-11-15 (fixed by the v2 migration).

## Intent

A guard in the backend that stops a tier which leaks, without stopping the others, so testnet keeps proving. It does
not depend on knowing why a worker got stuck.

## Design

New backend module `gpu-guard.ts`, started next to the billing and idle-timeout readers in `main.ts` when RunPod
endpoints are configured. Every RunPod call goes to REST v2 (`RUNPOD_REST_URL`), key in the Authorization header only,
never logged; RFC 9457 errors logged with `problemText`. It never throws, never blocks start-up, and a failed read of
one tier does not stop the others.

### Signals (per tier, i.e. per configured RunPod endpoint)

1. **Stuck worker** (fast). Every `checkSeconds`, `GET /v2/serverless/{id}/workers`. A worker id whose `status` is a
   billed, busy state (`RUNNING`, `INITIALIZING`, `UNHEALTHY`; not `IDLE`, `THROTTLED`, `EXITED`) at every check for
   longer than `stuckMinutes` trips the tier. The guard keeps, per worker id, when it first saw it in such a state; a
   check where the worker is gone or in another state clears it. A proof takes 1–3 min and the endpoint timeout is
   10 min, so 15 min of `RUNNING` is not a proof.
2. **Spend** (slow backstop). Every `spendCheckSeconds`, `GET /v2/billing/serverless?serverlessId=…&bucketSize=hour`
   for the last 3 hours. A completed hour bucket with `totalAmount` above `maxUsdPerHour` trips the tier. A bucket is
   checked once (keep the start times already judged), so one bad hour trips once.

### Action

- **Trip:** read the endpoint (`GET /v2/serverless/{id}`), remember its `workers` (`min`, `max`, `idleTimeout`), then
  `PATCH /v2/serverless/{id}` with `{ workers: { min: 0, max: 0, idleTimeout } }`. Setting max to 0 stops the stuck
  worker. Log `gpu_guard_tripped` at error level: tier label, endpoint id (short), signal (`stuck-worker` or `spend`),
  the evidence (worker id, minutes running; or hour and amount), trips in the last 24 h.
- **Restore:** after `cooldownMinutes`, PATCH the remembered `workers` back; log `gpu_guard_restored`. Only a tier the
  guard itself zeroed is restored, and only if it still reads `max: 0` (someone else's change wins).
- **Hold:** the trip that makes `maxTripsPerDay` trips of a tier within 24 h is not restored. Log `gpu_guard_held` at
  error level. A held tier stays at 0 for the life of the process unless its live `max` is seen above 0 again (the owner
  ran `deploy/runpod/apply.mjs --apply`); then the hold clears and is logged as `gpu_guard_released`.
- A failed PATCH is logged and retried at the next check; the guard never marks a tier tripped that it did not change.
- The spend check keeps only the bill records whose `serverlessId` is the tier's endpoint (a record without one is skipped,
  as in `parseBillingRows`) and adds the records of one `startTime` together before it compares with `maxUsdPerHour`.

### Restart

The state of each tier (`zeroed` with the workers to put back and `restoreAt`, `held`, the trip times and the last trip) is
kept in the backend database, table `gpu_guard_state`, one row per endpoint id. It is written after every trip, restore,
release and hold, and read when the guard is created (`gpu_guard_state_loaded`). A tier that was in a cool-down continues
it (and is restored at the next check once `restoreAt` has passed), a held tier stays held until its live `max` is seen
above 0, and trips keep counting within 24 h, so a restart cannot bypass `maxTripsPerDay`. An unreadable row is logged
(`gpu_guard_state_unreadable`) and the tier starts clean; a failed write is logged (`gpu_guard_state_unsaved`) and the
guard goes on with the state in memory.

### Configuration (`backend.json`, zod in `config.ts`, all with defaults)

```json
"gpuGuard": {
  "enabled": true,
  "checkSeconds": 300,
  "stuckMinutes": 15,
  "spendCheckSeconds": 3600,
  "maxUsdPerHour": 0.5,
  "cooldownMinutes": 10,
  "maxTripsPerDay": 3
}
```

`checkSeconds` 300 keeps v2 calls near 3 × 288 = 864 a day for the workers list. The defaults are the owner's $0.50/h.

### Visibility

- The guard's state per tier (`ok` | `tripped` until a time | `held`, last trip with its signal and evidence) is part
  of the backend's private billing figures (`figuresOf`), not the public ones.
- The status service's RunPod check reports a tier the guard tripped or holds (it already reads the backend or RunPod;
  pick the smaller change and say which in the PR).

## Out of scope

- The prover's race (it stops pinging once one tier wins) and the worker image.
- RunPod's account-wide $80/h limit: RunPod has no API or console setting to lower it; only support can.
- Making the guard the owner of `workersMax`: `endpoints.json` stays the source; the guard is an emergency override.

## Checks

- Unit tests with a fake fetch and clock for: stuck detection across checks (cleared by a gap, not tripped before
  `stuckMinutes`, tripped after), states that do not count (`IDLE`, `THROTTLED`), spend over and under the limit,
  bucket judged once, trip PATCH body, restore after cool-down, no restore when someone else changed `max`, hold at
  `maxTripsPerDay`, release when live `max` > 0, one tier failing does not stop another, key never in a log line.
- Backend coverage gates stay green; `tsc` clean.
