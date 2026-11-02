import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { parseDocPages } from "../../src/docs/docs-index";
import {
  actionResults,
  addressResult,
  crossResult,
  linkContextOf,
  PALETTE_SITES,
  searchChainsOf,
  docResults,
  emptyQueryGroups,
  flattenGroups,
  groupResults,
  moveHighlight,
  pairResults,
  rankResults,
  RESULT_KINDS,
  tokenResults,
  transferResult,
  viewResults,
} from "../../src/search/search-model";

const pages = parseDocPages({
  "/docs/pages/05-fees-explained.md": "# Fees explained\n\n## The data source line\n\ntext\n\n## Base fee time\n\ntext\n",
  "/docs/pages/03-bridging-tokens.md": "# Bridging tokens\n\n## Failed releases\n\ntext\n",
});

const everything = [
  ...viewResults("eth-pls"),
  ...pairResults([{ id: "eth-pls", label: "Ethereum and PulseChain" }]),
  ...tokenResults(FIXTURE_TOKENS, FIXTURE_PAIR),
  ...actionResults({ pair: FIXTURE_PAIR, walletConnected: false }),
  ...docResults(pages),
];

describe("the cross-referenced results", () => {
  const context = linkContextOf(FIXTURE_PAIR);
  const [first, second] = [FIXTURE_PAIR.first, FIXTURE_PAIR.second];
  const base = { subtitle: "s", confirmed: true, chainId: null, addressType: null, rank: 0, links: [] as const };
  const line = (target: Parameters<typeof crossResult>[0]["target"], id = "x", title = "t") => crossResult({ ...base, id, kind: "message", title, target });

  it("takes the hosts of zkb.fi, with relative links into this page, and the chains of the pair", () => {
    expect(PALETTE_SITES).toMatchObject({ dapp: "", indexer: "https://indexer.zkb.fi", status: "https://status.zkb.fi", backend: "https://prove.zkb.fi" });
    expect(searchChainsOf(FIXTURE_PAIR).map((chain) => [chain.chainId, chain.side])).toEqual([[first.chainId, "first"], [second.chainId, "second"]]);
    expect(searchChainsOf(FIXTURE_PAIR)[0]?.contracts.bridge).toBe(first.contracts.messageBridge);
  });

  it("opens each kind of target on the page of the dapp that shows it", () => {
    const messageId = `0x${"ab".repeat(32)}` as const;
    const address = `0x${"cd".repeat(20)}`;
    expect(line({ type: "message", messageId }, "message:x")).toMatchObject({ id: `transfer:${messageId}`, kind: "transfer", jump: { type: "route", route: { name: "message", messageId } } });
    expect(line({ type: "transaction", chainId: 1, hash: messageId }).jump).toEqual({ type: "route", route: { name: "explore", page: { kind: "tx", chainId: 1, id: messageId } } });
    expect(line({ type: "address", address, chainId: null, role: null }, "address:a")).toMatchObject({ kind: "address", jump: { type: "route", route: { name: "address", address } } });
    expect(line({ type: "address", address }, "address:b").jump).toEqual({ type: "route", route: { name: "address", address } });
    expect(line({ type: "address", address, chainId: 1, role: "gate" }).jump).toEqual({ type: "route", route: { name: "explore", page: { kind: "contract", chainId: 1, id: address } } });
    expect(line({ type: "address", address, chainId: 1, role: null }).jump).toMatchObject({ route: { name: "address" } });
    expect(line({ type: "address", address, chainId: null, role: "gate" }).jump).toMatchObject({ route: { name: "address" } });
    expect(line({ type: "token", side: "second", chainId: 369, address }).jump).toEqual({ type: "route", route: { name: "explore", page: { kind: "token", id: `second:${address}` } } });
    expect(line({ type: "slot", slot: "7" })).toMatchObject({ kind: "slot", jump: { route: { page: { kind: "slot", id: "7" } } } });
    expect(line({ type: "block", chainId: 1, number: "7" })).toMatchObject({ kind: "block", jump: { route: { page: { kind: "block", chainId: 1, id: "7" } } } });
    expect(line({ type: "proof", chainId: 1, index: "7" })).toMatchObject({ kind: "proof", jump: { route: { page: { kind: "proof", chainId: 1, id: "7" } } } });
    expect(line({ type: "release", cid: "bafy" })).toMatchObject({ kind: "release", jump: { route: { page: { kind: "release", id: "bafy" } } } });
  });

  it("keeps the links of the shared search", () => {
    const links = [{ surface: "indexer", label: "Indexer", url: "https://indexer.zkb.fi/#lookup=1" }] as const;
    expect(crossResult({ ...base, id: "slot:1", kind: "slot", title: "Slot 1", target: { type: "slot", slot: "1" }, links }).links).toEqual(links);
  });

  it("gives a token of the pair its links when the caller asks, and none otherwise", () => {
    const token = FIXTURE_TOKENS[0]!;
    const [withLinks] = tokenResults([token], FIXTURE_PAIR, context);
    expect(withLinks?.links?.map((link) => link.surface)).toContain("indexer");
    expect(withLinks?.links?.find((link) => link.surface === "dapp")?.url).toBe(`#/explore/token/${token.side}/${token.address.toLowerCase()}`);
    expect(tokenResults([token], FIXTURE_PAIR)[0]?.links).toBeUndefined();
  });
});

