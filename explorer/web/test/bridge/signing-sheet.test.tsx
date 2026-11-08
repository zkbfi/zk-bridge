import { screen, within } from "@testing-library/react";
import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { TransactionDialog } from "../../src/actions/TransactionDialog";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS } from "../../src/tx/bridge-draft";
import type { SequenceState, TransactionSequence } from "../../src/tx/transaction-sequence";
import { buildDeliveryReport, buildFixtureContext } from "../helpers";
import { connectedWallet, renderWithWallet } from "../app/support";

const hookState = vi.hoisted(() => ({ current: null as null | { state: SequenceState; sequence: TransactionSequence } }));
vi.mock("../../src/actions/use-transaction-sequence", () => ({ useTransactionSequence: () => hookState.current }));

describe("the signing dialog on the bridge screen", () => {
  it("is a sheet with the transactions as a joined step list and pill buttons, not the explorer's modal", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 0n });
    const draft = computeBridgeDraft(
      { token: `first:${FIXTURE_TOKENS[0]!.address}`, amount: "250", receiver: getAddress(`0x${"cd".repeat(20)}`), mode: "plain", data: "", callGas: "", callbackGas: "" },
      { ...DEFAULT_DELIVERY_OPTIONS, mode: "none" },
      { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n },
    );
    hookState.current = {
      sequence: { cancel: () => undefined, confirm: () => undefined, retry: () => undefined, start: () => undefined, subscribe: () => () => undefined, getState: () => hookState.current!.state },
      state: { phase: "preparing", steps: draft.steps, stepIndex: 0, prepared: null, submittedHash: null, outcomes: [], error: null } as unknown as SequenceState,
    };
    renderWithWallet(<TransactionDialog steps={draft.steps} variant="sheet" onClose={() => undefined} />, { wallet: connectedWallet() });
    const sheet = screen.getByRole("dialog", { name: "Review before you sign" });
    expect(sheet.className).toContain("zb-sheet");
    const steps = sheet.querySelectorAll(".zb-step");
    expect(steps.length).toBe(draft.steps.length);
    expect(steps[0]?.getAttribute("data-state")).toBe("now");
    // The headline names the current step; the step list names every step.
    expect(within(sheet).getByTestId("confirm-headline")).toHaveTextContent(draft.steps[0]!.plan.title);
    expect(within(sheet).getAllByText(draft.steps[0]!.plan.title)).toHaveLength(2);
  });

  it("shows an inserted gate confirmation in the step list, the wait for a beacon header, and a retry after a reverted confirmation", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 30n });
    const draft = computeBridgeDraft(
      { token: `first:${FIXTURE_TOKENS[0]!.address}`, amount: "250", receiver: getAddress(`0x${"cd".repeat(20)}`), mode: "plain", data: "", callGas: "", callbackGas: "" },
      { ...DEFAULT_DELIVERY_OPTIONS, mode: "none" },
      { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n },
    );
    const relay = draft.steps.at(-1)!;
    const confirmStep = { ...relay, plan: { ...relay.plan, title: "Confirm this epoch on the gate (epoch 360335)" }, gateConfirm: { epoch: 360_335n, gas: 150_000n, validUntil: 1n } };
    const retry = vi.fn();
    const cancel = vi.fn();
    const sequence = { cancel, confirm: () => undefined, retry, start: () => undefined, subscribe: () => () => undefined, getState: () => hookState.current!.state };
    hookState.current = {
      sequence,
      state: { phase: "waiting", steps: [relay], stepIndex: 0, prepared: null, submittedHash: null, outcomes: [], error: null, gateWait: { chainName: "Ethereum", epoch: 360_335n, seconds: 12 } } as SequenceState,
    };
    const view = renderWithWallet(<TransactionDialog steps={[relay]} variant="sheet" onClose={() => undefined} />, { wallet: connectedWallet() });
    expect(screen.getByText("The Ethereum deposit gate needs a beacon header of epoch 360335 on chain before this epoch can be confirmed. Checking again in 12 seconds.")).toBeInTheDocument();
    screen.getByRole("button", { name: "Cancel" }).click();
    expect(cancel).toHaveBeenCalled();

    hookState.current = {
      sequence,
      state: { phase: "waiting", steps: [relay], stepIndex: 0, prepared: null, submittedHash: null, outcomes: [], error: null, gateWait: { chainName: "Ethereum", epoch: 360_335n, seconds: 22, epochSecondsLeft: 10 } } as SequenceState,
    };
    view.rerender(<TransactionDialog steps={[relay]} variant="sheet" onClose={() => undefined} />);
    expect(screen.getByText("Epoch 360335 of the Ethereum deposit gate ends in 10 seconds, too soon for a confirmation and your send to land in it. Waiting for the next epoch: checking again in 22 seconds.")).toBeInTheDocument();

    hookState.current = {
      sequence,
      state: {
        phase: "error",
        steps: [confirmStep, relay],
        stepIndex: 0,
        prepared: null,
        submittedHash: null,
        outcomes: [{ title: confirmStep.plan.title, status: "reverted", transactionHash: `0x${"01".repeat(32)}`, gateConfirm: true }],
        error: "The confirmation of epoch 360335 reverted.",
      } as SequenceState,
    };
    view.rerender(<TransactionDialog steps={[relay]} variant="sheet" onClose={() => undefined} />);
    const sheet = screen.getByRole("dialog", { name: "Review before you sign" });
    expect(sheet.querySelectorAll(".zb-step")).toHaveLength(2);
    expect(within(sheet).getAllByText("Confirm this epoch on the gate (epoch 360335)").length).toBeGreaterThan(0);
    screen.getByRole("button", { name: "Try again" }).click();
    expect(retry).toHaveBeenCalled();

    hookState.current = { sequence, state: { phase: "finished", steps: [confirmStep, relay], stepIndex: 2, prepared: null, submittedHash: null, outcomes: [], error: null } as SequenceState };
    view.rerender(<TransactionDialog steps={[relay]} variant="sheet" onClose={() => undefined} />);
    expect([...screen.getByRole("dialog", { name: "Review before you sign" }).querySelectorAll(".zb-step")].map((step) => step.getAttribute("data-state"))).toEqual(["done", "done"]);
  });
});
