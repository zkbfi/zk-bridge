import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { formatListState, isListKind, pageCount, parseListState, requestOf, viewKey, withFilter, withPage, withSort } from "../../src/explore/browse-model";

const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TOKEN = `first:${ADDRESS}`;

describe("a list's address", () => {
  it("is empty for the default view, and the default view reads back from an empty address", () => {
    expect(parseListState("transfers", undefined)).toEqual({ filters: {}, sort: "newest", page: 1 });
    expect(formatListState("transfers", { filters: {}, sort: "newest", page: 1 })).toBe("");
  });

  it("writes only what differs from the default and reads it back", () => {
    const state = { filters: { status: "inflight", from: "first", account: ADDRESS, token: TOKEN, since: "24h", kind: "token" }, sort: "oldest", page: 3 };
    const query = formatListState("transfers", state);
    expect(new URLSearchParams(query).get("page")).toBe("3");
    expect(parseListState("transfers", query)).toEqual(state);
  });

  it("drops what the list does not know, so an old link opens the list unfiltered", () => {
    const state = parseListState("transfers", `status=lost&from=third&kind=x&since=1y&token=nope&account=zzz&sort=biggest&page=0&unknown=1`);
    expect(state).toEqual({ filters: {}, sort: "newest", page: 1 });
    expect(parseListState("transfers", "page=1.5").page).toBe(1);
    expect(parseListState("transfers", "page=x").page).toBe(1);
    expect(parseListState("transfers", `account=${"0x".padEnd(80, "a")}`).filters).toEqual({});
    expect(parseListState("addresses", "q=0xAB").filters).toEqual({ q: "0xAB" });
    expect(parseListState("addresses", "q=zz").filters).toEqual({});
    expect(parseListState("addresses", "q=%20%20").filters).toEqual({});
    expect(parseListState("proofs", "poster=0xab").filters).toEqual({});
  });

  it("changes a filter, a sort or a page, and a changed filter or sort goes back to page 1", () => {
    const base = { filters: { status: "inflight" }, sort: "newest", page: 4 };
    expect(withFilter(base, "kind", "token")).toEqual({ filters: { status: "inflight", kind: "token" }, sort: "newest", page: 1 });
    expect(withFilter(base, "status", null)).toEqual({ filters: {}, sort: "newest", page: 1 });
    expect(withFilter(base, "status", "")).toEqual({ filters: {}, sort: "newest", page: 1 });
    expect(withSort(base, "oldest")).toEqual({ filters: { status: "inflight" }, sort: "oldest", page: 1 });
    expect(withPage(base, 9).page).toBe(9);
  });

  it("knows the paged kinds", () => {
    expect(["transfers", "proofs", "tokens", "addresses"].every(isListKind)).toBe(true);
    expect(isListKind("contracts")).toBe(false);
  });

  it("keeps one snapshot key for the pages of a view", () => {
    const a = { filters: { status: "inflight" }, sort: "newest", page: 1 };
    expect(viewKey("transfers", a)).toBe(viewKey("transfers", { ...a, page: 7 }));
    expect(viewKey("transfers", a)).not.toBe(viewKey("transfers", { ...a, sort: "oldest" }));
  });

  it("counts pages, with at least one", () => {
    expect([0, 1, 50, 51, 1284].map((total) => pageCount(total))).toEqual([1, 1, 1, 2, 26]);
  });
});

describe("the request a state makes", () => {
  const pair = FIXTURE_PAIR;
  const request = (kind: Parameters<typeof requestOf>[0], query: string, asOf?: number) => requestOf(kind, parseListState(kind, query), pair, 1_000_000, asOf);

  it("asks for 50 rows at the offset of the page, with the snapshot", () => {
    expect(request("transfers", "page=3", 77)).toMatchObject({ limit: 50, offset: 100, sort: "newest", asOf: 77 });
    expect(request("transfers", "")).toMatchObject({ offset: 0, asOf: undefined });
  });

  it("turns the transfer filters into the indexer's", () => {
    const query = `from=second&status=failed&kind=message&since=7d&token=${TOKEN}&account=${ADDRESS}`;
    expect(request("transfers", query)).toMatchObject({
      direction: `${pair.second.chainId}>${pair.first.chainId}`,
      status: "release_failed",
      kind: "message",
      token: ADDRESS,
      address: ADDRESS,
      from: 1_000_000 - 7 * 86_400,
    });
    expect(request("transfers", "from=first&status=inflight&since=1h")).toMatchObject({ direction: `${pair.first.chainId}>${pair.second.chainId}`, status: "inflight", from: 1_000_000 - 3600 });
    expect(request("transfers", "status=delivered")).toMatchObject({ status: "delivered", direction: undefined, token: undefined, from: undefined });
  });

  it("turns the proof, token and address filters into the indexer's", () => {
    expect(request("proofs", `chain=second&poster=${ADDRESS}&sort=slot-high`)).toMatchObject({ chainId: pair.second.chainId, poster: ADDRESS, sort: "slot-high" });
    expect(request("proofs", "")).toMatchObject({ chainId: undefined });
    expect(request("tokens", "chain=first&kind=copy&sort=transfers", 5)).toMatchObject({ chainId: pair.first.chainId, kind: "copy", sort: "transfers", asOf: undefined });
    expect(request("tokens", "")).toMatchObject({ chainId: undefined });
    expect(request("addresses", "role=poster&q=0xab&sort=recent", 5)).toMatchObject({ role: "poster", q: "0xab", sort: "recent", asOf: undefined });
  });
});