describe("rankResults", () => {
  it("ranks a title that starts with the query above a match in the subtitle", () => {
    const ranked = rankResults("audit", everything);
    expect(ranked[0]?.id).toBe("view:audit");
  });

  it("finds a token by symbol on either chain", () => {
    const titles = rankResults("usdc", everything).filter((result) => result.kind === "token").map((result) => result.title);
    expect(titles).toEqual(expect.arrayContaining(["USDC", "zUSDC"]));
  });

  it("finds a token by address", () => {
    const token = FIXTURE_TOKENS[0]!;
    const found = rankResults(token.address.toLowerCase(), everything);
    expect(found.some((result) => result.id.startsWith("token:") && result.title === token.symbol)).toBe(true);
  });

  it("needs every word of the query to match", () => {
    expect(rankResults("audit zzzz", everything)).toHaveLength(0);
  });

  it("finds a doc page by title and by heading, and tells the page of a heading", () => {
    const byTitle = rankResults("fees explained", everything).find((result) => result.kind === "doc");
    expect(byTitle?.jump).toEqual({ type: "route", route: { name: "docs", slug: "fees-explained", heading: null } });
    const byHeading = rankResults("data source", everything).find((result) => result.kind === "doc");
    expect(byHeading?.title).toBe("The data source line");
    expect(byHeading?.subtitle).toContain("Fees explained");
    expect(byHeading?.jump).toEqual({ type: "route", route: { name: "docs", slug: "fees-explained", heading: "the-data-source-line" } });
  });

  it("returns nothing for an empty query", () => {
    expect(rankResults("", everything)).toEqual([]);
  });
});

describe("groupResults", () => {
  it("groups by kind in the fixed order and drops empty groups", () => {
    const mixed = [...rankResults("a", everything), transferResult({ messageId: `0x${"ab".repeat(32)}`, subtitle: "x" }), addressResult(`0x${"ab".repeat(20)}`)];
    const groups = groupResults(mixed);
    const order = groups.map((group) => group.id);
    expect(order).toEqual(RESULT_KINDS.filter((kind) => order.includes(kind)));
    expect(groups.every((group) => group.results.length > 0)).toBe(true);
    expect(groups[0]?.id).toBe("transfer");
  });

  it("cuts a long group", () => {
    const manyTokens = Array.from({ length: 20 }, (_, index) => ({ ...tokenResults(FIXTURE_TOKENS, FIXTURE_PAIR)[0]!, id: `token:${index}` }));
    expect(groupResults(manyTokens)[0]?.results).toHaveLength(6);
  });

  it("shows recent results first for an empty query, and does not repeat them below", () => {
    const recent = [viewResults("eth-pls")[2]!];
    const groups = emptyQueryGroups(recent, [...viewResults("eth-pls"), ...actionResults({ pair: FIXTURE_PAIR, walletConnected: false })]);
    expect(groups[0]?.id).toBe("recent");
    const ids = flattenGroups(groups).map((result) => result.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("actionResults", () => {
  it("offers connect before a wallet is connected and disconnect after", () => {
    const before = actionResults({ pair: FIXTURE_PAIR, walletConnected: false }).map((result) => result.id);
    const after = actionResults({ pair: FIXTURE_PAIR, walletConnected: true }).map((result) => result.id);
    expect(before).toContain("action:connect-wallet");
    expect(before).not.toContain("action:disconnect-wallet");
    expect(after).toContain("action:disconnect-wallet");
  });

  it("names the sending functions of the bridge action without a fallback, and offers no claim action", () => {
    const results = actionResults({ pair: FIXTURE_PAIR, walletConnected: true });
    const bridge = results.find((result) => result.id === "action:bridge")!;
    expect(bridge.subtitle).toBe("relayTokens or relayTokensAndCall, with an optional gas limit");
    expect(bridge.subtitle).not.toMatch(/allback/);
    expect(results.map((result) => result.id)).not.toContain("action:claim");
  });

  it("offers a switch to each chain of the pair, and the actions of the brief", () => {
    const ids = actionResults({ pair: FIXTURE_PAIR, walletConnected: true }).map((result) => result.id);
    expect(ids).toEqual(expect.arrayContaining(["action:bridge", "action:wrap", "action:send-message", "action:settings", "action:switch-chain:1", "action:switch-chain:369", "action:theme:dark"]));
  });
});

describe("viewResults: the connections page", () => {
  it("offers a result that opens the settings route, and finds it by the words indexer and RPC", () => {
    const results = viewResults("eth-pls");
    const connections = results.find((result) => result.id === "view:settings");
    expect(connections?.title).toBe("Connections: indexer and RPC URLs");
    expect(connections?.jump).toEqual({ type: "route", route: { name: "settings" } });
    expect(rankResults("rpc", results)[0]?.id).toBe("view:settings");
    expect(rankResults("indexer", results)[0]?.id).toBe("view:settings");
  });

  it("keeps every view in the empty-query list, so the extra result does not push the docs out", () => {
    const groups = emptyQueryGroups([], viewResults("eth-pls"));
    expect(groups[0]?.results.map((result) => result.id)).toContain("view:docs");
    expect(groups[0]?.results).toHaveLength(viewResults("eth-pls").length);
  });
});

describe("moveHighlight", () => {
  it("moves down and up and wraps at both ends", () => {
    expect(moveHighlight(0, 3, "ArrowDown")).toBe(1);
    expect(moveHighlight(2, 3, "ArrowDown")).toBe(0);
    expect(moveHighlight(0, 3, "ArrowUp")).toBe(2);
    expect(moveHighlight(1, 3, "ArrowUp")).toBe(0);
  });

  it("jumps to the first and the last result", () => {
    expect(moveHighlight(1, 5, "Home")).toBe(0);
    expect(moveHighlight(1, 5, "End")).toBe(4);
  });

  it("has no highlight when there are no results", () => {
    expect(moveHighlight(0, 0, "ArrowDown")).toBe(-1);
  });
});
