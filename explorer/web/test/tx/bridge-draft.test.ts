import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { decodeFeeDirector, defaultTip, encodeFeeDirector, feeModeOf, tokenMediatorAbi } from "@zk-bridge/shared";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS, tipStatusOf, type DeliveryOptions } from "../../src/tx/bridge-draft";
import type { BridgeFormValues } from "../../src/tx/bridge-steps";
import { buildDeliveryReport, buildFixtureContext } from "../helpers";

const usdc = FIXTURE_TOKENS[0]!;
const weth = FIXTURE_TOKENS[2]!;
const receiver = getAddress(`0x${"cd".repeat(20)}`);
const feeRouter = getAddress(FIXTURE_PAIR.second.contracts.feeRouter!);
const values = (overrides: Partial<BridgeFormValues> = {}): BridgeFormValues => ({ token: `first:${usdc.address}`, amount: "100", receiver, mode: "plain", data: "", fallback: "", ...overrides });
const options = (overrides: Partial<DeliveryOptions> = {}): DeliveryOptions => ({ ...DEFAULT_DELIVERY_OPTIONS, ...overrides });

const data = async (overrides: { readonly report?: ReturnType<typeof buildDeliveryReport> | null; readonly priorityFeeWei?: bigint | null; readonly valuations?: Record<string, bigint> } = {}) => {
  const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
  return {
    pair: FIXTURE_PAIR,
    tokens,
    context: overrides.valuations === undefined ? context : { ...context, tokenValuationsWei: overrides.valuations },
    report: overrides.report === undefined ? buildDeliveryReport(369) : overrides.report,
    priorityFeeWei: overrides.priorityFeeWei === undefined ? 10n ** 9n : overrides.priorityFeeWei,
  };
};

/** WETH on Ethereum arrives on PulseChain as the wrapped native token, which is worth one coin per token. */
const wrappedData = async () => {
  const { context } = await buildFixtureContext({ allowance: 10n ** 12n });
  const wrappedOnSecond = FIXTURE_PAIR.second.contracts.wrappedNative!;
  const tokens = [
    { ...weth, counterpart: wrappedOnSecond },
    { address: wrappedOnSecond, symbol: "WPLS", decimals: 18, side: "second" as const, counterpart: weth.address },
  ];
  return { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n };
};

describe("computeBridgeDraft", () => {
  it("is incomplete until an amount is typed, and says what to do", async () => {
    const draft = computeBridgeDraft(values({ amount: "" }), DEFAULT_DELIVERY_OPTIONS, await data());
    expect(draft).toMatchObject({ status: "incomplete", reason: "Enter an amount." });
  });

  it("shows the exact bridge fee as soon as the amount is valid, before the receiver is typed", async () => {
    const draft = computeBridgeDraft(values({ receiver: "" }), DEFAULT_DELIVERY_OPTIONS, await data());
    expect(draft.status).toBe("incomplete");
    expect(draft.bridgeFees?.sourceFee).toBe(100_000n);
  });

  it("blocks an amount with too many fraction digits and an amount above the balance", async () => {
    expect(computeBridgeDraft(values({ amount: "1.1234567" }), DEFAULT_DELIVERY_OPTIONS, await data()).status).toBe("blocked");
    const above = computeBridgeDraft(values({ amount: "99999999" }), DEFAULT_DELIVERY_OPTIONS, await data());
    expect(above).toMatchObject({ status: "blocked" });
    expect(above.reason).toMatch(/more than your USDC balance/);
  });
});

describe("the default tip", () => {
  it("is on with no choice from the user: 0.1 percent of the transfer, to the receiver, through the fee router of the deployment", async () => {
    expect(DEFAULT_DELIVERY_OPTIONS.mode).toBe("percentage");
    expect(DEFAULT_DELIVERY_OPTIONS.percentText).toBe("0.1");
    const draft = computeBridgeDraft(values(), DEFAULT_DELIVERY_OPTIONS, await data());
    expect(draft.status).toBe("ready");
    expect(draft.tip?.kind).toBe("on");
    expect(draft.delivery?.director).toEqual(defaultTip(receiver));
    expect(draft.delivery?.description.certainty).toBe("exact");
    const relay = draft.steps.at(-1)!;
    expect(relay.disclosure.delivery).toBe(draft.delivery);
    const decoded = decodeFunctionData({ abi: tokenMediatorAbi, data: relay.plan.data });
    expect(decoded.functionName).toBe("relayTokensAndCall");
    expect(getAddress(decoded.args![1] as string)).toBe(feeRouter);
    expect(decodeFeeDirector(decoded.args![3] as `0x${string}`)).toEqual(defaultTip(receiver));
  });

  it("needs no price: a token with no known value still gets its tip, with no cost lines", async () => {
    const draft = computeBridgeDraft(values(), DEFAULT_DELIVERY_OPTIONS, await data());
    expect(draft.defaultSenderPriceText).toBe("");
    expect(draft.delivery?.description.breakdown).toEqual([]);
  });

  it("takes the percentage that the user types", async () => {
    const draft = computeBridgeDraft(values(), options({ percentText: "0.5" }), await data());
    expect(draft.delivery?.director.multiplier).toBe(5n * 10n ** 15n);
    expect(computeBridgeDraft(values(), options({ percentText: "abc" }), await data())).toMatchObject({ status: "blocked", reason: expect.stringContaining("percentage") });
  });

  it("waits for the report, and says that No tip is the way out, instead of showing a tip", async () => {
    const draft = computeBridgeDraft(values(), DEFAULT_DELIVERY_OPTIONS, await data({ report: null }));
    expect(draft).toMatchObject({ status: "blocked", deliveryProblem: expect.stringContaining("has not loaded") });
    expect(draft.reason).toMatch(/choose No tip/);
    expect(draft.steps).toEqual([]);
  });
});

