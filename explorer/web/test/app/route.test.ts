import { describe, expect, it } from "vitest";
import { EMPTY_HISTORY_FILTERS } from "../../src/views/history-model";
import {
  formatLocation,
  formatRoute,
  HOME_ROUTE,
  linkedFields,
  NO_OVERLAY,
  parseLocation,
  parseOverlay,
  parseRoute,
  resolveHome,
  routeTitle,
  type Overlay,
  type Route,
} from "../../src/app/route";

const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";
const MESSAGE = `0x${"ab".repeat(32)}`;

const routes: readonly Route[] = [
  { name: "global" },
  { name: "pair", pairId: "eth-pls", token: null },
  { name: "pair", pairId: "eth-pls", token: ADDRESS },
  { name: "pair", pairId: "eth-pls", token: ADDRESS, view: { direction: "first-to-second", kind: "token", status: "delivered", address: "0x52908400", range: "24h", rows: 150 } },
  { name: "pair", pairId: "sepolia-pls943", token: null, view: { direction: "second-to-first" } },
  { name: "history", filters: EMPTY_HISTORY_FILTERS, scanBlocks: 600_000n },
  { name: "audit" },
  { name: "prover" },
  { name: "settings" },
  { name: "history", filters: EMPTY_HISTORY_FILTERS },
  { name: "history", filters: { ...EMPTY_HISTORY_FILTERS, chain: 369, eventKind: "sent" } },
  {
    name: "history",
    filters: {
      ...EMPTY_HISTORY_FILTERS,
      direction: { sourceChainId: 1, destinationChainId: 369 },
      statuses: ["covered", "delivered"],
      from: 5n,
      to: 9n,
      limit: 20,
      cursor: { timestamp: 7n, kind: "sent", key: `0x${"ab".repeat(32)}` },
    },
  },
  { name: "docs", slug: null, heading: null },
  { name: "docs", slug: "fees-explained", heading: null },
  { name: "docs", slug: "fees-explained", heading: "the-data-source-line" },
  { name: "address", address: ADDRESS },
  { name: "message", messageId: MESSAGE as `0x${string}` },
];

