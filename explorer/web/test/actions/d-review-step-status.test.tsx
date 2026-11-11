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

const twoSteps = async () => {
  const { context, tokens } = await buildFixtureContext({ allowance: 0n });
  const [wrap] = planBridgeSteps({ values: { token: "first:native", amount: "0.1", receiver: owner, mode: "plain", data: "", callGas: "", callbackGas: "" }, tokens, context, delivery: null });
  const gate = { ...wrap!, plan: { ...wrap!.plan, title: "Confirm this epoch on the gate (epoch 360442)" } };
  return [gate, wrap!] as const;
};

const stateOf = (steps: readonly { readonly plan: unknown }[], overrides: Partial<SequenceState>): SequenceState =>
  ({
    phase: "wallet",
    steps,
    stepIndex: 0,
    prepared: { plan: steps[0]!.plan, from: owner, unsigned: { maxFeePerGas: 1_000_027n, maxPriorityFeePerGas: 1_000_000n }, gasEstimate: 1n, gasLimit: 2n, maximumNetworkFee: 3n },
    submittedHash: null,
    outcomes: [],
    error: null,
    ...overrides,
  }) as SequenceState;

const renderPhase = async (overrides: Partial<SequenceState>) => {
  const steps = await twoSteps();
  const handlers = { onClose: vi.fn(), onCancel: vi.fn(), onConfirm: vi.fn(), onRetry: vi.fn() };
  renderPage(<TransactionReview steps={steps} state={stateOf(steps, overrides)} view={buildConfirmView(steps[0])} variant="sheet" {...handlers} />);
  return document.querySelectorAll(".zb-step");
};

describe("the step list of the signing sheet", () => {
  it("says the current step is in the wallet while the wallet holds it, and the next one is next", async () => {
    const steps = await renderPhase({ phase: "wallet" });
    expect(steps).toHaveLength(2);
    expect(within(steps[0] as HTMLElement).getByText("in your wallet")).toBeInTheDocument();
    expect(within(steps[1] as HTMLElement).getByText("next")).toBeInTheDocument();
  });

  it("says the current step is confirming once it is submitted", async () => {
    const steps = await renderPhase({ phase: "confirming", submittedHash: `0x${"ab".repeat(32)}` });
    expect(within(steps[0] as HTMLElement).getByText("confirming")).toBeInTheDocument();
    expect(screen.getByText(/^Submitted as /)).toBeInTheDocument();
  });
});
