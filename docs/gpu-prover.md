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
| Health path | `/ping` (variable `HEALTH_CHECK_PATH`, default `/ping`). 200 means ready. 204 means starting. Any other status marks the worker unhealthy, and RunPod removes it from the pool. |
| Wait when no worker is free | 2 minutes. |
| Processing time of one request | 5.5 minutes. |
| Size of a request or an answer | 30 MB. |
| A wrong port | The page says that the worker then stays up for 8 minutes and answers 502. |

The page does not say which status the proxy gives when no worker is available. It names the text "no workers available". The client retries on that text with any status.

The routes of the worker:

| Route | Answer |
|---|---|
| `GET /ping` | 204 while the SP1 setup runs. 200 with `{"status":"ready"}` afterwards. |
| `POST /prove` | 200 with `{"proof":"0x...","publicValues":"0x..."}`. |

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
| 400 | The request is wrong, or the worker holds no program with this key, or the key belongs to the other statement kind. | Stops. |
| 422 | The program rejects the input. | Stops. |
| 500 | The proof failed. | Retries. |
| 503 | The worker still starts. | Retries. |

The worker proves one statement at a time. A second request waits, because one GPU runs one proof. It answers `/ping` during a proof, because each request has its own thread.

## What the prover checks

`RemoteProver` runs the program natively first, as every backend does. A rejected input never leaves your machine. It accepts an answer only when all of these hold:

1. The public values equal the public values of the native run of `lc-core`.
2. The proof has 356 bytes and starts with the selector `0x4388a21c` of the pinned verifier (`docs/sp1-version-policy.md`).
3. The Groth16 proof verifies for the program key that the caller asked for. The prover does this with the crate `sp1-verifier` 6.8.1 (published 2026-09-24, so it meets the age rule). The check takes a few milliseconds on the processor and needs no GPU and no `sp1-sdk`.

Check 3 also fixes the program key. A proof of another program does not verify under the key that the contract stores. So the remote backend needs no copy of the guest program files and no key of its own.

The chain stays the final check. The verifier contract refuses every proof that fails. The local checks save a transaction and a retry cycle when a worker is wrong.

The test file `prover/tests/remote_prover.rs` runs these checks against a fake worker with a real proof. The proof is `test/hardened/fixtures/sp1-proof-ethereum-update.json`. The tests cover: a good proof, wrong public values, wrong length, wrong selector, a proof for another key, a tampered proof, a worker that refuses, a timeout with a retry, and the cold start answers.

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
```

The environment variables `ZK_BRIDGE_PROVER_PROVER_REMOTE_URL` and `ZK_BRIDGE_PROVER_PROVER_REMOTE_API_KEY_ENV` override the first two keys.

With a route, the `prove` command reads `programVKey()` from the destination light client and stops when `program_vkey` differs from it. In that case you can leave `program_vkey` out. A run that starts from an explicit head needs the key in the file or in `--program-vkey`. A fork observation proof uses the key that the fork registry stores. The proof check binds each key, so the remote backend needs no second copy.

The timeout of 900 seconds covers the wait for a worker (2 minutes), the cold start and one proof. The RunPod page recommends at least 3 retries with delays of 5 to 10 seconds for cold starts. The defaults match that.

## Cold start

I did not measure the cold start. The parts are:

| Part | Billed | Note |
|---|---|---|
| Pull of the image | No (the pricing page says so) | The image holds the CUDA runtime and a server binary of 251 MB. |
| Start of the GPU server and the SP1 setup of two programs | Yes | Runs while `/ping` answers 204. |
| Download of the circuit files | No | Baked into the image. |

Record the time from the first 204 to the first 200 in the first live run. The RunPod page measures a cold start the same way.

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
