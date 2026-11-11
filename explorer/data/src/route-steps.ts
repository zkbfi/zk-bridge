/**
 * Route actions (docs/superpowers/specs/2026-11-11-route-actions-design.md): every on-chain step the route needs, as one
 * model for the backend, the dapp and any other client. The backend lists the pending steps with their situation and
 * constraints in numbers (`GET /route/steps`), makes the proof of a step on request (`POST /steps/requests`, one job per
 * step at a time, a request while one runs joins it), shows the job (`GET /steps/jobs/:jobId`) and serves the finished
 * proof with public fields only (`GET /steps/proofs/:kind/:subject`). A visitor posts it from their own wallet;
 * {@link stepFlow} says where the guided flow of one step stands. Times are milliseconds since 1970; gas and wei are
 * decimal text.
 */
import { z } from "zod";
import { latestForkObservationSchema } from "./fork-observation.js";
import { evidencePackageSchema } from "./prover/packages.js";

/** Every kind of step, in the order a route needs them. */
export const ROUTE_STEP_KINDS = ["light-client-update", "registry-light-client-update", "fork-observation", "open-deposits", "layout-rows", "deliver", "seal"] as const;

/** One kind of step. */
export type RouteStepKind = (typeof ROUTE_STEP_KINDS)[number];

/** The kinds whose proof the backend makes on request. A seal needs none: the dapp builds its evidence from a beacon node or the registry. */
export const REQUESTABLE_STEP_KINDS = ["light-client-update", "registry-light-client-update", "fork-observation", "open-deposits", "layout-rows", "deliver"] as const;

/** One kind whose proof the backend makes. */
export type RequestableStepKind = (typeof REQUESTABLE_STEP_KINDS)[number];

/** The kinds whose proof runs on the GPU (SP1). The others are built from chain and beacon data in seconds. */
export const GPU_STEP_KINDS: readonly RouteStepKind[] = ["light-client-update", "registry-light-client-update", "fork-observation"];

/** Whether a step's proof runs on the GPU. */
export const usesGpu = (kind: RouteStepKind): boolean => GPU_STEP_KINDS.includes(kind);

/** Whether a kind can be asked for. */
export const isRequestableKind = (kind: string): kind is RequestableStepKind => (REQUESTABLE_STEP_KINDS as readonly string[]).includes(kind);

/** The name of each kind, as a heading. */
export const STEP_TITLES: Readonly<Record<RouteStepKind, string>> = {
  "light-client-update": "Light client update",
  "registry-light-client-update": "Fork registry light client update",
  "fork-observation": "Fork observation",
  "open-deposits": "Open deposits",
  "layout-rows": "Layout rows",
  deliver: "Deliver a message",
  seal: "Seal the gate",
};

/** The id of a step: its kind and its subject. */
export const stepIdOf = (kind: RouteStepKind, subject: string): string => `${kind}:${subject}`;

/** What a pending step holds up. */
export const STEP_BLOCKS = ["sends", "deliveries"] as const;

/** One thing a step holds up. */
export type StepBlock = (typeof STEP_BLOCKS)[number];

const directionSchema = z.enum(["first-to-second", "second-to-first"]);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be 20 bytes of 0x hex");
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 32 bytes of 0x hex");
const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, "must be 0x hex");
const decimalSchema = z.string().regex(/^\d+$/, "must be decimal text");
const kindSchema = z.enum(ROUTE_STEP_KINDS);

