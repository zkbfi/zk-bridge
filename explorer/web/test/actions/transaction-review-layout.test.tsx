/**
 * The layout of the review (owner, 2026-11-08: "the confirmation modal is hugely crowded"): the headline and the key
 * facts are on screen; the arguments, the gas numbers and what was sent so far sit behind Details; the decoded arguments
 * are always in the page; a call the page cannot read cannot be sent.
 */
import { screen, within } from "@testing-library/react";
import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { TransactionReview } from "../../src/actions/TransactionDialog";
import { buildConfirmView } from "../../src/tx/confirm-model";
import { planBridgeSteps } from "../../src/tx/bridge-steps";
import type { SequenceState } from "../../src/tx/transaction-sequence";
import { buildFixtureContext } from "../helpers";
import { renderPage } from "../render";

const owner = getAddress("0x8D43a3DF4951652d04bA29098D292136Af004Bdd");
const confirmHash = "0x9b8b5a632be6370761d5a34d2f6543af91b8305ca91e7127492ed7598fac36ee" as const;

const wrapSteps = async () => {
  const { context, tokens } = await buildFixtureContext({ allowance: 0n });
  const [wrap] = planBridgeSteps({ values: { token: "first:native", amount: "0.1", receiver: owner, mode: "plain", data: "", callGas: "", callbackGas: "" }, tokens, context, delivery: null });
  const gate = { ...wrap!, plan: { ...wrap!.plan, title: "Confirm this epoch on the gate (epoch 360442)" } };
  return [gate, wrap!] as const;
};

const reviewState = (steps: readonly [unknown, ...unknown[]] | readonly unknown[], wrap: (typeof steps)[number], overrides: Partial<SequenceState> = {}): SequenceState =>
  ({
    phase: "review",
    steps,
    stepIndex: 1,
    prepared: { plan: (wrap as { plan: unknown }).plan, from: owner, unsigned: { maxFeePerGas: 1_000_027n, maxPriorityFeePerGas: 1_000_000n }, gasEstimate: 406_633n, gasLimit: 487_959n, maximumNetworkFee: 487_972_174_893n },
    submittedHash: null,
    outcomes: [{ title: "Confirm this epoch on the gate (epoch 360442)", status: "success", transactionHash: confirmHash, gateConfirm: true }],
    error: null,
    ...overrides,
  }) as SequenceState;

const handlers = () => ({ onClose: vi.fn(), onCancel: vi.fn(), onConfirm: vi.fn(), onRetry: vi.fn() });

describe("the review of the owner's wrap", () => {
  it("leads with what happens, the amount and the destination, then the key facts, and keeps the raw facts behind Details", async () => {
    const steps = await wrapSteps();
    const view = buildConfirmView(steps[1]);
    const actions = handlers();
    renderPage(<TransactionReview steps={steps} state={reviewState(steps, steps[1])} view={view} variant="sheet" {...actions} />);
    const headline = screen.getByTestId("confirm-headline");
    expect(headline).toHaveTextContent("Wrap ETH and relay it to the other chain");
    expect(headline).toHaveTextContent("0.1 ETH");
    expect(headline).toHaveTextContent("to 0x8D43…4Bdd on PulseChain");
    expect(document.querySelectorAll(".zb-step")).toHaveLength(2);
    const review = screen.getByTestId("confirm-review");
    expect(within(review).getByText("Network fee").nextSibling).toHaveTextContent("at most ≈ 0.00000049 ETH");
    expect(screen.getByTestId("confirm-no-router")).toHaveTextContent(/^The delivery router wraps the coin you send, then relays it on the bridge\. It takes no fee/);
    const details = screen.getByTestId("confirm-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText("receiver").nextSibling).toHaveTextContent(owner);
    expect(within(details).getByText(/estimate 406633, limit 487959/)).toBeInTheDocument();
    expect(within(details).getByText(/max fee 0.001000027 gwei, tip 0.001 gwei/)).toBeInTheDocument();
    expect(within(within(details).getByTestId("confirm-sent")).getByText(confirmHash)).toBeInTheDocument();
    screen.getByRole("button", { name: "Send to wallet" }).click();
    expect(actions.onConfirm).toHaveBeenCalled();
  });

  it("refuses to send a call it cannot read, and still shows the facts", async () => {
    const steps = await wrapSteps();
    const broken = { ...steps[1], plan: { ...steps[1].plan, data: "0xdeadbeef" as const } };
    renderPage(<TransactionReview steps={[steps[0], broken]} state={reviewState([steps[0], broken], broken)} view={buildConfirmView(broken)} variant="sheet" {...handlers()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The page cannot read this call from its bytes, so it will not send it.");
    expect(screen.getByRole("button", { name: "Send to wallet" })).toBeDisabled();
    expect(screen.queryByTestId("confirm-headline")).toHaveTextContent("Wrap ETH");
  });

  it("opens what was sent so far after an error, and shows the step position in the explorer's modal", async () => {
    const steps = await wrapSteps();
    renderPage(<TransactionReview steps={steps} state={reviewState(steps, steps[1], { phase: "error", prepared: null, error: "Not sent." })} view={buildConfirmView(steps[1])} variant="modal" {...handlers()} />);
    expect((screen.getByTestId("confirm-sent") as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByText("Step 2 of 2")).toBeInTheDocument();
    expect(screen.queryByTestId("confirm-review")).toBeNull();
  });

  it("keeps the step list for one step out of the sheet: the headline names it", async () => {
    const steps = await wrapSteps();
    renderPage(<TransactionReview steps={[steps[1]]} state={reviewState([steps[1]], steps[1], { stepIndex: 0, outcomes: [] })} view={buildConfirmView(steps[1])} variant="sheet" {...handlers()} />);
    expect(document.querySelectorAll(".zb-step")).toHaveLength(0);
    expect(screen.queryByText(/^Step \d of/)).toBeNull();
    expect(screen.queryByTestId("confirm-sent")).toBeNull();
  });
});

describe("approxCoin", () => {
  it("rounds small amounts to two significant digits and keeps larger ones to six decimals", async () => {
    const { approxCoin } = await import("../../src/actions/TransactionDialog");
    expect(approxCoin(0n)).toBe("0");
    expect(approxCoin(487_972_174_893n)).toBe("≈ 0.00000049");
    expect(approxCoin(2_626_560_000_000_000n)).toBe("≈ 0.0026");
    expect(approxCoin(12_345_678_900_000_000n)).toBe("0.012345");
  });
});
