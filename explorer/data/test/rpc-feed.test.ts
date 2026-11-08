import { describe, expect, it } from "vitest";
import { encodeCursor } from "../src/index.js";
import { createRpcHarness, HARNESS_NOW } from "./support/rpc-harness.js";
import type { MessageName } from "./support/scenario.js";

const EXPECTED_STATUS: Readonly<Record<MessageName, string>> = {
  delivered: "delivered",
  returned: "delivered",
  plain: "delivered",
  failed: "waiting_for_finality",
  paid: "delivered",
  stuck: "release_failed",
  callbackFailed: "delivered",
  covered: "covered",
  young: "sent",
  waiting: "waiting_for_finality",
  backward: "sent",
};

const statusesOf = (feed: { items: { messageId: string; status: string }[] }) => Object.fromEntries(feed.items.map((item) => [item.messageId, item.status]));

describe("the feed from the chains", () => {
  it("derives the status of every message from the logs of both chains, with the rules of the indexer", async () => {
    const harness = createRpcHarness();
    const feed = await harness.body("/api/feed?limit=50");
    const expected = Object.fromEntries(Object.entries(harness.scenario.ids).map(([name, id]) => [id, EXPECTED_STATUS[name as MessageName]]));
    expect(statusesOf(feed)).toEqual(expected);
    expect(feed.nextCursor).toBeNull();
    expect(feed.coverage).toMatchObject({ source: "rpc", complete: true, coveredFrom: 0, partial: [] });
  });

  it("lists the newest send first", async () => {
    const harness = createRpcHarness();
    const feed = await harness.body("/api/feed?limit=50");
    const times = feed.items.map((item: { sent: { timestamp: number } }) => item.sent.timestamp);
    expect(times).toEqual([...times].sort((left, right) => right - left));
    expect(feed.items[0].messageId).toBe(harness.scenario.ids.young);
    expect(feed.items[1].messageId).toBe(harness.scenario.ids.backward);
  });

  it("joins the token facts of both chains into one transfer", async () => {
    const harness = createRpcHarness();
    const feed = await harness.body("/api/feed?limit=50");
    const item = feed.items.find((entry: { messageId: string }) => entry.messageId === harness.scenario.ids.delivered);
    expect(item).toMatchObject({
      kind: "token",
      direction: { sourceChainId: 1, destinationChainId: 369, label: "1>369" },
      sender: harness.scenario.accounts.sender,
      transfer: {
        value: "1000",
        deliveredValue: "1000",
        paidTo: harness.scenario.accounts.recipient,
        recipient: harness.scenario.accounts.recipient,
        handler: "handleBridgedTokens",
        sourceIsNative: true,
        sourceToken: { chainId: 1, symbol: "USDT", decimals: 6, isBridgedCopy: false },
        destinationToken: { chainId: 369, symbol: "USDT.e", decimals: 6, isBridgedCopy: true, homeToken: harness.scenario.tokens.native },
      },
    });
  });

  it("shows a release that the recipient could not take as release_failed, final, with no claim and no fallback fields", async () => {
    const harness = createRpcHarness();
    const feed = await harness.body("/api/feed?limit=50");
    const byName = (name: MessageName) => feed.items.find((entry: { messageId: string }) => entry.messageId === harness.scenario.ids[name]);
    expect(byName("stuck")).toMatchObject({ status: "release_failed", releaseFailed: true, transfer: { recipient: harness.scenario.accounts.recipient, paidTo: null } });
    expect(byName("callbackFailed")).toMatchObject({ status: "delivered", releaseFailed: false, callbackFailed: true });
    for (const name of ["claimableOutstanding", "fallbackUsed"]) expect(byName("stuck")).not.toHaveProperty(name);
    expect(byName("stuck").transfer).not.toHaveProperty("fallbackRecipient");
  });

  it("lists sends of the same second with the larger identifier first", async () => {
    const harness = createRpcHarness();
    const feed = await harness.body("/api/feed?limit=50");
    const order = feed.items.map((item: { messageId: string }) => item.messageId);
    const { plain, waiting } = harness.scenario.ids;
    expect(harness.scenario.events.filter((event) => [plain, waiting].includes(event.args.messageId as never) && event.eventName === "UserRequestForAffirmation").map((event) => event.blockNumber)).toEqual([120n, 120n]);
    expect(waiting > plain).toBe(true);
    expect(order.indexOf(waiting)).toBeLessThan(order.indexOf(plain));
  });

  it("names the delivery transaction sender from the receipt, and the head that covered the send", async () => {
    const harness = createRpcHarness();
    const feed = await harness.body("/api/feed?limit=50");
    const item = feed.items.find((entry: { messageId: string }) => entry.messageId === harness.scenario.ids.delivered);
    expect(item.delivered).toMatchObject({ executedBy: `0x${"e0".repeat(20)}` });
    expect(item.covered).toEqual({ headSlot: 300, timestamp: Number(harness.scenario.timestampOf(369, 215n)) });
    const failed = feed.items.find((entry: { messageId: string }) => entry.messageId === harness.scenario.ids.failed);
    expect(failed.delivered).toBeNull();
    expect(failed.covered).toBeNull();
  });

  it("leaves the executor empty when the receipt cannot be read, and still lists the message", async () => {
    const harness = createRpcHarness();
    const original = harness.chains[369]!.getTransactionReceipt;
    harness.chains[369]!.getTransactionReceipt = async () => {
      throw new Error("receipt unavailable");
    };
    const feed = await harness.body("/api/feed?limit=50");
    harness.chains[369]!.getTransactionReceipt = original;
    const item = feed.items.find((entry: { messageId: string }) => entry.messageId === harness.scenario.ids.delivered);
    expect(item.delivered.executedBy).toBeNull();
  });
});

