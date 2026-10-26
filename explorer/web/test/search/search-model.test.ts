import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { parseDocPages } from "../../src/docs/docs-index";
import {
  actionResults,
  addressResult,
  classifyQuery,
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
  "/docs/pages/03-bridging-tokens.md": "# Bridging tokens\n\n## Claimable balances\n\ntext\n",
});

const everything = [
  ...viewResults("eth-pls"),
  ...pairResults([{ id: "eth-pls", label: "Ethereum and PulseChain" }]),
  ...tokenResults(FIXTURE_TOKENS, FIXTURE_PAIR),
  ...actionResults({ pair: FIXTURE_PAIR, walletConnected: false }),
  ...docResults(pages),
];

describe("classifyQuery", () => {
  it("tells an address, a 32 byte hash, words and nothing apart", () => {
    expect(classifyQuery("  ").kind).toBe("empty");
    expect(classifyQuery(`0x${"ab".repeat(20)}`).kind).toBe("address");
    expect(classifyQuery(`0x${"AB".repeat(32)}`)).toEqual({ kind: "hash", hash: `0x${"ab".repeat(32)}` });
    expect(classifyQuery("0x1234").kind).toBe("text");
    expect(classifyQuery("usdc").kind).toBe("text");
  });
});

describe("rankResults", () => {
  it("ranks a title that starts with the query above a match in the subtitle", () => {
    const ranked = rankResults("audit", everything);
    expect(ranked[0]?.id).toBe("view:audit");
  });

  it("finds a token by symbol on either chain", () => {
    const titles = rankResults("usdc", everything).filter((result) => result.kind === "token").map((result) => result.title);
    expect(titles).toEqual(expect.arrayContaining(["USDC", "zkbUSDC"]));
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

  it("offers a switch to each chain of the pair, and the actions of the brief", () => {
    const ids = actionResults({ pair: FIXTURE_PAIR, walletConnected: true }).map((result) => result.id);
    expect(ids).toEqual(expect.arrayContaining(["action:bridge", "action:wrap", "action:send-message", "action:claim", "action:settings", "action:switch-chain:1", "action:switch-chain:369", "action:theme:dark"]));
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
