import { decodeFunctionData, encodeFunctionData, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { tokenMediatorAbi } from "@zk-bridge/shared";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { buildConfirmView } from "../../src/tx/confirm-model";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS, type DeliveryOptions } from "../../src/tx/bridge-draft";
import type { WebStep } from "../../src/tx/bridge-steps";
import { buildDeliveryReport, buildFixtureContext } from "../helpers";

const usdc = FIXTURE_TOKENS[0]!;
const receiver = getAddress(`0x${"cd".repeat(20)}`);

const stepsOf = async (allowance: bigint, options: Partial<DeliveryOptions>): Promise<readonly WebStep[]> => {
  const { context, tokens } = await buildFixtureContext({ allowance });
  const draft = computeBridgeDraft(
    { token: `first:${usdc.address}`, amount: "250", receiver, mode: "plain", data: "", fallback: "" },
    { ...DEFAULT_DELIVERY_OPTIONS, ...options },
    { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n },
  );
  if (draft.status !== "ready") throw new Error(draft.reason ?? "not ready");
  return draft.steps;
};

describe("buildConfirmView: the parts of a step", () => {
  it("shows no bridge fees and no router notice for an allowance step of a plain transfer", async () => {
    const [approval] = await stepsOf(0n, { mode: "none" });
    const view = buildConfirmView(approval!);
    expect(view.functionSignature).toBe("approve(address,uint256)");
    expect(view.noRouterNotice).toBeNull();
    expect(view.delivery).toBeNull();
  });

  it("shows no bridge fee lines when the disclosure holds no fees", async () => {
    const [relay] = await stepsOf(10n ** 12n, { mode: "none" });
    const withoutFees: WebStep = { ...relay!, disclosure: { ...relay!.disclosure, bridgeFees: null } };
    expect(buildConfirmView(withoutFees).bridgeFees).toBeNull();
  });

  it("shows no bridge fee lines when the disclosure holds fees but no token to write them in", async () => {
    const [relay] = await stepsOf(10n ** 12n, { mode: "none" });
    expect(relay!.disclosure.bridgeFees).not.toBeNull();
    const withoutToken: WebStep = { ...relay!, disclosure: { ...relay!.disclosure, amountToken: null } };
    expect(buildConfirmView(withoutToken).bridgeFees).toBeNull();
  });

  it("writes the cost lines in the coin of the chain of the step when the disclosure names no destination coin", async () => {
    const [relay] = await stepsOf(10n ** 12n, { mode: "percentage", senderPriceText: "1" });
    const view = buildConfirmView({ ...relay!, disclosure: { ...relay!.disclosure, destinationNativeSymbol: null } });
    expect(view.delivery!.costLines.length).toBeGreaterThan(0);
    for (const line of view.delivery!.costLines) expect(line.text).toMatch(/ ETH \(estimate: /);
  });
});

describe("buildConfirmView: a tip that the call does not carry", () => {
  it("blocks a call that has no receiver argument when a tip was chosen", async () => {
    const [approval] = await stepsOf(0n, { mode: "none" });
    const [tipped] = await stepsOf(10n ** 12n, { mode: "percentage" });
    const forged: WebStep = { ...approval!, disclosure: { ...approval!.disclosure, feesApplyTo: "this-transaction", delivery: tipped!.disclosure.delivery } };
    expect(buildConfirmView(forged).blockedReason).toBe("The call names no router, but a tip was chosen.");
  });

  it("blocks a call that names the shown router but carries no fee director", async () => {
    const [relay] = await stepsOf(10n ** 12n, { mode: "none" });
    const [tipped] = await stepsOf(10n ** 12n, { mode: "percentage" });
    const shown = { ...tipped!.disclosure.delivery!, router: receiver };
    const forged: WebStep = { ...relay!, disclosure: { ...relay!.disclosure, delivery: shown } };
    expect(buildConfirmView(forged).blockedReason).toBe("The call carries no fee director, but a delivery fee was chosen.");
  });

  it("blocks a call whose data argument is not a fee director", async () => {
    const [tipped] = await stepsOf(10n ** 12n, { mode: "percentage" });
    const decoded = decodeFunctionData({ abi: tokenMediatorAbi, data: tipped!.plan.data });
    const [token, router, value] = decoded.args as readonly [`0x${string}`, `0x${string}`, bigint, `0x${string}`];
    const data = encodeFunctionData({ abi: tokenMediatorAbi, functionName: "relayTokensAndCall", args: [token, router, value, "0x1234"] });
    const forged: WebStep = { ...tipped!, plan: { ...tipped!.plan, data } };
    expect(buildConfirmView(forged).blockedReason).toBe("The fee director in the call data cannot be read.");
  });
});
