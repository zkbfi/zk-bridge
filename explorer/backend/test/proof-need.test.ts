import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createProofNeedReader, withoutIndexer } from "../src/requests/proof-need.ts";
import { PAIR } from "./support.ts";

const NOW_SECONDS = 2_000_000;
const KEEP_ALIVE_SECONDS = 43_200;

type IndexerState = {
  /** The messages in status waiting_for_finality, by direction label. */
  waiting: Record<string, number>;
  /** The time of the stored head on each chain, by the chain of the light client. Null: no head. */
  heads: Record<number, number | null>;
  status?: number;
  body?: unknown;
  delayMilliseconds?: number;
};

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A chain indexer on a free local port, with the two routes that the reader calls. It records each query. */
async function startIndexer(state: IndexerState) {
  const queries: string[] = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    queries.push(c.req.url.slice(c.req.url.indexOf("/api")));
    if (state.delayMilliseconds !== undefined) await new Promise((resolve) => setTimeout(resolve, state.delayMilliseconds));
    if (state.status !== undefined) return c.json({ error: "down" }, state.status as 500);
    if (state.body !== undefined) return c.json(state.body as object);
    await next();
  });
  app.get("/api/feed", (c) => {
    const count = state.waiting[c.req.query("direction") ?? ""] ?? 0;
    expect(c.req.query("status")).toBe("waiting_for_finality");
    return c.json({ items: Array.from({ length: Math.min(count, Number(c.req.query("limit"))) }, () => ({})), nextCursor: null });
  });
  app.get("/api/heads", (c) =>
    c.json({
      heads: PAIR.sides.map((side, index) => ({
        chainId: side.chainId,
        trackedChainId: PAIR.sides[1 - index]!.chainId,
        storedHeadSlot: state.heads[side.chainId] === null ? null : 100,
        storedHeadExecutionTimestamp: state.heads[side.chainId] ?? null,
      })),
    }),
  );
  const port = await new Promise<number>((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (address) => resolve(address.port));
    servers.push(server);
  });
  return { baseUrl: `http://127.0.0.1:${port}/`, queries };
}

const fresh = NOW_SECONDS - 60;
const stale = NOW_SECONDS - KEEP_ALIVE_SECONDS - 1;

async function reader(state: IndexerState, timeoutMilliseconds?: number) {
  const indexer = await startIndexer(state);
  const read = createProofNeedReader({ baseUrl: indexer.baseUrl, pair: PAIR, keepAliveSeconds: KEEP_ALIVE_SECONDS, timeoutMilliseconds });
  return { read: (direction: "first-to-second" | "second-to-first") => read(direction, NOW_SECONDS * 1000), queries: indexer.queries };
}

describe("the proof need reader against a chain indexer", () => {
  it("needs a proof when a message of the direction waits for a head, and asks for that direction only", async () => {
    const { read, queries } = await reader({ waiting: { "1>369": 1 }, heads: { 1: fresh, 369: fresh } });
    expect(await read("first-to-second")).toEqual({ needed: true, why: "waiting-message" });
    expect(queries).toContain("/api/feed?direction=1%3E369&status=waiting_for_finality&limit=1");
    expect(await read("second-to-first")).toEqual({ needed: false });
  });

  it("needs a proof when the light client of the destination holds a head older than the keep-alive time", async () => {
    // The light client on chain 369 follows chain 1: it is the destination of first-to-second.
    const { read } = await reader({ waiting: {}, heads: { 1: fresh, 369: stale } });
    expect(await read("first-to-second")).toEqual({ needed: true, why: "keep-alive" });
    expect(await read("second-to-first")).toEqual({ needed: false });
  });

  it("needs a proof when the light client of the destination holds no head", async () => {
    const { read } = await reader({ waiting: {}, heads: { 1: null, 369: fresh } });
    expect(await read("second-to-first")).toEqual({ needed: true, why: "keep-alive" });
  });

  it("fails when the indexer answers an error status, a wrong shape, a heads list without the destination, or too late", async () => {
    await expect((await reader({ waiting: {}, heads: {}, status: 500 })).read("first-to-second")).rejects.toThrow(/500/);
    await expect((await reader({ waiting: {}, heads: {}, body: { items: "no", heads: [] } })).read("first-to-second")).rejects.toThrow(/shape/);
    await expect((await reader({ waiting: {}, heads: {}, body: { items: [], heads: [] } })).read("first-to-second")).rejects.toThrow(/no light client/);
    await expect((await reader({ waiting: {}, heads: { 1: fresh, 369: fresh }, delayMilliseconds: 200 }, 50)).read("first-to-second")).rejects.toThrow();
  });

  it("fails without a chain indexer, so a request is refused and not proved", async () => {
    await expect(withoutIndexer("first-to-second", 0)).rejects.toThrow("indexerUrl is not set");
  });
});
