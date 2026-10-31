import type { ProofRequestAnswer } from "@zk-bridge/shared/backend-client";
import type { ProofDirection } from "@zk-bridge/shared";
import type { LightClientFacts } from "./plan.ts";
import type { ProofOutcome, ProofPath, Runtime, Target } from "./march.ts";

/** The part of the backend client (`@zk-bridge/shared/backend-client`) that the backend path uses. */
export type BackendPort = {
  readonly requestProof: (request: { pair: string; direction: ProofDirection; reason: "keep-alive" }) => Promise<ProofRequestAnswer>;
  readonly requestStatus: (requestId: string) => Promise<{ readonly status: string; readonly jobId: string; readonly error: string | null; readonly newSlot: string | null }>;
};

/** Settings of the backend path. */
export type BackendPathOptions = {
  readonly pair: string;
  /** Shown in the dry run, such as `https://prove.zkb.fi`. */
  readonly baseUrl: string;
  /** A rate limit that asks to wait at most this long is waited out. A longer one defers to the next run. */
  readonly maxRetryWaitSeconds: number;
  /** How long a job may stay queued or proving. */
  readonly jobTimeoutSeconds: number;
  readonly pollSeconds: number;
};

/** The job statuses after which the backend does no more work on a job. */
const DONE_STATUSES = new Set(["published", "on-chain", "failed"]);

/**
 * Proofs through the backend (`POST /requests`, reason `keep-alive`). The backend checks its own limits and asks its
 * chain indexer whether the direction needs a proof, so a request can be refused without fault: a refusal defers to the
 * next run. A request for a direction with an active job joins that job. The backend's job ends when the proof is on
 * msgboard (`published`); the runner bot then posts `update`, so the march waits for the head after that.
 */
export function backendPath(backend: BackendPort, options: BackendPathOptions, runtime: Runtime): ProofPath {
  return {
    describe: (target) => `POST ${options.baseUrl}/requests {pair: ${options.pair}, direction: ${target.direction}, reason: keep-alive}`,
    async prove(target): Promise<ProofOutcome> {
      let waited = 0;
      for (;;) {
        const answer = await backend.requestProof({ pair: options.pair, direction: target.direction, reason: "keep-alive" });
        if ("requestId" in answer) return await followJob(backend, answer.requestId, options, runtime);
        if (answer.refused === "nothing-to-prove") {
          return { kind: "deferred", detail: "the backend refused: nothing-to-prove (its indexer sees a head younger than limits.keepAliveSeconds); use --via local if the deadline is near" };
        }
        if (waited + answer.retryAfterSeconds > options.maxRetryWaitSeconds) {
          return { kind: "deferred", detail: `the backend refused: ${answer.refused}, retry after ${answer.retryAfterSeconds} s` };
        }
        runtime.log(`march: ${target.label}: the backend answered ${answer.refused}; asking again in ${answer.retryAfterSeconds} s`);
        waited += answer.retryAfterSeconds;
        await runtime.sleep(answer.retryAfterSeconds * 1000);
      }
    },
  };
}

async function followJob(backend: BackendPort, requestId: string, options: BackendPathOptions, runtime: Runtime): Promise<ProofOutcome> {
  const deadline = runtime.now() + options.jobTimeoutSeconds;
  for (;;) {
    const job = await backend.requestStatus(requestId);
    if (job.status === "failed") return { kind: "failed", detail: `backend job ${job.jobId} failed: ${job.error ?? "no reason given"}` };
    if (DONE_STATUSES.has(job.status)) return { kind: "submitted", detail: `backend job ${job.jobId} is ${job.status} (new slot ${job.newSlot ?? "unknown"})` };
    if (runtime.now() >= deadline) return { kind: "failed", detail: `backend job ${job.jobId} is still ${job.status} after ${options.jobTimeoutSeconds} s` };
    await runtime.sleep(options.pollSeconds * 1000);
  }
}

/** The result of one run of a program. */
export type RunResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

/** Settings of the local path. */
export type LocalPathOptions = {
  /** The `zk-bridge-prover` binary. */
  readonly prover: string;
  /** The prover configuration (docs/testnet-run.md, step 6). */
  readonly proverConfig: string;
  /** The route of the prover configuration for each direction. */
  readonly routes: Readonly<Record<ProofDirection, string>>;
};

/** The exit code of `zk-bridge-prover prove` when the head already is the newest final header. */
export const PROVER_UP_TO_DATE = 3;

/**
 * Proofs with the local prover: `zk-bridge-prover prove --route <route> --to stdout`, then `update` sent to the light
 * client by `send` (the binary wires `cast send` with the operator's keystore). The package must start at the head the
 * march read and name the light client of the target, or nothing is sent.
 */
export function localPath(
  options: LocalPathOptions,
  run: (command: string, args: readonly string[]) => Promise<RunResult>,
  send: (target: Target, calldata: `0x${string}`) => Promise<{ readonly ok: boolean; readonly detail: string }>,
): ProofPath {
  const argumentsFor = (target: Target) => ["--config", options.proverConfig, "prove", "--route", options.routes[target.direction], "--to", "stdout"];
  return {
    describe: (target) => `run ${options.prover} ${argumentsFor(target).join(" ")} and send update to ${target.lightClient}`,
    async prove(target: Target, facts: LightClientFacts): Promise<ProofOutcome> {
      const result = await run(options.prover, argumentsFor(target));
      if (result.exitCode === PROVER_UP_TO_DATE) return { kind: "up-to-date", detail: "zk-bridge-prover exit code 3" };
      if (result.exitCode !== 0) return { kind: "failed", detail: `zk-bridge-prover exit code ${result.exitCode}: ${lastLine(result.stderr)}` };
      const proofPackage = parsePackage(result.stdout);
      if (proofPackage === null) return { kind: "failed", detail: "zk-bridge-prover printed no proof package" };
      if (proofPackage.startHeadSlot !== facts.headSlot) {
        return { kind: "failed", detail: `the package starts at slot ${proofPackage.startHeadSlot}, the light client is at ${facts.headSlot}` };
      }
      const named = proofPackage.destination?.lightClient;
      if (named !== undefined && named.toLowerCase() !== target.lightClient.toLowerCase()) {
        return { kind: "failed", detail: `the package is for light client ${named}, not ${target.lightClient}: check the route of ${target.direction}` };
      }
      const sent = await send(target, proofPackage.updateCalldata);
      if (!sent.ok) return { kind: "failed", detail: `update was not sent: ${sent.detail}` };
      return { kind: "submitted", detail: `update to slot ${proofPackage.newHeadSlot} sent: ${sent.detail}` };
    },
  };
}

type PackageView = { startHeadSlot: number; newHeadSlot: number; updateCalldata: `0x${string}`; destination?: { lightClient?: string } };

/** The proof package: the one JSON line on standard output (prover/src/handoff.rs), or null. */
function parsePackage(stdout: string): PackageView | null {
  for (const line of stdout.split("\n").reverse()) {
    try {
      const value = JSON.parse(line) as Partial<PackageView>;
      if (typeof value.startHeadSlot === "number" && typeof value.newHeadSlot === "number" && typeof value.updateCalldata === "string" && /^0x[0-9a-fA-F]+$/.test(value.updateCalldata)) {
        return value as PackageView;
      }
    } catch {
      // Not the package line.
    }
  }
  return null;
}

const lastLine = (text: string) =>
  text
    .trim()
    .split("\n")
    .slice(-1)[0] as string;