describe("route", () => {
  it.each(routes.map((route) => [formatRoute(route), route] as const))("survives a round trip through the hash: %s", (_hash, route) => {
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it("#/history?chain=369&eventKind=sent round-trips", () => {
    const route = parseRoute("#/history?chain=369&eventKind=sent");
    expect(route).toEqual({ name: "history", filters: { ...EMPTY_HISTORY_FILTERS, chain: 369, eventKind: "sent" } });
    expect(formatRoute(route)).toBe("#/history?chain=369&eventKind=sent");
  });

  it("opens the history with no filter for an empty or a refused query", () => {
    expect(formatRoute(parseRoute("#/history"))).toBe("#/history");
    expect(parseRoute("#/history?chain=eth")).toEqual({ name: "history", filters: EMPTY_HISTORY_FILTERS });
  });

  it("gives the home route for an empty or unknown hash, and the home route opens the default pair", () => {
    expect(parseRoute("")).toEqual(HOME_ROUTE);
    expect(parseRoute("#/")).toEqual(HOME_ROUTE);
    expect(parseRoute("#/nothing/here")).toEqual(HOME_ROUTE);
    expect(resolveHome(HOME_ROUTE, "sepolia-pls943")).toEqual({ name: "pair", pairId: "sepolia-pls943", token: null });
    const audit: Route = { name: "audit" };
    expect(resolveHome(audit, "sepolia-pls943")).toBe(audit);
  });

  it("writes the home route as the bare hash", () => {
    expect(formatRoute(HOME_ROUTE)).toBe("#/");
    expect(routeTitle(HOME_ROUTE)).toBe("Pair view");
  });

  it("drops an empty address filter", () => {
    expect(parseRoute("#/pair/eth-pls?address=")).toEqual({ name: "pair", pairId: "eth-pls", token: null });
    expect(formatRoute({ name: "pair", pairId: "eth-pls", token: null, view: { address: "" } })).toBe("#/pair/eth-pls");
  });

  it("keeps the table of all pairs at its own address, never at the landing", () => {
    expect(formatRoute({ name: "global" })).toBe("#/pairs");
    expect(parseRoute("#/pairs")).toEqual({ name: "global" });
  });

  it("writes only what differs from the default pair view, so a default link stays short", () => {
    expect(formatRoute({ name: "pair", pairId: "eth-pls", token: null, view: { rows: 50 } })).toBe("#/pair/eth-pls");
    expect(parseRoute("#/pair/eth-pls?rows=50")).toEqual({ name: "pair", pairId: "eth-pls", token: null });
  });

  it("drops or clamps a pair view value that a crafted link puts in", () => {
    expect(parseRoute("#/pair/eth-pls?direction=sideways&kind=x&status=stolen&range=1y&address=0xnothex")).toEqual({ name: "pair", pairId: "eth-pls", token: null });
    expect(parseRoute("#/pair/eth-pls?rows=99999")).toEqual({ name: "pair", pairId: "eth-pls", token: null, view: { rows: 1000 } });
    expect(parseRoute("#/pair/eth-pls?rows=70")).toEqual({ name: "pair", pairId: "eth-pls", token: null, view: { rows: 100 } });
    expect(parseRoute("#/pair/eth-pls?rows=-5")).toEqual({ name: "pair", pairId: "eth-pls", token: null });
  });

  it("keeps the history scan depth in the address, and refuses a depth that is not a multiple of the default", () => {
    expect(parseRoute("#/history?scan=400000")).toEqual({ name: "history", filters: EMPTY_HISTORY_FILTERS, scanBlocks: 400_000n });
    expect(parseRoute("#/history?scan=12345")).toEqual({ name: "history", filters: EMPTY_HISTORY_FILTERS });
    expect(parseRoute("#/history?scan=800000000")).toEqual({ name: "history", filters: EMPTY_HISTORY_FILTERS, scanBlocks: 20_000_000n });
    expect(formatRoute({ name: "history", filters: { ...EMPTY_HISTORY_FILTERS, chain: 369 }, scanBlocks: 400_000n })).toBe("#/history?chain=369&scan=400000");
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
    expect(routeTitle({ name: "history", filters: EMPTY_HISTORY_FILTERS })).toBe("History");
  });
});

describe("the dialog in the address", () => {
  const overlays: readonly Overlay[] = [
    NO_OVERLAY,
    { ...NO_OVERLAY, dialog: "settings" },
    { ...NO_OVERLAY, dialog: "bridge" },
    {
      ...NO_OVERLAY,
      dialog: "bridge",
      bridge: {
        token: `second:${ADDRESS}`,
        amount: "1.5",
        receiver: ADDRESS,
        mode: "call",
        data: "0xabcd",
        gasLimit: "300000",
        callTarget: ADDRESS,
        callData: "0x12",
        tip: { mode: "fixed", fixedText: "2", marginPercentText: "15", percentText: "1", gasMultiplierText: "1.2", ceilingGweiText: "40", senderPriceText: "3000", routerText: ADDRESS, payoutNative: true },
      },
    },
    { ...NO_OVERLAY, dialog: "wrap", bridge: { token: "first:native", amount: "0.25" } },
    { ...NO_OVERLAY, dialog: "bridge", bridge: { tip: { mode: "none" } } },
    { ...NO_OVERLAY, dialog: "message" },
    { ...NO_OVERLAY, dialog: "message", message: { chain: "second", target: ADDRESS, data: "0x", gas: "250000" } },
  ];

  it.each(overlays.map((overlay) => [formatLocation({ route: { name: "pair", pairId: "eth-pls", token: null }, overlay }), overlay] as const))(
    "survives a round trip over the pair view: %s",
    (hash, overlay) => {
      expect(parseLocation(hash)).toEqual({ route: { name: "pair", pairId: "eth-pls", token: null }, overlay });
    },
  );

  it("follows the view's own query, and never disturbs the history filters", () => {
    const route: Route = { name: "history", filters: { ...EMPTY_HISTORY_FILTERS, chain: 369 } };
    const overlay: Overlay = { ...NO_OVERLAY, dialog: "message", message: { target: "0x12" } };
    const hash = formatLocation({ route, overlay });
    expect(hash).toBe("#/history?chain=369&dialog=message&msg.target=0x12");
    expect(parseLocation(hash)).toEqual({ route, overlay });
    expect(formatLocation({ route: { name: "audit" }, overlay: { ...NO_OVERLAY, dialog: "settings" } })).toBe("#/audit?dialog=settings");
  });

  it("reads a form's fields only for its own dialog", () => {
    expect(parseOverlay("#/?dialog=message&bridge.amount=5&msg.gas=1")).toEqual({ ...NO_OVERLAY, dialog: "message", message: { gas: "1" } });
    expect(parseOverlay("#/?bridge.amount=5")).toEqual(NO_OVERLAY);
    expect(parseOverlay("#/?dialog=wallet-drain")).toEqual(NO_OVERLAY);
  });

  it("drops every field of the wrong shape, so a crafted link cannot prefill garbage", () => {
    const hash = "#/?dialog=bridge&bridge.token=first:evil&bridge.amount=1e18&bridge.receiver=attacker&bridge.mode=drain&bridge.data=zz&bridge.gas=-1"
      + "&bridge.callTarget=0x12345678901234567890123456789012345678901&tip.mode=all&tip.router=nope&tip.native=yes";
    expect(parseOverlay(hash)).toEqual({ ...NO_OVERLAY, dialog: "bridge" });
    expect(parseOverlay(`#/?dialog=bridge&bridge.data=0x${"a".repeat(30_000)}`)).toEqual({ ...NO_OVERLAY, dialog: "bridge" });
  });

  it("names every field a link filled in that moves or spends funds, and not the user's own account", () => {
    const overlay: Overlay = { ...NO_OVERLAY, dialog: "bridge", bridge: { amount: "1", receiver: ADDRESS, callTarget: ADDRESS, callData: "0x1", data: "0x2", tip: { routerText: ADDRESS } } };
    expect(linkedFields(overlay, null)).toEqual(["amount", "receiver", "call target", "call data", "data for the receiver", "relay router"]);
    expect(linkedFields(overlay, ADDRESS.toLowerCase())).not.toContain("receiver");
    expect(linkedFields({ ...NO_OVERLAY, dialog: "message", message: { target: ADDRESS, data: "0x1", gas: "9" } }, null)).toEqual(["target contract", "message data", "gas for the call"]);
    expect(linkedFields({ ...NO_OVERLAY, dialog: "bridge", bridge: { token: "first:native", gasLimit: "9", mode: "call" } }, null)).toEqual(["token", "kind of transfer", "gas for the call"]);
    expect(linkedFields({ ...NO_OVERLAY, dialog: "bridge", bridge: {} }, null)).toEqual([]);
  });

  it("names every tip setting a link filled in, since each one changes what the sender pays", () => {
    const tip = { mode: "fixed", percentText: "50", fixedText: "9", marginPercentText: "90", gasMultiplierText: "9", ceilingGweiText: "999", senderPriceText: "9", payoutNative: true } as const;
    expect(linkedFields({ ...NO_OVERLAY, dialog: "bridge", bridge: { tip } }, null)).toEqual([
      "tip kind", "tip percentage", "fixed tip", "tip margin", "tip gas multiplier", "gas price ceiling", "sender gas price", "tip paid in the native coin",
    ]);
  });
});
