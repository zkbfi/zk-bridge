import { describe, expect, it } from "vitest";
import {
  compareHistoryEvents,
  encodeHistoryCursor,
  historyEventKey,
  historyEventView,
  parseHistoryEvents,
  parseHistoryQuery,
  type HistoryEvent,
} from "../src/index.js";

const hash = (byte: string): `0x${string}` => `0x${byte.repeat(32)}`;
const query = (text: string) => parseHistoryQuery(new URLSearchParams(text));

const sent: HistoryEvent = {
  kind: "sent",
  chainId: 1,
  timestamp: 1_000n,
  transactionHash: hash("a1"),
  messageId: hash("01"),
  slot: null,
  status: "sent",
};
const head: HistoryEvent = { ...sent, kind: "head-update", chainId: 369, messageId: null, slot: 80n, status: null };

describe("parseHistoryQuery", () => {
  it("parseHistoryQuery refuses an unknown eventKind", () => {
    expect(query("eventKind=minted")).toEqual({ ok: false, problem: "invalid eventKind: minted" });
  });

  it("refuses a chain that is not a number and a cursor that is not a cursor", () => {
    expect(query("chain=eth")).toEqual({ ok: false, problem: "invalid chain: eth" });
    expect(query("cursor=1000:sent:nope")).toEqual({ ok: false, problem: "invalid cursor: 1000:sent:nope" });
  });

  it("passes the problems of the feed filters on", () => {
    expect(query("limit=201")).toEqual({ ok: false, problem: "invalid limit: 201" });
  });

  it("reads the feed filters, the chain and the event kind, with the defaults for the rest", () => {
    const result = query("direction=1>369&status=sent&from=5&chain=369&eventKind=delivered");
    expect(result).toEqual({
      ok: true,
      filters: {
        direction: { sourceChainId: 1, destinationChainId: 369 },
        kind: null,
        statuses: ["sent"],
        token: null,
        address: null,
        from: 5n,
        to: null,
        limit: 50,
        chain: 369,
        eventKind: "delivered",
        cursor: null,
      },
    });
  });
});

describe("the cursor", () => {
  it("a cursor survives a round trip", () => {
    for (const event of [sent, head]) {
      const text = encodeHistoryCursor({ timestamp: event.timestamp, kind: event.kind, key: historyEventKey(event) });
      const result = query(`cursor=${text}`);
      expect(result).toMatchObject({ ok: true, filters: { cursor: { timestamp: 1_000n, kind: event.kind, key: historyEventKey(event) } } });
    }
    expect(encodeHistoryCursor({ timestamp: 7n, kind: "head-update", key: "369-80" })).toBe("7:head-update:369-80");
  });
});

describe("compareHistoryEvents", () => {
  it("orders by time, then kind name, then key, all descending", () => {
    const older = { ...sent, timestamp: 900n };
    const delivered = { ...sent, kind: "delivered" as const };
    const lowerKey = { ...sent, messageId: hash("00") };
    const sorted = [older, lowerKey, delivered, head, sent].sort(compareHistoryEvents);
    expect(sorted).toEqual([sent, lowerKey, head, delivered, older]);
    expect(compareHistoryEvents(sent, { ...sent })).toBe(0);
    // The same order from the other side.
    expect([sent, lowerKey, head, delivered, older].reverse().sort(compareHistoryEvents)).toEqual(sorted);
    expect(compareHistoryEvents(lowerKey, sent)).toBe(1);
    expect(compareHistoryEvents(delivered, head)).toBe(1);
    expect(compareHistoryEvents(older, sent)).toBe(1);
  });
});

describe("parseHistoryEvents", () => {
  it("reads what historyEventView wrote, with bigint times and slots", () => {
    const body = { items: [historyEventView(sent), historyEventView(head)], nextCursor: "9:sent:" + hash("01"), partial: false };
    expect(parseHistoryEvents(body)).toEqual({ items: [sent, head], nextCursor: body.nextCursor, partial: false });
  });

  it("keeps a missing cursor as null and reads a partial flag", () => {
    expect(parseHistoryEvents({ items: [], partial: true })).toEqual({ items: [], nextCursor: null, partial: true });
  });

  it("answers null for a body that is not a page or holds an item that is not an event", () => {
    expect(parseHistoryEvents(null)).toBeNull();
    expect(parseHistoryEvents({ items: "no" })).toBeNull();
    expect(parseHistoryEvents({ items: [7] })).toBeNull();
    expect(parseHistoryEvents({ items: [{ ...historyEventView(sent), kind: "burned" }] })).toBeNull();
    expect(parseHistoryEvents({ items: [{ ...historyEventView(sent), timestamp: "1000" }] })).toBeNull();
  });
});
