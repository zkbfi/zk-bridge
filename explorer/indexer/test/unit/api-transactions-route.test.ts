import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { transactionCostRow } from "@zk-bridge/shared";
import { headUpdates, messages, tokens, transactionCosts, transfers } from "../../ponder.schema";
import { registerFeedRoutes } from "../../src/api/routes/feed";
import { registerTransactionRoutes } from "../../src/api/routes/transactions";
import { calls, respondWith, type QueryCall } from "./support/fake-api";
import { hashOf, sentMessageRow } from "./support/handler-fixtures";

const app = new Hono();
registerFeedRoutes(app);
registerTransactionRoutes(app);
const get = async (path: string) => {
  const response = await app.request(path);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

const E18 = 10n ** 18n;
const costOf = (chainId: number, byte: string, price: boolean) =>
  transactionCostRow({
    chainId,
    transactionHash: hashOf(byte),
    blockNumber: 100n,
    timestamp: 1_000n,
    gasUsed: 100_000n,
    effectiveGasPrice: 10n ** 9n,
    price: price ? { usdE18: 3_000n * E18, block: 90n, pool: null, source: "pulsex-weth-copy" } : null,
  });

/** Answers each table from the given rows; a cost query gets the rows whose hash reached the where clause. */
const serve = (rows: { messageRow?: unknown; costs?: ReturnType<typeof costOf>[]; updates?: unknown[]; covered?: number }) =>
  respondWith((call: QueryCall) => {
    if (call.table === tokens) return [];
    if (call.table === transactionCosts) return (rows.costs ?? []).filter((row) => call.whereValues.includes(row.transactionHash));
    if (call.table === headUpdates) return rows.updates ?? [];
    if (call.table === messages && call.fields !== undefined) return [{ count: rows.covered ?? 0 }];
    return rows.messageRow === undefined ? [] : [rows.messageRow];
  });

beforeEach(() => serve({}));

describe("GET /api/tx/:chainId/:hash", () => {
  it("serves one stored transaction's cost, in wei and in dollars at its named-block price", async () => {
    serve({ costs: [costOf(1, "aa", true)] });
    const { status, body } = await get(`/api/tx/1/0x${"AA".repeat(32)}`);
    expect(status).toBe(200);
    expect(body).toEqual({
      chainId: 1,
      hash: hashOf("aa"),
      block: "100",
      gasUsed: "100000",
      effectiveGasPriceWei: "1000000000",
      costWei: "100000000000000",
      costUsd: "300000000000000000",
      nativeUsd: { usd: "3000000000000000000000", source: "pulsex-weth-copy", priceBlock: "90" },
    });
    expect(calls[0]?.whereValues).toEqual([1, hashOf("aa")]);
  });

  it("answers 404 for a transaction it does not store, and 400 for a bad chain or hash", async () => {
    expect((await get(`/api/tx/1/${hashOf("bb")}`)).status).toBe(404);
    expect(await get(`/api/tx/x/${hashOf("bb")}`)).toEqual({ status: 400, body: { error: "invalid chain" } });
    expect(await get(`/api/tx/0/${hashOf("bb")}`)).toEqual({ status: 400, body: { error: "invalid chain" } });
    expect(await get("/api/tx/1/0x12")).toEqual({ status: 400, body: { error: "invalid transaction hash" } });
  });
});

describe("a message's costs", () => {
  const id = hashOf("ab");
  const delivered = { ...sentMessageRow(id, 100n), sentTransactionHash: hashOf("01"), deliveredTransactionHash: hashOf("02"), coveredByHeadSlot: 77n };

  it("are its send, its delivery, and the covering update shared by the messages it covered, from the same rows as /api/tx", async () => {
    serve({ messageRow: { messages: delivered, transfers: null }, costs: [costOf(1, "01", true), costOf(369, "02", false), costOf(369, "03", false)], updates: [{ transactionHash: hashOf("03") }], covered: 4 });
    const { body } = await get(`/api/messages/${id}`);
    expect(body.costs.sent).toMatchObject({ chainId: 1, hash: hashOf("01"), costUsd: "300000000000000000" });
    expect(body.costs.delivered).toMatchObject({ chainId: 369, hash: hashOf("02"), costUsd: null, nativeUsd: null });
    expect(body.costs.proof).toMatchObject({ chainId: 369, hash: hashOf("03"), coveredMessages: 4 });
    expect((await get(`/api/tx/369/${hashOf("03")}`)).body).toEqual((({ coveredMessages: _drop, ...rest }) => rest)(body.costs.proof));
  });

  it("are empty before anything is stored, and the proof is empty while no update covered it", async () => {
    serve({ messageRow: { messages: { ...delivered, deliveredTransactionHash: null, coveredByHeadSlot: null }, transfers: null } });
    expect((await get(`/api/messages/${id}`)).body.costs).toEqual({ sent: null, delivered: null, proof: null });
    serve({ messageRow: { messages: { ...delivered, sentTransactionHash: null }, transfers: null }, updates: [{ transactionHash: hashOf("03") }] });
    expect((await get(`/api/messages/${id}`)).body.costs).toEqual({ sent: null, delivered: null, proof: null });
  });

  it("counts no covered messages when the count answers nothing", async () => {
    serve({ messageRow: { messages: delivered, transfers: null }, costs: [costOf(369, "03", false)], updates: [{ transactionHash: hashOf("03") }] });
    respondWith((call: QueryCall) => {
      if (call.table === transactionCosts) return [costOf(369, "03", false)];
      if (call.table === headUpdates) return [{ transactionHash: hashOf("03") }];
      if (call.table === messages && call.fields !== undefined) return [];
      return call.table === messages ? [{ messages: delivered, transfers: null }] : [];
    });
    expect((await get(`/api/messages/${id}`)).body.costs.proof.coveredMessages).toBe(0);
    expect(transfers).toBeDefined();
  });
});
