import { screen } from "@testing-library/react";
import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR, FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { TransactionDialog } from "../../src/actions/TransactionDialog";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS } from "../../src/tx/bridge-draft";
import type { SequenceState, TransactionSequence } from "../../src/tx/transaction-sequence";
import { buildDeliveryReport, buildFixtureContext } from "../helpers";
import { connectedWallet, renderWithWallet } from "../app/support";

const hookState = vi.hoisted(() => ({ current: null as null | { state: SequenceState; sequence: TransactionSequence } }));

vi.mock("../../src/actions/use-transaction-sequence", () => ({ useTransactionSequence: () => hookState.current }));

/**
 * The sequence of the page always sets the fees and the hash. The state type allows both to be missing, so the dialog
 * must still say something true when they are. This test hands the dialog such a state.
 */
describe("the confirm dialog with a state that has no fees and no hash", () => {
  it("shows zero for the missing fees and omits the hash", async () => {
    const { context, tokens } = await buildFixtureContext({ allowance: 10n ** 12n });
    const draft = computeBridgeDraft(
      { token: `first:${FIXTURE_TOKENS[0]!.address}`, amount: "250", receiver: getAddress(`0x${"cd".repeat(20)}`), mode: "plain", data: "", gasLimit: "" },
      { ...DEFAULT_DELIVERY_OPTIONS, mode: "none" },
      { pair: FIXTURE_PAIR, tokens, context, report: buildDeliveryReport(369), priorityFeeWei: 10n ** 9n },
    );
    const step = draft.steps[0]!;
    hookState.current = {
      sequence: { cancel: () => undefined, confirm: () => undefined, retry: () => undefined, start: () => undefined, subscribe: () => () => undefined, getState: () => hookState.current!.state },
      state: {
        phase: "confirming",
        steps: [step],
        stepIndex: 0,
        prepared: {
          plan: step.plan,
          from: FIXTURE_ACCOUNT,
          unsigned: { type: "eip1559", chainId: 1, to: step.plan.to, data: step.plan.data, value: 0n },
          gasEstimate: 100_000n,
          gasLimit: 120_000n,
          maximumNetworkFee: 0n,
        },
        submittedHash: null,
        outcomes: [],
        error: null,
      },
    };
    renderWithWallet(<TransactionDialog steps={[step]} onClose={() => undefined} />, { wallet: connectedWallet() });
    expect(screen.getByText("Submitted. Waiting for the chain to confirm it…")).toBeInTheDocument();
    expect(screen.getByText(/max fee 0 gwei, tip 0 gwei/)).toBeInTheDocument();
  });
});