describe("No tip", () => {
  it("sends a plain relay: no call data, no router, no delivery", async () => {
    const draft = computeBridgeDraft(values(), options({ mode: "none" }), await data({ report: null }));
    expect(draft.status).toBe("ready");
    expect(draft.tip?.kind).toBe("off");
    expect(draft.delivery).toBeNull();
    const decoded = decodeFunctionData({ abi: tokenMediatorAbi, data: draft.steps.at(-1)!.plan.data });
    expect(decoded.functionName).toBe("relayTokens");
    expect(getAddress(decoded.args![1] as string)).toBe(receiver);
  });
});

describe("No tip means no router at all", () => {
  it("builds calldata that names no router and holds no fee director, for a plain relay and for a relay with a fallback", async () => {
    const forms = [values(), values({ mode: "fallback", data: "0x", fallback: receiver })];
    for (const form of forms) {
      const draft = computeBridgeDraft(form, options({ mode: "none" }), await data());
      const relay = draft.steps.at(-1)!.plan;
      expect(draft.delivery).toBeNull();
      expect(["relayTokens", "relayTokensWithFallback"]).toContain(relay.functionName);
      expect(relay.data.toLowerCase()).not.toContain(feeRouter.slice(2).toLowerCase());
      expect(relay.data).not.toContain(encodeFeeDirector(defaultTip(receiver)).slice(2));
      const decoded = decodeFunctionData({ abi: tokenMediatorAbi, data: relay.data });
      expect(getAddress(decoded.args![1] as string)).toBe(receiver);
    }
  });

  it("keeps the router field out of the calldata even when a router is typed", async () => {
    const other = getAddress(`0x${"ee".repeat(20)}`);
    const draft = computeBridgeDraft(values(), options({ mode: "none", routerText: other }), await data());
    expect(draft.steps.at(-1)!.plan.data.toLowerCase()).not.toContain(other.slice(2).toLowerCase());
    expect(draft.steps.at(-1)!.plan.functionName).toBe("relayTokens");
  });
});

describe("when no tip can travel", () => {
  it("sends a plain relay on the wrap route, and says why", async () => {
    const draft = computeBridgeDraft(values({ token: "first:native", amount: "1" }), DEFAULT_DELIVERY_OPTIONS, await data());
    expect(draft.status).toBe("ready");
    expect(draft.tip).toMatchObject({ kind: "unavailable", reason: expect.stringMatching(/wrap route carries no call data.*plain relay, with no tip/) });
    expect(draft.delivery).toBeNull();
    expect(draft.steps.at(-1)!.plan.functionName).toBe("wrapAndRelayTokens");
  });

  it("sends a plain relay toward a chain with no fee router, and says why", async () => {
    const wpls = FIXTURE_TOKENS.find((token) => token.symbol === "WPLS")!;
    const draft = computeBridgeDraft(values({ token: `second:${wpls.address}`, amount: "1" }), DEFAULT_DELIVERY_OPTIONS, await data());
    expect(draft.status).toBe("ready");
    expect(draft.tip).toMatchObject({ kind: "unavailable", reason: expect.stringMatching(/no fee router for Ethereum.*plain relay, with no tip/) });
    expect(draft.steps.at(-1)!.plan.functionName).toBe("relayTokens");
  });
});

