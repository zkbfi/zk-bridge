import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { GAS_MODE_HELP } from "@zk-bridge/shared";
import { CALL_TIP_NOTE } from "../../src/tx/confirm-model";
import { TransactionDialog } from "../../src/actions/TransactionDialog";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS } from "../../src/tx/bridge-draft";
import type { WebStep } from "../../src/tx/bridge-steps";
import { buildDeliveryReport, buildFixtureContext } from "../helpers";
import { renderPage } from "../render";

const usdc = FIXTURE_TOKENS[0]!;

const stepsOf = async (input: { readonly allowance: bigint; readonly delivery: boolean }): Promise<readonly WebStep[]> => {
  const { context, tokens } = await buildFixtureContext({ allowance: input.allowance });
  const draft = computeBridgeDraft(
    { token: `first:${usdc.address}`, amount: "250", receiver: getAddress(`0x${"cd".repeat(20)}`), mode: "plain", data: "", callGas: "", callbackGas: "" },
    { ...DEFAULT_DELIVERY_OPTIONS, mode: input.delivery ? "percentage" : "none", senderPriceText: "1" },
    { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n },
  );
  if (draft.status !== "ready") throw new Error(draft.reason ?? "not ready");
  return draft.steps;
};

const gasStepsOf = async (pair: typeof FIXTURE_PAIR): Promise<readonly WebStep[]> => {
  const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
  const draft = computeBridgeDraft(
    { token: `first:${usdc.address}`, amount: "250", receiver: getAddress(`0x${"cd".repeat(20)}`), mode: "plain", data: "", callGas: "", callbackGas: "" },
    { ...DEFAULT_DELIVERY_OPTIONS, senderPriceText: "3000" },
    { pair, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n },
  );
  if (draft.status !== "ready") throw new Error(draft.reason ?? "not ready");
  return draft.steps;
};

const callTarget = getAddress(`0x${"ab".repeat(20)}`);

const callStepsOf = async (): Promise<readonly WebStep[]> => {
  const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
  const draft = computeBridgeDraft(
    { token: `first:${usdc.address}`, amount: "250", receiver: getAddress(`0x${"cd".repeat(20)}`), mode: "plain", data: "", callGas: "200000", callbackGas: "", callTarget, callData: "0xABCD" },
    { ...DEFAULT_DELIVERY_OPTIONS, mode: "percentage", senderPriceText: "1" },
    { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n },
  );
  if (draft.status !== "ready") throw new Error(draft.reason ?? "not ready");
  return draft.steps;
};

describe("the confirm dialog: the call after the delivery", () => {
  it("lists the call target and the call data of a tipped relay, with the note about gas based tips", async () => {
    renderPage(<TransactionDialog steps={await callStepsOf()} onClose={() => undefined} />, {});
    const call = await screen.findByTestId("confirm-delivery-call");
    expect(within(call).getByText("Call after the delivery")).toBeInTheDocument();
    expect(within(call).getByText("Call target").nextSibling).toHaveTextContent(callTarget);
    expect(within(call).getByText("Call data").nextSibling).toHaveTextContent("0xabcd");
    expect(within(call).getByTestId("confirm-call-note")).toHaveTextContent(CALL_TIP_NOTE);
  });
});

