import { decodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { DEFAULT_GAS_MARGIN, decodeDeliveryCall, decodeFeeDirector, encodeFeeDirector, routerCallbackGas, senderPriceOfToken, tokenMediatorAbi } from "@zk-bridge/shared";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { CALL_TIP_NOTE, buildConfirmView } from "../../src/tx/confirm-model";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS } from "../../src/tx/bridge-draft";
import { parseDeliveryCallText, planBridgeSteps, type BridgeFormValues, type WebStep } from "../../src/tx/bridge-steps";
import { DEFAULT_MARGIN_RATE, selectDelivery } from "../../src/tx/delivery-selection";
import { buildDeliveryReport, buildFixtureContext } from "../helpers";

const usdc = FIXTURE_TOKENS[0]!;
const receiver = getAddress(`0x${"cd".repeat(20)}`);
const callTarget = getAddress(`0x${"77".repeat(20)}`);
const otherTarget = getAddress(`0x${"88".repeat(20)}`);
const deliveryRouter = FIXTURE_PAIR.second.contracts.deliveryRouter!;

const values = (overrides: Partial<BridgeFormValues> = {}): BridgeFormValues => ({
  token: `first:${usdc.address}`,
  amount: "250",
  receiver,
  mode: "plain",
  data: "",
  callGas: "", callbackGas: "",
  callTarget: "",
  callData: "",
  ...overrides,
});

const CALL_GAS = 200_000n;

const deliveryFor = (callGas: bigint) => {
  const selection = selectDelivery(
    {
      mode: "percentage",
      recipient: receiver,
      transferValue: 250_000_000n,
      transferValueAtMost: 250_000_000n,
      token: { symbol: "zUSDC", decimals: 6 },
      tokenValueInWei: 10n ** 18n,
      senderPrice: senderPriceOfToken({ tokenValueInWei: 10n ** 18n, tokenDecimals: 18 }),
      payout: "token",
      report: buildDeliveryReport(369),
      priorityFeeWei: 10n ** 9n,
      percentageRate: 10n ** 15n,
      fixedAmount: null,
      marginRate: DEFAULT_MARGIN_RATE,
      gasMargin: DEFAULT_GAS_MARGIN,
      destinationName: "PulseChain",
      baseFeeCeilingWei: null,
      callGas,
    },
    { router: deliveryRouter, defaultRouter: deliveryRouter },
  );
  if (selection.kind !== "available") throw new Error(selection.reason);
  return selection;
};

/** The tip with no call, and the same tip once a call asks for CALL_GAS. */
const delivery = deliveryFor(0n);
const deliveryWithCall = deliveryFor(CALL_GAS);

const wordsOf = (selection: typeof delivery) =>
  encodeFeeDirector(selection.director, {
    router: deliveryRouter,
    protectedAddresses: [],
    destinationToken: usdc.counterpart,
    destinationWrappedNative: FIXTURE_PAIR.second.contracts.wrappedNative,
  });
const directorWords = wordsOf(delivery);
const directorWordsWithCall = wordsOf(deliveryWithCall);

const tippedStep = async (overrides: Partial<BridgeFormValues> = {}): Promise<WebStep> => {
  const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
  const withCall = (overrides.callTarget ?? "") !== "" || (overrides.callData ?? "") !== "";
  return planBridgeSteps({ values: values(overrides), tokens, context, delivery: withCall ? deliveryWithCall : delivery }).at(-1)!;
};

const dataArgumentOf = (step: WebStep): string => decodeFunctionData({ abi: tokenMediatorAbi, data: step.plan.data }).args![3] as string;

