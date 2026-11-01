import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { headUpdates, messages, tokens, transfers } from "../../ponder.schema";
import { registerSearchRoute } from "../../src/api/routes/search";
import { calls, respondWith, type QueryCall } from "./support/fake-api";
import { BRIDGE_ON_ETHEREUM, LIGHT_CLIENT_ON_PULSECHAIN, addressOf, hashOf, sentMessageRow } from "./support/handler-fixtures";

const app = new Hono();
registerSearchRoute(app);
const get = async (path: string) => {
  const response = await app.request(path);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

const id = hashOf("ab");
const sentHash = hashOf("01");
const row = { ...sentMessageRow(id, 100n), sentTransactionHash: sentHash, deliveredTransactionHash: hashOf("02") };
const usdc = { chainId: 1, address: addressOf("31"), name: "USD Coin", symbol: "USDC", decimals: 6, metadataRead: true, isBridgedCopy: false, homeChainId: 1, homeToken: addressOf("31") };
const noSymbol = { ...usdc, address: addressOf("32"), symbol: null };
const transfer = { messageId: id, sourceChainId: 1, destinationChainId: 369, sourceToken: addressOf("31"), sender: addressOf("f0"), recipient: addressOf("f1"), paidTo: null };
const update = { chainId: 369, slot: 11_477_760n, transactionHash: hashOf("f1") };

type Data = { message?: unknown; transferless?: boolean; updates?: unknown[]; transferCount?: number | null; prefixRows?: unknown[] };
const serve = (data: Data) =>
  respondWith((call: QueryCall) => {
    if (call.table === tokens) return [usdc, noSymbol];
    if (call.table === headUpdates) return data.updates ?? [];
    if (call.table === transfers) return [{ count: data.transferCount ?? 0 }];
    if (call.table === messages && call.whereValues.some((value) => typeof value === "string" && value.endsWith("%"))) return data.prefixRows ?? [];
    // The fake runs no SQL: the message answers only a query that names its identifier or one of its transactions.
    // A lookup by identifier binds one value; a lookup by transaction binds the hash twice.
    const named = call.whereValues.length === 1 ? call.whereValues[0] === id : [sentHash, hashOf("02")].includes(call.whereValues[0] as `0x${string}`);
    return data.message === undefined || !named ? [] : [data.message];
  });

const environment = { ...process.env };
beforeEach(() => serve({}));
afterEach(() => {
  process.env = { ...environment };
});

describe("GET /api/search", () => {
  it("finds a message by identifier with its token symbol and links to every surface", async () => {
    serve({ message: { messages: row, transfers: transfer } });
    const { status, body } = await get(`/api/search?q=${id.toUpperCase().replace("0X", "0x")}`);
    expect(status).toBe(200);
    expect(body.query).toBe(id.toUpperCase().replace("0X", "0x"));
    expect(body.candidates.map((candidate: { kind: string }) => candidate.kind)).toEqual(["message-id", "transaction"]);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ id: `message:${id}`, kind: "message", confirmed: true });
    expect(body.results[0].subtitle).toMatch(/^Transfer of USDC · /);
    expect(body.results[0].links.map((link: { surface: string; url: string }) => [link.surface, link.url])).toEqual([
      ["dapp", `https://next.zkb.fi/#/message/${id}`],
      ["indexer", `https://indexer.zkb.fi/#lookup=${id}`],
      ["status", "https://status.zkb.fi/#check=pipeline-first-to-second"],
      ["backend", `https://prove.zkb.fi/progress/${id}`],
    ]);
    expect(calls.some((call) => call.table === messages && call.whereValues.includes(id))).toBe(true);
  });

  it("finds a message by the transaction that sent it, and a message without a transfer has no symbol", async () => {
    serve({ message: { messages: row, transfers: null } });
    const { body } = await get(`/api/search?q=${sentHash}`);
    expect(body.results.map((result: { id: string }) => result.id)).toEqual([`message:${id}`, `transaction:1:${sentHash}`]);
    expect(body.results[0].subtitle).toMatch(/^Transfer · .*found by transaction/);
    expect(body.results[1].subtitle).toMatch(/^Send of a transfer/);
  });

  it("finds a transfer whose token has no symbol", async () => {
    serve({ message: { messages: row, transfers: { ...transfer, sourceToken: addressOf("32") } } });
    const { body } = await get(`/api/search?q=${id}`);
    expect(body.results[0].subtitle).toMatch(/^Transfer · /);
    serve({ message: { messages: { ...row, kind: "message" }, transfers: { ...transfer, sourceToken: null } } });
    expect((await get(`/api/search?q=${id}`)).body.results[0].subtitle).toMatch(/^Message · /);
  });

  it("finds a light client update by its transaction", async () => {
    serve({ updates: [update] });
    const { body } = await get(`/api/search?q=${update.transactionHash}`);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ kind: "transaction", chainId: 369, confirmed: true });
    expect(body.results[0].subtitle).toContain("slot 11,477,760");
  });

  it("offers an unknown hash as a transaction on each chain", async () => {
    const { body } = await get(`/api/search?q=${hashOf("c0")}`);
    expect(body.results.map((result: { chainId: number; confirmed: boolean }) => [result.chainId, result.confirmed])).toEqual([[1, false], [369, false]]);
  });

  it("names a contract of the deployment, with the check of its light client", async () => {
    const { body } = await get(`/api/search?q=${LIGHT_CLIENT_ON_PULSECHAIN}`);
    expect(body.results[0]).toMatchObject({ kind: "address", addressType: "lightClient", chainId: 369 });
    expect(body.results[0].links.find((link: { surface: string }) => link.surface === "status").url).toBe("https://status.zkb.fi/#check=lightclient-first-to-second");
    expect(body.results[0].links.filter((link: { surface: string }) => link.surface === "explorer").map((link: { label: string }) => link.label)).toEqual(["PulseChain scan"]);
  });

  it("names a bridged token by its address and counts the transfers of another address", async () => {
    expect((await get(`/api/search?q=${addressOf("31")}`)).body.results[0]).toMatchObject({ kind: "token", title: "USDC" });
    serve({ transferCount: 7 });
    const { body } = await get(`/api/search?q=${addressOf("77")}`);
    expect(body.results[0]).toMatchObject({ kind: "address", addressType: "unknown" });
    expect(body.results[0].subtitle).toContain("7 transfers");
  });

  it("counts no transfers when the database gives no row", async () => {
    respondWith((call) => (call.table === transfers ? [] : []));
    expect((await get(`/api/search?q=${addressOf("77")}`)).body.results[0].subtitle).toContain("0 transfers");
  });

  it("finds a token by symbol, skipping a token without one", async () => {
    const { body } = await get("/api/search?q=usdc");
    expect(body.results.map((result: { title: string }) => result.title)).toEqual(["USDC"]);
  });

  it("finds a message by the start of its identifier", async () => {
    serve({ prefixRows: [{ messages: row, transfers: transfer }] });
    const { body } = await get(`/api/search?q=${id.slice(0, 12)}`);
    expect(body.results[0]).toMatchObject({ kind: "message" });
    expect(calls.some((call) => call.whereValues.includes(`${id.slice(0, 12)}%`))).toBe(true);
  });

  it("answers a slot with the update that used it", async () => {
    serve({ updates: [update] });
    const { body } = await get("/api/search?q=11477760");
    expect(body.results[0]).toMatchObject({ kind: "slot", confirmed: true });
    expect(calls.some((call) => call.table === headUpdates && call.whereValues.includes(11_477_760n))).toBe(true);
  });

  it("answers a bridge address by its role", async () => {
    expect((await get(`/api/search?q=${BRIDGE_ON_ETHEREUM}`)).body.results[0].title).toBe("MessageBridge on Ethereum");
  });

  it("reads no table for a text it does not know, and says that a name is not resolved", async () => {
    const { body } = await get("/api/search?q=vitalik.eth");
    expect(body).toMatchObject({ results: [], unsupported: "name" });
    expect(calls).toHaveLength(0);
  });

  it("limits the results, and refuses a bad request", async () => {
    expect((await get("/api/search?q=5&limit=2")).body.results).toHaveLength(2);
    expect(await get("/api/search")).toEqual({ status: 400, body: { error: "missing q" } });
    expect((await get(`/api/search?q=${"a".repeat(201)}`)).status).toBe(400);
    for (const limit of ["0", "51", "x", "1.5"]) expect((await get(`/api/search?q=5&limit=${limit}`)).status, limit).toBe(400);
  });

  it("reports a failing table in problems and still answers", async () => {
    respondWith(() => {
      throw new Error("db down");
    });
    const { status, body } = await get(`/api/search?q=${id}`);
    expect(status).toBe(200);
    expect(body.problems).toContain("indexer: db down");
  });

  it("links to the hosts that the deployment names", async () => {
    process.env.EXPLORER_SITE_DAPP = "https://dapp.example";
    process.env.EXPLORER_SITE_INDEXER = "https://indexer.example";
    process.env.EXPLORER_SITE_STATUS = "https://status.example";
    process.env.EXPLORER_SITE_BACKEND = "https://prove.example";
    process.env.EXPLORER_SITE_GATEWAY = "https://gateway.example";
    const { body } = await get(`/api/search?q=bafy${"a".repeat(30)}`);
    expect(body.results[0].links.map((link: { url: string }) => new URL(link.url).origin)).toEqual(["https://dapp.example", "https://indexer.example", "https://status.example", "https://gateway.example"]);
  });
});