/** One pending step, as `GET /route/steps` lists it. */
export const routeStepSchema = z
  .object({
    /** `<kind>:<subject>`. */
    id: z.string(),
    kind: kindSchema,
    /** A direction (light client update, open deposits), a chain id (registry update, fork observation, seal) or a message id (layout rows, delivery). */
    subject: z.string(),
    direction: directionSchema.nullable(),
    /** The chain the posting transaction goes to. */
    chainId: z.number().int().positive(),
    /** The contract the posting transaction calls, when known. */
    target: addressSchema.nullable(),
    messageId: hashSchema.nullable(),
    situation: z
      .object({
        /** Since when the step is pending: the head's last update, the message's cover, the version's start. */
        since: z.number().nullable(),
        /** How far the light client is behind: the age of its head, in seconds. */
        behindSeconds: z.number().nullable(),
        /** The transfers that wait for this step. */
        waitingTransfers: z.number().int().nonnegative(),
        /** What the step holds up. */
        blocks: z.array(z.enum(STEP_BLOCKS)),
        /** When the light client strands if nothing lands (the period handoff), or the registry's light client reaches 64 periods. */
        strandsAt: z.number().nullable(),
        /** Layout rows the delivery needs first (layout rows and delivery steps). */
        layoutRows: z.number().int().nonnegative().nullable(),
        /** The fork version the chain runs and the one the registry holds (fork observation). */
        activeVersion: z.string().nullable(),
        recordedVersion: z.string().nullable(),
      })
      .passthrough(),
    constraints: z
      .object({
        /** The newest final slot the proof reaches, and when the next one is expected. Null for a step without finality. */
        finality: z.object({ finalizedSlot: z.number(), nextAt: z.number() }).passthrough().nullable(),
        /**
         * The GPU: the median time of a proof on a warm worker and with a worker start (from the benchmarks), whether a worker is
         * warm now, and the 24 h budget of the direction that pays for it. Null for a step without GPU.
         */
        gpu: z
          .object({
            warmMs: z.number().nullable(),
            coldMs: z.number().nullable(),
            workerWarm: z.boolean(),
            budgetUsd: z.number(),
            spentUsd: z.number(),
            leftUsd: z.number(),
          })
          .passthrough()
          .nullable(),
        /** The job that makes the proof now: a request joins it. */
        job: z.object({ jobId: z.string(), status: z.string(), startedAt: z.number() }).passthrough().nullable(),
        /** A finished proof waits at `GET /steps/proofs/:kind/:subject`. */
        proofReady: z.boolean(),
        /** The posting transaction: its gas (simulated with the proof, or the fallback the runner uses), the gas price now and the cost. */
        posting: z
          .object({
            gas: decimalSchema.nullable(),
            gasSource: z.enum(["simulated", "fallback"]).nullable(),
            gasPriceWei: decimalSchema.nullable(),
            costWei: decimalSchema.nullable(),
          })
          .passthrough(),
        /** The step that must land first, by id. */
        after: z.string().nullable(),
      })
      .passthrough(),
    /** Who posts the step when nobody else has by `at`, and when. `at` null: the backend or runner posts as soon as it can. */
    fallback: z.object({ by: z.enum(["backend", "runner"]), at: z.number().nullable() }).passthrough().nullable(),
  })
  .passthrough();

/** One pending step. */
export type RouteStep = z.infer<typeof routeStepSchema>;

/** The answer of `GET /route/steps`. `unread` names the reads that failed, so a missing step is not taken for a done one. */
export const routeStepsSchema = z.object({ now: z.number(), steps: z.array(routeStepSchema), unread: z.array(z.string()) }).passthrough();

/** Every pending step. */
export type RouteSteps = z.infer<typeof routeStepsSchema>;

/** A request to make the proof of a step. */
export type StepRequestInput = { readonly pair: string; readonly kind: RequestableStepKind; readonly subject: string };

/**
 * The answer to a step request. A refusal is a value:
 *
 * - accepted: `jobId` is the job that makes the proof; `joined` when it was running already; `ready` when the proof is
 *   made already (the job finished).
 * - `nothing-to-prove`: `why` `no-need` (the step is not pending), `proof-pending` (a proof made already waits to land).
 * - `rate-limited`: a caller limit, one job per finality, the retry wait or the direction's GPU budget; `detail` says which.
 * - `cannot-check`: the backend could not read the chains; ask again after `retryAfterSeconds`.
 * - `not-served`: this backend does not make this kind (its module is off).
 */
