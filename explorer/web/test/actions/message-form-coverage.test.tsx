import { StatefulMessageForm } from "../support/stateful";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { WebStep } from "../../src/tx/bridge-steps";
import { renderPage } from "../render";

const TARGET = `0x${"cd".repeat(20)}`;

const renderForm = () => {
  const onReview = vi.fn();
  renderPage(<StatefulMessageForm pair={FIXTURE_PAIR} onReview={onReview} />);
  return { onReview };
};

const pasteTarget = async (text: string) => {
  await userEvent.click(screen.getByLabelText(/^Target contract on/));
  await userEvent.paste(text);
};

describe("the message form", () => {
  it("sends from the first chain by default and names the other chain as the destination", () => {
    renderForm();
    expect(screen.getByLabelText("Send from")).toHaveValue("first");
    expect(screen.getByLabelText("Target contract on PulseChain")).toBeInTheDocument();
    expect(screen.getByText("Enter the target contract on the other chain.")).toBeInTheDocument();
  });

  it("swaps the source and the destination when the user sends from the second chain", async () => {
    renderForm();
    await userEvent.selectOptions(screen.getByLabelText("Send from"), "second");
    expect(screen.getByLabelText("Target contract on Ethereum")).toBeInTheDocument();
    expect(screen.getByLabelText("Gas for the call on Ethereum")).toBeInTheDocument();
    await pasteTarget(TARGET);
    expect(await screen.findByText("Sends from PulseChain. You see every detail before your wallet opens.")).toBeInTheDocument();
  });

  it("plans the call on the chain of the sender, with the data and the gas that the user typed", async () => {
    const { onReview } = renderForm();
    await userEvent.selectOptions(screen.getByLabelText("Send from"), "second");
    await pasteTarget(TARGET);
    await userEvent.click(screen.getByLabelText("Call data"));
    await userEvent.paste("0xabcd");
    const gas = screen.getByLabelText(/^Gas for the call on/);
    await userEvent.clear(gas);
    await userEvent.type(gas, "300000");
    expect(screen.getByLabelText("Call data")).toHaveValue("0xabcd");
    expect(gas).toHaveValue("300000");
    const review = screen.getByRole("button", { name: "Review transaction" });
    await waitFor(() => expect(review).toBeEnabled());
    await userEvent.click(review);
    const steps = onReview.mock.calls[0]![0] as readonly WebStep[];
    expect(steps).toHaveLength(1);
    expect(steps[0]!.plan.chain.chainId).toBe(FIXTURE_PAIR.second.chainId);
    expect(steps[0]!.plan.functionName).toBe("requireToPassMessage");
    expect(steps[0]!.disclosure.delivery).toBeNull();
  });

  it("disables Review and says why when the gas is not a whole number", async () => {
    renderForm();
    await pasteTarget(TARGET);
    const gas = screen.getByLabelText(/^Gas for the call on/);
    await userEvent.clear(gas);
    await userEvent.type(gas, "12.5");
    expect(screen.getByRole("button", { name: "Review transaction" })).toBeDisabled();
    expect(screen.getByText("The gas must be a whole number.")).toBeInTheDocument();
  });

  it("disables Review and shows the reason when the target is not an address", async () => {
    renderForm();
    await pasteTarget("0x12");
    expect(screen.getByRole("button", { name: "Review transaction" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review transaction" })).toHaveAccessibleDescription(/address/i);
  });

  it("sends nothing to the review when the form is submitted with a problem", () => {
    const { onReview } = renderForm();
    fireEvent.submit(screen.getByRole("form", { name: "Send a message" }));
    expect(onReview).not.toHaveBeenCalled();
  });
});
