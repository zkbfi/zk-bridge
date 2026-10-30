import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeeLine, type FeeLineProps } from "../../src/bridge/FeeLine";

const props = (overrides: Partial<FeeLineProps> = {}): FeeLineProps => ({
  tip: <span>0.0012 ETH</span>,
  tipHelp: "The tip pays whoever delivers your transfer. It is 0.1% of the amount, at least their gas at today's price.",
  gas: <span>0.0004 PLS</span>,
  gasHelp: "What the delivery costs in gas on the destination.",
  gasLevel: 2,
  time: "~15 min",
  steps: [
    { label: "Sent on Ethereum", estimate: "~12 s", seconds: 12 },
    { label: "Final on Ethereum", estimate: "~13 min", seconds: 798 },
  ],
  sliders: [{ label: "Tip", help: "How much of the amount pays the deliverer.", value: 0.1, min: 0, max: 1, step: 0.01, valueText: "0.1%", ticks: [{ at: 0.04, label: "break-even for bots" }, { at: 0.3, label: "typical" }], onChange: vi.fn() }],
  sliderNote: "Left of break-even a delivery bot loses money at today's gas price.",
  ...overrides,
});

describe("the fee line", () => {
  it("shows icons and values, never the words tip or gas as labels", () => {
    const { container } = render(<FeeLine {...props()} />);
    const line = container.querySelector(".zb-fees")!;
    expect(line.textContent).not.toMatch(/\btip\b|\bgas\b/i);
    expect(screen.getByRole("img", { name: "Tip" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Gas" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Time" })).toBeInTheDocument();
  });

  it("explains each item in a tooltip", async () => {
    render(<FeeLine {...props()} />);
    await userEvent.hover(screen.getByRole("button", { name: /0.0012 ETH/ }));
    expect(screen.getByRole("tooltip")).toHaveTextContent(/0.1% of the amount/);
  });

  it("opens the tip drawer with sliders and tick marks, and closes it on a second click, a click away and Escape", async () => {
    render(<FeeLine {...props()} />);
    const tip = screen.getByRole("button", { name: /0.0012 ETH/ });
    await userEvent.click(tip);
    expect(tip).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("slider", { name: "Tip" })).toBeInTheDocument();
    expect(screen.getByText("break-even for bots")).toBeInTheDocument();
    await userEvent.click(tip);
    expect(screen.queryByRole("slider")).toBeNull();
    await userEvent.click(tip);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("slider")).toBeNull();
    await userEvent.click(tip);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("moves a slider", async () => {
    const onChange = vi.fn();
    render(<FeeLine {...props({ sliders: [{ ...props().sliders[0]!, onChange }] })} />);
    await userEvent.click(screen.getByRole("button", { name: /0.0012 ETH/ }));
    fireEvent.change(screen.getByRole("slider", { name: "Tip" }), { target: { value: "0.5" } });
    expect(onChange).toHaveBeenCalledWith(0.5);
  });

  it("lists every technical step in the time drawer", async () => {
    render(<FeeLine {...props()} />);
    await userEvent.click(screen.getByRole("button", { name: /~15 min/ }));
    expect(screen.getByText("Final on Ethereum")).toBeInTheDocument();
    expect(screen.getByText("~13 min")).toBeInTheDocument();
  });
});
