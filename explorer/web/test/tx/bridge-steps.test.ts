import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import { DEFAULT_GAS_MARGIN, decodeFeeDirector, encodeFeeDirector, feeModeOf, senderPriceOfToken, settingsOf, tokenMediatorAbi, wETHOmnibridgeRouterAbi } from "@zk-bridge/shared";
import { buildBridgeSteps } from "@terminal/app/actions";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { PlanInputError, planClaim, planSendMessage, planWrapAndRelay } from "@terminal/tx/plan";
import { planBridgeSteps, type BridgeFormValues } from "../../src/tx/bridge-steps";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS, type DeliveryOptions } from "../../src/tx/bridge-draft";
import { selectDelivery, DEFAULT_MARGIN_RATE } from "../../src/tx/delivery-selection";
import { buildDeliveryReport, buildFixtureContext } from "../helpers";

const usdc = FIXTURE_TOKENS[0]!;
const receiver = getAddress(`0x${"cd".repeat(20)}`);
const deliveryRouter = FIXTURE_PAIR.second.contracts.deliveryRouter!;

const values = (overrides: Partial<BridgeFormValues> = {}): BridgeFormValues => ({
  token: `first:${usdc.address}`,
  amount: "250",
  receiver,
  mode: "plain",
  data: "",
  fallback: "",
  ...overrides,
});

const ROUTERS = { router: deliveryRouter, defaultRouter: deliveryRouter } as const;
const WRAPPED_PRICE = senderPriceOfToken({ tokenValueInWei: 10n ** 18n, tokenDecimals: 18 });

const deliveryFor = (mode: "percentage" | "gas-multiplier" | "fixed" = "percentage") => {
  const selection = selectDelivery(
    {
      mode,
      recipient: receiver,
      transferValue: 250_000_000n,
      transferValueAtMost: 250_000_000n,
      token: { symbol: "zkbUSDC", decimals: 6 },
      tokenValueInWei: 10n ** 18n,
      senderPrice: mode === "gas-multiplier" ? { numerator: 3_000n * 10n ** 6n, denominator: 10n ** 18n } : WRAPPED_PRICE,
      payout: "token",
      report: buildDeliveryReport(369),
      priorityFeeWei: 10n ** 9n,
      percentageRate: 10n ** 15n,
      fixedAmount: null,
      marginRate: DEFAULT_MARGIN_RATE,
      gasMargin: DEFAULT_GAS_MARGIN,
      destinationName: "PulseChain",
      baseFeeCeilingWei: null,
    },
    ROUTERS,
  );
  if (selection.kind !== "available") throw new Error(selection.reason);
  return selection;
};

describe("planBridgeSteps without a delivery fee: calldata equals what the terminal builds", () => {
  it("builds the same steps as the terminal for the same inputs, byte for byte", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    for (const form of [values(), values({ mode: "call", data: "0xabcd" }), values({ mode: "fallback", data: "0x", fallback: FIXTURE_ACCOUNT })]) {
      const web = planBridgeSteps({ values: form, tokens, context, delivery: null });
      const terminal = buildBridgeSteps({ ...form }, tokens, context);
      expect(web.map((step) => step.plan.data)).toEqual(terminal.map((step) => step.plan.data));
      expect(web.map((step) => step.plan.to)).toEqual(terminal.map((step) => step.plan.to));
    }
  });

  it("matches an independent encoding against the shared ABI of the mediator", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const amount = parseUnits("250", 6);
    const [relay] = planBridgeSteps({ values: values(), tokens, context, delivery: null });
    expect(relay!.plan.data).toBe(encodeFunctionData({ abi: tokenMediatorAbi, functionName: "relayTokens", args: [usdc.address, receiver, amount] }));
    const [call] = planBridgeSteps({ values: values({ mode: "call", data: "0xabcd" }), tokens, context, delivery: null });
    expect(call!.plan.data).toBe(encodeFunctionData({ abi: tokenMediatorAbi, functionName: "relayTokensAndCall", args: [usdc.address, receiver, amount, "0xabcd"] }));
    const [fallback] = planBridgeSteps({ values: values({ mode: "fallback", data: "0xabcd", fallback: FIXTURE_ACCOUNT }), tokens, context, delivery: null });
    expect(fallback!.plan.data).toBe(
      encodeFunctionData({ abi: tokenMediatorAbi, functionName: "relayTokensWithFallback", args: [usdc.address, receiver, amount, "0xabcd", FIXTURE_ACCOUNT] }),
    );
  });

  it("puts an exact allowance first when the allowance is too low, and never an unlimited one", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 0n });
    const steps = planBridgeSteps({ values: values(), tokens, context, delivery: null });
    expect(steps).toHaveLength(2);
    expect(steps[0]!.plan.data).toBe(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [FIXTURE_PAIR.first.contracts.tokenMediator, parseUnits("250", 6)] }));
    // The allowance names the relay that follows, so the user sees what the tip belongs to before the first signature.
    expect(steps[0]!.disclosure.feesApplyTo).toBe("next-transaction");
    expect(steps[1]!.disclosure.feesApplyTo).toBe("this-transaction");
  });

  it("wraps the native coin through the router exactly as the terminal plan does", async () => {
    const { context, tokens } = await buildFixtureContext();
    const [step] = planBridgeSteps({ values: values({ token: "first:native", amount: "1.5" }), tokens, context, delivery: null });
    const expected = planWrapAndRelay({ chain: FIXTURE_PAIR.first, receiver, value: parseUnits("1.5", 18) });
    expect(step!.plan.data).toBe(expected.data);
    expect(step!.plan.value).toBe(parseUnits("1.5", 18));
    expect(step!.plan.data).toBe(encodeFunctionData({ abi: wETHOmnibridgeRouterAbi, functionName: "wrapAndRelayTokens", args: [receiver] }));
  });

  it("refuses an amount above the balance, with a sentence", async () => {
    const { context, tokens } = await buildFixtureContext();
    expect(() => planBridgeSteps({ values: values({ amount: "999999" }), tokens, context, delivery: null })).toThrow(/more than your USDC balance/);
  });
});

