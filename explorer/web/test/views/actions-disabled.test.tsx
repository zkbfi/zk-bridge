import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ActionArea } from "../../src/views/pair/ActionArea";
import { ActionDialog } from "../../src/actions/ActionDialogs";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { renderPage } from "../render";

describe("the action area", () => {
  it("disables every action until a wallet is connected, and says why", () => {
    renderPage(<ActionArea pair={FIXTURE_PAIR} snapshots={undefined} snapshotError={null} />, { connected: false });
    for (const name of [/Bridge tokens/, /Wrap the native coin/, /Send a message/, /Claim balances/]) expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByText(/Connect a wallet to act/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect wallet" })).toBeEnabled();
  });

  it("enables the actions once a wallet is connected, and opens the dialog that was asked for", async () => {
    const open = vi.fn();
    renderPage(<ActionArea pair={FIXTURE_PAIR} snapshots={undefined} snapshotError={null} />, { connected: true, actions: { open } });
    for (const name of [/Bridge tokens/, /Wrap the native coin/, /Send a message/, /Claim balances/]) expect(screen.getByRole("button", { name })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /Send a message/ }));
    expect(open).toHaveBeenCalledWith("message");
  });

  it("shows a simulated wallet as simulated", () => {
    renderPage(<ActionArea pair={FIXTURE_PAIR} snapshots={undefined} snapshotError={null} />);
    expect(screen.getByText(/Simulated wallet\. Nothing reaches a chain/)).toBeInTheDocument();
  });

  it("shows balances of both chains, and the claimable amount, with no fee rate", async () => {
    const { buildFixtureContext } = await import("../helpers");
    const { context } = await buildFixtureContext();
    renderPage(<ActionArea pair={FIXTURE_PAIR} snapshots={context.snapshots ?? undefined} snapshotError={null} />);
    const ethereum = screen.getByTestId("balances-1");
    expect(within(ethereum).queryByText(/Bridge fee/)).toBeNull();
    expect(within(ethereum).getByText(/25 USDC claimable/)).toBeInTheDocument();
    expect(screen.getByTestId("balances-369")).toBeInTheDocument();
  });
});

describe("the action dialogs", () => {
  it("asks to connect a wallet first when none is connected", async () => {
    renderPage(<ActionDialog dialog="bridge" onClose={() => undefined} />, { connected: false });
    expect(await screen.findByText(/Connect a wallet first/)).toBeInTheDocument();
  });

  it("lists the claimable balance and starts the review of a claim", async () => {
    renderPage(<ActionDialog dialog="claim" onClose={() => undefined} />);
    const claim = await screen.findByRole("button", { name: "Claim USDC" }, { timeout: 15_000 });
    await userEvent.click(claim);
    expect(await screen.findByRole("dialog", { name: "Review before you sign" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("claim(address,address)")).toBeInTheDocument());
  });

  it("disables Review in the message form until the target is an address, then reviews requireToPassMessage", async () => {
    renderPage(<ActionDialog dialog="message" onClose={() => undefined} />);
    const review = await screen.findByRole("button", { name: "Review transaction" }, { timeout: 15_000 });
    expect(review).toBeDisabled();
    expect(review).toHaveAccessibleDescription(/Enter the target contract/);
    await userEvent.type(screen.getByLabelText(/^Target contract on/), "0x12");
    expect(review).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/^Target contract on/));
    await userEvent.click(screen.getByLabelText(/^Target contract on/));
    await userEvent.paste(`0x${"cd".repeat(20)}`);
    await waitFor(() => expect(review).toBeEnabled());
    await userEvent.click(review);
    expect(await screen.findByText("requireToPassMessage(address,bytes,uint256)")).toBeInTheDocument();
  });

  it("keeps the form values when the user cancels the review", async () => {
    renderPage(<ActionDialog dialog="message" onClose={() => undefined} />);
    await userEvent.click(await screen.findByLabelText(/^Target contract on/, undefined, { timeout: 15_000 }));
    await userEvent.paste(`0x${"cd".repeat(20)}`);
    await userEvent.click(screen.getByRole("button", { name: "Review transaction" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Review before you sign" })).toBeNull());
    expect(screen.getByLabelText(/^Target contract on/)).toHaveValue(`0x${"cd".repeat(20)}`);
  });
});
