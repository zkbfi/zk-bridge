import { describe, expect, it } from "vitest";
import { createIndexerClient, NOT_FOUND, transactionLookupQuery, type JsonRequester } from "../../src/data/indexer-client";
import { parseMessageDetail } from "../../src/data/message-detail";

const MESSAGE_ID = `0x${"ab".repeat(32)}`;
const TRANSACTION = `0x${"cd".repeat(32)}`;
const ADDRESS = `0x${"12".repeat(20)}`;

const apiItem = {
  messageId: MESSAGE_ID,
  kind: "token",
  status: "delivered",
  direction: { sourceChainId: 1, destinationChainId: 369, label: "1>369" },
  sender: ADDRESS,
  executor: ADDRESS,
  gasLimit: 2_000_000,
  sent: { transactionHash: TRANSACTION, blockNumber: 12, timestamp: 1_790_000_000 },
  covered: { headSlot: 100, timestamp: 1_790_000_100 },
  delivered: { transactionHash: TRANSACTION, blockNumber: 40, timestamp: 1_790_000_200, success: true, executedBy: ADDRESS },
  callbackFailed: false,
  releaseFailed: false,
  transfer: {
    sourceToken: { chainId: 1, address: ADDRESS, symbol: "USDC", decimals: 6 },
    destinationToken: { chainId: 369, address: ADDRESS, symbol: "zUSDC", decimals: 6 },
    sender: ADDRESS,
    recipient: ADDRESS,
    value: "1000000",
    deliveredValue: "999000",
  },
  data: "0x1234",
};

describe("parseMessageDetail", () => {
  it("reads amounts as bigint and keeps both chains' facts", () => {
    const detail = parseMessageDetail(apiItem);
    expect(detail.transfer?.value).toBe(1_000_000n);
    expect(detail.transfer?.deliveredValue).toBe(999_000n);
    expect(detail.sentAt).toBe(1_790_000_000);
    expect(detail.deliveredAt).toBe(1_790_000_200);
    expect(detail.deliverySucceeded).toBe(true);
    expect(detail.data).toBe("0x1234");
  });

  it("reads an undelivered message with nothing after the send", () => {
    const detail = parseMessageDetail({ ...apiItem, status: "sent", covered: null, delivered: null, transfer: null, kind: "message" });
    expect(detail).toMatchObject({ coveredAt: null, deliveredAt: null, deliverySucceeded: null, transfer: null, kind: "message" });
  });

  it("refuses an amount that is a JSON number, because it may have lost digits", () => {
    expect(() => parseMessageDetail({ ...apiItem, transfer: { ...apiItem.transfer, value: 1_000_000 } })).toThrow(/not a decimal string/);
  });

  it("refuses an unknown status", () => {
    expect(() => parseMessageDetail({ ...apiItem, status: "teleported" })).toThrow(/Unknown status/);
  });
});

describe("createIndexerClient", () => {
  it("reads one message by identifier from the existing route, in lower case", async () => {
    const seen: string[] = [];
    const request: JsonRequester = async (url) => {
      seen.push(url);
      return apiItem;
    };
    const message = await createIndexerClient({ baseUrl: "http://indexer.test/", request }).message(MESSAGE_ID.toUpperCase().replace("0X", "0x") as `0x${string}`);
    expect(seen).toEqual([`http://indexer.test/api/messages/${MESSAGE_ID}`]);
    expect(message?.id).toBe(MESSAGE_ID);
  });

  it("gives null for a message that the indexer does not know", async () => {
    const client = createIndexerClient({ baseUrl: "http://indexer.test", request: async () => NOT_FOUND });
    expect(await client.message(MESSAGE_ID as `0x${string}`)).toBeNull();
  });

  it("finds a message by transaction hash through the GraphQL route of Ponder, with no new route", async () => {
    const calls: { url: string; body: string | undefined }[] = [];
    const request: JsonRequester = async (url, init) => {
      calls.push({ url, body: init?.body });
      return { data: { messagess: { items: [{ messageId: MESSAGE_ID }] } } };
    };
    const found = await createIndexerClient({ baseUrl: "http://indexer.test", request }).findMessageByTransaction(TRANSACTION as `0x${string}`);
    expect(found).toBe(MESSAGE_ID);
    expect(calls[0]!.url).toBe("http://indexer.test/graphql");
    const query = JSON.parse(calls[0]!.body!).query as string;
    expect(query).toBe(transactionLookupQuery(TRANSACTION as `0x${string}`));
    expect(query).toContain("sentTransactionHash");
    expect(query).toContain("deliveredTransactionHash");
  });

  it("gives null when no message has the hash", async () => {
    const client = createIndexerClient({ baseUrl: "http://indexer.test", request: async () => ({ data: { messagess: { items: [] } } }) });
    expect(await client.findMessageByTransaction(TRANSACTION as `0x${string}`)).toBeNull();
  });
});

describe("a transaction's cost", () => {
  const cost = { chainId: 369, hash: TRANSACTION, block: "40", gasUsed: "100000", effectiveGasPriceWei: "1000000000", costWei: "100000000000000", costUsd: null, nativeUsd: null };
  it("reads GET /api/tx/:chainId/:hash, and null for a transaction the indexer does not store", async () => {
    const urls: string[] = [];
    const client = createIndexerClient({ baseUrl: "https://indexer.example/", request: async (url) => (urls.push(url), url.includes("/369/") ? cost : NOT_FOUND) });
    expect(await client.transactionCost(369, TRANSACTION.toUpperCase().replace("0X", "0x") as `0x${string}`)).toEqual(cost);
    expect(urls[0]).toBe(`https://indexer.example/api/tx/369/${TRANSACTION}`);
    expect(await client.transactionCost(1, TRANSACTION as `0x${string}`)).toBeNull();
  });
  it("refuses an answer of the wrong shape", async () => {
    const client = createIndexerClient({ baseUrl: "https://indexer.example", request: async () => ({ ...cost, costWei: 1 }) });
    await expect(client.transactionCost(369, TRANSACTION as `0x${string}`)).rejects.toThrow(/transaction cost/);
  });
});
