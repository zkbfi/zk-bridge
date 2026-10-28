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

describe("head updates that share a timestamp", () => {
  const headAt = (chainId: number, slot: bigint): HistoryEvent => ({ ...head, chainId, slot });

  /** Pages through the events with a limit of one, as the cursor does: each page starts after the last event. */
  const pagesOf = (events: HistoryEvent[]): HistoryEvent[] => {
    const sorted = [...events].sort(compareHistoryEvents);
    const seen: HistoryEvent[] = [];
    let last: HistoryEvent | null = null;
    for (;;) {
      const previous: HistoryEvent | null = last;
      const next: HistoryEvent | undefined = sorted.find((event) => previous === null || compareHistoryEvents(previous, event) < 0);
      if (next === undefined) return seen;
      seen.push(next);
      last = next;
    }
  };

  it("sorts slot 10 before slot 9, as the database does", () => {
    const sorted = [headAt(369, 9n), headAt(369, 10n)].sort(compareHistoryEvents);
    expect(sorted.map((event) => event.slot)).toEqual([10n, 9n]);
  });

  it("returns each of slots 9 and 10 exactly once when paging with a limit of one", () => {
    expect(pagesOf([headAt(369, 9n), headAt(369, 10n)]).map((event) => event.slot)).toEqual([10n, 9n]);
  });

  it("sorts chain 369 before chain 1 and returns each exactly once when paging with a limit of one", () => {
    const events = [headAt(1, 5n), headAt(369, 5n)];
    expect([...events].sort(compareHistoryEvents).map((event) => event.chainId)).toEqual([369, 1]);
    expect(pagesOf(events).map((event) => event.chainId)).toEqual([369, 1]);
  });

  it("keeps the cursor text for such an event parseable", () => {
    const text = encodeHistoryCursor({ timestamp: 1_000n, kind: "head-update", key: historyEventKey(headAt(369, 10n)) });
    expect(text).toBe("1000:head-update:369-10");
    expect(query(`cursor=${text}`)).toMatchObject({ ok: true });
  });
});
