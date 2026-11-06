import { describe, expect, it } from "vitest";
import {
  BROWSE_PAGE_SIZE,
  BrowseError,
  browseParams,
  createBrowseClient,
  parseBrowseAddresses,
  parseBrowseAddressesQuery,
  parseBrowseCounts,
  parseBrowseMessages,
  parseBrowseMessagesQuery,
  parseBrowseProofs,
  parseBrowseProofsQuery,
  parseBrowseTokens,
  parseBrowseTokensQuery,
} from "../src/browse.js";

const q = (text: string) => new URLSearchParams(text);
const account = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const lower = account.toLowerCase();
const id = `0x${"0a".repeat(32)}`;

describe("parseBrowseMessagesQuery", () => {
  it("uses the defaults for an empty query", () => {
    const result = parseBrowseMessagesQuery(q(""));
    expect(result).toEqual({
      ok: true,
      query: { limit: BROWSE_PAGE_SIZE, offset: 0, direction: null, kind: null, statuses: [], token: null, sender: null, recipient: null, address: null, from: null, to: null, sort: "newest", asOf: null },
    });
  });

  it("parses every filter, expands inflight, lowercases addresses and reads the window", () => {
    const result = parseBrowseMessagesQuery(
      q(`direction=1>369&kind=token&status=inflight,delivered&token=${account}&sender=${account}&recipient=${account}&address=${account}&from=10&to=20&asOf=30&sort=amount-high&limit=25&offset=50`),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.query).toMatchObject({
      direction: { sourceChainId: 1, destinationChainId: 369 },
      kind: "token",
      statuses: ["sent", "waiting_for_finality", "covered", "delivered"],
      token: lower,
      sender: lower,
      recipient: lower,
      address: lower,
      from: 10n,
      to: 20n,
      asOf: 30n,
      sort: "amount-high",
      limit: 25,
      offset: 50,
    });
  });

  it("names the value it refuses", () => {
    const problems = (text: string) => {
      const result = parseBrowseMessagesQuery(q(text));
      return result.ok ? null : result.problem;
    };
    expect(problems("limit=0")).toBe("invalid limit: 0");
    expect(problems("limit=201")).toBe("invalid limit: 201");
    expect(problems("limit=x")).toBe("invalid limit: x");
    expect(problems("offset=-1")).toBe("invalid offset: -1");
    expect(problems("offset=10000001")).toBe("invalid offset: 10000001");
    expect(problems("direction=up")).toBe("invalid direction: up");
    expect(problems("kind=other")).toBe("invalid kind: other");
    expect(problems("status=nope")).toBe("invalid status: nope");
    expect(problems("sort=biggest")).toBe("invalid sort: biggest");
    expect(problems("token=0x12")).toBe("invalid token: 0x12");
    expect(problems("sender=0x12")).toBe("invalid sender: 0x12");
    expect(problems("recipient=0x12")).toBe("invalid recipient: 0x12");
    expect(problems("address=0x12")).toBe("invalid address: 0x12");
    expect(problems("from=-1")).toBe("invalid from: -1");
    expect(problems("to=x")).toBe("invalid to: x");
    expect(problems("asOf=x")).toBe("invalid asOf: x");
  });
});

describe("parseBrowseProofsQuery", () => {
  it("uses the defaults, and parses every filter", () => {
    expect(parseBrowseProofsQuery(q(""))).toEqual({ ok: true, query: { limit: 50, offset: 0, chainId: null, poster: null, from: null, to: null, sort: "newest", asOf: null } });
    const result = parseBrowseProofsQuery(q(`chainId=943&poster=${account}&from=1&to=2&asOf=3&sort=slot-low&limit=5&offset=10`));
    expect(result).toEqual({ ok: true, query: { limit: 5, offset: 10, chainId: 943, poster: lower, from: 1n, to: 2n, sort: "slot-low", asOf: 3n } });
  });

  it("names the value it refuses", () => {
    const problems = (text: string) => {
      const result = parseBrowseProofsQuery(q(text));
      return result.ok ? null : result.problem;
    };
    expect(problems("limit=0")).toBe("invalid limit: 0");
    expect(problems("chainId=x")).toBe("invalid chainId: x");
    expect(problems("poster=1")).toBe("invalid poster: 1");
    expect(problems("sort=x")).toBe("invalid sort: x");
    expect(problems("from=x")).toBe("invalid from: x");
  });
});

describe("parseBrowseTokensQuery", () => {
  it("uses the defaults, and parses every filter", () => {
    expect(parseBrowseTokensQuery(q(""))).toEqual({ ok: true, query: { limit: 50, offset: 0, chainId: null, kind: null, sort: "symbol" } });
    expect(parseBrowseTokensQuery(q("chainId=1&kind=copy&sort=transfers&limit=10&offset=20"))).toEqual({ ok: true, query: { limit: 10, offset: 20, chainId: 1, kind: "copy", sort: "transfers" } });
  });

  it("names the value it refuses", () => {
    const problems = (text: string) => {
      const result = parseBrowseTokensQuery(q(text));
      return result.ok ? null : result.problem;
    };
    expect(problems("offset=x")).toBe("invalid offset: x");
    expect(problems("chainId=x")).toBe("invalid chainId: x");
    expect(problems("kind=x")).toBe("invalid kind: x");
    expect(problems("sort=x")).toBe("invalid sort: x");
  });
});

