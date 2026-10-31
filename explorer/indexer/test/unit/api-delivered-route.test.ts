import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { messages, tokens, transfers } from "../../ponder.schema";
import { registerDeliveredRoute } from "../../src/api/routes/delivered";
import { calls, respondWith, type QueryCall } from "./support/fake-api";
import { addressOf } from "./support/handler-fixtures";

const app = new Hono();
registerDeliveredRoute(app);

const get = async (path: string) => {
  const response = await app.request(path);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

const token = addressOf("aa");
const tokenRow = {
  chainId: 1,
  address: token,
  name: "Tether",
  symbol: "USDT",
  decimals: 6,
  metadataRead: true,
  isBridgedCopy: false,
  homeChainId: 1,
  homeToken: token,
  registeredTransactionHash: null,
  registeredBlockNumber: null,
  registeredTimestamp: null,
};

/** Answers the grouped delivered query with `rows`, and each timing query with `timing(sourceChainId, since)`. */
const serve = (rows: unknown[], timing: (sourceChainId: unknown, since: unknown) => unknown[] = () => []) =>
  respondWith((call: QueryCall) => {
    if (call.table === tokens) return [tokenRow];
    if (call.table === messages && call.fields !== undefined && "totalMedian" in call.fields) return timing(call.whereValues[1], call.whereValues[2]);
    if (call.table === messages) return rows;
    return [];
  });

beforeEach(() => serve([]));

describe("GET /api/delivered", () => {
  it("asks once, grouped, for the messages delivered in the last 7 days, with their transfers", async () => {
    const { status, body } = await get("/api/delivered?now=1000000");
    expect(status).toBe(200);
    expect(body.directions).toEqual([]);
    expect(body.now).toBe(1_000_000);
    const query = calls.find((call) => call.table === messages && !("totalMedian" in (call.fields ?? {})))!;
    expect(query.joins).toEqual([transfers]);
    expect(query.grouped).toBe(true);
    expect(query.whereValues).toEqual(["delivered", 1_000_000n - 7n * 86_400n]);
  });

  it("sums each direction's counts over its tokens and keeps the value per token", async () => {
    serve([
      { sourceChainId: 1, destinationChainId: 369, token, day: 2, week: 5, dayValue: "300", weekValue: "900" },
      { sourceChainId: 1, destinationChainId: 369, token: null, day: 1, week: 1, dayValue: null, weekValue: null },
      { sourceChainId: 369, destinationChainId: 1, token: addressOf("bb"), day: 0, week: 3, dayValue: "0", weekValue: "70" },
    ]);
    const { body } = await get("/api/delivered?now=1000000");
    expect(body.directions).toEqual([
      { sourceChainId: 1, destinationChainId: 369, last24h: 3, last7d: 6, byToken: [{ token: expect.objectContaining({ address: token, symbol: "USDT" }), value24h: "300", value7d: "900" }] },
      { sourceChainId: 369, destinationChainId: 1, last24h: 0, last7d: 3, byToken: [{ token: expect.objectContaining({ chainId: 369, symbol: null }), value24h: "0", value7d: "70" }] },
    ]);
  });
});

describe("GET /api/delivered timing", () => {
  it("asks per direction for the deliveries of the last 24 hours and of the last 7 days, and shows each window's stats", async () => {
    serve([], (sourceChainId, since) =>
      sourceChainId === 1 && since === 1_000_000n - 86_400n
        ? [{ count: 3, totalAvg: 933.3, totalMedian: 1100, totalP90: 1100, sentMedian: 768, sentP90: 768, finalMedian: 232, finalP90: 312, readyMedian: 100, readyP90: 100 }]
        : [],
    );
    const { body } = await get("/api/delivered?now=1000000");
    const timingCalls = calls.filter((call) => "totalMedian" in (call.fields ?? {}));
    // The two directions are asked at once, so in either order.
    expect(timingCalls).toHaveLength(4);
    expect(timingCalls.map((call) => call.whereValues)).toEqual(expect.arrayContaining([
      ["delivered", 1, 1_000_000n - 86_400n],
      ["delivered", 1, 1_000_000n - 7n * 86_400n],
      ["delivered", 369, 1_000_000n - 86_400n],
      ["delivered", 369, 1_000_000n - 7n * 86_400n],
    ]));
    expect(body.timing[0]).toEqual({
      sourceChainId: 1,
      last24h: {
        count: 3,
        sentToDelivered: { avg: 933.3, median: 1100, p90: 1100 },
        steps: { sent: { median: 768, p90: 768 }, final: { median: 232, p90: 312 }, ready: { median: 100, p90: 100 } },
      },
      last7d: { count: 0, sentToDelivered: { avg: null, median: null, p90: null }, steps: { sent: { median: null, p90: null }, final: { median: null, p90: null }, ready: { median: null, p90: null } } },
    });
    expect(body.timing[1].sourceChainId).toBe(369);
  });
});
