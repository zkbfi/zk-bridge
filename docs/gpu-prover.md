# GPU prover

This document explains how to prove on a rented GPU that exists only while a job runs. The proof producer (`zk-bridge-prover prove`) sends each proof job to a worker in a container. The worker runs on RunPod Serverless. You pay for the seconds that the worker runs.

The producer keeps no state and sends no transaction. It hands each proof to a stateful server, which stores it and sends it to the chain (see `prover/README.md`).

Nothing here changes what the contracts trust. A proof that the verifier contract accepts is valid, whoever made it. The worker holds no key and no secret of the bridge.

## How it fits together

```
proof producer (prove command)                  RunPod Serverless endpoint
  native run of lc-core  (refuses a bad input)
  POST /prove  ------------------------------->   prove-worker  (one container, one GPU)
  Authorization: Bearer <API key>                    native run again
                                                     SP1 GPU server: Groth16 proof
  <-------------------------------------------      proof + public values
  checks the answer, then hands the proof off
  (standard output or a webhook of a stateful server)
```

The pieces in this repository:

| Piece | File | Needs a GPU |
|---|---|---|
| `RemoteProver`, the client | `prover/src/remote.rs` | No. It is in the default build. |
| Request handling of the worker | `prover/src/worker.rs` | No. It is in the default build and has tests. |
| Worker binary `prove-worker` | `prover/src/bin/prove_worker.rs` | Yes. Cargo feature `sp1-cuda`. |
| The proving code on the GPU | `Sp1CudaProver` in `prover/src/prover.rs` | Yes. Cargo feature `sp1-cuda`. |
| Image | `docker/Dockerfile`, target `prover-gpu-worker` | Yes, at run time. |

`Sp1CudaProver` and the prover on the processor, `Sp1Prover`, are one generic type, `Sp1ClientProver`. Only the proving client differs. The native run, the program key check, the check of the proven public values and the local verification are the same code.

## Why a load balancing endpoint

RunPod offers two kinds of Serverless endpoint.

- A queue endpoint runs a handler function that the RunPod library calls. You send jobs to `/run` and read results from `/status`.
- A load balancing endpoint forwards plain HTTP to a port in your container.

I chose load balancing, as you decided. It needs no RunPod library in the image, and the worker is an ordinary HTTP server that you can test on your laptop. I did not add queue mode. Queue mode would add a second code path, a polling client and a dependency on the RunPod library, and I cannot test any of them without an account.

The limit of this choice is the processing time. See "Limits that matter" below.

## The worker contract

