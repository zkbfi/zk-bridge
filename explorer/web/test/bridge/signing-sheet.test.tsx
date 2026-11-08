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
    expect(within(sheet).getByText(draft.steps[0]!.plan.title)).toBeInTheDocument();
  });
});
