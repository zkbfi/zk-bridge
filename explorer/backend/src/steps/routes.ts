/**
 * The routes of the route steps: `GET /route/steps`, `POST /steps/requests`, `GET /steps/jobs/:jobId` and
 * `GET /steps/proofs/:kind/:subject`. The requests module adds them. They never name an endpoint, a key or a path.
 */
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ROUTE_STEP_KINDS, REQUESTABLE_STEP_KINDS, type ProofDirection, type RouteStepKind, type RouteSteps, type StepProof } from "@zk-bridge/shared";
import type { BackendModuleContext } from "../module.ts";
import { archiveServiceOf } from "../archive/module.ts";
import { createReadLimiter, READS_PER_CALLER_PER_MINUTE, type ProgressReads } from "../progress/routes.ts";
import { requestServiceOf } from "../requests/module.ts";
import { createStepChainReads, type StepChainReads } from "./chain.ts";
import { gpuEstimateNow, gpuViewOf } from "./gpu.ts";
import { buildRouteSteps } from "./list.ts";
import { createStepService, sidesOf, type StepService } from "./service.ts";

/** The largest request body in bytes. */
export const MAXIMUM_STEP_BODY_BYTES = 4096;

/** How long one list of the route steps serves the next reads, in milliseconds. */
export const ROUTE_STEPS_REUSE_MILLISECONDS = 15_000;

const bodySchema = z.object({ pair: z.string().min(1), kind: z.enum(REQUESTABLE_STEP_KINDS), subject: z.string().min(1).max(80) }).strict();

const services = new WeakMap<BackendModuleContext, StepService>();
const chains = new WeakMap<BackendModuleContext, StepChainReads>();

/** The chain reads of a context: its own (a test), else one set over viem per context. */
function chainOf(context: BackendModuleContext): StepChainReads {
  const known = chains.get(context);
  if (known !== undefined) return known;
  const created = context.stepChain ?? createStepChainReads();
  chains.set(context, created);
  return created;
}

/** The price of a GPU hour: the configured price. RunPod's serverless billing (REST v2) gives dollars and no billed time, so no rate can be measured from it. */
async function usdPerHourOf(context: BackendModuleContext): Promise<number> {
  return context.config.watch.warmup.gpuUsdPerHour;
}

/** How long a worker stays up after its last proof, in milliseconds. */
const idleMillisecondsOf = (context: BackendModuleContext): number => (context.endpointIdleTimeoutSeconds?.() ?? context.config.watch.warmup.idleTimeoutSeconds) * 1000;

/** The step service of a context: one per context, shared by the requests module's routes and the seal module's fallback posters. */
export function stepServiceOf(context: BackendModuleContext): StepService {
  const known = services.get(context);
  if (known !== undefined) return known;
  const observation = context.config.seal?.observation ?? { retryMinutes: 60, maxProofsPerVersionPerDay: 4 };
  const created = createStepService({
    storage: context.storage,
    pair: context.pair,
    now: context.now,
    logger: context.logger,
    limits: context.config.limits,
    proverTimeoutMilliseconds: context.config.prover.timeoutSeconds * 1000,
    requestService: () => (context.config.indexerUrl === undefined ? null : requestServiceOf(context)),
    ...(context.headProver === undefined ? {} : { headProver: context.headProver }),
    ...(context.observationProver === undefined ? {} : { observationProver: context.observationProver }),
    ...(context.openingProver === undefined ? {} : { openingProver: context.openingProver }),
    archive: () => archiveServiceOf(context),
    chain: chainOf(context),
    readUsdPerHour: () => usdPerHourOf(context),
    observationLimits: { retryMinutes: observation.retryMinutes, maxProofsPerVersionPerDay: observation.maxProofsPerVersionPerDay },
    gpuEstimate: () => gpuEstimateNow(context.storage, context.now(), idleMillisecondsOf(context)),
  });
  services.set(context, created);
  return created;
}