export type StepRequestAnswer =
  | { readonly jobId: string; readonly joined?: true; readonly ready?: true }
  | { readonly refused: "nothing-to-prove"; readonly why?: string }
  | { readonly refused: "rate-limited"; readonly retryAfterSeconds: number; readonly why?: string; readonly detail?: string }
  | { readonly refused: "cannot-check"; readonly retryAfterSeconds: number }
  | { readonly refused: "not-served"; readonly detail?: string };

/** The statuses of a step job. */
export const STEP_JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

/** One status. */
export type StepJobStatus = (typeof STEP_JOB_STATUSES)[number];

/** The answer of `GET /steps/jobs/:jobId`. `etaAt`: when the proof is expected, from the benchmarks; null when not known. */
export const stepJobSchema = z
  .object({
    jobId: z.string(),
    kind: kindSchema,
    subject: z.string(),
    status: z.enum(STEP_JOB_STATUSES),
    startedAt: z.number(),
    updatedAt: z.number(),
    etaAt: z.number().nullable(),
    error: z.string().nullable(),
  })
  .passthrough();

/** One step job. */
export type StepJob = z.infer<typeof stepJobSchema>;

/** The proof of a light client update: the proof message as the board carries it (`payload`), and where it is. */
export const lightClientUpdateProofSchema = z
  .object({
    kind: z.literal("light-client-update"),
    subject: directionSchema,
    chainId: z.number().int().positive(),
    payload: hexSchema,
    startSlot: z.number().int().nonnegative(),
    newSlot: z.number().int().nonnegative(),
    provedAt: z.number(),
    where: z.enum(["stored", "board"]),
  })
  .passthrough();

/** The proof of an update of the fork registry's own light client. */
export const registryUpdateProofSchema = z
  .object({
    kind: z.literal("registry-light-client-update"),
    subject: z.string(),
    chainId: z.number().int().positive(),
    lightClient: addressSchema,
    programKey: hashSchema,
    startSlot: z.number().int().nonnegative(),
    startRoot: hashSchema,
    newSlot: z.number().int().nonnegative(),
    newRoot: hashSchema,
    publicValues: hexSchema,
    proof: hexSchema,
    provedAt: z.number(),
  })
  .passthrough();

/** The proof of a fork observation: the backend's public view. */
export const forkObservationProofSchema = z.object({ kind: z.literal("fork-observation"), subject: z.string(), observation: latestForkObservationSchema }).passthrough();

/** The opening proof of a bridge: the `openDeposits(proof)` call, with the slots it rests on. */
export const openDepositsProofSchema = z
  .object({
    kind: z.literal("open-deposits"),
    subject: directionSchema,
    chainId: z.number().int().positive(),
    bridge: addressSchema,
    calldata: hexSchema,
    remoteSlot: z.number().int().nonnegative(),
    storedSlot: z.number().int().nonnegative(),
    remoteBlockNumber: z.number().int().nonnegative(),
    provedAt: z.number(),
  })
  .passthrough();

/** The evidence of a delivery (its layout rows first). */
export const evidenceProofSchema = z.object({ kind: z.enum(["layout-rows", "deliver"]), subject: hashSchema, evidence: evidencePackageSchema }).passthrough();

/** The answer of `GET /steps/proofs/:kind/:subject`. */
export const stepProofSchema = z.union([lightClientUpdateProofSchema, registryUpdateProofSchema, forkObservationProofSchema, openDepositsProofSchema, evidenceProofSchema]);

/** One finished proof. */
export type StepProof = z.infer<typeof stepProofSchema>;