describe("the filters of the feed", () => {
  it("filters by direction, kind and status", async () => {
    const harness = createRpcHarness();
    const ids = harness.scenario.ids;
    expect((await harness.body("/api/feed?direction=369>1")).items.map((item: { messageId: string }) => item.messageId)).toEqual([ids.backward, ids.returned]);
    const messages = await harness.body("/api/feed?kind=message");
    expect(messages.items.map((item: { messageId: string }) => item.messageId).sort()).toEqual([ids.plain, ids.failed, ids.waiting].sort());
    const failed = await harness.body("/api/feed?status=release_failed,delivered");
    expect(failed.items.map((item: { status: string }) => item.status).sort()).toContain("release_failed");
    expect((await harness.answer("/api/feed?status=failed_call")).status).toBe(400);
  });

  it("filters by token on either side of the transfer", async () => {
    const harness = createRpcHarness();
    const { native, copy } = harness.scenario.tokens;
    const byNative = await harness.body(`/api/feed?token=${native}&limit=50`);
    const byCopy = await harness.body(`/api/feed?token=${copy}&limit=50`);
    expect(byNative.items.length).toBeGreaterThan(0);
    expect(byCopy.items.length).toBeGreaterThan(0);
    expect(byCopy.items.map((item: { messageId: string }) => item.messageId)).toContain(harness.scenario.ids.returned);
    expect(byNative.items.every((item: { transfer: unknown }) => item.transfer !== null)).toBe(true);
  });

  it("filters by an account that is the sender, the recipient or the payee", async () => {
    const harness = createRpcHarness();
    const { callbackRecipient, recipientBack, executor } = harness.scenario.accounts;
    expect((await harness.body(`/api/feed?address=${callbackRecipient}`)).items.map((item: { messageId: string }) => item.messageId)).toEqual([harness.scenario.ids.callbackFailed]);
    expect((await harness.body(`/api/feed?address=${recipientBack}`)).items.map((item: { messageId: string }) => item.messageId).sort()).toEqual([harness.scenario.ids.returned, harness.scenario.ids.backward].sort());
    expect((await harness.body(`/api/feed?address=${executor}`)).items).toHaveLength(3);
    expect((await harness.body(`/api/feed?address=${executor.toUpperCase().replace("0X", "0x")}`)).items).toHaveLength(3);
  });

  it("filters by send time, both ends included", async () => {
    const harness = createRpcHarness();
    const at = (block: bigint) => harness.scenario.timestampOf(1, block);
    const window = await harness.body(`/api/feed?from=${at(120n)}&to=${at(165n)}&limit=50`);
    expect(window.items.map((item: { sent: { blockNumber: number } }) => item.sent.blockNumber).sort()).toEqual([120, 120, 160, 165]);
  });

  it("pages with a cursor, newest first, with no item twice and none missing", async () => {
    const harness = createRpcHarness();
    const all = (await harness.body("/api/feed?limit=50")).items.map((item: { messageId: string }) => item.messageId);
    const first = await harness.body("/api/feed?limit=4");
    expect(first.items).toHaveLength(4);
    expect(first.nextCursor).toMatch(/^\d+:0x[0-9a-f]{64}$/);
    const second = await harness.body(`/api/feed?limit=4&cursor=${first.nextCursor}`);
    const third = await harness.body(`/api/feed?limit=4&cursor=${second.nextCursor}`);
    expect(third.nextCursor).toBeNull();
    const paged = [...first.items, ...second.items, ...third.items].map((item: { messageId: string }) => item.messageId);
    expect(paged).toEqual(all);
  });

  it("answers 400 with the problem for a query that does not parse", async () => {
    const harness = createRpcHarness();
    expect(await harness.answer("/api/feed?limit=0")).toEqual({ status: 400, body: { error: "invalid limit: 0" } });
    expect(await harness.answer("/api/feed?status=nope")).toMatchObject({ status: 400 });
  });
});

