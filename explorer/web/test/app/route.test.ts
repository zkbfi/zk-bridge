import { describe, expect, it } from "vitest";
import { formatRoute, HOME_ROUTE, parseRoute, routeTitle, type Route } from "../../src/app/route";

const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";
const MESSAGE = `0x${"ab".repeat(32)}`;

const routes: readonly Route[] = [
  { name: "global" },
  { name: "pair", pairId: "eth-pls", token: null },
  { name: "pair", pairId: "eth-pls", token: ADDRESS },
  { name: "audit" },
  { name: "prover" },
  { name: "settings" },
  { name: "docs", slug: null, heading: null },
  { name: "docs", slug: "fees-explained", heading: null },
  { name: "docs", slug: "fees-explained", heading: "the-data-source-line" },
  { name: "address", address: ADDRESS },
  { name: "message", messageId: MESSAGE as `0x${string}` },
];

describe("route", () => {
  it.each(routes)("survives a round trip through the hash: %j", (route) => {
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it("falls back to the global view for an empty or unknown hash", () => {
    expect(parseRoute("")).toEqual(HOME_ROUTE);
    expect(parseRoute("#/nothing/here")).toEqual(HOME_ROUTE);
  });

  it("refuses an address or a message identifier of the wrong shape", () => {
    expect(parseRoute("#/address/0x12")).toEqual(HOME_ROUTE);
    expect(parseRoute("#/message/0x12")).toEqual(HOME_ROUTE);
  });

  it("drops a token filter that is not an address", () => {
    expect(parseRoute("#/pair/eth-pls?token=nonsense")).toEqual({ name: "pair", pairId: "eth-pls", token: null });
  });

  it("gives the settings route its own hash and title, so a link opens the connections page", () => {
    expect(formatRoute({ name: "settings" })).toBe("#/settings");
    expect(routeTitle({ name: "settings" })).toBe("Connections");
  });
});
