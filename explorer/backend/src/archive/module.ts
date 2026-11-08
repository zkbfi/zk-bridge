import type { Hono } from "hono";
import type { BackendModuleContext } from "../module.ts";
import type { ModuleHealth } from "../health.ts";
import { createArchiveService, type ArchiveService } from "./build.ts";
import { createPublicClient, http } from "viem";
import type { PairSide } from "@zk-bridge/shared";
import { readLightClient } from "../keepalive/sources.ts";
import { createHandoffCapture, handoffPeriods, LIVE_HANDOFF_MILLISECONDS, readHandoff, type HandoffCapture } from "./handoffs.ts";
import { readProofRows } from "./proof-rows.ts";
import { createReceiptIndexReader } from "./receipt.ts";
import { createIndexerClient } from "./work-list.ts";

/** How often the archive reads the work list, in milliseconds. */
export const CYCLE_INTERVAL_MILLISECONDS = 60_000;

const MESSAGE_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const services = new WeakMap<BackendModuleContext, ArchiveService | null>();
const captures = new WeakMap<BackendModuleContext, HandoffCapture | null>();

/** The handoff capture of a context, or null when it is off or the context has no `handoff-update` command. */
function captureFor(context: BackendModuleContext): HandoffCapture | null {
  if (captures.has(context)) return captures.get(context) as HandoffCapture | null;
  const { config, pair } = context;
  const readFacts = context.readLightClientOf ?? ((side: PairSide) => readLightClient(createPublicClient({ transport: http(side.rpcUrl) }), side.contracts.lightClient));
  const [first, second] = pair.sides;
  const created =
    !config.handoffCapture.enabled || context.handoffProver === undefined
      ? null
      : createHandoffCapture({
          storage: context.storage,
          prover: context.handoffProver,
          // The source chain of each route, whose clock the light client on the other side keeps.
          targets: [
            { direction: "first-to-second" as const, chainId: first.chainId, readFacts: () => readFacts(second) },
            { direction: "second-to-first" as const, chainId: second.chainId, readFacts: () => readFacts(first) },
          ].filter((target) => (target.chainId === first.chainId ? first : second).beaconUrl !== null),
          backfillPeriods: config.handoffCapture.backfillPeriods,
          intervalMilliseconds: config.handoffCapture.intervalSeconds * 1000,
          logger: context.logger,
          now: context.now,
        });
  captures.set(context, created);
  return created;
}

const HANDOFF_FILE = /^(\d{1,9})\.json$/;
const CHAIN_ID = /^\d{1,12}$/;

/** The archive service of a context, or null when the configuration names no chain indexer. */
function serviceFor(context: BackendModuleContext): ArchiveService | null {
  if (services.has(context)) return services.get(context) as ArchiveService | null;
  const baseUrl = context.config.indexerUrl;
  const created =
    baseUrl === undefined
      ? null
      : createArchiveService({
          storage: context.storage,
          prover: context.prover,
          indexer: createIndexerClient({ baseUrl, fetchFunction: () => globalThis.fetch }),
          receipts: createReceiptIndexReader({ rpcUrls: context.config.rpcUrls, fetchFunction: () => globalThis.fetch }),
          pairName: context.config.pair,
          now: context.now,
          logger: context.logger,
        });
  services.set(context, created);
  return created;
}

/**
 * Adds `GET /evidence/:messageId`. It answers the stored evidence unchanged, 400 for a bad id and 404 for no entry.
 * Adds `GET /archive/proofs`: every proof and piece of evidence the backend holds, for the proof archive of the indexer
 * (`proof-rows.ts`). Caddy does not pass it on, so only the server itself reads it.
 */
export function register(app: Hono, context: BackendModuleContext): void {
  const service = serviceFor(context);
  app.get("/archive/proofs", (request) => request.json(readProofRows(context.storage, context.now() - LIVE_HANDOFF_MILLISECONDS)));
  app.get("/archive/handoffs/:chainId", (request) => {
    const chainId = request.req.param("chainId");
    if (!CHAIN_ID.test(chainId)) return request.json({ error: "the chain id must be a whole number" }, 400);
    return request.json({ periods: handoffPeriods(context.storage, Number(chainId)) });
  });
  app.get("/archive/handoffs/:chainId/:file", (request) => {
    const chainId = request.req.param("chainId");
    const file = HANDOFF_FILE.exec(request.req.param("file"));
    if (!CHAIN_ID.test(chainId) || file === null) return request.json({ error: "the path must be /archive/handoffs/<chainId>/<period>.json" }, 400);
    const record = readHandoff(context.storage, Number(chainId), Number(file[1]));
    if (record === null) return request.json({ error: "no handoff record for this period" }, 404);
    return request.body(record, 200, { "content-type": "application/json" });
  });
  app.get("/evidence/:messageId", (request) => {
    const messageId = request.req.param("messageId");
    if (!MESSAGE_ID_PATTERN.test(messageId)) return request.json({ error: "the message id must be 32 bytes of 0x hex" }, 400);
    const body = service?.readEvidence(messageId) ?? null;
    if (body === null) return request.json({ error: "no evidence for this message" }, 404);
    return request.body(body, 200, { "content-type": "application/json" });
  });
}

/** Runs one archive pass now. A test and the timer call it. Does nothing without a chain indexer address. */
export async function runArchiveCycle(context: BackendModuleContext): Promise<void> {
  await serviceFor(context)?.runCycle();
}

/** Starts the pass timer. Resolves with the function that stops it and waits for the running pass. */
export async function start(context: BackendModuleContext): Promise<() => Promise<void>> {
  const stopCapture = startCapture(context);
  const service = serviceFor(context);
  if (service === null) {
    context.logger.warn("archive_without_indexer", {});
    return stopCapture;
  }
  const pass = () => void service.runCycle();
  pass();
  const timer = setInterval(pass, CYCLE_INTERVAL_MILLISECONDS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await Promise.all([service.settled(), stopCapture()]);
  };
}

/** Runs one capture pass now. A test calls it. Does nothing when the capture is off. */
export async function runHandoffCapture(context: BackendModuleContext): Promise<void> {
  await captureFor(context)?.runOnce();
}

/** Starts the capture timer of the handoff archive, when the capture is on. Resolves with nothing to wait for otherwise. */
function startCapture(context: BackendModuleContext): () => Promise<void> {
  const capture = captureFor(context);
  if (capture === null) {
    context.logger.warn("handoff_capture_off", { reason: context.config.handoffCapture.enabled ? "no handoff-update command in this context" : "handoffCapture.enabled is false" });
    return async () => {};
  }
  const pass = () => void capture.runOnce();
  pass();
  const timer = setInterval(pass, context.config.handoffCapture.intervalSeconds * 1000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await capture.settled();
  };
}

/** Reports the archive counts, or degraded when the indexer is missing or failing. */
export function health(context: BackendModuleContext): ModuleHealth {
  const service = serviceFor(context);
  const capture = captureFor(context)?.status();
  const handoffs = capture === undefined ? "handoff capture off" : `${capture.kept} handoff records, ${capture.failing} periods failing`;
  if (service === null) return { state: "degraded", detail: `indexerUrl is not set; ${handoffs}` };
  const status = service.status();
  const detail = `${status.entries} entries, ${status.withEvidence} with evidence, ${status.failing} failing; ${handoffs}`;
  if (status.lastCycleError !== null) return { state: "degraded", detail: `${detail}; the chain indexer failed (${status.lastCycleError})` };
  return { state: "running", detail };
}