describe("the confirm dialog: the default gas based tip", () => {
  it("shows the limit as the price ceiling and what the gas based mode means, with no notice on a chain that reports a base fee", async () => {
    renderPage(<TransactionDialog steps={await gasStepsOf(FIXTURE_PAIR)} onClose={() => undefined} />, {});
    const delivery = await screen.findByTestId("confirm-delivery");
    expect(within(delivery).getByText("gas based, up to the limit")).toBeInTheDocument();
    expect(within(delivery).getByTestId("confirm-tip-maximum")).toHaveTextContent(/^The tip is expected to be about [\d.]+ zUSDC at the gas estimate\. The most it can take is [\d.]+ zUSDC, the limit/);
    expect(within(delivery).getByTestId("confirm-gas-mode-help")).toHaveTextContent(GAS_MODE_HELP);
    expect(within(delivery).queryByTestId("confirm-gas-notice")).toBeNull();
  });

  it("shows the notice that a chain with no base fee makes the tip read the whole gas price", async () => {
    const pair = { ...FIXTURE_PAIR, second: { ...FIXTURE_PAIR.second, baseFee: "none" as const } };
    renderPage(<TransactionDialog steps={await gasStepsOf(pair)} onClose={() => undefined} />, {});
    const delivery = await screen.findByTestId("confirm-delivery");
    expect(within(delivery).getByTestId("confirm-gas-notice")).toHaveTextContent("PulseChain reports no base fee, so the tip reads the whole gas price.");
  });
});