describe("parseBrowseAddressesQuery", () => {
  it("uses the defaults, and parses every filter", () => {
    expect(parseBrowseAddressesQuery(q(""))).toEqual({ ok: true, query: { limit: 50, offset: 0, role: null, prefix: null, sort: "activity" } });
    expect(parseBrowseAddressesQuery(q("role=poster&q=0xAB12&sort=recent"))).toEqual({ ok: true, query: { limit: 50, offset: 0, role: "poster", prefix: "ab12", sort: "recent" } });
  });

  it("names the value it refuses", () => {
    const problems = (text: string) => {
      const result = parseBrowseAddressesQuery(q(text));
      return result.ok ? null : result.problem;
    };
    expect(problems("limit=999")).toBe("invalid limit: 999");
    expect(problems("role=x")).toBe("invalid role: x");
    expect(problems("sort=x")).toBe("invalid sort: x");
    expect(problems("q=zz")).toBe("invalid q: zz");
    expect(problems("q=0x")).toBe("invalid q: 0x");
  });
});

describe("browseParams", () => {
  it("leaves out what is missing or empty and joins lists", () => {
    expect(browseParams({ a: undefined, b: null, c: "", d: [], e: ["x", "y"], f: 0, g: 5n, h: "t" }).toString()).toBe("e=x%2Cy&f=0&g=5&h=t");
  });
});

const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({ items, total: 7, limit: 50, offset: 0, asOf: 100, ...extra });
const token = { chainId: 943, address: lower, symbol: "tUSD", name: "Dollar", decimals: 6 };

describe("parseBrowseMessages", () => {
  const sent = {
    messageId: id,
    kind: "token",
    status: "sent",
    direction: { sourceChainId: 943, destinationChainId: 1 },
    sender: lower,
    executor: lower,
    sent: { transactionHash: id, timestamp: 10 },
    delivered: { timestamp: 20 },
    transfer: { sourceToken: token, sender: account, recipient: lower, paidTo: null, value: "46610000" },
  };

  it("reads a transfer", () => {
    const result = parseBrowseMessages(page([sent]));
    expect(result).toMatchObject({ total: 7, limit: 50, offset: 0, asOf: 100 });
    expect(result.items[0]).toEqual({
      id,
      kind: "token",
      status: "sent",
      sourceChainId: 943,
      destinationChainId: 1,
      sender: lower,
      recipient: lower,
      token: { chainId: 943, address: lower, symbol: "tUSD", decimals: 6 },
      amount: 46610000n,
      sentAt: 10,
      deliveredAt: 20,
      sourceTransactionHash: id,
    });
  });

  it("reads a plain message, with the executor as recipient, and a transfer that has no recipient but a payee", () => {
    const plain = parseBrowseMessages(page([{ ...sent, kind: "message", transfer: null, sent: null, delivered: null }])).items[0];
    expect(plain).toMatchObject({ kind: "message", sender: lower, recipient: lower, token: null, amount: null, sentAt: null, deliveredAt: null, sourceTransactionHash: null });
    const paid = parseBrowseMessages(page([{ ...sent, transfer: { sourceToken: null, sender: null, recipient: null, paidTo: lower, value: null } }])).items[0];
    expect(paid).toMatchObject({ sender: lower, recipient: lower, token: null, amount: null });
    const bare = parseBrowseMessages(page([{ ...sent, sender: undefined, executor: undefined, transfer: undefined, sent: undefined, delivered: undefined }])).items[0];
    expect(bare).toMatchObject({ sender: null, recipient: null });
    const noPayee = parseBrowseMessages(page([{ ...sent, transfer: { sourceToken: { ...token, symbol: null, decimals: null } } }])).items[0];
    expect(noPayee).toMatchObject({ recipient: null, token: { symbol: null, decimals: null } });
  });

  it("refuses an answer that is not a page of messages", () => {
    expect(() => parseBrowseMessages(null)).toThrow(BrowseError);
    expect(() => parseBrowseMessages([])).toThrow("not an object");
    expect(() => parseBrowseMessages(page([{ ...sent, status: "lost" }]))).toThrow("message status");
    expect(() => parseBrowseMessages(page([{ ...sent, status: 5 }]))).toThrow("message status");
    expect(() => parseBrowseMessages(page([{ ...sent, messageId: "nope" }]))).toThrow("messageId");
    expect(() => parseBrowseMessages(page([{ ...sent, sender: "0x1", transfer: { ...sent.transfer, sender: null } }]))).toThrow("sender");
    expect(() => parseBrowseMessages(page([{ ...sent, transfer: { value: "1.5" } }]))).toThrow("value");
    expect(() => parseBrowseMessages(page([sent], { items: {} }))).toThrow("a list");
    expect(() => parseBrowseMessages(page([sent], { total: -1 }))).toThrow("a count");
    expect(() => parseBrowseMessages(page([{ ...sent, direction: { sourceChainId: "1", destinationChainId: 2 } }]))).toThrow("whole number");
    expect(() => parseBrowseMessages(page([{ ...sent, transfer: { sourceToken: { ...token, symbol: 5 } } }]))).toThrow("text");
  });
});

