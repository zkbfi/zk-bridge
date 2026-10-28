import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { headUpdates, messages } from "../../ponder.schema";
import { registerHistoryRoute } from "../../src/api/routes/history";
import { calls, respondWith, type QueryCall } from "./support/fake-api";
import { addressOf, hashOf, sentMessageRow } from "./support/handler-fixtures";

const app = new Hono();
registerHistoryRoute(app);

const get = async (path: string) => {
  const response = await app.request(path);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

/** A message sent at `sent` and, when `delivered` is given, delivered at that time. */
const messageRow = (id: string, sent: bigint, delivered: bigint | null = null) => ({
  messages: {
    ...sentMessageRow(hashOf(id), 100n),
    sentTimestamp: sent,
    sentTransactionHash: hashOf("a1"),
    status: delivered === null ? "sent" : "delivered",
    deliveredTimestamp: delivered,
    deliveredTransactionHash: delivered === null ? null : hashOf("d1"),
  },
  transfers: null,
});

const headRow = (slot: bigint, timestamp: bigint, chainId = 369) => ({
  chainId,
  slot,
  headerRoot: hashOf("f1"),
  executionBlockHash: hashOf("f2"),
  executionBlockNumber: 55n,
  transactionHash: hashOf("c1"),
  blockNumber: 7n,
  timestamp,
  gasUsed: 1n,
  effectiveGasPrice: 1n,
  costWei: 1n,
  poster: addressOf("99"),
});

/**
 * Answers the three sources by the order of the queries: the sends, then the deliveries, then the heads. The sends and
 * the deliveries both read `messages`, so the table alone cannot tell them apart.
 */
const serve = (sources: { sent?: unknown[]; delivered?: unknown[]; heads?: unknown[] }) =>
  respondWith((call: QueryCall) => {
    if (call.table === headUpdates) return sources.heads ?? [];
    const messageQueries = calls.filter((other) => other.table === messages);
    return messageQueries.indexOf(call) === 0 ? (sources.sent ?? []) : (sources.delivered ?? []);
  });

beforeEach(() => serve({}));

describe("GET /api/history", () => {
  it("merges sent, delivered and head-update events newest first", async () => {
    serve({
      sent: [messageRow("02", 2_000n, 5_000n), messageRow("01", 1_000n)],
      delivered: [messageRow("02", 2_000n, 5_000n)],
      heads: [headRow(90n, 3_000n)],
    });
    const { status, body } = await get("/api/history");
    expect(status).toBe(200);
    expect(body.partial).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((item: { kind: string; timestamp: number }) => [item.kind, item.timestamp])).toEqual([
      ["delivered", 5_000],
      ["head-update", 3_000],
      ["sent", 2_000],
      ["sent", 1_000],
    ]);
    expect(body.items[0]).toMatchObject({ chainId: 369, messageId: hashOf("02"), transactionHash: hashOf("d1"), slot: null, status: "delivered" });
    expect(body.items[1]).toMatchObject({ chainId: 369, messageId: null, transactionHash: hashOf("c1"), slot: 90, status: null });
    expect(body.items[2]).toMatchObject({ chainId: 1, messageId: hashOf("02"), transactionHash: hashOf("a1") });
  });

  it("pages: a full page names a cursor, and the cursor reaches every source", async () => {
    serve({ sent: [messageRow("03", 3_000n), messageRow("02", 2_000n)], heads: [headRow(80n, 2_500n)] });
    const first = await get("/api/history?limit=2");
    expect(first.body.items.map((item: { timestamp: number }) => item.timestamp)).toEqual([3_000, 2_500]);
    expect(first.body.nextCursor).toBe("2500:head-update:369-80");
    expect(calls.every((call) => call.limit === 3)).toBe(true);

    await get(`/api/history?limit=2&cursor=${first.body.nextCursor}`);
    const [sent, delivered, heads] = calls.slice(3);
    // Sends sort after head updates by name, so none is left at the cursor time. Deliveries sort before them.
    expect(sent?.whereValues).toContain(2_500n);
    expect(delivered?.whereValues).toContain(2_500n);
    expect(heads?.whereValues).toEqual([2_500n, 2_500n, 369, 369, 80n]);
  });

  it("continues inside a timestamp: a cursor of the same kind keeps only lower keys", async () => {
    await get(`/api/history?eventKind=sent&cursor=2000:sent:${hashOf("05")}`);
    expect(calls[0]?.whereValues).toEqual([2_000n, 2_000n, hashOf("05")]);
    serve({});
    await get(`/api/history?eventKind=delivered&cursor=2000:delivered:${hashOf("05")}`);
    expect(calls[0]?.whereValues).toEqual([2_000n, 2_000n, hashOf("05")]);
  });

  it("filters by chain and eventKind", async () => {
    await get("/api/history?chain=369&eventKind=head-update");
    expect(calls.map((call) => call.table)).toEqual([headUpdates]);
    expect(calls[0]?.whereValues).toEqual([369]);

    serve({});
    await get("/api/history?chain=1&eventKind=sent");
    expect(calls.map((call) => call.table)).toEqual([messages]);
    expect(calls[0]?.whereValues).toEqual([1]);

    serve({});
    await get("/api/history?chain=369&eventKind=delivered");
    expect(calls.map((call) => call.table)).toEqual([messages]);
    expect(calls[0]?.whereValues).toEqual([369]);
  });

  it("keeps the feed filters: address, status, from, to", async () => {
    const address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    await get(`/api/history?address=${address}&status=sent,covered&from=10&to=20&direction=1>369`);
    const [sent, delivered, heads] = calls;
    const lowercase = address.toLowerCase();
    const filters = [1, 369, "sent", "covered", ...Array(5).fill(lowercase)];
    expect(sent?.whereValues).toEqual([...filters, 10n, 20n]);
    expect(delivered?.whereValues).toEqual([...filters, 10n, 20n]);
    // An account or a status picks messages, so no head update can match.
    expect(heads).toBeUndefined();
  });

  it("limits head updates by direction and time when no message filter is set", async () => {
    await get("/api/history?eventKind=head-update&direction=1>369&from=10&to=20");
    expect(calls[0]?.whereValues).toEqual([369, 10n, 20n]);
  });

  it("refuses an unknown eventKind and runs no query", async () => {
    const { status, body } = await get("/api/history?eventKind=other");
    expect(status).toBe(400);
    expect(body).toEqual({ error: "invalid eventKind: other" });
    expect(calls).toEqual([]);
  });
});
