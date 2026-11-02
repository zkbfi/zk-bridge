import type { Hono } from "hono";
import type { BackendModuleContext } from "../module.ts";
import type { ModuleHealth } from "../health.ts";
import { createArchiveService, type ArchiveService } from "./build.ts";
import { readProofRows } from "./proof-rows.ts";
import { createReceiptIndexReader } from "./receipt.ts";
import { createIndexerClient } from "./work-list.ts";

/** How often the archive reads the work list, in milliseconds. */
export const CYCLE_INTERVAL_MILLISECONDS = 60_000;

const MESSAGE_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const services = new WeakMap<BackendModuleContext, ArchiveService | null>();

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
  app.get("/archive/proofs", (request) => request.json(readProofRows(context.storage)));
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
  const service = serviceFor(context);
  if (service === null) {
    context.logger.warn("archive_without_indexer", {});
    return async () => {};
  }
  const pass = () => void service.runCycle();
  pass();
  const timer = setInterval(pass, CYCLE_INTERVAL_MILLISECONDS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await service.settled();
  };
}

/** Reports the archive counts, or degraded when the indexer is missing or failing. */
export function health(context: BackendModuleContext): ModuleHealth {
  const service = serviceFor(context);
  if (service === null) return { state: "degraded", detail: "indexerUrl is not set" };
  const status = service.status();
  const detail = `${status.entries} entries, ${status.withEvidence} with evidence, ${status.failing} failing`;
  if (status.lastCycleError !== null) return { state: "degraded", detail: `${detail}; the chain indexer failed (${status.lastCycleError})` };
  return { state: "running", detail };
}