/** Adds the four routes. */
export function registerStepRoutes(app: Hono, context: BackendModuleContext, options: { readonly callerOf: (request: Context) => string; readonly progress: ProgressReads }): void {
  const service = stepServiceOf(context);
  const limiter = createReadLimiter({ perMinute: READS_PER_CALLER_PER_MINUTE, now: context.now });
  const proofFound = (request: Context, proof: StepProof | null) => (proof === null ? request.json({ error: "no finished proof for this step" }, 404) : request.json(proof));
  const limited = (request: Context) => {
    const wait = limiter.take(options.callerOf(request));
    if (wait === 0) return null;
    request.header("Retry-After", String(wait));
    return request.json({ error: "rate-limited", retryAfterSeconds: wait }, 429);
  };
  let cache: { at: number; answer: Promise<RouteSteps> } | null = null;

  const list = (): Promise<RouteSteps> => {
    const { indexer } = options.progress;
    return buildRouteSteps({
      now: context.now(),
      pair: context.pair,
      storage: context.storage,
      keepAliveSeconds: context.config.limits.keepAliveSeconds,
      proverTimeoutMilliseconds: context.config.prover.timeoutSeconds * 1000,
      service,
      chain: chainOf(context),
      pipelineOf: options.progress.pipelineOf,
      coveredOf: async (direction: ProofDirection) => {
        if (indexer === null) throw new Error("no chain indexer");
        const { source, destination } = sidesOf(context.pair, direction);
        return indexer.covered(source.chainId, destination.chainId);
      },
      gpuOf: async (direction) =>
        gpuViewOf({
          storage: context.storage,
          direction,
          now: context.now(),
          estimate: gpuEstimateNow(context.storage, context.now(), idleMillisecondsOf(context)),
          usdPerHour: await usdPerHourOf(context),
          budgetUsd: context.config.limits.gpuBudgetUsdPerDirectionPerDay,
        }),
    });
  };

  app.get("/route/steps", async (request) => {
    const refused = limited(request);
    if (refused !== null) return refused;
    if (cache === null || context.now() - cache.at >= ROUTE_STEPS_REUSE_MILLISECONDS) {
      const entry = { at: context.now(), answer: list() };
      cache = entry;
      // A failed list is not kept: the next read builds it again.
      entry.answer.catch(() => (cache = null));
    }
    try {
      return request.json(await cache.answer);
    } catch (error) {
      context.logger.warn("route_steps_failed", { error });
      return request.json({ error: "the route steps cannot be read now" }, 503);
    }
  });

  app.post(
    "/steps/requests",
    bodyLimit({ maxSize: MAXIMUM_STEP_BODY_BYTES, onError: (request) => request.json({ error: "the request body is too large" }, 413) }),
    async (request) => {
      const body = bodySchema.safeParse(await request.req.json().catch(() => null));
      if (!body.success) return request.json({ error: "the request body is not valid" }, 400);
      if (body.data.pair !== context.config.pair) return request.json({ error: `this backend serves the pair ${context.config.pair}` }, 400);
      const result = await service.submit({ ...body.data, caller: options.callerOf(request) });
      if ("invalid" in result) return request.json({ error: result.invalid }, 400);
      if (!("refused" in result)) {
        cache = null;
        return request.json(result, 202);
      }
      switch (result.refused) {
        case "nothing-to-prove":
          return request.json({ error: result.refused, why: result.why }, 409);
        case "not-served":
          return request.json({ error: result.refused, detail: result.detail }, 404);
        case "cannot-check":
          request.header("Retry-After", String(result.retryAfterSeconds));
          return request.json({ error: result.refused, retryAfterSeconds: result.retryAfterSeconds }, 503);
        default:
          request.header("Retry-After", String(result.retryAfterSeconds));
          return request.json({ error: result.refused, retryAfterSeconds: result.retryAfterSeconds, why: result.why, detail: result.detail }, 429);
      }
    },
  );

  app.get("/steps/jobs/:jobId", (request) => {
    const refused = limited(request);
    if (refused !== null) return refused;
    const job = service.job(request.req.param("jobId"));
    if (job === null) return request.json({ error: "no such job" }, 404);
    return request.json(job);
  });

  app.get("/steps/proofs/:kind/:subject", (request) => {
    const kind = request.req.param("kind");
    if (!(ROUTE_STEP_KINDS as readonly string[]).includes(kind)) return request.json({ error: "unknown kind" }, 404);
    const refused = limited(request);
    if (refused !== null) return refused;
    return proofFound(request, service.proof(kind as RouteStepKind, request.req.param("subject")));
  });
}
