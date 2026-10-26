import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { buildConfirmView } from "../../src/tx/confirm-model";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS } from "../../src/tx/bridge-draft";
import type { WebStep } from "../../src/tx/bridge-steps";
import { buildDeliveryReport, buildFixtureContext } from "../helpers";

const usdc = FIXTURE_TOKENS[0]!;
const receiver = getAddress(`0x${"cd".repeat(20)}`);

const relayStep = async (options: Partial<typeof DEFAULT_DELIVERY_OPTIONS> = {}): Promise<WebStep> => {
  const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
  const draft = computeBridgeDraft(
    { token: `first:${usdc.address}`, amount: "250", receiver, mode: "plain", data: "", fallback: "" },
    { ...DEFAULT_DELIVERY_OPTIONS, senderPriceText: "1", mode: "none", ...options },
    { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n },
  );
  if (draft.status !== "ready") throw new Error(draft.reason ?? "not ready");
  return draft.steps.at(-1)!;
};

describe("buildConfirmView", () => {
  it("shows chain, contract, function, decoded arguments, value and the bridge fees for a plain relay", async () => {
    const view = buildConfirmView(await relayStep());
    expect(view.chainText).toBe("Ethereum (chain 1)");
    expect(view.contractText).toContain("TokenMediator");
    expect(view.contractText).toContain(getAddress(FIXTURE_PAIR.first.contracts.tokenMediator));
    expect(view.functionSignature).toBe("relayTokens(address,address,uint256)");
    expect(view.arguments.map((argument) => argument.name)).toEqual(["token", "receiver", "value"]);
    expect(view.arguments.find((argument) => argument.name === "value")?.value).toBe("250000000");
    expect(view.arguments.find((argument) => argument.name === "value")?.meaning).toBe("250 USDC");
    expect(view.valueText).toBe("0 ETH");
    expect(view.bridgeFees?.lines.map((line) => line.label)).toEqual(["Bridge fee on the source chain", "Bridge fee on delivery", "Arrives"]);
    expect(view.bridgeFees?.lines[0]?.text).toBe("0.1% = 0.25 USDC (exact)");
    expect(view.delivery).toBeNull();
    expect(view.blockedReason).toBeNull();
  });

  it("shows the delivery fee, its label, the maximum that the runner can take, the cost lines and the data source", async () => {
    const step = await relayStep({ mode: "percentage" });
    const view = buildConfirmView(step);
    expect(view.delivery?.certaintyLabel).toBe("exact");
    expect(view.delivery?.runnerMaximum).toMatch(/^The runner can take at most [\d.]+ zkbUSDC\./);
    expect(view.delivery?.costLines.map((line) => line.label)).toEqual(["Gas cost", "Proof cost", "Margin"]);
    // The delivery runs on PulseChain, so its cost is in PLS, not in the ETH of the chain that the transfer leaves.
    for (const line of view.delivery?.costLines ?? []) expect(line.text).toMatch(/ PLS \(estimate: /);
    expect(view.delivery?.dataSource).toContain("measured from 40 recent deliveries, p90");
    expect(view.delivery?.baseFee).toContain("base fee 7 gwei");
    expect(view.delivery?.directorLines.map((line) => line.label)).toEqual(["Recipient after the fee", "Settings", "Limit", "Multiplier"]);
    expect(view.delivery?.directorLines[0]?.text).toBe(receiver);
    expect(view.functionSignature).toBe("relayTokensAndCall(address,address,uint256,bytes)");
  });

  it("shows the router, the tip mode, the tip now and its maximum, and the two facts about the runner", async () => {
    const view = buildConfirmView(await relayStep({ mode: "percentage" }));
    const delivery = view.delivery!;
    expect(delivery.routerText).toBe(getAddress(FIXTURE_PAIR.second.contracts.feeRouter!));
    expect(delivery.routerWarning).toBeNull();
    expect(delivery.tipMode).toBe("percentage of the transfer");
    // The router receives 250 less 0.1 percent at each end: 249.50025. The tip is 0.1 percent of that, cut to the unit.
    expect(delivery.tipNow).toBe("0.2495 zkbUSDC (exact)");
    expect(delivery.runnerMaximum).toBe("The runner can take at most 0.24975 zkbUSDC. Everything else goes to the recipient.");
    expect(delivery.runnerNotes.join(" ")).toMatch(/Only one whitelisted runner can collect tips through a router/);
    expect(delivery.runnerNotes.join(" ")).toMatch(/anyone else calls the bridge directly.*no tip is paid.*recipient then gets the whole amount/);
  });

  it("names the tip now as an estimate, with its maximum, for a gas multiplier", async () => {
    const view = buildConfirmView(await relayStep({ mode: "gas-multiplier", senderPriceText: "3000" }));
    expect(view.delivery?.tipMode).toBe("gas multiplier");
    expect(view.delivery?.tipNow).toMatch(/^about [\d.]+ zkbUSDC now \(estimate, at most [\d.]+ zkbUSDC\)$/);
  });

  it("warns about a router that is not the fee router of the deployment, and keeps the transfer allowed", async () => {
    const other = getAddress(`0x${"ee".repeat(20)}`);
    const view = buildConfirmView(await relayStep({ mode: "percentage", routerText: other }));
    expect(view.delivery?.routerText).toBe(other);
    expect(view.delivery?.routerWarning).toContain("is not the fee router of the deployment");
    expect(view.delivery?.routerWarning).toContain(getAddress(FIXTURE_PAIR.second.contracts.feeRouter!));
    expect(view.blockedReason).toBeNull();
  });

  it("says that no router is involved for a relay with no tip", async () => {
    const view = buildConfirmView(await relayStep({ mode: "none" }));
    expect(view.noRouterNotice).toMatch(/^No router is involved\. This relay carries no tip and no fee terms/);
    expect(view.noRouterNotice).toMatch(/Anyone can deliver it directly on the bridge, for free/);
    expect(buildConfirmView(await relayStep({ mode: "percentage" })).noRouterNotice).toBeNull();
  });

  it("shows no tip lines for a plain relay", async () => {
    const view = buildConfirmView(await relayStep({ mode: "none" }));
    expect(view.delivery).toBeNull();
    expect(view.functionSignature).toBe("relayTokens(address,address,uint256)");
  });

  it("blocks the signature when the call goes to another router than the one that was shown", async () => {
    const step = await relayStep({ mode: "percentage" });
    const shown = step.disclosure.delivery!;
    const tampered: WebStep = { ...step, disclosure: { ...step.disclosure, delivery: { ...shown, router: getAddress(`0x${"ee".repeat(20)}`) } } };
    expect(buildConfirmView(tampered).blockedReason).toMatch(/router in the call differs/);
  });

  it("shows the fees of the relay on the allowance step too, marked as the fees of the next transaction, and does not block it", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 0n });
    const draft = computeBridgeDraft(
      { token: `first:${usdc.address}`, amount: "250", receiver, mode: "plain", data: "", fallback: "" },
      { ...DEFAULT_DELIVERY_OPTIONS, senderPriceText: "1" },
      { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n },
    );
    if (draft.status !== "ready") throw new Error(draft.reason ?? "not ready");
    const approval = buildConfirmView(draft.steps[0]!);
    expect(approval.functionSignature).toBe("approve(address,uint256)");
    expect(approval.bridgeFees?.appliesTo).toBe("paid by the relay that follows this allowance");
    expect(approval.delivery?.runnerMaximum).toMatch(/The runner can take at most/);
    expect(approval.blockedReason).toBeNull();
    expect(buildConfirmView(draft.steps[1]!).bridgeFees?.appliesTo).toBe("paid by this transaction");
  });

  it("reads the arguments from the calldata, so the dialog cannot show what the wallet will not receive", async () => {
    const step = await relayStep();
    const forged: WebStep = { ...step, plan: { ...step.plan, arguments: [{ name: "value", type: "uint256", value: "1" }] } };
    const view = buildConfirmView(forged);
    expect(view.arguments.find((argument) => argument.name === "value")?.value).toBe("250000000");
  });

  it("blocks the signature when the calldata does not match the planned function", async () => {
    const step = await relayStep();
    const other = await relayStep({ mode: "percentage" });
    const forged: WebStep = { ...step, plan: { ...step.plan, data: other.plan.data } };
    const view = buildConfirmView(forged);
    expect(view.blockedReason).toMatch(/Nothing was sent/);
  });

  it("blocks the signature when the call data holds a different fee director than the one that was shown", async () => {
    const step = await relayStep({ mode: "percentage" });
    const percentage = step.disclosure.delivery!;
    const tampered: WebStep = { ...step, disclosure: { ...step.disclosure, delivery: { ...percentage, director: { ...percentage.director, multiplier: percentage.director.multiplier + 1n } } } };
    expect(buildConfirmView(tampered).blockedReason).toMatch(/differs from the one that was shown/);
  });

  it("blocks bytes that no known ABI reads", async () => {
    const step = await relayStep();
    const view = buildConfirmView({ ...step, plan: { ...step.plan, data: "0xdeadbeef" } });
    expect(view.blockedReason).toMatch(/cannot read this call/);
  });
});
