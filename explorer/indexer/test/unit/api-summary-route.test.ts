import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { feeBalances, headUpdates, messages, tokens, transfers } from "../../ponder.schema";
import { registerSummaryRoutes } from "../../src/api/routes/summary";
import { pair } from "../../src/lib/pair";
import { calls, publicClients, respondWith, type QueryCall } from "./support/fake-api";
import { addressOf, hashOf } from "./support/handler-fixtures";

const app = new Hono();
registerSummaryRoutes(app);

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

type Tables = {
  inFlight?: unknown[];
  volume?: unknown[];
  fees?: unknown[];
  updates?: Record<string, unknown>[];
};

/** Answers each query of the summary by its table and its fields. */
const serve = (tables: Tables) =>
  respondWith((call: QueryCall) => {
    if (call.table === tokens) return [tokenRow];
    if (call.table === messages) return tables.inFlight ?? [];
    if (call.table === transfers) return tables.volume ?? [];
    if (call.table === feeBalances) return tables.fees ?? [];
    if (call.table === headUpdates) return (tables.updates ?? []).filter((row) => call.whereValues.includes(row.chainId));
    return [];
  });

beforeEach(() => {
  for (const key of Object.keys(publicClients)) delete publicClients[key];
  serve({});
});

afterEach(() => vi.useRealTimers());

describe("GET /api/summary", () => {
  it("names the pair, the heads and the gates of both sides, with empty totals when nothing is stored", async () => {
    const { status, body } = await get("/api/summary?now=1000000");
    expect(status).toBe(200);
    expect(body.pair).toBe(pair.name);
    expect(body.now).toBe(1_000_000);
    expect(body.heads.map((head: { chainId: number }) => head.chainId)).toEqual([1, 369]);
    expect(body.gates.map((gate: { chainId: number }) => gate.chainId)).toEqual([1, 369]);
    expect(body.inFlight).toEqual({
      total: 0,
      byStatus: { sent: 0, waiting_for_finality: 0, covered: 0 },
      byDirection: {},
    });
    expect(body.volume24h).toEqual([]);
    expect(body.feesAccrued).toEqual([]);
    expect(body.lastHeadUpdates).toEqual([
      { chainId: 1, update: null },
      { chainId: 369, update: null },
    ]);
  });

  it("counts the in flight messages in total, by status and by direction, with zero for a status that has none", async () => {
    serve({
      inFlight: [
        { direction: "1>369", status: "sent", count: 2 },
        { direction: "1>369", status: "covered", count: 1 },
        { direction: "369>1", status: "sent", count: 4 },
      ],
    });
    const { body } = await get("/api/summary?now=1000000");
    expect(body.inFlight).toEqual({
      total: 7,
      byStatus: { sent: 6, waiting_for_finality: 0, covered: 1 },
      byDirection: { "1>369": 3, "369>1": 4 },
    });
  });

  it("asks for the in flight statuses only, grouped in the database", async () => {
    await get("/api/summary?now=1000000");
    const query = calls.find((call) => call.table === messages);
    expect(query?.whereValues).toEqual(["sent", "waiting_for_finality", "covered"]);
    expect(query?.grouped).toBe(true);
  });

  it("asks for the transfers of the last 24 hours before the clock of the request", async () => {
    await get("/api/summary?now=1000000");
    expect(calls.find((call) => call.table === transfers)?.whereValues).toEqual([1_000_000n - 86_400n]);
  });

  it("shows the volume of the day with its token, and zero for a null total and null for a token that is unknown", async () => {
    serve({
      volume: [
        { chainId: 1, token, total: "500", count: 3 },
        { chainId: 369, token: null, total: null, count: 1 },
      ],
    });
    const { body } = await get("/api/summary?now=1000000");
    expect(body.volume24h).toEqual([
      { chainId: 1, token: expect.objectContaining({ address: token, symbol: "USDT" }), volume: "500", transfers: 3 },
      { chainId: 369, token: null, volume: "0", transfers: 1 },
    ]);
  });

  it("lists only the balances with accrued fees above zero", async () => {
    serve({
      fees: [
        { chainId: 1, token, charged: 10n, collected: 4n, accrued: 6n },
        { chainId: 1, token: addressOf("bb"), charged: 5n, collected: 5n, accrued: 0n },
      ],
    });
    const { body } = await get("/api/summary?now=1000000");
    expect(body.feesAccrued).toEqual([{ chainId: 1, token: expect.objectContaining({ address: token }), accrued: "6" }]);
  });

  it("shows the newest head update of each side, with numbers and strings, and null for a side with none", async () => {
    serve({
      updates: [
        {
          chainId: 369,
          slot: 500n,
          headerRoot: hashOf("11"),
          executionBlockHash: hashOf("22"),
          executionBlockNumber: 4_000n,
          transactionHash: hashOf("aa"),
          blockNumber: 100n,
          timestamp: 1_000n,
          gasUsed: 21_000n,
          effectiveGasPrice: 3n,
          costWei: 63_000n,
          poster: addressOf("f0"),
        },
      ],
    });
    const { body } = await get("/api/summary?now=1000000");
    expect(body.lastHeadUpdates).toEqual([
      { chainId: 1, update: null },
      {
        chainId: 369,
        update: {
          slot: 500,
          executionBlockNumber: 4_000,
          transactionHash: hashOf("aa"),
          timestamp: 1_000,
          gasUsed: "21000",
          costWei: "63000",
          poster: addressOf("f0"),
        },
      },
    ]);
    expect(calls.filter((call) => call.table === headUpdates).every((call) => call.limit === 1)).toBe(true);
  });

  it.each(["0", "abc", "1.5", "-5", ""])("uses the real clock when now is %j", async (text) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2_000_000_000_500));
    const { body } = await get(`/api/summary?now=${text}`);
    expect(body.now).toBe(2_000_000_000);
  });

  it("uses the real clock when the request has no now", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2_000_000_000_500));
    const { body } = await get("/api/summary");
    expect(body.now).toBe(2_000_000_000);
  });
});