/** Where the guided flow of one step stands: make the proof, wait for it, post it, done. */
export type StepFlow =
  /** Nothing made yet: "Make the proof". `retryAt` set: a limit refused it; the button comes back then. */
  | { readonly phase: "make"; readonly retryAt: number | null; readonly note: string | null }
  /** The backend makes the proof: the job, and when it is expected. */
  | { readonly phase: "proving"; readonly jobId: string; readonly startedAt: number; readonly etaAt: number | null }
  /** The proof is made: "Post it from your wallet". */
  | { readonly phase: "post" }
  /** The job failed: its reason; "Make the proof" again. */
  | { readonly phase: "failed"; readonly error: string }
  /** The visitor's own transaction went through. */
  | { readonly phase: "done"; readonly transaction: string }
  /** Someone else posted the step (the backend, the runner, another visitor): nothing left to do. */
  | { readonly phase: "posted-elsewhere" };

/**
 * Where the flow of one step stands, from the reads of the page.
 *
 * @param input.kind The kind of the step.
 * @param input.pending The step as the newest list shows it, or null once it is no longer listed (posted).
 * @param input.job The job this page started or joined, as last read; null before any.
 * @param input.proofReady Whether the finished proof can be read now.
 * @param input.transaction The visitor's own confirmed transaction, once there is one.
 * @param input.refusal The last refusal of a request: its words and until when the button stays off.
 */
export const stepFlow = (input: {
  readonly kind: RouteStepKind;
  readonly pending: RouteStep | null;
  readonly job: StepJob | null;
  readonly proofReady: boolean;
  readonly transaction: string | null;
  readonly refusal?: { readonly note: string; readonly retryAt: number | null } | null;
}): StepFlow => {
  if (input.transaction !== null) return { phase: "done", transaction: input.transaction };
  if (input.pending === null) return { phase: "posted-elsewhere" };
  if (input.kind === "seal" || input.proofReady || input.pending.constraints.proofReady) return { phase: "post" };
  const job = input.job ?? (input.pending.constraints.job === null ? null : { jobId: input.pending.constraints.job.jobId, status: "running" as const, startedAt: input.pending.constraints.job.startedAt, etaAt: null, error: null });
  if (job !== null && (job.status === "queued" || job.status === "running")) return { phase: "proving", jobId: job.jobId, startedAt: job.startedAt, etaAt: job.etaAt };
  if (job !== null && job.status === "failed") return { phase: "failed", error: job.error ?? "the proof could not be made" };
  const refusal = input.refusal ?? null;
  return { phase: "make", retryAt: refusal?.retryAt ?? null, note: refusal?.note ?? null };
};

/**
 * The step that holds up a transfer: the step of its message (layout rows, delivery) or of its direction (the light
 * client update, then opening the deposits). Null when none is pending.
 *
 * @param steps The pending steps.
 * @param input.messageId The transfer.
 * @param input.direction Its direction.
 * @param input.covered Whether the light client holds a head that covers it (then only its delivery steps can hold it up).
 */
export const blockingStepOf = (steps: readonly RouteStep[], input: { readonly messageId: string; readonly direction: "first-to-second" | "second-to-first"; readonly covered: boolean }): RouteStep | null => {
  const own = steps.find((step) => step.messageId !== null && step.messageId.toLowerCase() === input.messageId.toLowerCase());
  if (own !== undefined) return own;
  if (input.covered) return null;
  return steps.find((step) => step.kind === "light-client-update" && step.direction === input.direction) ?? null;
};

/**
 * The steps that hold up new sends or deliveries, for a one-line notice: deposits closed, a gate to seal, or a light
 * client within `strandingHours` of stranding.
 *
 * @param steps The pending steps.
 * @param now Milliseconds since 1970.
 * @param strandingHours How close to stranding counts. Default 12.
 */
export const routeBlockersOf = (steps: readonly RouteStep[], now: number, strandingHours = 12): readonly RouteStep[] =>
  steps.filter(
    (step) =>
      step.kind === "open-deposits" ||
      step.kind === "seal" ||
      (step.kind === "light-client-update" && step.situation.strandsAt !== null && step.situation.strandsAt - now <= strandingHours * 3_600_000),
  );