describe("the call fields of the bridge form", () => {
  it("encodes no call, and the data is the five words of the director, when both fields are empty", async () => {
    const empty = await tippedStep();
    expect(dataArgumentOf(empty)).toBe(directorWords);
    expect(dataArgumentOf(empty)).toHaveLength(2 + 160 * 2);
    expect(empty.disclosure.deliveryCall).toBeNull();
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const absent = planBridgeSteps({ values: { token: values().token, amount: "250", receiver, mode: "plain", data: "", callGas: "", callbackGas: "" }, tokens, context, delivery }).at(-1)!;
    expect(absent.plan.data).toBe(empty.plan.data);
  });

  it("appends the target and the call data after the five words", async () => {
    const step = await tippedStep({ callTarget, callData: "0xABcd" });
    expect(dataArgumentOf(step)).toBe(`${directorWordsWithCall}${"77".repeat(20)}abcd`);
    expect(decodeDeliveryCall(dataArgumentOf(step) as `0x${string}`)).toEqual({ target: `0x${"77".repeat(20)}`, data: "0xabcd" });
    expect(step.disclosure.deliveryCall).toEqual({ target: callTarget, data: "0xabcd" });
  });

  it("allows a target with no call data: 180 bytes, a call with empty data", async () => {
    const step = await tippedStep({ callTarget, callData: "  " });
    expect(dataArgumentOf(step)).toBe(`${directorWordsWithCall}${"77".repeat(20)}`);
    expect(step.disclosure.deliveryCall).toEqual({ target: callTarget, data: "0x" });
  });

  it("refuses call data without a target, with a sentence", () => {
    expect(() => parseDeliveryCallText({ callTarget: "", callData: "0xabcd" })).toThrow("The call data needs a call target. Enter the target contract, or clear the call data.");
  });

  it("refuses a target that is not an address", () => {
    for (const bad of ["0x1234", "hello", `0x${"zz".repeat(20)}`, `${"77".repeat(20)}`]) {
      expect(() => parseDeliveryCallText({ callTarget: bad, callData: "" })).toThrow("The call target must be an address that starts with 0x and has 40 hexadecimal digits.");
    }
  });

  it("refuses call data with an odd number of digits, without 0x, or with a character that is not hex", () => {
    for (const bad of ["0xabc", "abcd", "0xzz", "0x 12"]) {
      expect(() => parseDeliveryCallText({ callTarget, callData: bad })).toThrow("The call data must be hex that starts with 0x and has an even number of digits, such as 0xabcd.");
    }
  });

  it("carries the call gas in the fifth word of the terms and the callback gas of the router in the relay", async () => {
    const step = await tippedStep({ callTarget, callData: "0xabcd" });
    expect(decodeFeeDirector(dataArgumentOf(step) as `0x${string}`).callGas).toBe(CALL_GAS);
    const args = decodeFunctionData({ abi: tokenMediatorAbi, data: step.plan.data }).args as readonly unknown[];
    expect(args[4]).toBe(routerCallbackGas({ callGas: CALL_GAS }));
  });

  it("blocks the draft and asks for the call gas when a call has none, and takes the number when it has one", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const options = { ...DEFAULT_DELIVERY_OPTIONS, senderPriceText: "1", mode: "percentage" as const };
    const data = { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n };
    for (const callGas of ["", "0", "1.5", "abc"]) {
      const blocked = computeBridgeDraft(values({ callTarget, callGas }), options, data);
      expect(blocked.status).toBe("blocked");
      expect(blocked.reason).toBe("Enter the call gas: the exact gas the call gets, as a whole number above zero.");
    }
    const ready = computeBridgeDraft(values({ callTarget, callGas: " 123456 " }), options, data);
    expect(ready.status).toBe("ready");
    expect(ready.delivery?.director.callGas).toBe(123_456n);
    expect(computeBridgeDraft(values({ callGas: "999" }), options, data).delivery?.director.callGas).toBe(0n);
  });

  it("refuses a call on a relay with no tip, because only the delivery router makes it", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    expect(() => planBridgeSteps({ values: values({ callTarget }), tokens, context, delivery: null })).toThrow(/needs a tip/);
  });

  it("refuses a target that the router would not call: the router itself", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    expect(() => planBridgeSteps({ values: values({ callTarget: deliveryRouter }), tokens, context, delivery: deliveryWithCall })).toThrow(/target of the call is the router itself/);
  });

  it("leaves the plain relay with empty fields byte-identical to a form without the fields", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const withFields = planBridgeSteps({ values: values(), tokens, context, delivery: null });
    const { callTarget: _target, callData: _data, ...without } = values();
    const withoutFields = planBridgeSteps({ values: without, tokens, context, delivery: null });
    expect(withFields.map((step) => step.plan.data)).toEqual(withoutFields.map((step) => step.plan.data));
  });

  it("blocks the draft with the sentence for call data without a target", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const draft = computeBridgeDraft(values({ callData: "0xabcd", callGas: "100" }), { ...DEFAULT_DELIVERY_OPTIONS, senderPriceText: "1", mode: "percentage" }, { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n });
    expect(draft.status).toBe("blocked");
    expect(draft.reason).toBe("The call data needs a call target. Enter the target contract, or clear the call data.");
  });
});

