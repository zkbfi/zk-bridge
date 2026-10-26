import { describe, expect, it } from "vitest";
import { DEFAULT_FEED_LIMIT, encodeCursor, parseFeedQuery } from "../../src/lib/feed-query";

const parse = (query: string) => parseFeedQuery(new URLSearchParams(query));
const id = `0x${"0a".repeat(32)}`;

describe("parseFeedQuery", () => {
  it("uses defaults for an empty query", () => {
    const result = parse("");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.filters.limit).toBe(DEFAULT_FEED_LIMIT);
      expect(result.filters.statuses).toEqual([]);
      expect(result.filters.direction).toBeNull();
    }
  });

  it("parses every filter and lowercases addresses", () => {
    const result = parse(
      `direction=1>369&kind=token&status=sent,covered&token=0x70997970C51812dc3A010C7d01b50e0d17dc79C8&address=0x70997970C51812dc3A010C7d01b50e0d17dc79C8&from=10&to=20&limit=5`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filters.direction).toEqual({ sourceChainId: 1, destinationChainId: 369 });
    expect(result.filters.statuses).toEqual(["sent", "covered"]);
    expect(result.filters.token).toBe("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    expect(result.filters.address).toBe("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
    expect([result.filters.from, result.filters.to]).toEqual([10n, 20n]);
  });

  it("accepts a dash in a direction, which survives URLs without escaping", () => {
    const result = parse("direction=369-1");
    expect(result.ok && result.filters.direction).toEqual({ sourceChainId: 369, destinationChainId: 1 });
  });

  it("round trips a cursor", () => {
    const cursor = encodeCursor({ sentTimestamp: 123n, messageId: id as `0x${string}` });
    const result = parse(`cursor=${cursor}`);
    expect(result.ok && result.filters.cursor).toEqual({ sentTimestamp: 123n, messageId: id });
  });

  it.each([
    ["direction=abc"],
    ["kind=other"],
    ["status=sent,bogus"],
    ["token=0x12"],
    ["address=nope"],
    ["from=-1"],
    ["to=1.5"],
    ["limit=0"],
    ["limit=abc"],
    ["limit=-1"],
    ["limit=201"],
    ["cursor=garbage"],
  ])("refuses %s", (query) => {
    expect(parse(query).ok).toBe(false);
  });

  it.each([
    ["direction=abc", "invalid direction: abc"],
    ["kind=other", "invalid kind: other"],
    ["status=sent,bogus", "invalid status: sent,bogus"],
    ["token=0x12", "invalid token: 0x12"],
    ["address=nope", "invalid address: nope"],
    ["from=-1", "invalid from: -1"],
    ["to=1.5", "invalid to: 1.5"],
    ["limit=abc", "invalid limit: abc"],
    ["limit=201", "invalid limit: 201"],
    ["cursor=garbage", "invalid cursor: garbage"],
  ])("names the field and the value when it refuses %s", (query, problem) => {
    expect(parse(query)).toEqual({ ok: false, problem });
  });

  it("accepts the limits 1 and 200", () => {
    expect(parse("limit=1").ok && parse("limit=1")).toMatchObject({ filters: { limit: 1 } });
    expect(parse("limit=200")).toMatchObject({ ok: true, filters: { limit: 200 } });
  });
});
