# RunPod REST API v2

Date: 2026-11-16. Status: being built.

Owner, 2026-11-16, verbatim:

> also, it seems like runpod updated their api recently and depricated their v1 api. we need to make sure we are using the
> right one and that we are using all the best features of iit

## What changed at RunPod

- REST API v1 (`https://rest.runpod.io/v1`) was retired on 2026-11-15. Its host no longer answers: from the server,
  `rest.runpod.io` gives no connection. RunPod's guide: https://docs.runpod.io/api-reference-v2/migrate-from-v1.
- REST API v2 is `https://api.runpod.io/v2`, same Bearer key; the server's existing key works on it (checked 2026-11-16).
  Schema: https://api.runpod.io/v2/openapi.json (version 2.0.0).
- GraphQL (`https://api.runpod.io/graphql`) is retired "in early 2027", no date yet.
- The serverless runtime (`https://<id>.api.runpod.ai`, `/ping`) is a different API and does not change.

## What zkb.fi used, and the effect

| Use | Today | Effect |
|---|---|---|
| Per-endpoint GPU spend (backend `billing.ts`) | REST v1 `GET /billing/endpoints` | **Broken since the retirement**: the backend logs `billing_spend_unreadable` every 15 min; the spend figures are stale |
| Account balance (backend `billing.ts`) | GraphQL `myself { clientBalance }` | Works; v2 has no balance read (RunPod: "Keep using the GraphQL API for this") |
| Idle timeout read (backend `idle-timeout.ts`) | GraphQL | Works until early 2027 |
| Status page RunPod check (`explorer/status/src/checks/prover.ts`) | GraphQL | Works until early 2027 |
| `deploy/runpod/apply.mjs` | GraphQL `saveEndpoint`, `saveTemplate` | Works until early 2027 |
| Prover jobs, warm-up `/ping` | `<id>.api.runpod.ai` | Unchanged |

## Intent

1. Fix the spend read now: v2 `GET /v2/billing/serverless` (`serverlessId`, `bucketSize`, `startTime`, `endTime`;
   records carry `gpuAmount`, `diskAmount`, `totalAmount` per bucket).
2. Move every other read and write to v2, so GraphQL is left only for the balance (no v2 equivalent) and nothing breaks
   when GraphQL goes.
3. Use what v2 adds where it helps zkb.fi (below).

## v2 shapes (read from the live API and the schema)

An endpoint (`GET /v2/serverless/{id}`) carries its container config itself: `image`, `env`, `disk`, `ports`,
`registry`, plus `type: "LOAD_BALANCER"`, `scaling: {type: "REQUEST_COUNT", requestCount}`, `workers: {min, max,
idleTimeout}`, `timeout` (ms), `flashboot` (`OFF` | `FLASHBOOT` | `PRIORITY_FLASHBOOT`), `gpu: {pools, excludedTypes,
minCudaVersion, allowedCudaVersions, count}`. `PATCH /v2/serverless/{id}` changes only the fields given; unknown fields
are a 422. Lists are paginated (`pagination.nextCursor`, `hasNextPage`). Errors are RFC 9457 (`title`, `status`,
`detail`).

Templates are copied into an endpoint at creation and not linked afterwards ("Template edits don't reach existing
resources"), so one endpoint per template is no longer a constraint.

## Changes

1. **`endpoints.json` and `apply.mjs` on v2.** The shared container settings (image by digest, disk, ports, env,
   registry id) stay in one place in the file and are written to each tier's endpoint directly; the per-tier templates
   go. Each tier declares `gpu.pools`, `gpu.excludedTypes`, `gpu.minCudaVersion`, `workers`, `idleTimeout`,
   `flashboot`, `timeoutMs`, `scaling`. Dry run by default, `--apply`, `--delete-retired` as today. The script lists
   RunPod templates that no endpoint in the file needs and deletes them only with a flag.
   Live drift to settle in the file: `gpu-24gb` has `minCudaVersion` 12.8, `gpu-48gb` 12.0 (planner's call: 12.8 on
   all three, the image's CUDA; the builder checks the image's CUDA first).
2. **Idle-timeout read and status check on v2** `GET /v2/serverless/{id}`.
3. **Status: stale workers.** `GET /v2/serverless/{id}/workers` gives `endpointVersion` and per-worker `isStale`. The
   status page says when a worker still runs an older endpoint configuration (for example the image before a rollout).
4. **Cold starts, measured.** `GET /v2/serverless/{id}/metrics/cold-starts` per tier feeds the stats the backend
   already reports, so the 30 s start wait can be judged from RunPod's own counts.

## Planner's calls (owner may change)

- `PRIORITY_FLASHBOOT` is not turned on: RunPod does not publish its price in the schema; it stays `FLASHBOOT` until
  priced.
- The balance stays on GraphQL until RunPod offers a v2 read; the status page names this as the one GraphQL use.
- Not adopted: worker affinity (`X-Runpod-Worker-Id`; one job per worker today), batch jobs (queue endpoints), global
  volumes (the image carries its keys).

## Non-goals

- No change to the prover, the worker image, or how jobs are sent.
