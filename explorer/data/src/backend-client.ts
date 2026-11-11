import { z } from "zod";
import type { Hex } from "viem";
import type { JsonFetcher, JsonResponse } from "./connection.js";
import type { JsonRequestInit } from "./msgboard/board-http.js";
import type { ProofDirection } from "./proof-message.js";
import { evidencePackageSchema, type EvidencePackage } from "./prover/packages.js";
import { latestForkObservationSchema, type LatestForkObservation } from "./fork-observation.js";
import { routeStepsSchema, stepJobSchema, stepProofSchema, type RouteStepKind, type RouteSteps, type StepJob, type StepProof, type StepRequestAnswer, type StepRequestInput } from "./route-steps.js";
import { benchmarksSchema, directionPipelineSchema, transferProgressSchema, type Benchmarks, type DirectionPipeline, type TransferProgress } from "./pipeline-views.js";

/** Posts a JSON body and parses the JSON of the answer. The `postJsonResponse` of the msgboard code fits it. */
export type JsonPoster = (url: string, init: JsonRequestInit) => Promise<JsonResponse>;

/** The backend answered with a status or a shape that the client does not know. */
export class BackendClientError extends Error {
  override readonly name = "BackendClientError";
}

const directionSchema = z.enum(["first-to-second", "second-to-first"]);
const statusSchema = z.enum(["queued", "proving", "published", "on-chain", "failed"]);
const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 32 bytes of 0x hex");

/** One job, as the backend shows it. Times are milliseconds since 1970. */
export const jobViewSchema = z
  .object({
    jobId: z.string(),
    direction: directionSchema,
    status: statusSchema,
    createdAt: z.number(),
    updatedAt: z.number(),
    startSlot: z.string().nullable(),
    newSlot: z.string().nullable(),
    error: z.string().nullable(),
  })
  .passthrough();

/** One job, as the backend shows it. */
export type JobView = z.infer<typeof jobViewSchema>;

const requestAcceptedSchema = z.object({ requestId: z.string(), jobId: z.string(), joined: z.literal(true).optional() }).passthrough();
const rateLimitedSchema = z.object({ error: z.literal("rate-limited"), retryAfterSeconds: z.number(), why: z.string().optional(), detail: z.string().optional() }).passthrough();
const nothingToProveSchema = z.object({ error: z.literal("nothing-to-prove"), why: z.string().optional() }).passthrough();
const cannotCheckSchema = z.object({ error: z.literal("cannot-check"), retryAfterSeconds: z.number() }).passthrough();
const notServedSchema = z.object({ error: z.literal("not-served"), detail: z.string().optional() }).passthrough();
const stepAcceptedSchema = z.object({ jobId: z.string(), joined: z.literal(true).optional(), ready: z.literal(true).optional() }).passthrough();
const requestStatusSchema = jobViewSchema.and(z.object({ requestId: z.string(), reason: z.string(), messageId: hashSchema.nullable(), requestedAt: z.number() }));
const directionStatusSchema = z.object({ direction: directionSchema, job: jobViewSchema.nullable() }).passthrough();

/** The latest valid proof of a direction, as the msgboard indexer serves it. Slots are decimal text. */
export const latestProofSchema = z
  .object({
    pair: z.string(),
    direction: directionSchema,
    programKey: hashSchema,
    startSlot: z.string().regex(/^\d+$/),
    startRoot: hashSchema,
    newSlot: z.string().regex(/^\d+$/),
    newRoot: hashSchema,
    publicValues: hexSchema,
    proof: hexSchema,
  })
  .passthrough();

/** The latest valid proof of a direction. */
export type LatestProof = z.infer<typeof latestProofSchema>;

const healthSchema = z
  .object({
    status: z.literal("ok"),
    time: z.number(),
    modules: z.record(z.string(), z.object({ state: z.enum(["running", "not built", "degraded"]), detail: z.string().optional() })),
    queue: z.object({ length: z.number() }),
    lastJobs: z.record(z.string(), z.unknown()),
  })
  .passthrough();

/** The answer of `GET /health`. */
export type BackendHealth = z.infer<typeof healthSchema>;

/** The proof request. */
export type ProofRequestInput = { pair: string; direction: ProofDirection; reason: "message" | "keep-alive" | "user"; messageId?: Hex };

