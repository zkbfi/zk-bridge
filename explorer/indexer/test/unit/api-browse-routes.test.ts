import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { headUpdates, messages, tokens, transfers } from "../../ponder.schema";
import { resetBrowseCache } from "../../src/api/browse-cache";
import { registerBrowseRoutes } from "../../src/api/routes/browse";
import { calls, respondWith, type QueryCall } from "./support/fake-api";
import { addressOf, hashOf, sentMessageRow } from "./support/handler-fixtures";

const app = new Hono();
registerBrowseRoutes(app);

const get = async (path: string) => {
  const response = await app.request(path);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

const tokenRow = (chainId: number, byte: string, symbol: string | null, isBridgedCopy: boolean) => ({
  chainId,
  address: addressOf(byte),
  name: symbol,
  symbol,
  decimals: 6,
  metadataRead: true,
  isBridgedCopy,
  homeChainId: 1,
  homeToken: addressOf("aa"),
  registeredTransactionHash: null,
  registeredBlockNumber: null,
  registeredTimestamp: null,
});

const transferRow = (messageId: `0x${string}`) => ({
  messageId,
  sourceChainId: 1,
  destinationChainId: 369,
  sourceToken: addressOf("aa"),
  destinationToken: addressOf("bb"),
  sender: addressOf("11"),
  recipient: addressOf("22"),
  value: 42n,
  deliveredValue: null,
  paidTo: null,
  handler: "handleBridgedTokens",
  deploysCopy: false,
  hasCallback: false,
  sourceIsNative: true,
  sentTimestamp: 1_000n,
});

const headRow = (chainId: number, slot: bigint, timestamp: bigint) => ({
  chainId,
  slot,
  headerRoot: hashOf("01"),
  executionBlockHash: hashOf("02"),
  executionBlockNumber: 50n,
  transactionHash: hashOf("03"),
  blockNumber: 60n,
  timestamp,
  gasUsed: 600_000n,
  effectiveGasPrice: 100n,
  costWei: 60_000_000n,
  poster: addressOf("f1"),
});

beforeEach(() => {
  resetBrowseCache();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(5_000_000));
  respondWith(() => []);
});
afterEach(() => vi.useRealTimers());

describe("GET /api/browse/messages", () => {
  const serve = (rows: unknown[], total: number) =>
    respondWith((call: QueryCall) => (call.table === tokens ? [tokenRow(1, "aa", "USDT", false)] : call.fields !== undefined ? [{ count: total }] : rows));

  it("pages the messages with the total that match, and says when the snapshot is from", async () => {
    const id = hashOf("01");
    serve([{ messages: { ...sentMessageRow(id, 100n), sentTimestamp: 2_000n }, transfers: transferRow(id) }], 1284);
    const { status, body } = await get("/api/browse/messages?limit=25&offset=50");
    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 1284, limit: 25, offset: 50, asOf: 5000 });
    expect(body.items[0]).toMatchObject({ messageId: id, transfer: { value: "42", sourceToken: { symbol: "USDT" } } });
    const list = calls.find((call) => call.table === messages && call.fields === undefined);
    expect([list?.limit, list?.offset, list?.ordered, list?.joins]).toEqual([25, 50, true, [transfers]]);
    const total = calls.find((call) => call.table === messages && call.fields !== undefined);
    expect(total?.joins).toEqual([transfers]);
  });

  it("counts with the same filters as the page, so the total is the total of what the page filters", async () => {
    serve([], 0);
    const account = addressOf("22");
    await get(`/api/browse/messages?direction=1>369&kind=token&status=inflight&token=${addressOf("aa")}&sender=${account}&recipient=${account}&from=10&to=20&asOf=4000&sort=amount-low`);
    const [list, total] = ["list", "total"].map((name) => calls.find((call) => call.table === messages && (call.fields === undefined) === (name === "list")) as QueryCall);
    expect(list?.whereValues).toEqual(total?.whereValues);
    expect(list?.whereValues).toEqual(expect.arrayContaining([1, 369, "token", "sent", "waiting_for_finality", "covered", addressOf("aa"), account, 10n, 20n, 4000n]));
  });

  it.each(["newest", "oldest", "amount-high", "amount-low"])("sorts %s", async (sort) => {
    serve([], 0);
    expect((await get(`/api/browse/messages?sort=${sort}`)).status).toBe(200);
    expect(calls.find((call) => call.table === messages && call.fields === undefined)?.ordered).toBe(true);
  });

  it("repeats the asOf of the request, and shows a total of 0 for a database that answers nothing", async () => {
    const { body } = await get("/api/browse/messages?asOf=1234");
    expect(body).toMatchObject({ total: 0, items: [], asOf: 1234 });
  });

  it("refuses a query it cannot read, with the reason", async () => {
    expect(await get("/api/browse/messages?sort=biggest")).toEqual({ status: 400, body: { error: "invalid sort: biggest" } });
  });
});