describe("the confirm model with a call", () => {
  it("shows the target, the call data and the note about the gas based tip", async () => {
    const view = buildConfirmView(await tippedStep({ callTarget, callData: "0xabcd" }));
    expect(view.blockedReason).toBeNull();
    expect(view.delivery?.callLines).toEqual([
      { label: "Call target", text: callTarget },
      { label: "Call data", text: "0xabcd" },
    ]);
    expect(view.delivery?.directorLines.slice(-2)).toEqual([
      { label: "Call gas", text: "200000 (the exact gas the call gets)" },
      { label: "Callback gas", text: `${routerCallbackGas({ callGas: CALL_GAS })} (the call gas plus the router's own work; the page sets it for you)` },
    ]);
    expect(view.delivery?.callNote).toBe("A gas based tip counts the call gas, so the tip is higher with a call. The limit is still the most it can take.");
    expect(CALL_TIP_NOTE).toBe(view.delivery?.callNote);
  });

  it("shows empty call data in words, and shows no call lines or note without a call", async () => {
    expect(buildConfirmView(await tippedStep({ callTarget })).delivery?.callLines[1]).toEqual({ label: "Call data", text: "empty" });
    const none = buildConfirmView(await tippedStep());
    expect(none.delivery?.callLines).toEqual([]);
    expect(none.delivery?.callNote).toBeNull();
  });

  it("refuses bytes with another call target than the one that was shown", async () => {
    const shown = await tippedStep({ callTarget, callData: "0xabcd" });
    const built = await tippedStep({ callTarget: otherTarget, callData: "0xabcd" });
    const forged: WebStep = { ...shown, plan: { ...shown.plan, data: built.plan.data } };
    expect(buildConfirmView(forged).blockedReason).toBe("The call after the delivery in the call data differs from the one that was shown. Nothing was sent.");
  });

  it("refuses bytes with other call data than the data that was shown", async () => {
    const shown = await tippedStep({ callTarget, callData: "0xabcd" });
    const built = await tippedStep({ callTarget, callData: "0xabce" });
    const forged: WebStep = { ...shown, plan: { ...shown.plan, data: built.plan.data } };
    expect(buildConfirmView(forged).blockedReason).toBe("The call after the delivery in the call data differs from the one that was shown. Nothing was sent.");
  });

  it("refuses bytes that hold a call when none was shown, and bytes that hold none when a call was shown", async () => {
    const withCall = await tippedStep({ callTarget, callData: "0xabcd" });
    const without = await tippedStep();
    const hidden: WebStep = { ...without, plan: { ...without.plan, data: withCall.plan.data } };
    const missing: WebStep = { ...withCall, plan: { ...withCall.plan, data: without.plan.data } };
    // The call gas is part of the terms, so the terms differ before the call does.
    expect(buildConfirmView(hidden).blockedReason).toMatch(/differs from the one that was shown/);
    expect(buildConfirmView(missing).blockedReason).toMatch(/differs from the one that was shown/);
  });
});