describe("reading the history in bounded windows", () => {
  const options = { api: { blockSpan: 40, maxWindowsPerRequest: 1 } } as const;

  it("never asks for a window wider than the block span, starts at the head, and goes back newest first", async () => {
    const harness = createRpcHarness(options);
    await harness.body("/api/feed?limit=50");
    await harness.body("/api/feed?limit=50");
    for (const chain of Object.values(harness.chains)) {
      expect(chain.calls.getLogs.every((request) => request.toBlock - request.fromBlock + 1n <= 40n)).toBe(true);
      const bridgeWindows = chain.calls.getLogs.filter((request) => request.address === harness.scenario.pair.sides[chain === harness.chains[1] ? 0 : 1].contracts.bridge);
      expect(bridgeWindows[0]?.toBlock).toBe(300n);
      const starts = bridgeWindows.map((request) => request.fromBlock);
      expect(starts).toEqual([...starts].sort((left, right) => Number(right - left)));
    }
  });

  it("lists only what it can state correctly and says how far back it has read", async () => {
    const harness = createRpcHarness(options);
    const first = await harness.body("/api/feed?limit=50");
    expect(first.coverage.complete).toBe(false);
    expect(first.coverage.coveredFrom).toBeGreaterThan(0);
    expect(first.coverage.partial).toEqual(["feed"]);
    expect(first.nextCursor).not.toBeNull();
    for (const item of first.items) expect(item.sent.timestamp).toBeGreaterThanOrEqual(first.coverage.coveredFrom);
  });

  it("gives each message the status that it has with the whole history, at every depth", { timeout: 60_000 }, async () => {
    const harness = createRpcHarness(options);
    const final = Object.fromEntries(Object.entries(harness.scenario.ids).map(([name, id]) => [id, EXPECTED_STATUS[name as MessageName]]));
    let previousCount = -1;
    let feed = await harness.body("/api/feed?limit=50");
    for (let request = 0; request < 40 && !feed.coverage.complete; request += 1) {
      for (const item of feed.items) expect(item.status, `${item.messageId} at depth ${request}`).toBe(final[item.messageId]);
      expect(feed.items.length).toBeGreaterThanOrEqual(previousCount);
      previousCount = feed.items.length;
      feed = await harness.body("/api/feed?limit=50");
    }
    expect(feed.coverage.complete).toBe(true);
    expect(statusesOf(feed)).toEqual(final);
  });

  it("stops reading older windows when the filter asks only for newer rows", async () => {
    const harness = createRpcHarness({ api: { blockSpan: 40, maxWindowsPerRequest: 20 } });
    const from = harness.scenario.timestampOf(1, 290n);
    const feed = await harness.body(`/api/feed?from=${from}&limit=50`);
    expect(feed.items.map((item: { messageId: string }) => item.messageId)).toEqual([harness.scenario.ids.young, harness.scenario.ids.backward]);
    expect(feed.nextCursor).toBeNull();
    expect(harness.chains[1].calls.getLogs.length).toBeLessThan(40);
  });

  it("reads the cursor boundary when a request finds no row, so the next request goes further back", async () => {
    const harness = createRpcHarness({ api: { blockSpan: 20, maxWindowsPerRequest: 1 } });
    const feed = await harness.body("/api/feed?status=release_failed&limit=5");
    expect(feed.items).toEqual([]);
    expect(feed.nextCursor).toBe(encodeCursor({ sentTimestamp: BigInt(feed.coverage.coveredFrom), messageId: `0x${"f".repeat(64)}` }));
  });

  it("splits a window that the node refuses for its size and still lists every message", async () => {
    const harness = createRpcHarness({
      first: { failLogs: (request) => (request.toBlock - request.fromBlock + 1n > 60n ? new Error("query returned more than 10000 results") : undefined) },
      second: { failLogs: (request) => (request.toBlock - request.fromBlock + 1n > 60n ? new Error("exceeds the block range limit") : undefined) },
      api: { blockSpan: 200, minimumBlockSpan: 20 },
    });
    const feed = await harness.body("/api/feed?limit=50");
    expect(feed.items).toHaveLength(11);
  });

  it("follows new blocks: a delivery that lands after the first read changes the status in the next answer", async () => {
    const harness = createRpcHarness({ api: { headMaxAgeMilliseconds: 0 } });
    harness.chains[1].setHead(210n);
    harness.chains[369].setHead(210n);
    const before = await harness.body("/api/feed?limit=50");
    const delivered = before.items.find((item: { messageId: string }) => item.messageId === harness.scenario.ids.delivered);
    expect(delivered.status).toBe("delivered");
    const returned = before.items.find((item: { messageId: string }) => item.messageId === harness.scenario.ids.returned);
    expect(returned.status).not.toBe("delivered");
    expect(before.items.find((item: { messageId: string }) => item.messageId === harness.scenario.ids.young)).toBeUndefined();
    harness.chains[1].setHead(300n);
    harness.chains[369].setHead(300n);
    const after = await harness.body("/api/feed?limit=50");
    expect(after.items).toHaveLength(11);
    expect(after.items.find((item: { messageId: string }) => item.messageId === harness.scenario.ids.returned).status).toBe("delivered");
  });
});

