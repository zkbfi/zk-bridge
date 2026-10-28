import { z } from "zod";
import type { Hex } from "viem";
import type { JsonFetcher, JsonResponse } from "./connection.js";
import type { JsonRequestInit } from "./msgboard/board-http.js";
import type { ProofDirection } from "./proof-message.js";
import { evidencePackageSchema, type EvidencePackage } from "./prover/packages.js";

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

const requestAcceptedSchema = z.object({ requestId: z.string(), jobId: z.string() }).passthrough();
const rateLimitedSchema = z.object({ error: z.literal("rate-limited"), retryAfterSeconds: z.number() }).passthrough();
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

/** The answer to a proof request. */
export type ProofRequestAnswer =
  | { readonly requestId: string; readonly jobId: string }
  | { readonly refused: "rate-limited"; readonly retryAfterSeconds: number };

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
    /** Asks for a proof. A refusal for rate limits comes back as a value, not as an error. */
    async requestProof(request: ProofRequestInput): Promise<ProofRequestAnswer> {
      const response = await input.postJson(`${base}/requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      if (response.status === 429) {
        const limited = parseAnswer(rateLimitedSchema, response, "a proof request");
        return { refused: "rate-limited", retryAfterSeconds: limited.retryAfterSeconds };
      }
      if (response.status !== 202) refuseStatus(response, "a proof request");
      return parseAnswer(requestAcceptedSchema, response, "a proof request");
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
    /** The evidence for a message, or null when the archive holds none. */
    async evidence(messageId: Hex): Promise<EvidencePackage | null> {
      const response = await get(`/evidence/${messageId}`);
      if (response.status === 404) return null;
      if (response.status !== 200) refuseStatus(response, "evidence");
      return parseAnswer(evidencePackageSchema, response, "evidence");
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