describe("parseBrowseProofs", () => {
  const proof = { number: 3, chainId: 943, slot: 11521312, timestamp: 5, transactionHash: id, poster: account, costWei: "60409100000000" };

  it("reads a proof", () => {
    expect(parseBrowseProofs(page([proof])).items[0]).toEqual({ number: 3, chainId: 943, slot: 11521312n, timestamp: 5, transactionHash: id, poster: lower, costWei: 60409100000000n });
  });

  it("refuses a proof with a field that is wrong", () => {
    expect(() => parseBrowseProofs(page([{ ...proof, poster: "x" }]))).toThrow("poster");
    expect(() => parseBrowseProofs(page([{ ...proof, number: 1.5 }]))).toThrow("proof number");
    expect(() => parseBrowseProofs(page([{ ...proof, slot: "x" }]))).toThrow("slot");
  });
});

describe("parseBrowseTokens", () => {
  it("reads a token", () => {
    const row = { ...token, isBridgedCopy: true, transfers: 4 };
    expect(parseBrowseTokens(page([row, { chainId: 1, address: lower, symbol: null, name: null, decimals: null, transfers: 0 }])).items).toEqual([
      { chainId: 943, address: lower, symbol: "tUSD", name: "Dollar", decimals: 6, isBridgedCopy: true, transfers: 4 },
      { chainId: 1, address: lower, symbol: null, name: null, decimals: null, isBridgedCopy: false, transfers: 0 },
    ]);
  });
});

describe("parseBrowseAddresses", () => {
  it("reads an address", () => {
    expect(parseBrowseAddresses(page([{ address: account, sent: 1, received: 2, posted: 3, lastActive: 9 }, { address: lower, sent: 0, received: 0, posted: 1, lastActive: null }])).items).toEqual([
      { address: lower, sent: 1, received: 2, posted: 3, lastActive: 9 },
      { address: lower, sent: 0, received: 0, posted: 1, lastActive: null },
    ]);
  });
});

const counts = {
  asOf: 100,
  messages: { total: 10, inFlight: 3, transfers: 8, plain: 2, byStatus: { sent: 3, delivered: 7 }, directions: [{ sourceChainId: 1, destinationChainId: 369, total: 6, inFlight: 2 }] },
  lightClientUpdates: { total: 5, chains: [{ chainId: 1, count: 5 }] },
  addresses: { total: 9, senders: 4, recipients: 5, posters: 1 },
  tokens: { total: 2, chains: [{ chainId: 1, total: 2, native: 1, copies: 1 }] },
  contracts: 12,
  gates: { total: 2, open: 1 },
  escrow: { entries: 3 },
};

describe("parseBrowseCounts", () => {
  it("reads the counts", () => {
    expect(parseBrowseCounts(counts)).toEqual(counts);
  });

  it("refuses counts with a field that is wrong", () => {
    expect(() => parseBrowseCounts({ ...counts, contracts: "12" })).toThrow("contracts");
    expect(() => parseBrowseCounts({ ...counts, messages: { ...counts.messages, byStatus: { sent: -1 } } })).toThrow("sent count");
    expect(() => parseBrowseCounts({ ...counts, escrow: null })).toThrow("escrow counts");
    expect(() => parseBrowseCounts({ ...counts, tokens: { total: 1, chains: [5] } })).toThrow("token chains");
  });
});

describe("createBrowseClient", () => {
  const asked: string[] = [];
  const client = (base: string | null, answer: unknown) =>
    createBrowseClient(
      () => base,
      async (url) => {
        asked.push(url);
        return answer;
      },
    );

  it("asks each endpoint with its query and parses the answer", async () => {
    asked.length = 0;
    expect((await client("https://i.test/", counts).counts()).messages.total).toBe(10);
    expect((await client("https://i.test", page([])).messages({ status: ["sent"], offset: 50 })).total).toBe(7);
    await client("https://i.test", page([])).proofs({});
    await client("https://i.test", page([])).tokens({ kind: "copy" });
    await client("https://i.test", page([])).addresses({ role: "poster" });
    expect(asked).toEqual([
      "https://i.test/api/counts",
      "https://i.test/api/browse/messages?status=sent&offset=50",
      "https://i.test/api/browse/proofs",
      "https://i.test/api/browse/tokens?kind=copy",
      "https://i.test/api/browse/addresses?role=poster",
    ]);
  });

  it("says when no indexer is set", async () => {
    await expect(client(null, counts).counts()).rejects.toThrow("No indexer is set");
  });
});
