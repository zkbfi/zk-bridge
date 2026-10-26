import { afterEach, describe, expect, it, vi } from "vitest";
import { createIndexerClient, IndexerError } from "../../src/indexer/client.ts";
import { feedItem, word } from "../support/builders.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listFeed", () => {
  it("asks for the direction, the statuses and the limit, and returns the page", async () => {
    const item = feedItem({ id: 3 });
    const fetch = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => jsonResponse({ items: [item], nextCursor: "next-1" }));
    const client = createIndexerClient({ baseUrl: "http://127.0.0.1:42069", fetch });
    const page = await client.listFeed({ sourceChainId: 1, destinationChainId: 369, statuses: ["covered", "pending"], limit: 25 });
    expect(page).toEqual({ items: [item], nextCursor: "next-1" });
    const url = fetch.mock.calls[0]![0] as URL;
    expect(url.pathname).toBe("/api/feed");
    expect(Object.fromEntries(url.searchParams)).toEqual({ direction: "1-369", status: "covered,pending", limit: "25" });
  });

  it("adds the cursor when the query has one", async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => jsonResponse({ items: [], nextCursor: null }));
    const client = createIndexerClient({ baseUrl: "http://127.0.0.1:42069", fetch });
    await client.listFeed({ sourceChainId: 1, destinationChainId: 369, statuses: ["covered"], limit: 5, cursor: "abc" });
    expect((fetch.mock.calls[0]![0] as URL).searchParams.get("cursor")).toBe("abc");
  });

  it("keeps fields that it does not know, because the indexer may add them", async () => {
    const item = { ...feedItem(), extra: "kept" };
    const client = createIndexerClient({ baseUrl: "http://x", fetch: async () => jsonResponse({ items: [item], nextCursor: null, more: 1 }) });
    const page = await client.listFeed({ sourceChainId: 1, destinationChainId: 369, statuses: [], limit: 1 });
    expect(page.items[0]).toMatchObject({ extra: "kept" });
  });
});

describe("getMessage", () => {
  it("returns the item with the call data of its message", async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => jsonResponse({ ...feedItem(), data: "0xdeadbeef" }));
    const message = await createIndexerClient({ baseUrl: "http://127.0.0.1:42069", fetch }).getMessage(word(7));
    expect(message.data).toBe("0xdeadbeef");
    expect((fetch.mock.calls[0]![0] as URL).pathname).toBe(`/api/messages/${word(7)}`);
  });
});

describe("errors", () => {
  it("names the status and the path without the query when the indexer answers an error", async () => {
    const client = createIndexerClient({ baseUrl: "http://x", fetch: async () => jsonResponse({}, 503) });
    const failure = await client.listFeed({ sourceChainId: 1, destinationChainId: 369, statuses: ["covered"], limit: 1 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IndexerError);
    expect((failure as Error).message).toBe("the indexer answered 503 for /api/feed");
  });

  it("names the path and every broken field when the answer has the wrong shape", async () => {
    const client = createIndexerClient({ baseUrl: "http://x", fetch: async () => jsonResponse({ items: "none", nextCursor: 4 }) });
    const failure = await client.listFeed({ sourceChainId: 1, destinationChainId: 369, statuses: [], limit: 1 }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe(
      "the indexer answered an unexpected shape for /api/feed: Invalid input: expected array, received string; Invalid input: expected string, received number",
    );
  });

  it("refuses an item whose message identifier is not hex", async () => {
    const client = createIndexerClient({ baseUrl: "http://x", fetch: async () => jsonResponse({ ...feedItem(), messageId: "nothex", data: "0x" }) });
    await expect(client.getMessage("any")).rejects.toThrow(/unexpected shape for \/api\/messages\/any/);
  });
});

describe("the request", () => {
  it("passes a timeout signal, 15 seconds by default and the configured limit when set", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = async () => jsonResponse({ items: [], nextCursor: null });
    await createIndexerClient({ baseUrl: "http://x", fetch }).listFeed({ sourceChainId: 1, destinationChainId: 2, statuses: [], limit: 1 });
    await createIndexerClient({ baseUrl: "http://x", fetch, timeoutMilliseconds: 250 }).listFeed({ sourceChainId: 1, destinationChainId: 2, statuses: [], limit: 1 });
    expect(timeout.mock.calls).toEqual([[15_000], [250]]);
  });

  it("uses the global fetch when none is given", async () => {
    const global = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    await createIndexerClient({ baseUrl: "http://x" }).listFeed({ sourceChainId: 1, destinationChainId: 2, statuses: [], limit: 1 });
    expect(global).toHaveBeenCalledOnce();
  });
});