describe("GET /api/browse/proofs", () => {
  it("pages the light client updates with their number on the chain and the total that match", async () => {
    respondWith((call: QueryCall) => {
      if (call.fields === undefined) return [headRow(369, 200n, 3_000n), headRow(1, 100n, 2_000n)];
      return call.whereValues.includes(369) && call.whereValues.length > 1 ? [{ count: 7 }] : call.whereValues.length === 0 ? [{ count: 221 }] : [{ count: 3 }];
    });
    const { status, body } = await get("/api/browse/proofs?limit=2");
    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 221, limit: 2, offset: 0, asOf: 5000 });
    expect(body.items.map((item: { slot: number; number: number }) => [item.slot, item.number])).toEqual([[200, 7], [100, 3]]);
    expect(body.items[0]).toMatchObject({ chainId: 369, poster: addressOf("f1"), costWei: "60000000" });
  });

  it("filters by chain, poster and time, sorts, and has a total of 0 and number 0 when the database answers nothing", async () => {
    respondWith((call: QueryCall) => (call.fields === undefined ? [headRow(1, 100n, 2_000n)] : []));
    const { body } = await get(`/api/browse/proofs?chainId=1&poster=${addressOf("f1")}&from=1&to=9&asOf=8&sort=slot-high&offset=4`);
    expect(body).toMatchObject({ total: 0, offset: 4, asOf: 8 });
    expect(body.items[0].number).toBe(0);
    const list = calls.find((call) => call.table === headUpdates && call.fields === undefined);
    expect(list?.whereValues).toEqual([1, addressOf("f1"), 1n, 9n, 8n]);
    expect(list?.offset).toBe(4);
  });

  it("finds an update by its slot and by its posting transaction", async () => {
    respondWith((call: QueryCall) => (call.fields === undefined ? [headRow(1, 100n, 2_000n)] : [{ count: 1 }]));
    const hash = `0x${"AB".repeat(32)}`;
    expect((await get(`/api/browse/proofs?slot=100&transactionHash=${hash}`)).status).toBe(200);
    const list = calls.find((call) => call.table === headUpdates && call.fields === undefined);
    expect(list?.whereValues).toEqual([100n, hash.toLowerCase()]);
  });

  it("refuses a slot or a transaction hash it cannot read", async () => {
    expect(await get("/api/browse/proofs?slot=x")).toEqual({ status: 400, body: { error: "invalid slot: x" } });
    expect(await get("/api/browse/proofs?transactionHash=0x12")).toEqual({ status: 400, body: { error: "invalid transactionHash: 0x12" } });
  });

  it.each(["newest", "oldest", "slot-high", "slot-low"])("sorts %s", async (sort) => {
    expect((await get(`/api/browse/proofs?sort=${sort}`)).status).toBe(200);
  });

  it("refuses a query it cannot read", async () => {
    expect(await get("/api/browse/proofs?chainId=x")).toEqual({ status: 400, body: { error: "invalid chainId: x" } });
  });
});

