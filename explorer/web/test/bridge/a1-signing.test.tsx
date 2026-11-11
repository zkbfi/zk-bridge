import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { clearPending, usePending } from "../../src/bridge/pending";
import { connectedWallet, renderWithWallet } from "../app/support";
import { USDC_QUERY } from "./token-link";

// The signing dialog is the transaction sequence's own business (tested with it); here it is a stand-in that reports
// what the bridge screen hands it and how it finishes, so the screen's side of the send is what is under test.
vi.mock("../../src/actions/TransactionDialog", () => ({
  TransactionDialog: ({ steps, onClose, onFinished }: { steps: readonly unknown[]; onClose: () => void; onFinished?: (hash: string) => void }) => (
    <div role="dialog" aria-label="Signing">
      <span data-testid="steps">{steps.length}</span>
      <button type="button" onClick={() => onFinished?.(`0x${"ab".repeat(32)}`)}>
        finish
      </button>
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

const Pending = () => <output data-testid="pending">{usePending().map((entry) => `${entry.sourceTransactionHash}|${entry.direction}|${entry.token.symbol}|${entry.amount}`).join(",")}</output>;

beforeEach(() => {
  window.localStorage.clear();
  clearPending();
});

const confirm = async () => {
  window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?${USDC_QUERY}&bridge.amount=50`);
  renderWithWallet(
    <>
      <Shell />
      <Pending />
    </>,
    { wallet: connectedWallet() },
  );
  await waitFor(() => expect(document.querySelector<HTMLButtonElement>(".zb-go")).toBeEnabled(), { timeout: 4000 });
  await userEvent.click(document.querySelector<HTMLButtonElement>(".zb-go")!);
  await userEvent.click(await screen.findByRole("button", { name: "Confirm in wallet" }));
  return screen.findByRole("dialog", { name: "Signing" });
};

describe("sending from the review sheet", () => {
  it("hands the draft's steps to the signing dialog and closes the review", async () => {
    await confirm();
    expect(Number(screen.getByTestId("steps").textContent)).toBeGreaterThan(0);
    expect(screen.queryByRole("dialog", { name: "Review" })).toBeNull();
  });

  it("records the transfer as sent, with the token and amount that were reviewed, once the send finishes", async () => {
    await confirm();
    expect(screen.getByTestId("pending")).toHaveTextContent("");
    await userEvent.click(screen.getByRole("button", { name: "finish" }));
    expect(screen.getByTestId("pending").textContent).toBe(`0x${"ab".repeat(32)}|first-to-second|USDC|50000000`);
  });

  it("closes the signing dialog without recording anything", async () => {
    await confirm();
    await userEvent.click(screen.getByRole("button", { name: "close" }));
    expect(screen.queryByRole("dialog", { name: "Signing" })).toBeNull();
    expect(screen.getByTestId("pending")).toHaveTextContent("");
  });
});
