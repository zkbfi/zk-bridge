# Transfer progress through the proving pipeline

Owner, 2026-11-01, verbatim:

> we should also be updating things like indexer.zkb.fi or the frontend to show the progression of each small piece so
> that we can show users when they are waiting on server a or service b. this may require us to expose a bit more
> information than we are now such as i have the proof but i do not type of get endpoints

> i look forward to seeing actual timing from bridges and proofs being generated.

## What exists (branch `feat/pipeline-progress`)

- Backend routes on the prove host (prove.zkb.fi): `GET /progress/:messageId`, `GET /directions/:direction/pipeline`,
  `GET /benchmarks?window=24h`. Shapes, stage keys, services and steps: explorer/backend/README.md, "Pipeline reads".
- `@zkb/data`: `createBackendClient({ baseUrl, fetchJson, postJson })` has `progress(messageId)` (null for an unknown
  message), `pipeline(direction)` and `benchmarks(window)`; the schemas `transferProgressSchema`,
  `directionPipelineSchema`, `benchmarksSchema`; `PIPELINE_STAGES`, `WAITING_SERVICES`, `WAITING_SERVICE_TEXT` (one
  sentence per service) and `BENCHMARK_STEPS`.
- indexer.zkb.fi: a "Proving pipeline" section per direction, "Look up a transfer" with the timeline, and "Recent proof
  timings".

## For the web app (bridge-ui session)

A transfer timeline in the dapp needs only `progress(messageId)`, polled every 15 s while the transfer is not
`delivered` (60 reads a minute per caller; a 429 carries `Retry-After`):

- Draw `stages` in order: `done` with `at`, the one `current`, the rest `pending`.
- Under the current stage, say what it waits on: `WAITING_SERVICE_TEXT[waitingOn.service]`, "since" `waitingOn.since`,
  and "expected" `waitingOn.eta` when present. An `eta` in the past means the step runs late, not that it is done.
- `proof.where` answers "we have the proof, it is not on chain yet": `stored` (made), `board` (on the msgboard),
  `applied` (on chain).
- `waitingOn.service === "none"` ends the timeline; for `failed_call` or `release_failed` the `delivered` stage carries
  the outcome in `detail`.
- The GPU services (`gpu-worker-start`, `gpu-proving`) are estimates from recent proofs; say "about".

Copy: say what happens (memory: user-facing copy tone); nothing dismissive.