describe("planBridgeSteps with a tip", () => {
  it("sends the tokens to the delivery router with the encoded fee director as call data", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const delivery = deliveryFor("percentage");
    const [relay] = planBridgeSteps({ values: values(), tokens, context, delivery });
    expect(relay!.plan.data).toBe(
      encodeFunctionData({ abi: tokenMediatorAbi, functionName: "relayTokensAndCall", args: [usdc.address, deliveryRouter, parseUnits("250", 6), encodeFeeDirector(delivery.director, { router: deliveryRouter, protectedAddresses: [], destinationToken: usdc.counterpart, destinationWrappedNative: FIXTURE_PAIR.second.contracts.wrappedNative })] }),
    );
    const decoded = decodeFunctionData({ abi: tokenMediatorAbi, data: relay!.plan.data });
    const director = decodeFeeDirector(decoded.args![3] as `0x${string}`);
    expect(director).toEqual(delivery.director);
    expect(director.recipient.toLowerCase()).toBe(receiver.toLowerCase());
    expect(feeModeOf(director.settings)).toBe("share");
    expect(relay!.disclosure.delivery).toBe(delivery);
  });

  it("explains in the arguments that the receiver is the delivery router, and that the tip goes to its reward address", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const [relay] = planBridgeSteps({ values: values(), tokens, context, delivery: deliveryFor() });
    const argument = relay!.plan.arguments.find((candidate) => candidate.name === "receiver");
    expect(argument?.meaning).toMatch(/^delivery router on PulseChain: pays the tip to its reward address/);
  });

  it("marks a router that is not the default delivery router", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const other = getAddress(`0x${"ee".repeat(20)}`);
    const delivery = { ...deliveryFor(), router: other };
    const [relay] = planBridgeSteps({ values: values(), tokens, context, delivery });
    expect(relay!.plan.arguments.find((candidate) => candidate.name === "receiver")?.meaning).toMatch(/^router \(not the default delivery router\) on PulseChain/);
    expect(getAddress(decodeFunctionData({ abi: tokenMediatorAbi, data: relay!.plan.data }).args![1] as string)).toBe(other);
  });

  it("refuses a hand written unwrap request for a token that is not the wrapped native token", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const base = deliveryFor();
    const delivery = { ...base, director: { ...base.director, settings: settingsOf({ mode: "share", payout: "native" }) } };
    expect(() => planBridgeSteps({ values: values(), tokens, context, delivery })).toThrow(/unwrapping works only for the wrapped native token/);
  });

  it("refuses a tip on the wrap route, which carries no call data", async () => {
    const { context, tokens } = await buildFixtureContext();
    expect(() => planBridgeSteps({ values: values({ token: "first:native", amount: "2" }), tokens, context, delivery: deliveryFor() })).toThrow(/wrap route carries no call data/);
  });
});