describe("GET /api/browse/tokens", () => {
  const rows = [tokenRow(1, "aa", "USDT", false), tokenRow(369, "bb", "USDT", true), tokenRow(1, "cc", "AAA", false), tokenRow(1, "dd", null, false), tokenRow(1, "ee", "AAA", false)];
  const serve = () =>
    respondWith((call: QueryCall) => {
      if (call.table === tokens) return rows;
      // The first grouped read counts transfers by source token, the second by destination token.
      const sourceCalls = calls.filter((other) => other.table === transfers).indexOf(call);
      return sourceCalls === 0
        ? [{ chainId: 1, token: addressOf("aa"), count: 5 }, { chainId: 1, token: addressOf("cc"), count: 1 }]
        : [{ chainId: 369, token: addressOf("bb"), count: 4 }, { chainId: 1, token: addressOf("aa"), count: 2 }];
    });

  it("sorts by symbol, with tokens that have none last, and counts the transfers that name each token", async () => {
    serve();
    const { body } = await get("/api/browse/tokens");
    expect(body.items.map((item: { address: string; transfers: number }) => [item.address.slice(2, 4), item.transfers])).toEqual([["cc", 1], ["ee", 0], ["aa", 7], ["bb", 4], ["dd", 0]]);
    expect(body).toMatchObject({ total: 5, limit: 50, offset: 0 });
  });

  it("sorts by transfers, and falls back to the symbol for equal counts", async () => {
    serve();
    const { body } = await get("/api/browse/tokens?sort=transfers");
    expect(body.items.map((item: { address: string }) => item.address.slice(2, 4))).toEqual(["aa", "bb", "cc", "ee", "dd"]);
  });

  it("filters by chain and kind, and pages", async () => {
    serve();
    expect((await get("/api/browse/tokens?chainId=369")).body.total).toBe(1);
    expect((await get("/api/browse/tokens?kind=copy")).body.total).toBe(1);
    expect((await get("/api/browse/tokens?kind=native&chainId=1")).body.total).toBe(4);
    const page = await get("/api/browse/tokens?limit=2&offset=4");
    expect([page.body.items.length, page.body.total]).toEqual([1, 5]);
  });

  it("refuses a query it cannot read", async () => {
    expect((await get("/api/browse/tokens?kind=x")).status).toBe(400);
  });
});

describe("GET /api/browse/addresses", () => {
  const a = addressOf("a1");
  const b = addressOf("b2");
  const c = addressOf("c3");
  const serve = () =>
    respondWith((call: QueryCall) => {
      if (call.table === transfers) {
        const order = calls.filter((other) => other.table === transfers).indexOf(call);
        return order === 0 ? [{ address: a, count: 3, last: "900" }, { address: null, count: 1, last: null }] : [{ address: b, count: 2, last: "950" }, { address: a, count: 1, last: "800" }];
      }
      if (call.table === messages) return [{ address: b, count: 1, last: "960" }, { address: c, count: 1, last: null }];
      return [{ address: c, count: 6, last: "700" }];
    });

  it("lists addresses by what they did, most active first, with the newest time", async () => {
    serve();
    const { body } = await get("/api/browse/addresses");
    expect(body.items).toEqual([
      { address: c, sent: 1, received: 0, posted: 6, lastActive: 700 },
      { address: a, sent: 3, received: 1, posted: 0, lastActive: 900 },
      { address: b, sent: 1, received: 2, posted: 0, lastActive: 960 },
    ]);
    expect(body).toMatchObject({ total: 3, limit: 50, offset: 0 });
  });

  it("sorts by the newest activity, filters by role and by address prefix, and pages", async () => {
    serve();
    expect((await get("/api/browse/addresses?sort=recent")).body.items.map((item: { address: string }) => item.address)).toEqual([b, a, c]);
    expect((await get("/api/browse/addresses?role=poster")).body.items.map((item: { address: string }) => item.address)).toEqual([c]);
    expect((await get("/api/browse/addresses?role=sender&q=0xa1")).body.total).toBe(1);
    expect((await get("/api/browse/addresses?role=recipient&limit=1&offset=1")).body).toMatchObject({ total: 2, items: [expect.objectContaining({ address: b })] });
  });

  it("orders addresses with the same activity, and with no time, by address", async () => {
    respondWith((call: QueryCall) => (call.table === transfers ? [{ address: b, count: 1, last: null }, { address: a, count: 1, last: null }] : []));
    expect((await get("/api/browse/addresses")).body.items.map((item: { address: string }) => item.address)).toEqual([a, b]);
    expect((await get("/api/browse/addresses?sort=recent")).body.items.map((item: { address: string }) => item.address)).toEqual([a, b]);
  });

  it("shares one scan between readers within the cache window, and scans again after it", async () => {
    serve();
    await get("/api/browse/addresses");
    const scans = calls.length;
    await get("/api/browse/addresses?sort=recent");
    expect(calls.length).toBe(scans);
    vi.setSystemTime(new Date(5_000_000 + 11_000));
    await get("/api/browse/addresses");
    expect(calls.length).toBe(scans * 2);
  });

  it("refuses a query it cannot read", async () => {
    expect((await get("/api/browse/addresses?q=zz")).status).toBe(400);
  });
});
