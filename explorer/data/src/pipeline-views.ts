import { z } from "zod";

/**
 * The pipeline reads of the backend: where one transfer is and what it waits on (`GET /progress/:messageId`), the
 * proving pipeline of a direction (`GET /directions/:direction/pipeline`) and the timings of each step
 * (`GET /benchmarks?window=24h`). Times are milliseconds since 1970; durations are milliseconds. The shapes are
 * described in explorer/backend/README.md, "Pipeline reads".
 */

/** The stages of a transfer, in order. */
export const PIPELINE_STAGES = ["sent", "final", "batched", "proving", "proof-ready", "update-posted", "delivered"] as const;

/** One stage key. */
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** The services a transfer can wait on. `none`: nothing; the transfer is done. */
export const WAITING_SERVICES = [
  "source-chain-finality",
  "batch-profit",
  "batch-max-wait",
  "proof-dedup-pending",
  "gpu-worker-start",
  "gpu-proving",
  "board-post",
  "light-client-update",
  "delivery",
  "none",
] as const;

/** One service. */
export type WaitingService = (typeof WAITING_SERVICES)[number];

/** What each service means, in a sentence a person reads. */
export const WAITING_SERVICE_TEXT: Readonly<Record<WaitingService, string>> = {
  "source-chain-finality": "The source chain is finalizing the block with this transfer.",
  "batch-profit": "The proof starts once the waiting transfers' fees cover its cost.",
  "batch-max-wait": "The proof starts at the batch's set time, whatever the fees.",
  "proof-dedup-pending": "A proof already made is landing first; this transfer goes in the proof after it.",
  "gpu-worker-start": "A GPU worker is starting for the proof.",
  "gpu-proving": "The GPU is making the proof.",
  "board-post": "The proof is made and is being posted to the message board.",
  "light-client-update": "The proof is on the message board; a runner posts it to the destination chain.",
  delivery: "The destination chain accepts the transfer; a runner delivers it.",
  none: "Nothing: the transfer is done.",
};

const directionSchema = z.enum(["first-to-second", "second-to-first"]);
const proofWhereSchema = z.enum(["stored", "board", "applied"]);
const waitingServiceSchema = z.enum(WAITING_SERVICES);

/** The answer of `GET /progress/:messageId`. */
export const transferProgressSchema = z
  .object({
    messageId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    direction: directionSchema,
    /** The status the chain indexer gives the message (`sent`, `waiting_for_finality`, `covered`, `delivered`...). */
    status: z.string(),
    /** The beacon slot of the source block, when the backend knows the slot clock. */
    slot: z.number().nullable(),
    stages: z.array(
      z.object({ key: z.enum(PIPELINE_STAGES), status: z.enum(["done", "current", "pending"]), at: z.number().optional(), detail: z.string().optional() }).passthrough(),
    ),
    waitingOn: z.object({ service: waitingServiceSchema, since: z.number(), eta: z.number().optional(), detail: z.string().optional() }).passthrough(),
    /** The proof that carries the transfer, once one exists: "I have the proof but it is not on chain" is `stored` or `board`. */
    proof: z.object({ startSlot: z.number(), newSlot: z.number(), where: proofWhereSchema }).passthrough().optional(),
    job: z.object({ jobId: z.string(), status: z.string() }).passthrough().optional(),
  })
  .passthrough();

/** Where a transfer is. */
export type TransferProgress = z.infer<typeof transferProgressSchema>;