describe("calldata parity with the terminal for a tipped relay", () => {
  const terminalValues = (extra: Record<string, string>): Record<string, string> => ({ ...values(), amount: "250", delivery: "yes", ...extra });
  const terminalContext = async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    // Three thousand zkbUSDC for one coin: one whole zkbUSDC is worth 10^18 * 10^6 / (3000 * 10^6) wei, rounded down.
    const valuation = (10n ** 18n * 10n ** 6n) / (3_000n * 10n ** 6n);
    return { tokens, context: { ...context, deliveryCost: buildDeliveryReport(369), tokenValuationsWei: { [FIXTURE_TOKENS[1]!.address.toLowerCase()]: valuation } } };
  };
  const webSteps = async (options: Partial<DeliveryOptions>) => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const draft = computeBridgeDraft(values({ amount: "250" }), { ...DEFAULT_DELIVERY_OPTIONS, senderPriceText: "3000", ...options }, { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n });
    if (draft.status !== "ready") throw new Error(draft.reason ?? "not ready");
    return draft.steps;
  };

  it.each([
    ["the default percentage", { mode: "percentage" as const }, { feeMode: "percentage" }],
    ["a typed percentage", { mode: "percentage" as const, percentText: "0.25" }, { feeMode: "percentage", feePercent: "0.25" }],
    ["a gas multiplier with the price of the sender", { mode: "gas-multiplier" as const, gasMultiplierText: "1.2" }, { feeMode: "gas", feeSenderPrice: "3000", feeMultiplier: "1.2" }],
    ["a gas multiplier with a ceiling", { mode: "gas-multiplier" as const, ceilingGweiText: "50", gasMultiplierText: "1.5" }, { feeMode: "gas", feeSenderPrice: "3000", feeCeilingGwei: "50", feeMultiplier: "1.5" }],
    ["a fixed amount", { mode: "fixed" as const, fixedText: "0.75" }, { feeMode: "fixed", feeFixed: "0.75" }],
    ["the suggested fixed amount", { mode: "fixed" as const }, { feeMode: "fixed" }],
  ])("builds the same bytes as the terminal for %s", async (_name, options, terminalExtra) => {
    const { context, tokens } = await terminalContext();
    const terminal = buildBridgeSteps(terminalValues(terminalExtra), tokens, context);
    const web = await webSteps(options);
    expect(web.map((step) => step.plan.data)).toEqual(terminal.map((step) => step.plan.data));
    expect(web.map((step) => step.plan.to)).toEqual(terminal.map((step) => step.plan.to));
    const relay = decodeFunctionData({ abi: tokenMediatorAbi, data: web.at(-1)!.plan.data });
    expect(relay.functionName).toBe("relayTokensAndCall");
  });
});

describe("other plans stay the terminal's", () => {
  it("builds a message and a claim from the terminal planners", () => {
    const message = planSendMessage({ chain: FIXTURE_PAIR.first, target: receiver, data: "0x", gas: 100_000n });
    expect(message.functionSignature).toBe("requireToPassMessage(address,bytes,uint256)");
    expect(() => planClaim({ chain: FIXTURE_PAIR.first, token: usdc, account: FIXTURE_ACCOUNT, claimable: 0n })).toThrow(/Nothing is claimable/);
  });
});

describe("planBridgeSteps refuses terms that the delivery router would send to its reward address", () => {
  const mediator = FIXTURE_PAIR.first.contracts.tokenMediator;
  const bridge = FIXTURE_PAIR.second.contracts.messageBridge;
  const zero = "0x0000000000000000000000000000000000000000";

  it("with a tip, when the recipient is zero, the router, a mediator or a bridge", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const refused: readonly [string, RegExp][] = [
      [zero, /zero address/],
      [deliveryRouter, /router itself/],
      [mediator, /mediator of/],
      [bridge, /bridge of/],
    ];
    for (const [recipient, message] of refused) {
      const delivery = deliveryFor();
      const aimed = { ...delivery, director: { ...delivery.director, recipient: getAddress(recipient) } };
      expect(() => planBridgeSteps({ values: values(), tokens, context, delivery: aimed })).toThrow(message);
    }
  });

  it("with a tip, when a custom router is the recipient", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const custom = getAddress(`0x${"ee".repeat(20)}`);
    const delivery = deliveryFor();
    const aimed = { ...delivery, router: custom, director: { ...delivery.director, recipient: custom } };
    expect(() => planBridgeSteps({ values: values(), tokens, context, delivery: aimed })).toThrow(/router itself/);
  });

  it("without a tip, when the receiver is a delivery router and the data is not the director", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    expect(() => planBridgeSteps({ values: values({ receiver: deliveryRouter }), tokens, context, delivery: null })).toThrow(PlanInputError);
    expect(() => planBridgeSteps({ values: values({ receiver: deliveryRouter, mode: "call", data: "0xabcd" }), tokens, context, delivery: null })).toThrow(/128 byte/);
  });
});
