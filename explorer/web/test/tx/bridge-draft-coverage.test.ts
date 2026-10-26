import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { defaultTip, FEE_SETTING } from "@zk-bridge/shared";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS, type DeliveryOptions } from "../../src/tx/bridge-draft";
import type { BridgeFormValues } from "../../src/tx/bridge-steps";
import { buildDeliveryReport, buildFixtureContext } from "../helpers";

const usdc = FIXTURE_TOKENS[0]!;
const receiver = getAddress(`0x${"cd".repeat(20)}`);
const values = (overrides: Partial<BridgeFormValues> = {}): BridgeFormValues => ({ token: `first:${usdc.address}`, amount: "100", receiver, mode: "plain", data: "", fallback: "", ...overrides });
const options = (overrides: Partial<DeliveryOptions> = {}): DeliveryOptions => ({ ...DEFAULT_DELIVERY_OPTIONS, ...overrides });

const data = async (overrides: { readonly report?: ReturnType<typeof buildDeliveryReport> | null; readonly priorityFeeWei?: bigint | null } = {}) => {
  const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
  return {
    pair: FIXTURE_PAIR,
    tokens,
    context,
    report: overrides.report === undefined ? buildDeliveryReport(369) : overrides.report,
    priorityFeeWei: overrides.priorityFeeWei === undefined ? 10n ** 9n : overrides.priorityFeeWei,
  };
};

describe("computeBridgeDraft: the token and the amount", () => {
  it("asks for a token when none is chosen", async () => {
    expect(computeBridgeDraft(values({ token: "" }), DEFAULT_DELIVERY_OPTIONS, await data())).toMatchObject({ status: "incomplete", reason: "Choose a token.", steps: [] });
  });

  it("asks for a token when the choice names a token that the list does not hold", async () => {
    const unknown = `first:0x${"99".repeat(20)}`;
    expect(computeBridgeDraft(values({ token: unknown }), DEFAULT_DELIVERY_OPTIONS, await data())).toMatchObject({ status: "incomplete", reason: "Choose a token." });
  });

  it("blocks an amount of zero", async () => {
    expect(computeBridgeDraft(values({ amount: "0" }), DEFAULT_DELIVERY_OPTIONS, await data())).toMatchObject({ status: "blocked", reason: "The amount must be above zero." });
  });

  it("says that the balances load when no chain snapshot is ready", async () => {
    const loaded = await data();
    const loading = { ...loaded, context: { ...loaded.context, snapshots: null } };
    const draft = computeBridgeDraft(values(), DEFAULT_DELIVERY_OPTIONS, loading);
    expect(draft.status).toBe("incomplete");
    expect(draft.reason).toBe("The balances and fee rates of both chains are loading. Check the RPC URLs if this stays.");
    expect(draft.bridgeFees).toBeNull();
  });

  it("says that the balances load when the snapshot of the other chain failed", async () => {
    const loaded = await data();
    const [first, second] = loaded.context.snapshots!;
    const failed = { status: "error" as const, chain: FIXTURE_PAIR.second, message: "endpoint down" };
    expect(first!.status).toBe("ok");
    expect(second!.status).toBe("ok");
    const draft = computeBridgeDraft(values(), DEFAULT_DELIVERY_OPTIONS, { ...loaded, context: { ...loaded.context, snapshots: [first!, failed] } });
    expect(draft.status).toBe("incomplete");
    expect(draft.reason).toMatch(/are loading/);
  });

  it("throws, and does not blame the user, when a token has a decimals value that no token can have", async () => {
    const loaded = await data();
    const broken = loaded.tokens.map((token) => (token.address === usdc.address ? { ...token, decimals: 256 } : token));
    expect(() => computeBridgeDraft(values(), DEFAULT_DELIVERY_OPTIONS, { ...loaded, tokens: broken })).toThrow(RangeError);
  });
});