/** The answer of `GET /directions/:direction/pipeline`. */
export const directionPipelineSchema = z
  .object({
    direction: directionSchema,
    now: z.number(),
    /** How a proof of the direction starts (absent from an older backend). */
    rule: z
      .object({ minIntervalSeconds: z.number(), lookaheadSeconds: z.number(), profitMargin: z.number(), proofCostUsd: z.string(), priced: z.boolean() })
      .passthrough()
      .optional(),
    batch: z
      .object({
        count: z.number(),
        oldestFinalAt: z.number(),
        trigger: z.enum(["profit", "max-wait"]),
        eta: z.number(),
        fallbackAt: z.number(),
        feesUsd: z.string().nullable(),
        costUsd: z.string().nullable(),
        detail: z.string(),
      })
      .passthrough()
      .nullable(),
    job: z
      .object({ jobId: z.string(), status: z.string(), step: waitingServiceSchema, startedAt: z.number(), elapsedMs: z.number(), eta: z.number().optional(), detail: z.string() })
      .passthrough()
      .nullable(),
    latestJob: z
      .object({ jobId: z.string(), status: z.string(), createdAt: z.number(), updatedAt: z.number(), startSlot: z.string().nullable(), newSlot: z.string().nullable(), error: z.string().nullable() })
      .passthrough()
      .nullable(),
    latestProof: z.object({ startSlot: z.number(), newSlot: z.number(), where: proofWhereSchema, since: z.number() }).passthrough().nullable(),
    head: z.object({ slot: z.number().nullable(), finalizedSlot: z.number().nullable(), lastUpdateAt: z.number().nullable(), lagSeconds: z.number().nullable() }).passthrough().nullable(),
    /** The watcher's latest decision, as the backend logs it (`why`, `detail`, and for a batch its facts). */
    decision: z.object({ at: z.number(), finalizedSlot: z.number(), due: z.boolean(), why: z.string(), detail: z.string() }).passthrough().nullable(),
    /**
     * The destination bridge's deposits as the latest decision read them: `waiting` while the bridge waits for an update
     * of this direction's light client to open, `proofDue` when a proof started for it. Absent from an older backend.
     */
    deposits: z.object({ open: z.boolean().nullable(), remoteHasHead: z.boolean().nullable(), waiting: z.boolean(), proofDue: z.boolean() }).passthrough().nullable().optional(),
  })
  .passthrough();

/** The proving pipeline of a direction. */
export type DirectionPipeline = z.infer<typeof directionPipelineSchema>;

/** The steps that `GET /benchmarks` times, in the order of a transfer. */
export const BENCHMARK_STEPS = ["workerWait", "remote", "workerQueue", "workerProve", "total", "webhookToBoard", "boardPost", "proofToOnChain", "coveredToDelivered", "sentToDelivered"] as const;

/** One timed step. */
export type BenchmarkStep = (typeof BENCHMARK_STEPS)[number];

const statSchema = z.object({ count: z.number(), medianMs: z.number().nullable(), p90Ms: z.number().nullable() }).passthrough();
const stepsSchema = z.object(Object.fromEntries(BENCHMARK_STEPS.map((step) => [step, statSchema])) as Record<BenchmarkStep, typeof statSchema>).passthrough();

/** The answer of `GET /benchmarks`. */
export const benchmarksSchema = z
  .object({
    window: z.string(),
    windowSeconds: z.number(),
    from: z.number(),
    to: z.number(),
    steps: stepsSchema,
    byDirection: z.object({ "first-to-second": stepsSchema, "second-to-first": stepsSchema }).passthrough(),
    recent: z.array(
      z
        .object({
          jobId: z.string(),
          direction: directionSchema,
          startSlot: z.number().nullable(),
          newSlot: z.number().nullable(),
          provedAt: z.number().nullable(),
          waitWorkerMs: z.number().nullable(),
          coldWorker: z.boolean().nullable(),
          remoteMs: z.number().nullable(),
          workerProveMs: z.number().nullable(),
          totalMs: z.number().nullable(),
          grindMs: z.number().nullable(),
          boardPostedAt: z.number().nullable(),
          onChainAt: z.number().nullable(),
          endpoint: z.string().nullable(),
          workerGpu: z.string().nullable(),
        })
        .passthrough(),
    ),
    indexer: z.enum(["ok", "unavailable"]),
  })
  .passthrough();

/** The timings of each step over a window. */
export type Benchmarks = z.infer<typeof benchmarksSchema>;