describe("failures", () => {
  it("says which chain has no RPC URL", async () => {
    const harness = createRpcHarness({ omitReader: 369 });
    await expect(harness.api.get("/api/feed")).rejects.toThrow("No RPC URL is set for pulsechain.");
  });

  it("removes the secrets from the message of a failed read", async () => {
    const secret = "https://rpc.example.org/v3/FAKEKEY1234567890";
    const harness = createRpcHarness({
      first: { failLogs: () => new Error(`HTTP request failed. URL: ${secret}`) },
      api: { redact: (text) => text.replaceAll(secret, "[redacted]") },
    });
    await expect(harness.api.get("/api/feed")).rejects.toThrow("HTTP request failed. URL: [redacted]");
  });

  it("keeps the name of the error, so a caller can tell the kind", async () => {
    const harness = createRpcHarness({ first: { failLogs: () => Object.assign(new Error("down"), { name: "HttpRequestError" }) } });
    await expect(harness.api.get("/api/feed")).rejects.toMatchObject({ name: "HttpRequestError" });
  });

  it("turns a value that is not an Error into a message", async () => {
    const harness = createRpcHarness({ first: { failLogs: () => "plain text" as unknown as Error } });
    await expect(harness.api.get("/api/feed")).rejects.toMatchObject({ message: "plain text", name: "Error" });
  });

  it("refuses a path that the RPC source does not serve", async () => {
    const harness = createRpcHarness();
    await expect(harness.api.get("/api/escrow")).rejects.toMatchObject({ name: "RpcUnsupportedError", message: "/api/escrow is not available from the RPC source." });
  });
});

describe("the clock", () => {
  it("uses the clock of the options and the now query of the request for the 24 hour window", async () => {
    const harness = createRpcHarness();
    const day = await harness.body("/api/summary");
    expect(day.now).toBe(HARNESS_NOW);
    const later = await harness.body(`/api/summary?now=${HARNESS_NOW + 90_000}`);
    expect(later.now).toBe(HARNESS_NOW + 90_000);
    expect(later.volume24h).toEqual([]);
    expect(day.volume24h.length).toBeGreaterThan(0);
    expect((await harness.body("/api/summary?now=abc")).now).toBe(HARNESS_NOW);
  });

  it("uses the system clock when the caller gives none, so the old synthetic history is outside the 24 hours", async () => {
    const harness = createRpcHarness({ api: { nowSeconds: undefined } });
    const summary = await harness.body("/api/summary");
    expect(Math.abs(summary.now - Math.floor(Date.now() / 1000))).toBeLessThan(60);
    expect(summary.volume24h).toEqual([]);
  });
});