/**
 * The answer to a proof request. The backend starts a job only when the chain indexer shows that the chains need a
 * proof, so a request can be refused without fault:
 *
 * - accepted with `joined`: a proof of the direction was running already, and the request joined it.
 * - `rate-limited`: a limit refused it. Ask again after `retryAfterSeconds`. `why` (from a newer backend): `limit` (a
 *   caller limit, the wait after a failed job, the daily job cap), `same-finality` (a job already proves to the newest
 *   finality; the next comes in about `retryAfterSeconds`) or `gpu-budget` (the direction's 24 h GPU budget is spent;
 *   `detail` says by how much).
 * - `nothing-to-prove`: nothing needs a proof. `why`: `no-need` (no final message waits and the head is fresh) or
 *   `proof-pending` (a proof already made waits to land). Asking again changes nothing for now.
 * - `cannot-check`: the backend could not ask its chain indexer. Ask again after `retryAfterSeconds`.
 */
export type ProofRequestAnswer =
  | { readonly requestId: string; readonly jobId: string; readonly joined?: true }
  | { readonly refused: "rate-limited"; readonly retryAfterSeconds: number; readonly why?: string; readonly detail?: string }
  | { readonly refused: "nothing-to-prove"; readonly why?: string }
  | { readonly refused: "cannot-check"; readonly retryAfterSeconds: number };

function parseAnswer<Schema extends z.ZodType>(schema: Schema, response: JsonResponse, what: string): z.infer<Schema> {
  const parsed = schema.safeParse(response.body);
  if (!parsed.success) throw new BackendClientError(`the backend answered ${what} with an unknown shape`);
  return parsed.data;
}

function refuseStatus(response: JsonResponse, what: string): never {
  throw new BackendClientError(`the backend answered ${what} with status ${response.status}`);
}

/**
 * A client for the backend. It holds no state and no secret. It parses every answer, so a wrong shape fails here and
 * not deeper in a page.
 *
 * @param input.baseUrl The backend address, such as `https://backend.example`.
 * @param input.fetchJson Reads a URL. A test passes a fake.
 * @param input.postJson Posts a body. A test passes a fake.
 */
