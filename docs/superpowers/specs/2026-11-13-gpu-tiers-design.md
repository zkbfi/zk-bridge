# GPU tiers: every choice of GPU, wait and batching in configuration

Date: 2026-11-13. Status: built on `feat/gpu-tier-start-wait` (prover) and `feat/gpu-tiers-config` (RunPod file, apply script, batching key).

Owner, 2026-11-13, verbatim:

> can we get smarter about the gpus we grab? are there any others? can we iterate through a list?

> i am fine with waiting 30s to start, but lets put all of these decisions into configurations

Earlier the same day the owner asked whether we keep to $1/day of GPU. Measured over the last 7 full days (11-06 to 11-12)
the average was $1.34 a day. The price of a GPU-hour rose from $0.76 (11-06 to 11-10) to $1.18 to $1.79 (11-11 to 11-13)
while the GPU time per light-client update stayed at about 92 to 99 s, and the number of light-client update jobs rose
from about 40 to 74 a day.

## Intent

1. Take the cheapest GPU that can run a light-client update. Pay for a dearer one only when no cheap one is ready
   within 30 s.
2. Never pay for an 80 GB GPU (A100, H100) on testnet.
3. Every choice here lives in a configuration file, not in the RunPod console and not in code: the GPU types of each
   tier, the order of the tiers, the wait before the next tier, the workers, the idle timeout, the image, and the
   batching rule that lets a transfer start its own light-client update.

## Tiers

A tier is one RunPod serverless endpoint with one price band of GPU types. The prover tries the tiers in order.

Planner's first configuration (owner may change):

| Tier | GPU groups (RunPod ids) | Cards | Wait before the next tier |
|---|---|---|---|
| `gpu-24gb` | `ADA_24`, `AMPERE_24` | RTX 4090, L4, RTX 3090 (RTX A5000 excluded, as today) | 30 s |
| `gpu-32gb` | `ADA_32_PRO` | RTX 5090 | 30 s |
| `gpu-48gb` | `ADA_48_PRO` | L40S, RTX 6000 Ada (L40 excluded, as today) | the full cold-start wait (last tier) |

No `AMPERE_80` and no `ADA_80_PRO` tier.

### "Waiting 30 s to start"

Today the prover sends the job and RunPod holds the request (up to about 5 minutes) while a worker starts. It cannot
tell "starting" from "proving". The new rule:

- Before it sends a job to a tier that has a start wait, the prover asks `/ping` of that tier until the worker answers
  200 (ready). If the tier is not ready after its start wait (30 s), the prover also wakes the next tier with `/ping`, and
  sends the job to the first tier that answers ready, preferring the earlier tier when both are. Planner's call: escalate,
  don't abandon. The started cheap worker is not thrown away; it may still win the race. The prover still never sends
  one job to two endpoints.
- A tier that answers ready within its start wait gets the job at once, as today.
- The warm-up of the backend keeps pinging only the first tier, so in the usual case the cheap worker is already
  ready.
- Every job records the tier that proved it (`endpoint`) and, with image `v9`, the GPU (`worker_gpu`), so the cost of a
  light-client update per card can be measured.

## Configuration

1. **RunPod endpoints, declared in the repository:** `deploy/runpod/endpoints.json`. It holds no secret: the template
   (image by digest, disk, ports, environment variable names and values that are not secret) and each tier (name, GPU
   ids in order, workers min and max, idle timeout, FlashBoot, execution timeout). A script `deploy/runpod/apply.mjs`
   reads it and the live RunPod state, prints the differences, and changes RunPod only with `--apply`. It creates a
   missing tier and never deletes an endpoint that is not in the file (it lists it instead). The key comes from the
   environment, never from the command line.
2. **The backend's endpoint list:** `remote.endpoints` in `backend.json`, one entry per tier in the same order, with
   the new `startWaitSeconds` (30) and the existing `readyWaitSeconds`, `timeoutSeconds` and `attempts`. The backend
   writes them into the prover's file (`start_wait_seconds`).
3. **Batching:** a new key on the batch levels of `watch` (pair or direction): `unpricedAtMaximumPays` (default
   `true`, today's rule). With `false`, a message whose token has no price and whose tip is at the automatic maximum no
   longer makes its batch pay at once; it waits for `minIntervalSeconds` like any other. Testnet sets it to `false`,
   so the traffic bot's transfers share one light-client update an hour per direction. Priced fees still count.

## Non-goals

- No change of contracts or of the proof.
- No per-GPU program: every tier runs the same image.
- No automatic change of tiers from measured cost; the measurements inform the next edit of the file.