describe("the confirm dialog", () => {
  it("shows chain, contract, function, decoded arguments, value and tip before the wallet opens", async () => {
    const onSend = vi.fn();
    renderPage(<TransactionDialog steps={await stepsOf({ allowance: 10n ** 12n, delivery: true })} onClose={() => undefined} />, { onSend });
    const review = await screen.findByTestId("confirm-review");
    expect(within(review).getByText("Ethereum (chain 1)")).toBeInTheDocument();
    expect(within(review).getByText(/^ERC-20 mediator at 0x/)).toBeInTheDocument();
    expect(within(review).getByText("relayTokensAndCall(address,address,uint256,bytes,uint256)")).toBeInTheDocument();
    expect(within(review).getByText("Value sent").nextSibling).toHaveTextContent("0 ETH");
    expect(within(review).getByText("value")).toBeInTheDocument();
    expect(within(review).getByText("250000000")).toBeInTheDocument();
    expect(within(review).queryByText(/Bridge fee/)).toBeNull();
    const delivery = within(review).getByTestId("confirm-delivery");
    expect(delivery).toHaveTextContent(/Tip for delivery \(paid by this transaction\)/);
    expect(within(delivery).getByText(getAddress(FIXTURE_PAIR.second.contracts.deliveryRouter!))).toBeInTheDocument();
    expect(within(delivery).getByText("percentage of the transfer")).toBeInTheDocument();
    expect(within(delivery).getByTestId("confirm-tip-now")).toHaveTextContent(/\(exact\)$/);
    expect(within(delivery).getByTestId("confirm-tip-maximum")).toHaveTextContent(/The tip can take at most/);
    expect(within(delivery).getByTestId("confirm-tip-notes")).toHaveTextContent(/Anyone can deliver through the delivery router.*recipient then gets the whole amount/);
    expect(within(delivery).queryByTestId("confirm-router-warning")).toBeNull();
    expect(within(delivery).getByText("Gas cost")).toBeInTheDocument();
    expect(within(delivery).queryByText("Proof cost")).toBeNull();
    expect(within(delivery).getByText("Margin")).toBeInTheDocument();
    expect(within(delivery).getByText(/measured from 40 recent deliveries, p90/)).toBeInTheDocument();
    expect(within(review).getByText("Network fee")).toBeInTheDocument();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows the reward address and the failed delivery address that the router returned, not swapped", async () => {
    const rewardAddress = getAddress(`0x${"11".repeat(20)}`);
    const failedDeliveryAddress = getAddress(`0x${"22".repeat(20)}`);
    renderPage(<TransactionDialog steps={await stepsOf({ allowance: 10n ** 12n, delivery: true })} onClose={() => undefined} />, {
      routerAddresses: { kind: "read", rewardAddress, failedDeliveryAddress },
    });
    const delivery = await screen.findByTestId("confirm-delivery");
    await waitFor(() => expect(within(delivery).getByTestId("confirm-failed-delivery")).toHaveTextContent(failedDeliveryAddress));
    expect(within(delivery).getByTestId("confirm-failed-delivery")).toHaveTextContent(`the tokens go to ${failedDeliveryAddress}`);
    expect(within(delivery).getByTestId("confirm-failed-delivery")).not.toHaveTextContent(rewardAddress);
    expect(within(delivery).getByText("Tip goes to").nextSibling).toHaveTextContent(rewardAddress);
    expect(within(delivery).queryByTestId("confirm-router-addresses-warning")).toBeNull();
  });

  it("uses the fixture router addresses by default", async () => {
    renderPage(<TransactionDialog steps={await stepsOf({ allowance: 10n ** 12n, delivery: true })} onClose={() => undefined} />);
    const failed = await screen.findByTestId("confirm-failed-delivery");
    await waitFor(() => expect(failed).toHaveTextContent(getAddress("0x00000000000000000000000000000000000000Cd")));
  });

  it("names no address and warns when the router addresses are unreadable", async () => {
    renderPage(<TransactionDialog steps={await stepsOf({ allowance: 10n ** 12n, delivery: true })} onClose={() => undefined} />, {
      routerAddresses: { kind: "unreadable", reason: "execution reverted" },
    });
    const warning = await screen.findByTestId("confirm-router-addresses-warning");
    expect(warning).toHaveTextContent(/Check the router before you sign/);
    const failed = screen.getByTestId("confirm-failed-delivery");
    expect(failed).toHaveTextContent(/could not read the failed delivery address/);
    expect(failed.textContent).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it("shows that no router is involved when there is no tip", async () => {
    renderPage(<TransactionDialog steps={await stepsOf({ allowance: 10n ** 12n, delivery: false })} onClose={() => undefined} />);
    expect(await screen.findByTestId("confirm-no-router")).toHaveTextContent(/No router is involved/);
    expect(screen.queryByTestId("confirm-delivery")).toBeNull();
  });

  it("hands the transaction to the wallet only when the user presses the send button", async () => {
    const onSend = vi.fn();
    renderPage(<TransactionDialog steps={await stepsOf({ allowance: 10n ** 12n, delivery: false })} onClose={() => undefined} />, { onSend });
    const send = await screen.findByRole("button", { name: "Send to wallet" });
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.click(send);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Done\. Every transaction is confirmed/)).toBeInTheDocument();
  });

  it("walks an allowance step and then the relay, each in full, and labels the position", async () => {
    const onSend = vi.fn();
    renderPage(<TransactionDialog steps={await stepsOf({ allowance: 0n, delivery: false })} onClose={() => undefined} />, { onSend });
    expect(await screen.findByText("Step 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("approve(address,uint256)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send to wallet" }));
    expect(await screen.findByText("Step 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("relayTokens(address,address,uint256)")).toBeInTheDocument();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("disables the send button and explains when the calldata does not match what was planned", async () => {
    const steps = await stepsOf({ allowance: 10n ** 12n, delivery: false });
    const forged: WebStep[] = [{ ...steps[0]!, plan: { ...steps[0]!.plan, data: "0xdeadbeef" } }];
    renderPage(<TransactionDialog steps={forged} onClose={() => undefined} />);
    const send = await screen.findByRole("button", { name: "Send to wallet" });
    expect(send).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/cannot read this call/);
  });

  it("closes without sending when the user cancels", async () => {
    const onSend = vi.fn();
    const onClose = vi.fn();
    renderPage(<TransactionDialog steps={await stepsOf({ allowance: 10n ** 12n, delivery: false })} onClose={onClose} />, { onSend });
    await screen.findByRole("button", { name: "Send to wallet" });
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("is a labelled modal dialog that closes on Escape", async () => {
    const onClose = vi.fn();
    renderPage(<TransactionDialog steps={await stepsOf({ allowance: 10n ** 12n, delivery: false })} onClose={onClose} />);
    const dialog = await screen.findByRole("dialog", { name: "Review before you sign" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    expect(FIXTURE_ACCOUNT).toBeTruthy();
  });
});