export function createBackendClient(input: { baseUrl: string; fetchJson: JsonFetcher; postJson: JsonPoster }) {
  const base = input.baseUrl.replace(/\/+$/, "");
  const get = (path: string) => input.fetchJson(`${base}${path}`);

  return {
    /** Asks for a proof. A refusal (see {@link ProofRequestAnswer}) comes back as a value, not as an error. */
    async requestProof(request: ProofRequestInput): Promise<ProofRequestAnswer> {
      const response = await input.postJson(`${base}/requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      if (response.status === 429) {
        const limited = parseAnswer(rateLimitedSchema, response, "a proof request");
        return { refused: "rate-limited", retryAfterSeconds: limited.retryAfterSeconds, ...(limited.why === undefined ? {} : { why: limited.why }), ...(limited.detail === undefined ? {} : { detail: limited.detail }) };
      }
      if (response.status === 409) {
        const nothing = parseAnswer(nothingToProveSchema, response, "a proof request");
        return { refused: "nothing-to-prove", ...(nothing.why === undefined ? {} : { why: nothing.why }) };
      }
      if (response.status === 503) {
        const unknown = parseAnswer(cannotCheckSchema, response, "a proof request");
        return { refused: "cannot-check", retryAfterSeconds: unknown.retryAfterSeconds };
      }
      if (response.status !== 202) refuseStatus(response, "a proof request");
      const accepted = parseAnswer(requestAcceptedSchema, response, "a proof request");
      return { requestId: accepted.requestId, jobId: accepted.jobId, ...(accepted.joined === true ? { joined: true as const } : {}) };
    },
    /** The state of one request and of its job. */
    async requestStatus(requestId: string) {
      const response = await get(`/requests/${encodeURIComponent(requestId)}`);
      if (response.status !== 200) refuseStatus(response, "a request status");
      return parseAnswer(requestStatusSchema, response, "a request status");
    },
    /** The active or newest job of a direction. */
    async directionStatus(direction: ProofDirection) {
      const response = await get(`/directions/${direction}`);
      if (response.status !== 200) refuseStatus(response, "a direction status");
      return parseAnswer(directionStatusSchema, response, "a direction status");
    },
    /** The latest proof of a direction, or null when the backend holds none. */
    async latestProof(direction: ProofDirection): Promise<LatestProof | null> {
      const response = await get(`/proofs/latest/${direction}`);
      if (response.status === 404) return null;
      if (response.status !== 200) refuseStatus(response, "a latest proof");
      return parseAnswer(latestProofSchema, response, "a latest proof");
    },
    /** The newest fork observation proof of a chain, or null when the backend holds none. */
    async latestForkObservation(chainId: number): Promise<LatestForkObservation | null> {
      const response = await get(`/fork-observations/${chainId}/latest`);
      if (response.status === 404) return null;
      if (response.status !== 200) refuseStatus(response, "a fork observation");
      return parseAnswer(latestForkObservationSchema, response, "a fork observation");
    },
    /** The evidence for a message, or null when the archive holds none. */
    async evidence(messageId: Hex): Promise<EvidencePackage | null> {
      const response = await get(`/evidence/${messageId}`);
      if (response.status === 404) return null;
      if (response.status !== 200) refuseStatus(response, "evidence");
      return parseAnswer(evidencePackageSchema, response, "evidence");
    },
    /**
     * Where a transfer is in the proving pipeline and which service it waits on, or null when the chain indexer does not
     * know the message. A 429 (60 reads a minute per caller) and a 503 (the indexer cannot be read) are errors.
     */
    async progress(messageId: Hex): Promise<TransferProgress | null> {
      const response = await get(`/progress/${messageId}`);
      if (response.status === 404) return null;
      if (response.status !== 200) refuseStatus(response, "a progress");
      return parseAnswer(transferProgressSchema, response, "a progress");
    },
    /** The proving pipeline of a direction: the waiting batch, the running job and its step, the newest proof and the head. */
    async pipeline(direction: ProofDirection): Promise<DirectionPipeline> {
      const response = await get(`/directions/${direction}/pipeline`);
      if (response.status !== 200) refuseStatus(response, "a pipeline");
      return parseAnswer(directionPipelineSchema, response, "a pipeline");
    },
    /** The median, p90 and count of each step over a window such as `24h`, `90m` or `7d` (1h to 30d). */
    async benchmarks(window = "24h"): Promise<Benchmarks> {
      const response = await get(`/benchmarks?window=${encodeURIComponent(window)}`);
      if (response.status !== 200) refuseStatus(response, "benchmarks");
      return parseAnswer(benchmarksSchema, response, "benchmarks");
    },
    /** Every pending step of the route, both directions, with its situation and constraints. */
    async routeSteps(): Promise<RouteSteps> {
      const response = await get("/route/steps");
      if (response.status !== 200) refuseStatus(response, "the route steps");
      return parseAnswer(routeStepsSchema, response, "the route steps");
    },
    /** Asks the backend to make the proof of a step. A refusal (see {@link StepRequestAnswer}) comes back as a value. */
    async requestStep(request: StepRequestInput): Promise<StepRequestAnswer> {
      const response = await input.postJson(`${base}/steps/requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      if (response.status === 429) {
        const limited = parseAnswer(rateLimitedSchema, response, "a step request");
        return { refused: "rate-limited", retryAfterSeconds: limited.retryAfterSeconds, ...(limited.why === undefined ? {} : { why: limited.why }), ...(limited.detail === undefined ? {} : { detail: limited.detail }) };
      }
      if (response.status === 409) {
        const nothing = parseAnswer(nothingToProveSchema, response, "a step request");
        return { refused: "nothing-to-prove", ...(nothing.why === undefined ? {} : { why: nothing.why }) };
      }
      if (response.status === 503) {
        const unknown = parseAnswer(cannotCheckSchema, response, "a step request");
        return { refused: "cannot-check", retryAfterSeconds: unknown.retryAfterSeconds };
      }
      if (response.status === 404) {
        const off = parseAnswer(notServedSchema, response, "a step request");
        return { refused: "not-served", ...(off.detail === undefined ? {} : { detail: off.detail }) };
      }
      if (response.status !== 202) refuseStatus(response, "a step request");
      const accepted = parseAnswer(stepAcceptedSchema, response, "a step request");
      return { jobId: accepted.jobId, ...(accepted.joined === true ? { joined: true as const } : {}), ...(accepted.ready === true ? { ready: true as const } : {}) };
    },
    /** One step job, or null when the backend does not know it. */
    async stepJob(jobId: string): Promise<StepJob | null> {
      const response = await get(`/steps/jobs/${encodeURIComponent(jobId)}`);
      if (response.status === 404) return null;
      if (response.status !== 200) refuseStatus(response, "a step job");
      return parseAnswer(stepJobSchema, response, "a step job");
    },
    /** The finished proof of a step, public fields only, or null when there is none. */
    async stepProof(kind: RouteStepKind, subject: string): Promise<StepProof | null> {
      const response = await get(`/steps/proofs/${kind}/${encodeURIComponent(subject)}`);
      if (response.status === 404) return null;
      if (response.status !== 200) refuseStatus(response, "a step proof");
      return parseAnswer(stepProofSchema, response, "a step proof");
    },
    /** The health report. */
    async health(): Promise<BackendHealth> {
      const response = await get("/health");
      if (response.status !== 200) refuseStatus(response, "a health check");
      return parseAnswer(healthSchema, response, "a health check");
    },
  };
}

/** The backend client. */
export type BackendClient = ReturnType<typeof createBackendClient>;