describe("the price field", () => {
  it("defaults from the valuation: one wrapped native token is worth one coin, so the price is 1", async () => {
    const draft = computeBridgeDraft(values({ token: `first:${weth.address}`, amount: "2" }), DEFAULT_DELIVERY_OPTIONS, await wrappedData());
    expect(draft.defaultSenderPriceText).toBe("1");
    expect(draft.delivery?.description.breakdown.map((line) => line.id)).toEqual(["gas", "proof", "margin"]);
  });

  it("defaults from a configured valuation of another token", async () => {
    // One whole zkbUSDC is worth 1/3000 of a coin, so one coin is worth 3000 zkbUSDC.
    const draft = computeBridgeDraft(values(), DEFAULT_DELIVERY_OPTIONS, await data({ valuations: { [FIXTURE_TOKENS[1]!.address.toLowerCase()]: 10n ** 18n / 3_000n } }));
    expect(draft.defaultSenderPriceText).toBe("3000");
  });

  it("offers the gas multiplier for any token, and prices it with the price that the user types", async () => {
    const withoutPrice = computeBridgeDraft(values(), options({ mode: "gas-multiplier" }), await data());
    expect(withoutPrice).toMatchObject({ status: "blocked", reason: expect.stringContaining("Enter your coin price") });
    const priced = computeBridgeDraft(values(), options({ mode: "gas-multiplier", senderPriceText: "3000" }), await data());
    expect(priced.status).toBe("ready");
    expect(priced.delivery?.description.certaintyLabel).toMatch(/^estimate, at most [\d.]+ zkbUSDC$/);
    const cheaper = computeBridgeDraft(values(), options({ mode: "gas-multiplier", senderPriceText: "1500" }), await data());
    expect(priced.delivery!.director.multiplier).toBe(cheaper.delivery!.director.multiplier * 2n);
  });

  it("refuses a price that is not a number above zero", async () => {
    for (const text of ["0", "abc", "-1"]) {
      const draft = computeBridgeDraft(values(), options({ senderPriceText: text }), await data());
      expect(draft).toMatchObject({ status: "blocked", reason: expect.stringContaining("Your coin price must be a number above zero") });
    }
  });
});

describe("the router field", () => {
  it("defaults to the fee router of the deployment on the destination chain", async () => {
    const draft = computeBridgeDraft(values(), DEFAULT_DELIVERY_OPTIONS, await data());
    expect(draft.tip?.kind === "on" && draft.tip.target.router).toBe(feeRouter);
    expect(draft.delivery).toMatchObject({ router: feeRouter, defaultRouter: feeRouter });
  });

  it("sends the relay to the router that the user names, and keeps the router of the deployment to mark the difference", async () => {
    const other = getAddress(`0x${"ee".repeat(20)}`);
    const draft = computeBridgeDraft(values(), options({ routerText: other }), await data());
    expect(draft.status).toBe("ready");
    expect(draft.delivery).toMatchObject({ router: other, defaultRouter: feeRouter });
    const decoded = decodeFunctionData({ abi: tokenMediatorAbi, data: draft.steps.at(-1)!.plan.data });
    expect(getAddress(decoded.args![1] as string)).toBe(other);
    expect(draft.steps.at(-1)!.plan.arguments.find((argument) => argument.name === "receiver")?.meaning).toMatch(/not the fee router of the deployment/);
  });

  it("refuses text that is not an address", async () => {
    const draft = computeBridgeDraft(values(), options({ routerText: "0x1234" }), await data());
    expect(draft).toMatchObject({ status: "blocked", reason: expect.stringContaining("router must be an address") });
  });
});

describe("the modes", () => {
  it("builds a gas based estimate with a maximum for the wrapped native token", async () => {
    const draft = computeBridgeDraft(values({ token: `first:${weth.address}`, amount: "2" }), options({ mode: "gas-multiplier" }), await wrappedData());
    expect(feeModeOf(draft.delivery!.director.settings)).toBe("gas");
    expect(draft.delivery?.description.certaintyLabel).toMatch(/^estimate, at most /);
  });

  it("builds a fixed tip from the suggestion when a price is known, and from the typed amount otherwise", async () => {
    const typed = computeBridgeDraft(values(), options({ mode: "fixed", fixedText: "0.5" }), await data());
    expect(typed.delivery?.director.limit).toBe(500_000n);
    const noPrice = computeBridgeDraft(values(), options({ mode: "fixed" }), await data());
    expect(noPrice).toMatchObject({ status: "blocked", reason: expect.stringContaining("Enter your coin price") });
    const priced = computeBridgeDraft(values(), options({ mode: "fixed", senderPriceText: "3000" }), await data());
    expect(priced.status).toBe("ready");
  });
});

describe("tipStatusOf", () => {
  it("is on by default, off for No tip, and unavailable on the wrap route even for No tip", async () => {
    const { pair, tokens } = await data();
    const base = { pair, tokens, valuations: {} };
    expect(tipStatusOf({ ...base, values: values(), options: DEFAULT_DELIVERY_OPTIONS }).kind).toBe("on");
    expect(tipStatusOf({ ...base, values: values(), options: options({ mode: "none" }) }).kind).toBe("off");
    expect(tipStatusOf({ ...base, values: values({ token: "first:native" }), options: options({ mode: "none" }) }).kind).toBe("unavailable");
  });
});
