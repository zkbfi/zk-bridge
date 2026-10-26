import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { messages, tokens, transfers } from "../../ponder.schema";
import { registerFeedRoutes } from "../../src/api/routes/feed";
import { encodeCursor } from "@zk-bridge/shared";
import { calls, respondWith, type QueryCall } from "./support/fake-api";
import { addressOf, hashOf, sentMessageRow } from "./support/handler-fixtures";

const app = new Hono();
registerFeedRoutes(app);

const get = async (path: string) => {
  const response = await app.request(path);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

const tokenRow = {
  chainId: 369,
  address: addressOf("bb"),
  name: "Tether",
  symbol: "USDT",
  decimals: 6,
  metadataRead: true,
  isBridgedCopy: true,
  homeChainId: 1,
  homeToken: addressOf("aa"),
  registeredTransactionHash: null,
  registeredBlockNumber: null,
  registeredTimestamp: null,
};

const transferRow = (messageId: `0x${string}`) => ({
  messageId,
  sourceChainId: 1,
  destinationChainId: 369,
  sourceToken: addressOf("aa"),
  destinationToken: addressOf("bb"),
  sender: addressOf("11"),
  recipient: addressOf("22"),
  fallbackRecipient: addressOf("22"),
  value: 42n,
  deliveredValue: null,
  paidTo: null,
  handler: "handleBridgedTokens",
  deploysCopy: false,
  hasCallback: false,
  sourceIsNative: true,
  sentTimestamp: 1_000n,
});

/** A feed row: the message joined to its transfer, or to nothing. */
const feedRow = (id: string, sentTimestamp: bigint, withTransfer = true) => {
  const messageId = hashOf(id);
  return {
    messages: { ...sentMessageRow(messageId, 100n), sentTimestamp },
    transfers: withTransfer ? transferRow(messageId) : null,
  };
};

/** The feed query has a limit of the page size plus one. The lookup of one message has a limit of one. */
const serve = (feed: unknown[], found: unknown[] = []) =>
  respondWith((call: QueryCall) => (call.table === tokens ? [tokenRow] : call.limit === 1 ? found : feed));

beforeEach(() => serve([]));

describe("GET /api/feed", () => {
  it("shows each message with its transfer and its tokens, and has no next page for a short result", async () => {
    serve([feedRow("01", 2_000n), feedRow("02", 1_000n, false)]);
    const { status, body } = await get("/api/feed");
    expect(status).toBe(200);
    expect(body.items.map((item: { messageId: string }) => item.messageId)).toEqual([hashOf("01"), hashOf("02")]);
    expect(body.items[0].transfer).toMatchObject({ value: "42", destinationToken: { symbol: "USDT" } });
    expect(body.items[1].transfer).toBeNull();
    expect(body.nextCursor).toBeNull();
  });

  it("joins the transfers, sorts newest first, and reads one row more than the limit to know about a next page", async () => {
    await get("/api/feed");
    const query = calls.find((call) => call.table === messages);
    expect(query?.joins).toEqual([transfers]);
    expect(query?.ordered).toBe(true);
    expect(query?.limit).toBe(51);
    expect(query?.whereValues).toEqual([]);
  });

  it("sends every filter of the request to the query", async () => {
    const address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const lowercase = address.toLowerCase();
    const cursor = encodeCursor({ sentTimestamp: 1_500n, messageId: hashOf("0a") });
    await get(
      `/api/feed?direction=1>369&kind=token&status=sent,covered&token=${address}&address=${address}&from=10&to=20&limit=5&cursor=${cursor}`,
    );
    expect(calls.find((call) => call.table === messages)?.whereValues).toEqual([
      1,
      369,
      "token",
      "sent",
      "covered",
      lowercase,
      lowercase,
      lowercase,
      lowercase,
      lowercase,
      lowercase,
      lowercase,
      lowercase,
      10n,
      20n,
      1_500n,
      1_500n,
      hashOf("0a"),
    ]);
    expect(calls.find((call) => call.table === messages)?.limit).toBe(6);
  });

  it("answers a page of the limit and a cursor that names its last row, when more rows exist", async () => {
    serve([feedRow("03", 3_000n), feedRow("02", 2_000n), feedRow("01", 1_000n)]);
    const { body } = await get("/api/feed?limit=2");
    expect(body.items.map((item: { messageId: string }) => item.messageId)).toEqual([hashOf("03"), hashOf("02")]);
    expect(body.nextCursor).toBe(`2000:${hashOf("02")}`);
  });

  it("gives no cursor when the rows fit in the limit exactly", async () => {
    serve([feedRow("02", 2_000n), feedRow("01", 1_000n)]);
    const { body } = await get("/api/feed?limit=2");
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
  });

  it("refuses a bad filter with its name and runs no query", async () => {
    const { status, body } = await get("/api/feed?kind=other");
    expect(status).toBe(400);
    expect(body).toEqual({ error: "invalid kind: other" });
    expect(calls).toEqual([]);
  });
});

describe("GET /api/messages/:messageId", () => {
  const id = hashOf("ab");

  it("shows the message with its transfer and the data of the message", async () => {
    serve([], [{ messages: { ...sentMessageRow(id, 100n), data: "0x1234" }, transfers: transferRow(id) }]);
    const { status, body } = await get(`/api/messages/${id}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ messageId: id, status: "sent", data: "0x1234", transfer: { value: "42" } });
  });

  it("looks the identifier up in lowercase, whatever case the request has", async () => {
    await get(`/api/messages/0x${"AB".repeat(32)}`);
    const query = calls.find((call) => call.table === messages);
    expect(query?.whereValues).toEqual([id]);
    expect(query?.limit).toBe(1);
  });

  it.each(["0x1234", `${"ab".repeat(32)}`, `0x${"zz".repeat(32)}`, `0x${"ab".repeat(33)}`])("refuses the identifier %s", async (text) => {
    const { status, body } = await get(`/api/messages/${text}`);
    expect(status).toBe(400);
    expect(body).toEqual({ error: "invalid message identifier" });
    expect(calls).toEqual([]);
  });

  it("answers 404 for a message that is not stored", async () => {
    const { status, body } = await get(`/api/messages/${id}`);
    expect(status).toBe(404);
    expect(body).toEqual({ error: "unknown message" });
  });
});