The page "Load balancing endpoints" (https://docs.runpod.io/serverless/load-balancing/overview, read on 2026-10-23) and the page "Build a load balancing worker" (https://docs.runpod.io/serverless/load-balancing/build-a-worker, read on 2026-10-23) give this contract. The worker follows it.

| Item | Value |
|---|---|
| Address of the endpoint | `https://ENDPOINT_IDENTIFIER.api.runpod.ai/PATH` |
| Authentication | `Authorization: Bearer <RunPod API key>`, checked by the RunPod proxy. The worker checks nothing. |
| Port of the API | Environment variable `PORT`. The default is 80. The image sets 8000, because the worker does not run as the superuser. |
| Port of the health check | Environment variable `PORT_HEALTH`. The default is the value of `PORT`. |
| Health path | `/ping` (variable `HEALTH_CHECK_PATH`, default `/ping`). 200 means ready. 204 means starting. Any other status marks the worker unhealthy, and RunPod removes it from the pool. The worker answers 503 for good when it refuses its host (MIG slice or too little host memory, see "GPU type requirement") and after a failed proof. |
| Wait when no worker is free | 2 minutes. |
| Processing time of one request | 5.5 minutes. |
| Size of a request or an answer | 30 MB. |
| A wrong port | The page says that the worker then stays up for 8 minutes and answers 502. |

The page does not say which status the proxy gives when no worker is available. It names the text "no workers available". The client waits on that text with any status.

On 2026-10-31 a cold endpoint (min workers 0, just after an endpoint change, while the hosts pulled the 20 GB image) held a request for about 5 minutes and then answered `400` with the body `{"status":400,"title":"Bad Request","detail":"timed out waiting for worker"}`. The worker became ready minutes later. The client treats this answer as "not ready yet" and waits (see "Cold start").

The routes of the worker:

| Route | Answer |
|---|---|
| `GET /ping` | 204 while the SP1 setup runs. 200 with `{"status":"ready"}` afterwards. 503 with `{"error":"..."}` for good when the worker refused its host or a proof failed. |
| `POST /prove` | 200 with `{"proof":"0x...","publicValues":"0x...","timings":{...}}`. `timings` is optional (see "Timing logs"). 503 with `{"error":"..."}` when the worker refused its host. |

The body of `POST /prove`:

```json
{
  "programKey": "0x<64 hex digits>",
  "statementKind": "lightClient",
  "guestInput": "0x<hex of the bytes that the guest reads>"
}
```

`statementKind` is `lightClient` or `forkObservation`. An error answer has the form `{"error": "..."}`. The statuses:

| Status | Meaning | The client |
|---|---|---|
| 400 with the RunPod `detail` "timed out waiting for worker" | The load balancer found no ready worker within its own wait. No proof ran. | Waits for the worker, up to `remote_cold_start_wait_seconds` (see "Cold start"). |
| 400 (any other) | The request is wrong, or the worker holds no program with this key, or the key belongs to the other statement kind. | Stops at once. |
| 422 | The program rejects the input. | Stops at once. |
| 500, 502, 429, no answer | The proof failed, a gateway error, a rate limit, or the request timed out. | Retries, up to `remote_attempts` requests. |
| 401, 403, 404, 405 | The endpoint turned the request away: the proxy does not take the key, or the address has a wrong path (the worker answers 404 and 405 only for a path or method it does not serve). No worker looked at the job. | Stops. With an endpoint list it moves to the next endpoint (see "Endpoint list"). |
| 503, 204, or the text "no workers available" | The worker still starts, or no worker is available. No proof ran. | Waits for the worker, up to `remote_cold_start_wait_seconds`. |

Only the `detail` field of a RunPod body counts for the first row. A 400 of the worker carries its text in `error`, so it stays final even if that text mentions a timeout. The client never sends a rejected input again, and it sends a job again only when no proof ran or the proof failed.

The worker proves one statement at a time. A second request waits, because one GPU runs one proof. It answers `/ping` during a proof, because each request has its own thread.

## What the prover checks

`RemoteProver` runs the program natively first, as every backend does. A rejected input never leaves your machine. It accepts an answer only when all of these hold:

1. The public values equal the public values of the native run of `lc-core`.
2. The proof has 356 bytes and starts with the selector `0x4388a21c` of the pinned verifier (`docs/sp1-version-policy.md`).
3. The Groth16 proof verifies for the program key that the caller asked for. The prover does this with the crate `sp1-verifier` 6.8.1 (published 2026-09-24, so it meets the age rule). The check takes a few milliseconds on the processor and needs no GPU and no `sp1-sdk`.

Check 3 also fixes the program key. A proof of another program does not verify under the key that the contract stores. So the remote backend needs no copy of the guest program files and no key of its own.

The chain stays the final check. The verifier contract refuses every proof that fails. The local checks save a transaction and a retry cycle when a worker is wrong.

The test file `prover/tests/remote_prover.rs` runs these checks against a fake worker with a real proof. The proof is `test/hardened/fixtures/sp1-proof-ethereum-update.json`. The tests cover: a good proof, wrong public values, wrong length, wrong selector, a proof for another key, a tampered proof, a worker that refuses, a timeout with a retry, and the cold start answers. Most of them need the fixture made anew (see the note at the top of the file). Three tests drive the transport alone and run today: a cold worker is awaited until it is ready (the RunPod 400, a 503 and a 204, then success), a cold start beyond the limit fails with a clear message, and every other 400 stops at once.

## Build and push the image

You need the two guest program files from the reproducible build (`docs/server-prover.md`, step 1). The build fails when their hashes differ from `light-client/program-keys.json`.

```
ELF_OUTPUT_DIR=light-client/elf light-client/scripts/program-keys.sh
docker build --platform linux/amd64 --target prover-gpu-worker \
  -t <registry>/<account>/zk-bridge-prover-gpu-worker:<tag> -f docker/Dockerfile .
docker push <registry>/<account>/zk-bridge-prover-gpu-worker:<tag>
```

Replace `<registry>`, `<account>` and `<tag>` with your own. Use an exact tag for each release. A moving tag such as `latest` can change under a running endpoint.

Do not build on the 2 GB local virtual machine. The build needs about 8 GB of memory. It needs no GPU and no CUDA toolkit.

### Build on the build host with the cache

Use `script/build-gpu-image.sh`. It builds in one persistent directory on the build host (`~/zk-bridge-build/gpu-image` on the build host; you must set the host with the variable `BUILD_HOST` or the option `--host`; the script has no default and stops with a message when both are missing), so the BuildKit cache stays between builds.

```
script/build-gpu-image.sh --tag zk-bridge-prover-gpu-worker:local          # build only, never pushes
script/build-gpu-image.sh --tag ghcr.io/<account>/zk-bridge-prover-gpu-worker:<tag> --push
script/build-gpu-image.sh --no-cache --tag zk-bridge-prover-gpu-worker:local   # a cold build, for timing
```

The script does five things. It fixes the ownership of the build directory. It syncs the tracked files of `HEAD` (`git archive`) and the two ELFs of `light-client/elf/` into it. It runs `docker build`. It fixes the ownership again. It prints the elapsed time and the image identifier, and with `--push` the registry digest. Commit your changes first: it builds `HEAD`, not the working tree.

Docker runs as root. A program-keys run or a build can leave root-owned files in the build directory, and the next sync then fails. The old workaround was a fresh folder for each build. The script now runs this instead, at the start and at the end:

```
docker run --rm -v "$HOME/zk-bridge-build/gpu-image:/w" <pinned runtime image> chown -R "$(id -u):$(id -g)" /w
```

Run the same command by hand after a manual `light-client/scripts/program-keys.sh` run in that directory.

The layers of the `build-gpu-worker` stage go from slowest to fastest changing: toolchain and packages, the light-client crates and the manifests, a dependency-only build from stub sources (one cache mount each for the cargo registry, the git dependencies and the target directory), then `prover/src`. The final stage puts the GPU server download, the 6 GB circuit files, the worker binary and the ELFs in that order. A change in `prover/src` now rebuilds one crate and writes two small layers. The checksums, the `VERIFIER_HASH` check, the ELF check and every pinned version are unchanged.

Measured on the build host (32 cores) on 2026-10-26, target `prover-gpu-worker`, same sources and ELFs:

| Step | Before | After |
|---|---|---|
| Cold build (`--no-cache`, empty cargo caches) | 145 s | 153 s |
| Rebuild after a one-line change in `prover/src` | 49 s | 6 s |
| Rebuild with no change | 2 s | 1 s |

The two images have the same ELF hashes, the same `prove-worker` binary hash (`414e4998...`), the same GPU server hash, the same `groth16_vk.bin` hash (`4388a21c...`, the `VERIFIER_HASH`), the same file ownership and modes, and the same environment, user, entry point and labels. The cold build does not get faster: it compiles the same crates. The gain is in every build after the first. Before the change, the circuit files sat after the worker binary, so every source change rewrote the 6 GB layer.

`light-client/scripts/program-keys.sh` also skips its Docker build now, when the hash of the guest sources matches `light-client/program-keys.source-hash`. Use `--force` to build anyway. On the build host the full check took 165 s and the skip took under 1 s.

### Build in GitHub Actions

The workflow `.github/workflows/prover-build.yml` does the build host rebuild of `docs/testnet-run.md` on GitHub-hosted runners. It runs only when you start it:

```
gh workflow run prover-build.yml -f image_tag=v6 -f push_image=true
gh run watch                                   # follow the run
gh run download <run id> -n program-keys -D light-client   # fetch the ELFs and keys
```

Use a new exact tag. `v4` and `v5` exist already (see below), and the workflow refuses a tag that exists in the registry. With `push_image=false` it builds and checks the image but pushes nothing.

It has two jobs:

1. `program-keys` builds sp1-cli 6.8.1 from source at the commit of the tag `v6.8.1` (no `sp1up`), runs `light-client/scripts/program-keys.sh --write` with `ELF_OUTPUT_DIR=light-client/elf`, and uploads the artifact `program-keys`: `elf/light-client.elf`, `elf/fork-observation.elf`, `program-keys.json` and `program-keys.source-hash`. The job summary shows the ELF hashes, the program keys, the difference from the committed `light-client/program-keys.json`, and whether each key in `script/testnet/bridge.config.testnet.json` matches. The workflow commits nothing. Review the keys, then commit `light-client/program-keys.json`, `light-client/program-keys.source-hash` and the keys in `script/testnet/bridge.config.testnet.json` and in the mainnet configuration (`programVKey` and `lightClientProgramVKey` take the light client key, `observationProgramVKey` takes the fork observation key).
2. `gpu-image` frees disk space on the runner (it removes the preinstalled toolchains and moves the Docker data to the larger temporary disk), downloads the artifact into `light-client/`, builds the target `prover-gpu-worker` for linux/amd64 without a cache, and checks inside the image that both ELFs match `program-keys.json` and that `groth16_vk.bin` hashes to `VERIFIER_HASH`. With `push_image=true` it logs in to GHCR with the workflow token (`GITHUB_TOKEN`, permission `packages: write`), pushes `ghcr.io/zkbfi/zk-bridge-prover-gpu-worker:<tag>` and writes the registry digest to the job summary. Reference the image by that digest in RunPod (`ghcr.io/zkbfi/zk-bridge-prover-gpu-worker@sha256:...`).

GHCR packages are private by default. RunPod then needs registry credentials (a token with `read:packages`, added as container registry credentials in the RunPod console), or make the package public in the package settings on GitHub: the code is open source, so the image holds nothing secret.

A hosted runner has much less disk and fewer cores than the build host, and no cache survives between runs. Expect a cold build every time (about one to two hours for both jobs). The step "Free disk space and move the Docker data" logs the free space before and after the cleanup, and warns when less than 45 GB is left for Docker.

What the image holds:

- The base is `nvidia/cuda:12.8.2-runtime-ubuntu24.04`, pinned by tag and digest. The tag was pushed on 2026-04-30, so it meets the age rule of 28 days before 2026-09-24.
- The SP1 GPU server of release v6.8.1 (`sp1_gpu_server_v6.8.1_x86_64.tar.gz`), pinned by SHA-256 hash. The hash is the one that GitHub shows for the release asset.
- `prove-worker`, built with `--features sp1-cuda`.
- The two guest program files, checked by the same stage that `prover-sp1` uses.

How `sp1-sdk` 6.8.1 finds the GPU server (read in the crate `sp1-cuda` 6.8.1 and in `~/.local/src/sp1-v6.8.1`): the client looks for `$HOME/.sp1/bin/sp1-gpu-server`. When the file is missing, or its `--version` differs from the crate version, the client downloads the release asset from GitHub. The image puts the file there, so the worker downloads nothing at run time. The client then starts the server as a child process and talks to it through the socket `/tmp/sp1-cuda-0.sock`. The cargo feature is `cuda` of `sp1-sdk`. Our feature `sp1-cuda` turns it on.

Test the image on any machine with an NVIDIA GPU and the NVIDIA container toolkit, before you create the endpoint:

```
docker run --rm --gpus all -p 8000:8000 <image>
curl -i http://127.0.0.1:8000/ping     # 204 while it starts, then 200
```

## Create the endpoint

Do these steps in the RunPod console. The names of the fields come from the page "Endpoint settings" (https://docs.runpod.io/serverless/endpoints/endpoint-configurations, read on 2026-10-23). The console can change them.

1. Create a Serverless endpoint of the type Load Balancer. If you pick another type, requests fail with `not allowed for QB API`.
2. Container image: the image that you pushed. If the registry is private, add the registry credentials in the console.
3. GPU: choose one or more types with 24 GB of video memory or more. SP1 documents "about 24 GB" for its GPU prover. You can list up to three types in priority order. Put the cheapest first.
4. Allowed CUDA versions: 12.8 and newer. The image uses CUDA 12.8, which needs a host driver of version 570 or newer.
5. Max workers: 1. One worker is enough for this service, and it limits the cost. Active workers: 0, so you pay nothing while no job runs.
6. Idle timeout: this is how long a worker waits after its last job before it stops. You pay for the wait. The default is 5 seconds. Each new start costs a cold start, so choose a value that covers the gap between two proofs of one burst. 60 seconds is a reasonable first value. Change it after you have seen real traffic.
7. FlashBoot: leave it enabled (the default). It keeps worker state after a stop and can shorten the next start.
8. Environment variables of the endpoint: `PORT=8000` and `PORT_HEALTH=8000`. Expose HTTP port 8000 in the field "Expose HTTP Ports". The page says that a custom port needs both.
9. Container disk: 40 GB. The image is 20.6 GB unpacked, because it holds the Groth16 circuit files (7.9 GB unpacked, 6.2 GB as the pinned tarball).
10. No network volume. The circuit files are baked into the image (`SP1_GROTH16_CIRCUIT_PATH=/opt/sp1-circuits/groth16`), pinned by the tarball SHA-256, and the build checks that `groth16_vk.bin` hashes to `VERIFIER_HASH`. A standard network volume was tried on 2026-10-25 and failed: writing the 7.9 GB on the first proof outlasted the 5.5-minute request limit (HTTP 504).

## Set the API key

1. Create an API key in the RunPod console. If the console can limit a key to one endpoint, do that.
2. Put the key in an environment variable of the process that runs the prover. The configuration names the variable. It never holds the key.

```
export RUNPOD_API_KEY=<the key>      # in the unit file or the secret store of your server, not in a repository
```

The producer refuses a configuration that has a key named `api_key`, `apikey` or `token`. It also refuses a value for `remote_api_key_env` that is not a name in capitals. The key does not appear in logs or in error messages. A plain `http://` address is refused, except for the local machine, because the key travels in the request.

The worker does not need the key. RunPod checks it at its proxy.

## Point the prover at the endpoint

```toml
[prover]
backend = "remote"
program_vkey = "0x00a2b556cd72b5d838b34c60b0367e1ffc9ab662d4e6aabca23e3682b0f5584b"   # optional with a route: the command reads the key from the light client
remote_url = "https://ENDPOINT_IDENTIFIER.api.runpod.ai"
remote_api_key_env = "RUNPOD_API_KEY"
remote_timeout_seconds = 900        # one request, from the first byte sent to the last byte read
remote_attempts = 4
remote_retry_delay_seconds = 10     # the wait before attempt n+1 is n times this value
remote_cold_start_wait_seconds = 900   # the longest wait for a worker that is not ready yet; 0 turns the wait off
```

The environment variables `ZK_BRIDGE_PROVER_PROVER_REMOTE_URL` and `ZK_BRIDGE_PROVER_PROVER_REMOTE_API_KEY_ENV` override the first two keys.

With a route, the `prove` command reads `programVKey()` from the destination light client and stops when `program_vkey` differs from it. In that case you can leave `program_vkey` out. A run that starts from an explicit head needs the key in the file or in `--program-vkey`. A fork observation proof uses the key that the fork registry stores. The proof check binds each key, so the remote backend needs no second copy.

The timeout of 900 seconds covers the wait for a worker (2 minutes), the cold start and one proof. The RunPod page recommends at least 3 retries with delays of 5 to 10 seconds for cold starts. The defaults match that. Answers of a worker that is not ready yet do not use up `remote_attempts`. `remote_cold_start_wait_seconds` bounds them instead (next section).

## Endpoint list

The owner's words: "start on the endpoint list in the prover"; "lets assume that the time to get the proof is of utmost importance. it seems like dedicated, especially if we assume that we will have consistent usage is the way to go"; "lets assume that the serverless one will have issues regarding inconsistent availability so we'll have to work around that"; "try to reduce costs wherever you can".

So the prover can hold several endpoints in priority order: a dedicated worker first (always warm, about 36 s per proof on an RTX 5090, `docs/gpu-trial-2026-11-01.md`), and the serverless endpoint as the fallback (cold starts from 24 s to 7 minutes). It sends a job to one endpoint at a time and moves to the next only when the current one cannot give a proof. It never sends the same job to two endpoints at once, so the serverless endpoint bills nothing while the dedicated worker answers.

```toml
[prover]
backend = "remote"
remote_timeout_seconds = 900          # the defaults of every endpoint that sets none of its own
remote_attempts = 4
remote_retry_delay_seconds = 10       # one value for every endpoint
remote_cold_start_wait_seconds = 900

[[prover.remote_endpoints]]
label = "dedicated"                   # the name in the logs; lower case letters, digits, '-' and '_'
url = "http://203.0.113.7:40123"      # a dedicated pod on its public TCP port: no RunPod proxy, no key
ready_wait_seconds = 20               # a dedicated worker is up or it is not; do not wait long
timeout_seconds = 120                 # a warm proof takes about 36 s
attempts = 2

[[prover.remote_endpoints]]
label = "serverless"
url = "https://ENDPOINT_IDENTIFIER.api.runpod.ai"
api_key_env = "RUNPOD_API_KEY"        # waits, timeout and attempts from the section above
```

Use either `remote_endpoints` or `remote_url` with `remote_api_key_env`, not both. A file with only `remote_url` works as before: it is a list of one endpoint with the label `remote`. At most 8 endpoints; each label once.

Per endpoint:

| Key | Default | Meaning |
|---|---|---|
| `label` | required | The name in the logs and in errors. The logs never show the URL. |
| `url` | required | The base URL. With a key: `https://`, or `http://` on the local machine, because the key travels in the request. Without a key: `http://` or `https://` to any host. |
| `api_key_env` | none | The NAME of the variable with the key. Without it the request has no `Authorization` header. The worker checks no key itself (`src/worker.rs`); on serverless the RunPod proxy checks it. |
| `ready_wait_seconds` | `remote_cold_start_wait_seconds` | The longest wait for a worker of this endpoint that answers "not ready", counted from the first request to this endpoint. |
| `timeout_seconds` | `remote_timeout_seconds` | One request to this endpoint. |
| `attempts` | `remote_attempts` | Requests after ordinary failures (no answer, 5xx, 429) before the prover moves on. |
| `start_wait_seconds` | none | The start wait of a GPU tier (see "GPU tiers" below). With it, the prover pings the endpoint until a worker is ready before it sends the job. After this many seconds it pings the next endpoint too. At least 1 and below the endpoint's ready wait. Without it the job is sent at once. |

What the prover does with each answer:

| Answer of an endpoint | Same endpoint | Next endpoint |
|---|---|---|
| 200 with a proof | Done. The proof is checked locally. | Never asked. |
| 200 with a proof that fails the local checks (public values, shape, Groth16) | The job fails, with the error line `remote_proof_refused endpoint=<label>`. | Never asked: a bad proof points at a broken or hostile worker and must be seen, not hidden by a second proof. |
| 200 that is not a proof | The job fails. | Never asked. |
| 400 from the worker, 422 | The job fails (`remote_job_refused`). The same input fails the same way everywhere. | Never asked. |
| 401, 403, 404, 405 (the endpoint turned the request away: a key it does not take, a wrong URL) | Not sent again. | Gets the job. |
| No answer (refused connection, timeout), 5xx, 429 | Sent again, up to `attempts`. | Gets the job when the attempts run out. |
| "Not ready" (503, 204, "no workers available", the RunPod 400 "timed out waiting for worker") | Waited for, up to `ready_wait_seconds`. | Gets the job when the wait runs out. |
| Every endpoint failed | | The job fails with one line per endpoint: `no remote endpoint gave a proof (2 tried); endpoint 1 (dedicated): ...; endpoint 2 (serverless): ...` |

Log lines name the endpoint by its position and label: `remote_prove_retry` and `remote_worker_not_ready` carry `endpoint_index` and `endpoint`; `remote_endpoint_failover` carries `endpoint_index`, `endpoint`, `next_endpoint_index`, `next_endpoint` and the reason. The prover takes the endpoint's address out of every reason. The `prove_timing` line carries `endpoint` (the label that gave the proof), `failover_count` (how many endpoints were given up before it) and `start_wait_ms` (see "GPU tiers").

A timeout does not stop the worker: a dedicated worker that answers too late may still finish that proof while the serverless endpoint proves the job. That costs nothing on a dedicated pod, which bills by the hour, but it keeps that GPU busy for the next job. Keep `timeout_seconds` of the dedicated worker well above one proof.

The worst case before the fallback starts, with the values above: a dedicated worker that takes the connection and never answers costs 2 × 120 s plus a 10 s pause, about 250 s. A dedicated worker that is down (connection refused) costs 10 s. A dedicated worker that answers "not ready" costs 20 s. Then the serverless endpoint may need its cold start (up to 900 s of waiting) and a proof. Keep the backend's job limit (1800 s by default) above that sum.

Reaching a dedicated pod: the RunPod HTTP proxy of a pod (`https://<pod>-<port>.proxy.runpod.net`) ends a request after about 100 s, which is too short for a first proof on a new worker (51 s to 94 s measured, more with a queue). Expose the worker port as a TCP port of the pod and use `http://<public IP>:<external port>`. That path has no TLS and no key check, so the entry has no `api_key_env`. A guest input is public chain data and every proof is verified locally, so a third party on the path can delay a job but cannot get a bad proof accepted. Anyone who finds the port can send jobs to the worker, though, which would queue our jobs behind theirs. Keep the port unpublished, and add a key check in front of the worker before the address becomes known.

### GPU tiers

The owner's words: "can we get smarter about the gpus we grab? are there any others? can we iterate through a list?"; "i am fine with waiting 30s to start, but lets put all of these decisions into configurations".

A tier is one RunPod serverless endpoint with one price band of GPU types. The list holds the tiers cheapest first. Each tier but the last has a start wait:

```toml
[prover]
backend = "remote"
remote_timeout_seconds = 360
remote_attempts = 3

[[prover.remote_endpoints]]
label = "gpu-24gb"                    # RTX 4090, L4, RTX 3090
url = "https://TIER1_IDENTIFIER.api.runpod.ai"
api_key_env = "RUNPOD_API_KEY"
start_wait_seconds = 30

[[prover.remote_endpoints]]
label = "gpu-32gb"                    # RTX 5090
url = "https://TIER2_IDENTIFIER.api.runpod.ai"
api_key_env = "RUNPOD_API_KEY"
start_wait_seconds = 30

[[prover.remote_endpoints]]
label = "gpu-48gb"                    # L40S, RTX 6000 Ada
url = "https://TIER3_IDENTIFIER.api.runpod.ai"
api_key_env = "RUNPOD_API_KEY"        # no start wait: the full cold-start wait
```

Before the prover sends a job (a light-client update or a fork observation) to a tier with a start wait, it asks `GET /ping` of that tier every 2 s, with the tier's key. The worker answers 204 while it starts and 200 when it is ready (`src/worker.rs`).

- A tier that answers 200 within its start wait gets the job at once.
- A tier that is not ready after its start wait stays in the race, and the next tier joins it. The prover pings both and sends the job to the first that answers 200. When both answer 200 in the same round, the earlier tier gets the job. The started cheap worker is not thrown away: it may still win.
- The next tier brings in the one after it the same way, after its own start wait. A tier without a start wait that joins the race is pinged too. A tier without a start wait that comes up when no tier is pinged gets the job at once, as without tiers.
- A 503 of `/ping` means a refused or broken worker. RunPod replaces it, so the prover counts it as "not ready" and keeps pinging. So does a ping without an answer, a 5xx and a 204.
- A 401, 403, 404 or 405 of `/ping` means the endpoint turned the request away. The prover gives that tier up at once, and the next tier joins at once.
- Each tier is pinged for at most its ready wait (`ready_wait_seconds`, or `remote_cold_start_wait_seconds`), counted from when it joined. Then it is given up. When every tier is given up, the job fails with one line per tier, as above.
- The prover sends the job to one tier only. When that tier then fails in a way another endpoint can help (the table above), the prover goes on with the tiers not given up yet: the ones still pinged, then the next in the list.
- After the 200 the rules of the table above apply to the job. A tier that then answers `/prove` with "not ready" (another job took the worker) is awaited up to its ready wait again, counted from that request.

The backend's warm-up pings only the first tier, so in the usual case the cheap worker is ready when the job comes.

Log lines: `remote_tier_escalate` (`from_endpoint_index`, `from_endpoint`, `to_endpoint_index`, `to_endpoint`, `waited_seconds`) when a tier brings in the next, and `remote_tier_chosen` (`endpoint_index`, `endpoint`, `start_wait_ms`) when a tier answers 200 and gets the job. A tier that is given up while pinged writes `remote_endpoint_failover`. The pings are not counted in `not_ready_count`. The `prove_timing` line carries `start_wait_ms`: the time spent pinging before the job was sent. `failover_count` counts the tiers given up, not the tiers still pinged when another one won. No line shows a URL or a key.

The backend and the bots write this file from their JSON configuration (`explorer/backend/README.md`, "Proving endpoints"; `explorer/bots/README.md`).

## RunPod endpoints in configuration

Owner, 2026-11-13: "lets put all of these decisions into configurations". The RunPod side of the GPU tiers is a file in
the repository, `deploy/runpod/endpoints.json`, and a script, `deploy/runpod/apply.mjs`, that makes RunPod match it. The
design is in `docs/superpowers/specs/2026-11-13-gpu-tiers-design.md`. The file holds no secret.

The file has three parts:

- `template`: the settings that every tier's template shares: the worker image by digest (`imageName`), the container
  disk, the exposed port, the registry credential id (`containerRegistryAuthId`, an id, not a password) and the
  environment (`PORT`, `PORT_HEALTH`). Change the image here, once: the script then updates the template of every tier.
  It names no template itself.
- `endpoints`: the tiers in the order the prover tries them. Each has a `label`, a RunPod `name`, a `template`
  (`{ "id"?, "name" }`), `gpuIds` (an ordered list of RunPod GPU group ids; an id that starts with `-`, such as
  `-NVIDIA L40`, excludes that card), `workersMin`, `workersMax`, `idleTimeout` (seconds), `flashBootType`, `scalerType`,
  `scalerValue`, `executionTimeoutMs` and `type` (`LB`, load balancing). `id` is the RunPod endpoint id. Leave it out for
  a tier that does not exist yet: the script creates it (matching by `name` on later runs) and prints the new id, which
  you then put in the file and in `backend.json`.
- `retired`: ids of endpoints that should be gone. The script deletes them only with `--apply --delete-retired`.

RunPod binds one template to one endpoint ("This template is already bound to an endpoint"), so each tier has its own
template, with the same settings and its own name. The `template` of a tier is found by its `id`, else from its
endpoint, else by its `name` among the account's templates, so a template that an earlier run made before its endpoint
failed is reused and not made twice. Without an `id` it is created and the new id is read from RunPod's answer. The
script never deletes a template, also not when it deletes a retired endpoint.

The tiers (planner's first choice, owner may change): `gpu-24gb` (`ADA_24`, `AMPERE_24`, no RTX A5000), `gpu-32gb`
(`ADA_32_PRO`) and `gpu-48gb` (`ADA_48_PRO`, no L40). No 80 GB tier.

To change RunPod:

1. Edit `deploy/runpod/endpoints.json` and commit it.
2. Dry run. It reads RunPod and prints, for each tier, a template line and an endpoint line with the fields that differ as
   `old -> new`. Environment
   values show as `(set)`. It also lists endpoints that exist at RunPod but are not in the file and not retired. It never
   touches those. It changes nothing.

   ```
   RUNPOD_API_KEY=... node deploy/runpod/apply.mjs
   ```

3. Apply. For each tier in order it saves the tier's template when it differs (or creates it), then saves the endpoint
   when it differs (or creates it) bound to that template.

   ```
   RUNPOD_API_KEY=... node deploy/runpod/apply.mjs --apply
   ```

4. Add `--delete-retired` to delete the endpoints under `retired` (it sets their workers to 0 first; their templates stay).
   This path has not been run against RunPod yet.

The key is read from the environment only, never from an argument, and the script prints neither the key nor a request.
It uses RunPod's GraphQL API, because the REST API has a small daily limit. A RunPod error prints its message and the exit
code is 1. `--config <path>` reads another file. `--config -` reads the JSON from standard input.

The key lives on the server, in `/etc/zk-bridge/backend/backend.env`. To run from there, copy the script and the file, and
source the environment file inside the root shell:

```
ssh zkbfi-app 'cat > /tmp/apply.mjs' < deploy/runpod/apply.mjs
ssh zkbfi-app 'sudo bash -c "set -a; . /etc/zk-bridge/backend/backend.env; set +a; node /tmp/apply.mjs --config -"' < deploy/runpod/endpoints.json
ssh zkbfi-app 'sudo bash -c "set -a; . /etc/zk-bridge/backend/backend.env; set +a; node /tmp/apply.mjs --config - --apply"' < deploy/runpod/endpoints.json
ssh zkbfi-app 'rm /tmp/apply.mjs'
```

The second line is the dry run and the third applies. The tests run with `node --test deploy/runpod`. They send no
request to RunPod.

The prover's own list of tiers is `remote.endpoints` in `backend.json` (`explorer/backend/README.md`, "Proving endpoints"),
one entry per tier in the same order, with the endpoint ids from RunPod in the URLs
(`deploy/app-server/config/backend/backend.json.example`). `startWaitSeconds` there sets how long the prover waits for a
tier to answer ready before it also wakes the next tier.

## Timing logs

The producer measures each step of a proof run, so that "how long does one proof take" and "would a faster GPU help" have an answer from real runs. Every line goes to standard error in the usual style (`ts=... level=info event=... key=value`). No line holds a URL, a key or a token.

One `prove_step` line per step, each with `elapsed_ms`:

| `step` | Written by | What it covers |
|---|---|---|
| `build` | producer | The beacon reads and the assembly of the update (`plan_update`). |
| `native` | producer | The native run of the program on the update and the checks that it starts at the stored head. |
| `prover_native` | remote backend | The native run before the request (the backend runs the program again on the guest input). |
| `wait_worker` | remote backend | From the first request until the start of the request that the worker accepted: every cold-start wait, every pause, every failed attempt, and the time spent on endpoints that were given up. Also carries `start_wait_ms` (the part spent pinging GPU tiers, see "GPU tiers"), `not_ready_count` (answers to `/prove` that said no worker was ready), `retry_count` (ordinary failures that were sent again), `endpoint` (the label of the endpoint that gave the proof) and `failover_count` (endpoints given up before it). The counts add up over every endpoint. |
| `remote` | remote backend | The accepted request, from the first byte sent to the last byte read. |
| `worker` | remote backend | What the worker reported (the `worker_*` keys below), or `worker_timings=none`. |
| `verify` | remote backend | The local Groth16 verification of the returned proof. |
| `check` | producer | The producer's own second check of the answer (shape and Groth16 verification). |

At the end of a run that produced a proof, one `prove_timing` line carries all of them:

```
ts=1793500000 level=info event=prove_timing build_ms=1200 native_ms=610 wait_worker_ms=60060 start_wait_ms=0 not_ready_count=2 retry_count=0 endpoint=serverless failover_count=1 remote_ms=43000 verify_ms=10 prove_ms=103700 total_ms=105100 worker_timings=reported worker_queue_ms=3 worker_native_ms=400 worker_prove_ms=41000 worker_verify_ms=20 worker_total_ms=41500 remote_overhead_ms=1500 worker_gpu="NVIDIA GeForce RTX 4090" worker_cpu_model="AMD EPYC 9354 32-Core Processor" worker_cpu_count=32
```

| Key | Meaning |
|---|---|
| `build_ms` | The `build` step. |
| `native_ms` | `native` plus `prover_native`. |
| `wait_worker_ms`, `not_ready_count`, `retry_count`, `remote_ms` | The remote steps above. Only for the remote backend. |
| `endpoint`, `failover_count` | The label of the endpoint that gave the proof, and how many endpoints were given up before it (`0` when the first answered). Only for the remote backend. A single `remote_url` has the label `remote`. |
| `start_wait_ms` | The time spent pinging GPU tiers before the job was sent (part of `wait_worker_ms`). `0` when no endpoint has a start wait. Only for the remote backend. |
| `verify_ms` | `verify` plus `check`. |
| `prove_ms` | The whole call of the backend (`native` of the backend, the wait, the request and the verification). For the local SP1 backend it is the proof. |
| `total_ms` | The whole run, from the program key check to the checked proof. It does not include the handoff. |
| `worker_timings` | `reported` or `none`. `none` means the worker sent no `timings` (an older image) or sent a value that does not fit. |
| `worker_queue_ms` | How long this request stood behind another proof of the same worker. This is waiting for the GPU, not proving. |
| `worker_native_ms` | The native run on the worker. |
| `worker_prove_ms` | The SP1 Groth16 proof: core proof, compression and the Groth16 wrap together. The SP1 client does one call and does not report the three apart. |
| `worker_verify_ms` | The worker's own verification of the new proof. |
| `worker_total_ms` | The whole request on the worker. |
| `remote_overhead_ms` | `remote_ms` minus `worker_total_ms`: network, proxy, and a cold start that RunPod hid inside the request. |
| `worker_gpu`, `worker_cpu_model`, `worker_cpu_count` | The hardware the proof ran on (`nvidia-smi` and `/proc/cpuinfo`). Left out when the worker could not tell. |

How to read them:

- Time to get a worker: `wait_worker_ms` plus `remote_overhead_ms`. Cold starts and the RunPod wait are in here, and so is `worker_queue_ms`.
- Time to prove: `worker_prove_ms`. This is the number to compare between GPUs. A faster GPU only shortens this value; the rest does not change with the GPU.
- Without worker timings, `remote_ms` is the upper bound of the proof time. It still includes a cold start that the platform held inside the request.

### The `timings` object of the answer

`POST /prove` may add `"timings"` to the 200 answer. All keys are camelCase and all numbers are whole milliseconds: `queueMs`, `nativeMs`, `proveMs`, `verifyMs`, `totalMs`, and the optional texts and number `gpu`, `cpuModel`, `cpuCount`. The field is optional on both ends. A worker without it still works, and the producer logs `worker_timings=none`. A value that does not fit is ignored, never an error. The producer cuts every hardware name to 80 characters and removes control characters and URLs.

Order of deployment: the producer must be updated before the image. An older producer rejects an answer with an unknown field. The worker part takes effect only after the GPU image is rebuilt and the endpoint points at the new image; until then the logs show `worker_timings=none`.

The backend logs `job_proved` when a job succeeds. It carries the parsed `prove_timing` fields (`route`, `newHeadSlot`, `timingReported` and every key above), so the numbers are in the backend log without the prover's standard error, which the backend keeps only when a run fails.

## Cold start

I did not measure the cold start. The parts are:

| Part | Billed | Note |
|---|---|---|
| Pull of the image | No (the pricing page says so) | The image holds the CUDA runtime and a server binary of 251 MB. |
| Start of the GPU server and the SP1 setup of two programs | Yes | Runs while `/ping` answers 204. |
| Download of the circuit files | No | Baked into the image. |

Record the time from the first 204 to the first 200 in the first live run. The RunPod page measures a cold start the same way.

A normal cold start took about 24 s. After an endpoint change the hosts pull the 20 GB image first, and that can take longer than the load balancer holds one request. The load balancer then answers `400` "timed out waiting for worker" (about 5 minutes on 2026-10-31), while the worker keeps starting.

The prover waits for the worker in that case. These answers mean "not ready yet": the RunPod 400 "timed out waiting for worker", 503, 204 and the text "no workers available". After each one the prover pauses and sends the job again. The first pause is `remote_retry_delay_seconds`, each next pause doubles, and no pause is longer than 60 seconds. No new request starts after `remote_cold_start_wait_seconds` (default 900, so 15 minutes) since the first request. Then the job fails with:

```
prover: the remote worker was not ready after 905 s of waiting, the limit of prover.remote_cold_start_wait_seconds (900 s); last answer: status 400: timed out waiting for worker
```

Each wait writes one line to standard error, for example:

```
ts=... level=warn event=remote_worker_not_ready waited_seconds=301 wait_seconds=10 limit_seconds=900 reason="status 400: timed out waiting for worker"
```

The line holds no key and no endpoint address.

Keep the backend's job limit (`prover.timeoutSeconds` in the backend configuration, 1800 by default) above this wait plus one proof. With the defaults the worst case is about 900 s of waiting, plus one more hold of the load balancer (about 300 s), plus one proof (at most 330 s, the RunPod processing limit; measured 120 to 204 s): about 1530 s. If you raise `remote_cold_start_wait_seconds`, raise the job limit too.

## Cost model

The pricing page (https://docs.runpod.io/serverless/pricing, read on 2026-10-23) says:

- Billing is per second, from the start of a worker to its full stop.
- Cold start, execution and the idle wait are billed. Image pull and the time that a worker is scaled down are not.
- Container disk costs about $0.10 per GB per month. A network volume costs $0.07 per GB per month under 1 TB.
- The default spend limit is $80 per hour for the account.

The page has no table of GPU prices. Read the rate of your GPU type on https://www.runpod.io/pricing and put it in this formula.

```
cost of one burst of proofs = rate per second x (cold start + sum of proof times + idle timeout)
cost per month             = bursts per month x cost of one burst + storage
```

An example with placeholders: if the rate is R dollars per second, the cold start is C seconds, one proof takes P seconds, you prove once per burst, and the idle timeout is T seconds, one burst costs R x (C + P + T). Measure C and P in the first live run.

The proof on the processor that I made on a 32-thread box took 14 minutes 22 seconds. The GPU time is not measured yet.

## Limits that matter

- **Processing time of 5.5 minutes per request.** The Groth16 wrapping step runs on the processor inside the GPU server, not on the GPU. A serverless worker has few processor cores. If the whole proof takes longer than 5.5 minutes, every request fails and you pay for each one. Measure one proof first. If it is too slow, a queue endpoint with an execution timeout (default 10 minutes, up to 7 days) is the fallback. It needs new code.
- **A fold of 64 updates** is much larger than one update. Measure it too.
- **Memory.** The run on the processor needed 61 GB at peak. The GPU server has its own memory profile. Check the host memory of the chosen GPU type in the first live run.
- **One worker.** With max workers 1, a second job waits for the first. The prover sends jobs one at a time, so this costs nothing.

## Checklist for the first live run

1. Build the guest programs and confirm that `light-client/scripts/program-keys.sh` exits with code 0.
2. Build and push the image with an exact tag. Write the tag and the image digest in your deploy notes.
3. If you have a machine with a GPU, run the image there and call `/ping`.
4. Create the endpoint with the settings above. Max workers 1, active workers 0.
5. Set the API key in the environment of the prover. Check that no file in the repository holds it (`git grep` for the first characters of the key).
6. Send one `GET /ping` through the endpoint address with the `Authorization` header. Expect 204 and then 200. Write down the time between them.
7. Run `zk-bridge-prover --config prover.toml prove` on a test route whose light client is current. Confirm that it exits with code 3 without a configuration error. The run reads the light client and compares `program_vkey` with the contract key before it asks the worker for anything.
8. Run `prove` on a test route whose light client lags. Write down the total time, the time of the worker (the log line `proved`) and the cost shown in the RunPod console.
9. Check that the proof bytes have 356 bytes and that the verifier contract on the test chain accepts them. This also gives the first accepting fixture for `test/hardened/SP1VerifierGroth16.t.sol` for circuit v6.1.0, if the fixture file is not yet in the repository.
10. Stop an endpoint worker in the middle of a proof (scale max workers to 0). Confirm that the prover retries and logs `remote_prove_retry`.
11. Prove a fork observation and a fold of several updates. Write down the times against the 5.5 minute limit.
12. Review the logs of the worker for the key or the request body. They must hold neither.

## What I could not check on this machine

- The image was not built, and the worker was not run on a GPU. This machine has no NVIDIA GPU.
- `cargo check --features sp1-cuda --all-targets` passes here. The feature compiles without CUDA, because the `sp1-cuda` crate is only a client of the GPU server.
- I did not run the GPU server binary. I read its dynamic libraries from the file: it needs `libcudart.so.12`, `libstdc++.so.6` and glibc 2.34 or newer. Whether it finds the Groth16 circuit files in `SP1_GROTH16_CIRCUIT_PATH` is the same behaviour as the processor prover, but I did not run it.
- The RunPod pages do not state the status code for "no workers available", the size of the circuit files, or GPU prices.

## Measured on RunPod (2026-10-25, image v3, RTX 4090, real Ethereum update)

| Step | Time |
|---|---|
| First pull of the 20.6 GB image on a new host (not billed) | about 300 s to ready |
| Cold worker with the image cached | 24 s to ready |
| First proof on a worker | about 50 s |
| Warm proof | about 27 s |

Every proof was 356 bytes and its public values equalled the native `lc-core` run.

## Image v4 (2026-10-26)

| Item | Value |
|---|---|
| Image | `<registry>/<account>/zk-bridge-prover-gpu-worker:v4` |
| Digest | `sha256:d9f491f92e66c9bf7e8a3355da0083fd244138aa38e106bbd8e982818c401ea4` |
| Built from | commit `10976fb`, on the build host, target `prover-gpu-worker`, platform linux/amd64 |
| Light client program key | `0x002a566f7e3d1e6996f7ffa35668291bfc7bce325ed34fe55ef41a2be3fd15cf` |
| Fork observation program key | `0x00c2a9c5a7b0826c85a59ca0dbeccae5309093072e40d26548b9b0c4183d3f39` |
| Endpoint | The endpoint runs v4 (release 5). Only the image changed. |

The program keys in this image are old. The guest programs changed on 2026-10-27, and `light-client/program-keys.json` holds new keys. The v4 image must not prove for the current bridge. Rebuild the worker image with `script/build-gpu-image.sh` before you use it, and check the keys inside the new image against `light-client/program-keys.json`.

The image holds the rebuilt ELFs (testnet chain selectors and Gloas). The ELF hashes in the image equal `light-client/program-keys.json`. The file `groth16_vk.bin` in the image hashes to `VERIFIER_HASH`, and the build checks this. The first proof on v4 is not measured yet.

## First live runs on v4 (2026-10-26)

### GPU type requirement: pool `ADA_24` only

The Groth16 step needs more host memory than a MIG slice gives. A first attempt ran with the pools `ADA_24` and `AMPERE_24`. Two workers landed on `NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb`, a 24 GB slice of a larger card. Its host memory share is 28.87 GiB. The container hit that limit during the Groth16 proof (system log: "high memory utilization 27.67GiB / 28.87GiB", then "triggered memory limits (OOM)"). The GPU server child process died. The worker kept answering `/ping` with 200 and failed every later job at once with `CudaClientError ... Broken pipe`. Four runs (with 4 and 10 attempts) failed this way, and the client never reached a good worker.

The endpoint used pool `ADA_24` only (RTX 4090, $1.10 per hour serverless). Do not add a pool or a GPU type that can hand out a MIG slice.

On 2026-10-31 RTX 4090 stock ran low and jobs sat at "Waiting for GPU to become available". The endpoint now names whole GPUs with 24 GB or more by type (not by pool), in priority order: RTX 4090, L4, RTX 3090, RTX 5090, RTX 6000 Ada, L40S, A100 SXM4 80 GB, RTX PRO 6000 Blackwell Server Edition, H100 80 GB HBM3. A proof takes one to three minutes, so even the dearest type costs about $0.20 per proof. No `MIG` type is listed. RunPod's REST API dropped the RTX PRO 4000, 4500 and 5000 Blackwell types from the list it stored.

The type list does not stop RunPod from handing out a MIG slice. On 2026-11-01 the endpoint `43nsvfb8svkosr` (load balancing) assigned `NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb` and `MIG 2g.48gb` twice, although the list names only whole GPUs. So the worker checks its host itself, once at the start (`prover/src/worker.rs`):

- It reads the GPU name, the device UUID and the MIG mode from `nvidia-smi`, and the host memory it may use: the smaller of the cgroup limit (`memory.max`, or the v1 `memory.limit_in_bytes`) and `MemTotal`.
- It refuses when the GPU is a MIG slice (the word `MIG` in the name, a UUID that starts with `MIG-`, or `mig.mode.current` is `Enabled`), or when the host memory is below the floor. The floor is `ZK_BRIDGE_WORKER_MIN_HOST_MEMORY_GIB`, default 48 (the CPU run peaked near 56 GiB, the RTX 4090 and 5090 hosts had 128 GiB or more, the MIG slice had 28.87 GiB). 0 switches the memory check off.
- A reading that is missing (no `nvidia-smi`, no cgroup file) never refuses.
- A refusing worker logs one line, `event=worker_refused reason=mig|host_memory gpu="..." host_memory_gib=...`, and does not load the proving client. It answers `/ping` and `/prove` with 503 and a JSON `error` for good. RunPod then removes it, and the client treats 503 as a failed attempt and tries again, which reaches another worker.

The image needs a rebuild to carry this check. The image `v5` does not hold it.

### Results on RTX 4090 (pool `ADA_24`)

Both proofs came from the `prove` command in remote mode, with `remote_api_key_env = "RUNPOD_API_KEY"`. The program key was `0x002a566f7e3d1e6996f7ffa35668291bfc7bce325ed34fe55ef41a2be3fd15cf`. Each proof has 356 bytes. `zk-bridge-prover verify` accepted both against that key (`{"valid":true}`, exit code 0).

| Item | Chain 943 (pulsechain-testnet-v4) | Sepolia |
|---|---|---|
| Start head slot | 11168480 | 11442368 |
| New head slot | 11168544 | 11442400 |
| Execution block number in the public values | 25742593 | 12000041 |
| Execution block hash in the public values | `0x3dc1ad0a...63b1` | `0x32ef6c92...f3f3` |
| The node agrees on the block hash | yes (`eth_getBlockByNumber`) | yes (`eth_getBlockByNumber`) |
| Time of the `prove` command | 204 s | 120 s |

How to read the times:

- **Sepolia, worker log.** The worker started at 19:33:09 UTC. It was ready at 19:33:31 (21 s from start, 14 s of SP1 setup). The first request got status 502 while the worker started, and the client retried after 10 s. The proof started at 19:34:03. The worker logged `proved seconds=58`. This is the first proof on a new worker. It includes 19 s to read the R1CS file and 5 s to read the proving key, and the Groth16 step itself took 15.5 s.
- **Chain 943.** The command took 204 s from start to hand-off. The log of that worker was not available (the log call returned nothing), so I cannot split the time. The worker had started at 19:24:19, 24 s before the request. The result is slower than Sepolia and than the 50 s of v3. I did not find the reason. Measure it again on a warm worker.
- **Sepolia input.** The guest input was 51465 bytes. A Gloas update needs the source node (`--source-rpc-url`) for the execution header.

Estimated cost at $1.10 per hour ($0.000306 per second). A worker bills from its start to its stop, including the 60 s idle timeout.

| Run | Billed time | Cost |
|---|---|---|
| Sepolia, one proof | 19:33:09 to 19:36:01 = about 172 s | about $0.053 |
| Chain 943, one proof | 19:24:19 to about 19:29:07 = about 288 s | about $0.088 |

Both include the cold start and the idle wait. A warm worker costs about $0.0003 per second of proof.

### Worker health fix

The worker now answers `/ping` with 503 after the proving client has failed a proof, and it stays at 503. RunPod then removes the worker and starts a new one. A refused key (status 400) does not change the health. The change is in `prover/src/worker.rs`, with the tests `ping_is_503_for_good_after_a_failed_proof` and `a_refused_key_keeps_ping_at_200`. The image `v4` does not hold this change. Build `v5` to get it.

### Holding the start state

Chain 943 serves a correct state only for the newest finalized header. The `prove` command reads the state of the start head, so a start head that is no longer the newest fails with a root mismatch. The runs above used a small local proxy for the beacon API. It holds the state of the start head, which I read while it was the newest, and forwards every other path. Then I waited for a newer finalized header and ran `prove` with `--beacon-url` pointing at the proxy. Sepolia worked the same way.

## Image v5 (2026-10-26)

| Item | Value |
|---|---|
| Image | `<registry>/<account>/zk-bridge-prover-gpu-worker:v5` |
| Digest | `sha256:f93ccd70ac081d4c6084f1377fb7df11f5fac3284bfc26fca1c573089779abfc` |
| Built from | commit `a618ecb`, on the build host, in a fresh folder, target `prover-gpu-worker`, platform linux/amd64 |
| Light client program key | `0x002a566f7e3d1e6996f7ffa35668291bfc7bce325ed34fe55ef41a2be3fd15cf` (unchanged from v4) |
| Fork observation program key | `0x00c2a9c5a7b0826c85a59ca0dbeccae5309093072e40d26548b9b0c4183d3f39` (unchanged from v4) |
| Endpoint | The endpoint runs v5. Only the image changed. The pool is still `ADA_24`. |

The program keys in this image are old. The guest programs changed on 2026-10-27, and `light-client/program-keys.json` holds new keys. The v5 worker image must not prove for the current bridge. Rebuild the worker image with `script/build-gpu-image.sh` before you use it, and check the keys inside the new image against `light-client/program-keys.json`.

Checks inside the image: `light-client.elf` hashes to `d7633e82...9bbf` and `fork-observation.elf` to `5a2535fa...91bf`, both equal to `light-client/program-keys.json`. The file `groth16_vk.bin` hashes to `4388a21c687fdd5f218d7e3d13190cac4c5355818d3605fd5fb811df468ee696`, which is `VERIFIER_HASH`. v5 holds the worker health fix (`/ping` answers 503 after a failed proof). A first proof on v5 is not measured yet.

The push of the 6 GB circuit layer takes about 35 minutes over the Wi-Fi of the build host (3 MB/s). The first two pushes ended with "use of closed network connection". The third, after a fresh login, completed. Log in again before each retry.
