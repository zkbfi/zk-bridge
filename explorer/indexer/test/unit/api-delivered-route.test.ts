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

const serve = (rows: unknown[]) =>
  respondWith((call: QueryCall) => {
    if (call.table === tokens) return [tokenRow];
    if (call.table === messages) return rows;
    return [];
  });

beforeEach(() => serve([]));

describe("GET /api/delivered", () => {
  it("asks once, grouped, for the messages delivered in the last 7 days, with their transfers", async () => {
    const { status, body } = await get("/api/delivered?now=1000000");
    expect(status).toBe(200);
    expect(body).toEqual({ now: 1_000_000, directions: [] });
    const query = calls.find((call) => call.table === messages)!;
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
