import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { PROOF_DIRECTIONS, type ProofDirection } from "@zk-bridge/shared";
import type { BackendModuleContext } from "../module.ts";
import { UNKNOWN_CALLER, callerKey } from "./caller.ts";
import { findActiveJob, findLatestJob, getJob, getRequest, type Job } from "./jobs.ts";
import { createRequestService, type RequestService } from "./service.ts";
import { startWatch } from "../watch/module.ts";
import { createWarmupStore, noteJobWorkerWait } from "../watch/warmup-store.ts";
import { recordProveTiming } from "./timings.ts";
import { registerProgressRoutes } from "../progress/routes.ts";

/** The largest request body in bytes. A real body is under 300 bytes. */
export const MAXIMUM_BODY_BYTES = 4096;

/** How often the module deletes old request rows, in milliseconds. */
export const PRUNE_INTERVAL_MILLISECONDS = 3_600_000;

const requestBodySchema = z
  .object({
    pair: z.string().min(1),
    direction: z.enum(PROOF_DIRECTIONS),
    reason: z.enum(["message", "keep-alive", "user"]),
    messageId: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "must be 32 bytes of 0x hex")
      .transform((value) => value as `0x${string}`)
      .optional(),
  })
  .strict()
  .refine((body) => body.reason !== "message" || body.messageId !== undefined, {
    message: "a request with the reason message needs a messageId",
    path: ["messageId"],
  });

const services = new WeakMap<BackendModuleContext, RequestService>();

/** The request service of a context. One context has one service. */
function serviceFor(context: BackendModuleContext): RequestService {
  const known = services.get(context);
  if (known !== undefined) return known;
  const created = createRequestService({
    storage: context.storage,
    proverForJob: context.proverForJob,
    readProofNeed: context.readProofNeed,
    now: context.now,
    limits: context.config.limits,
    proverTimeoutMilliseconds: context.config.prover.timeoutSeconds * 1000,
    logger: context.logger,
    // The timings of every proof are kept for `GET /benchmarks` and the estimates of `GET /progress`. A job that met a
    // cold worker also tells the warm-up how long a cold start takes.
    onProved: (event) => {
      recordProveTiming(context.storage, { jobId: event.jobId, direction: event.direction, startedAt: event.startedAt, provedAt: context.now(), timing: event.timing });
      const wait = noteJobWorkerWait(createWarmupStore(context.storage), { direction: event.direction, startedAt: event.startedAt, timing: event.timing, at: context.now() });
      if (wait.kind === "cold") context.logger.info("warmup_observed", { direction: event.direction, source: "job", jobId: event.jobId, seconds: wait.seconds });
      if (wait.kind === "missed") context.logger.warn("warmup_missed", { direction: event.direction, jobId: event.jobId, waitWorkerSeconds: wait.seconds });
    },
  });
  services.set(context, created);
  return created;
}

type SocketBindings = { incoming?: { socket?: { remoteAddress?: string } } };

/**
 * The key that the rate limits count. With the forwarded header trusted, it is the entry `trustedProxyHops` places from
 * the right: the entries to its right came from your own proxies, and the entries to its left can be forged by the
 * client. A header with fewer entries falls back to the socket address. With no address at all the key is the shared
 * unknown bucket, which has a low limit.
 */
export function callerOf(request: Context, config: { trustForwardedHeader: boolean; trustedProxyHops: number }): string {
  const entries = (request.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const forwarded = config.trustForwardedHeader ? entries[entries.length - config.trustedProxyHops] : undefined;
  const address = forwarded ?? (request.env as SocketBindings | undefined)?.incoming?.socket?.remoteAddress;
  return address === undefined ? UNKNOWN_CALLER : callerKey(address);
}

function describeJob(job: Job) {
  return {
    jobId: job.id,
    direction: job.direction,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startSlot: job.startSlot,
    newSlot: job.newSlot,
    error: job.error,
  };
}

/**
 * Adds `POST /requests`, `GET /requests/:id` and `GET /directions/:direction`, and the pipeline reads
 * `GET /progress/:messageId`, `GET /directions/:direction/pipeline` and `GET /benchmarks` (`progress/routes.ts`).
 */
export function register(app: Hono, context: BackendModuleContext): void {
  const service = serviceFor(context);
  registerProgressRoutes(app, context, { callerOf: (request) => callerOf(request, context.config) });

  app.post(
    "/requests",
    bodyLimit({ maxSize: MAXIMUM_BODY_BYTES, onError: (request) => request.json({ error: "the request body is too large" }, 413) }),
    async (request) => {
      const body = requestBodySchema.safeParse(await request.req.json().catch(() => null));
      if (!body.success) return request.json({ error: "the request body is not valid" }, 400);
      if (body.data.pair !== context.config.pair) return request.json({ error: `this backend serves the pair ${context.config.pair}` }, 400);
      const result = await service.submit({ ...body.data, caller: callerOf(request, context.config) });
      if (!("refused" in result)) return request.json(result, 202);
      // The chains need no proof now: no message waits for a head and the head is fresh. Asking again changes nothing.
      // A request from outside never names a target, so it never meets "duplicate"; both mean that asking again changes nothing.
      if (!("retryAfterSeconds" in result)) return request.json({ error: result.refused }, 409);
      request.header("Retry-After", String(result.retryAfterSeconds));
      return request.json({ error: result.refused, retryAfterSeconds: result.retryAfterSeconds }, result.refused === "cannot-check" ? 503 : 429);
    },
  );

  app.get("/requests/:id", (request) => {
    const stored = getRequest(context.storage, request.req.param("id"));
    if (stored === null) return request.json({ error: "no such request" }, 404);
    const job = getJob(context.storage, stored.jobId) as Job;
    return request.json({ requestId: stored.id, reason: stored.reason, messageId: stored.messageId, requestedAt: stored.createdAt, ...describeJob(job) });
  });

  app.get("/directions/:direction", (request) => {
    const direction = request.req.param("direction") as ProofDirection;
    if (!PROOF_DIRECTIONS.includes(direction)) return request.json({ error: "unknown direction" }, 404);
    const job = findActiveJob(context.storage, direction) ?? findLatestJob(context.storage, direction);
    return request.json({ direction, job: job === null ? null : describeJob(job) });
  });
}

/**
 * Prunes old request rows, resumes the jobs that a restart left behind, prunes again every hour, and starts the watch
 * that proves on finality (`watch` in the configuration). Resolves with the function that stops the timer and the
 * watch, and waits for the running jobs.
 */
export async function start(context: BackendModuleContext): Promise<() => Promise<void>> {
  const service = serviceFor(context);
  service.prune();
  service.recover();
  const timer = setInterval(() => service.prune(), PRUNE_INTERVAL_MILLISECONDS);
  timer.unref();
  const stopWatch = await startWatch({ context, service });
  return async () => {
    clearInterval(timer);
    await stopWatch();
    await service.settled();
  };
}