describe("computeBridgeDraft: the tip inputs", () => {
  it("takes the default percentage when the percentage field is empty", async () => {
    const draft = computeBridgeDraft(values(), options({ percentText: "  " }), await data());
    expect(draft.delivery?.director).toEqual(defaultTip(receiver));
  });

  it.each([
    ["the margin", { marginPercentText: "ten" }, "The margin must be a percentage such as 10."],
    ["the gas multiplier text", { gasMultiplierText: "fast" }, "The gas multiplier must be a number above zero, such as 1.2."],
    ["a gas multiplier of zero", { gasMultiplierText: "0" }, "The gas multiplier must be a number above zero, such as 1.2."],
    ["the ceiling", { ceilingGweiText: "high" }, "The ceiling must be a number of gwei."],
    ["the fixed amount", { fixedText: "1.1234567" }, "The fixed amount must be a number with at most 6 fraction digits."],
  ] as const)("blocks the draft and names the problem with %s", async (_name, change, sentence) => {
    const draft = computeBridgeDraft(values(), options(change), await data());
    expect(draft).toMatchObject({ status: "blocked", reason: sentence, deliveryProblem: sentence });
    expect(draft.steps).toEqual([]);
  });

  it("accepts a ceiling in gwei and sends it to the selection", async () => {
    const draft = computeBridgeDraft(values(), options({ ceilingGweiText: "50" }), await data());
    expect(draft.status).toBe("ready");
    expect(draft.delivery?.baseFeeCeilingWei).toBe(50n * 10n ** 9n);
  });

  it("waits for the priority fee before it builds a tip", async () => {
    const draft = computeBridgeDraft(values(), DEFAULT_DELIVERY_OPTIONS, await data({ priorityFeeWei: null }));
    expect(draft).toMatchObject({ status: "blocked", reason: "The priority fee of the destination chain has not loaded yet.", delivery: null });
  });

  it("asks for the receiver before it builds a tip when the receiver is not an address", async () => {
    const draft = computeBridgeDraft(values({ receiver: "0x1234" }), DEFAULT_DELIVERY_OPTIONS, await data());
    expect(draft).toMatchObject({ status: "blocked", reason: "Enter the receiver first.", deliveryProblem: "Enter the receiver first." });
  });

  it("passes the reason of the selection when the percentage is above one hundred percent", async () => {
    const draft = computeBridgeDraft(values(), options({ percentText: "101" }), await data());
    expect(draft).toMatchObject({ status: "blocked", reason: "The percentage is above 100 percent." });
  });

  it("blocks with the message of the planner when the tip is valid but the transfer is not", async () => {
    const draft = computeBridgeDraft(values({ amount: "99999999" }), options({ mode: "none" }), await data());
    expect(draft.status).toBe("blocked");
    expect(draft.reason).toMatch(/more than your USDC balance/);
    expect(draft.delivery).toBeNull();
    expect(draft.bridgeFees).not.toBeNull();
  });
});

describe("computeBridgeDraft: the payout and the failures of the planner", () => {
  it("asks for the native coin when the user wants it and the destination token is the wrapped native token", async () => {
    const weth = FIXTURE_TOKENS[2]!;
    const { context } = await buildFixtureContext({ allowance: 10n ** 12n });
    const wrappedOnSecond = FIXTURE_PAIR.second.contracts.wrappedNative!;
    const tokens = [
      { ...weth, counterpart: wrappedOnSecond },
      { address: wrappedOnSecond, symbol: "WPLS", decimals: 18, side: "second" as const, counterpart: weth.address },
    ];
    const wrapped = { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n };
    const form = values({ token: `first:${weth.address}`, amount: "2" });
    const native = computeBridgeDraft(form, options({ payoutNative: true }), wrapped);
    const plain = computeBridgeDraft(form, options({ payoutNative: false }), wrapped);
    expect(native.delivery!.director.settings & FEE_SETTING.unwrap).toBe(FEE_SETTING.unwrap);
    expect(plain.delivery!.director.settings & FEE_SETTING.unwrap).toBe(0n);
  });

  // This test records what the code does today. A fixed tip above the range of the director makes the encoder throw,
  // and the draft passes the throw on. The page should show a sentence instead. The report of this work lists the defect.
  it("passes on the failure of the encoder when a fixed tip is above the range of the director", async () => {
    const huge = `1${"0".repeat(80)}`;
    const loaded = await data();
    expect(() => computeBridgeDraft(values(), options({ mode: "fixed", fixedText: huge }), loaded)).toThrow(/not in safe 256-bit unsigned integer range/);
  });
});
