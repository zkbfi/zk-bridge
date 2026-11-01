import { describe, expect, it } from "vitest";
import { CACHE_MILLISECONDS, MESSAGE_CACHE_LIMIT, createIndexerReads } from "../src/progress/indexer.ts";
import { makeClock } from "./support.ts";

const ID = `0x${"ab".repeat(32)}`;
const message = (status = "sent") => ({
  messageId: ID,
  status,
  direction: { sourceChainId: 1, destinationChainId: 369, label: "1>369" },
  sent: { transactionHash: `0x${"11".repeat(32)}`, blockNumber: 5, timestamp: 1_000 },
  covered: null,
  delivered: null,
});

/** An indexer whose answers the test sets by path; every request is kept. */
function fakeIndexer() {
  const answers = new Map<string, { status: number; body: unknown }>();
  const requests: string[] = [];
  const fetchFunction = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    requests.push(path);
    const answer = answers.get(path) ?? answers.get(url.pathname);
    if (answer === undefined) throw new Error("connection refused");
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  return { answers, requests, fetchFunction, set: (path: string, body: unknown, status = 200) => answers.set(path, { status, body }) };
}

describe("the indexer reads of the progress routes", () => {
  it("reads a message, keeps it a few seconds, and answers null for an unknown one", async () => {
    const indexer = fakeIndexer();
    const clock = makeClock();
    const reads = createIndexerReads({ baseUrl: "http://indexer.test/", now: clock.now, fetchFunction: () => indexer.fetchFunction });
    indexer.set(`/api/messages/${ID}`, message());
    expect(await reads.message(ID)).toMatchObject({ status: "sent", sent: { timestamp: 1_000 } });
    indexer.set(`/api/messages/${ID}`, message("covered"));
    expect((await reads.message(ID))?.status).toBe("sent");
    clock.advance(CACHE_MILLISECONDS.message);
    expect((await reads.message(ID))?.status).toBe("covered");
    indexer.set(`/api/messages/0x${"cd".repeat(32)}`, { error: "unknown message" }, 404);
    expect(await reads.message(`0x${"cd".repeat(32)}`)).toBeNull();
    expect(indexer.requests).toEqual([`/api/messages/${ID}`, `/api/messages/${ID}`, `/api/messages/0x${"cd".repeat(32)}`]);
  });

  it("refuses an error status and an unknown shape, and does not keep a failure", async () => {
    const indexer = fakeIndexer();
    const reads = createIndexerReads({ baseUrl: "http://indexer.test", now: () => 0, fetchFunction: () => indexer.fetchFunction });
    indexer.set("/api/heads", { error: "down" }, 500);
    await expect(reads.heads()).rejects.toThrow("the chain indexer answered 500 for the heads");
    indexer.set("/api/heads", { heads: [{ chainId: "x" }] });
    await expect(reads.heads()).rejects.toThrow("the chain indexer sent the heads in an unknown shape");
    indexer.set("/api/heads", { heads: [{ chainId: 369, trackedChainId: 1, storedHeadSlot: 10, storedHeadSlotTimestamp: 120, finalizedSlot: 40, extra: true }] });
    expect(await reads.heads()).toEqual([{ chainId: 369, trackedChainId: 1, storedHeadSlot: 10, storedHeadSlotTimestamp: 120, finalizedSlot: 40, extra: true }]);
  });

  it("reads the head updates of a chain and the delivered messages of a direction", async () => {
    const indexer = fakeIndexer();
    const reads = createIndexerReads({ baseUrl: "http://indexer.test", now: () => 0, fetchFunction: () => indexer.fetchFunction });
    indexer.set("/api/head-updates?chainId=369&limit=200", { items: [{ chainId: 369, slot: 64, timestamp: 2_000, transactionHash: "0x" }] });
    indexer.set("/api/feed?direction=1%3E369&status=delivered&limit=200", { items: [{ ...message("delivered"), delivered: { timestamp: 3_000, success: true } }], nextCursor: null });
    expect(await reads.headUpdates(369)).toMatchObject([{ slot: 64, timestamp: 2_000 }]);
    expect(await reads.delivered(1, 369)).toMatchObject([{ status: "delivered", delivered: { timestamp: 3_000 } }]);
  });

  it("uses the global fetch by default and forgets the oldest answer past its limit", async () => {
    const indexer = fakeIndexer();
    const saved = globalThis.fetch;
    globalThis.fetch = indexer.fetchFunction;
    try {
      const reads = createIndexerReads({ baseUrl: "http://indexer.test", now: () => 0, timeoutMilliseconds: 1_000 });
      indexer.set(`/api/messages/${ID}`, message());
      for (let index = 0; index <= MESSAGE_CACHE_LIMIT; index += 1) {
        const id = `0x${index.toString(16).padStart(64, "0")}`;
        indexer.set(`/api/messages/${id}`, { ...message(), messageId: id });
        await reads.message(id);
      }
      await reads.message(`0x${"0".repeat(64)}`);
      expect(indexer.requests.filter((path) => path === `/api/messages/0x${"0".repeat(64)}`)).toHaveLength(2);
      await reads.message(`0x${MESSAGE_CACHE_LIMIT.toString(16).padStart(64, "0")}`);
      expect(indexer.requests.filter((path) => path === `/api/messages/0x${MESSAGE_CACHE_LIMIT.toString(16).padStart(64, "0")}`)).toHaveLength(1);
    } finally {
      globalThis.fetch = saved;
    }
  });
});
