import { describe, expect, it } from "vitest";
import { formatRoute, HOME_ROUTE, parseRoute, resolveHome, routeTitle } from "../../src/app/route";
import { viewResults } from "../../src/search/search-model";

const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";

describe("the bridge routes", () => {
  it("opens the bridge on the default pair, sending from the first chain, for an empty hash", () => {
    expect(resolveHome(HOME_ROUTE, "sepolia-pls943")).toEqual({ name: "bridge", pairId: "sepolia-pls943", dir: "first-to-second" });
    expect(routeTitle(HOME_ROUTE)).toBe("Bridge");
  });

  it("round-trips a direction and the form fields, and leaves defaults out of the link", () => {
    const hash = `#/bridge/eth-pls?dir=second-to-first&bridge.token=second:${ADDRESS}&bridge.amount=1.25&bridge.receiver=${ADDRESS}`;
    const route = parseRoute(hash);
    expect(route).toEqual({ name: "bridge", pairId: "eth-pls", dir: "second-to-first", form: { token: `second:${ADDRESS}`, amount: "1.25", receiver: ADDRESS } });
    expect(formatRoute(route)).toMatch(/^#\/bridge\/eth-pls\?dir=second-to-first&/);
    expect(formatRoute({ name: "bridge", pairId: "eth-pls", dir: "first-to-second" })).toBe("#/bridge/eth-pls");
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it("refuses a crafted direction or field and keeps the rest", () => {
    expect(parseRoute("#/bridge/eth-pls?dir=sideways&bridge.amount=1e18&bridge.receiver=attacker")).toEqual({ name: "bridge", pairId: "eth-pls", dir: "first-to-second" });
  });

  it("names the three screens, and the palette lists them", () => {
    expect(parseRoute("#/activity")).toEqual({ name: "activity" });
    expect(parseRoute("#/explore")).toEqual({ name: "explore" });
    expect(formatRoute({ name: "activity" })).toBe("#/activity");
    expect(formatRoute({ name: "explore" })).toBe("#/explore");
    expect(routeTitle({ name: "activity" })).toBe("Activity");
    expect(routeTitle({ name: "explore" })).toBe("Explore");
    const titles = viewResults("eth-pls").map((result) => result.title);
    expect(titles.slice(0, 3)).toEqual(["Activity", "Bridge", "Explore"]);
  });
});
