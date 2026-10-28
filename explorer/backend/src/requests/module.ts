import type { Context, Hono } from "hono";
import { z } from "zod";
import { PROOF_DIRECTIONS, type ProofDirection } from "@zk-bridge/shared";
import type { BackendModuleContext } from "../module.ts";
import { findActiveJob, findLatestJob, getJob, getRequest, type Job } from "./jobs.ts";
import { createRequestService, type RequestService } from "./service.ts";

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
  .strict();

const services = new WeakMap<BackendModuleContext, RequestService>();

/** The request service of a context. One context has one service. */
function serviceFor(context: BackendModuleContext): RequestService {
  const known = services.get(context);
  if (known !== undefined) return known;
  const created = createRequestService({
    storage: context.storage,
    proverForJob: context.proverForJob,
    now: context.now,
    limits: context.config.limits,
    proverTimeoutMilliseconds: context.config.prover.timeoutSeconds * 1000,
    logger: context.logger,
  });
  services.set(context, created);
  return created;
}

type SocketBindings = { incoming?: { socket?: { remoteAddress?: string } } };

/** The key that the rate limits count: the first forwarded address when trusted, else the socket address. */
function callerOf(request: Context, trustForwardedHeader: boolean): string {
  const forwarded = request.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (trustForwardedHeader && forwarded !== undefined && forwarded !== "") return forwarded;
  return (request.env as SocketBindings | undefined)?.incoming?.socket?.remoteAddress ?? "unknown";
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

/** Adds `POST /requests`, `GET /requests/:id` and `GET /directions/:direction`. */
export function register(app: Hono, context: BackendModuleContext): void {
  const service = serviceFor(context);

  app.post("/requests", async (request) => {
    const body = requestBodySchema.safeParse(await request.req.json().catch(() => null));
    if (!body.success) return request.json({ error: "the request body is not valid" }, 400);
    if (body.data.pair !== context.config.pair) return request.json({ error: `this backend serves the pair ${context.config.pair}` }, 400);
    const result = service.submit({ ...body.data, caller: callerOf(request, context.config.trustForwardedHeader) });
    if ("refused" in result) {
      request.header("Retry-After", String(result.retryAfterSeconds));
      return request.json({ error: "rate-limited", retryAfterSeconds: result.retryAfterSeconds }, 429);
    }
    return request.json(result, 202);
  });

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

/** Resumes the jobs that a restart left behind. Resolves with the function that waits for the running jobs. */
export async function start(context: BackendModuleContext): Promise<() => Promise<void>> {
  const service = serviceFor(context);
  service.recover();
  return () => service.settled();
}
