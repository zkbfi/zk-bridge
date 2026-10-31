import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { FeeLine, type FeeLineProps } from "../../src/bridge/FeeLine";

const props: FeeLineProps = {
  summary: "A bot delivers it · 0.1%",
  summaryFull: "A bot delivers it on PulseChain · fee 0.1%",
  gasHelp: "Gas level.",
  gasLevel: 1,
  onGasLevel: vi.fn(),
  time: "~15 min",
  steps: [{ label: "Final on Ethereum", estimate: "~13 min", seconds: 798 }],
  menu: <p>The delivery menu</p>,
};

const css = readFileSync(`${process.cwd()}/src/bridge/bridge.css`, "utf8");

const drawer = (container: HTMLElement) => container.querySelector<HTMLElement>(".zb-drawer")!;

describe("the fee drawer's motion", () => {
  it("toggles the open class and aria-expanded, and points the triggers at the drawer", async () => {
    const { container } = render(<FeeLine {...props} />);
    const tip = screen.getByRole("button", { name: /^Delivery settings/ });
    expect(tip).toHaveAttribute("aria-controls", drawer(container).id);
    expect(drawer(container)).not.toHaveClass("zb-open");
    expect(drawer(container)).toHaveAttribute("aria-hidden", "true");
    await userEvent.click(tip);
    expect(drawer(container)).toHaveClass("zb-open");
    expect(tip).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(tip);
    expect(drawer(container)).not.toHaveClass("zb-open");
    expect(tip).toHaveAttribute("aria-expanded", "false");
  });

  it("swaps by closing the content first, then reopening with the new item's", async () => {
    const { container } = render(<FeeLine {...props} />);
    await userEvent.click(screen.getByRole("button", { name: /^Delivery settings/ }));
    fireEvent.click(screen.getByRole("button", { name: /~15 min/ }));
    expect(drawer(container)).not.toHaveClass("zb-open");
    expect(container.querySelector(".zb-drawer-body")).toHaveAttribute("data-shown", "tip");
    await waitFor(() => expect(drawer(container)).toHaveClass("zb-open"));
    expect(container.querySelector(".zb-drawer-body")).toHaveAttribute("data-shown", "time");
    expect(screen.getByText("Final on Ethereum")).toBeInTheDocument();
  });

  it("closes on Escape and on a click outside", async () => {
    const { container } = render(<FeeLine {...props} />);
    await userEvent.click(screen.getByRole("button", { name: /^Delivery settings/ }));
    await userEvent.keyboard("{Escape}");
    expect(drawer(container)).not.toHaveClass("zb-open");
    await userEvent.click(screen.getByRole("button", { name: /^Delivery settings/ }));
    fireEvent.mouseDown(document.body);
    expect(drawer(container)).not.toHaveClass("zb-open");
  });

  it("uses the approved timings, and none under reduced motion", () => {
    expect(css).toMatch(/\.zb-drawer\.zb-open \{[^}]*grid-template-rows: 1fr; transition: grid-template-rows 200ms cubic-bezier\(\.2,\.7,\.2,1\)/);
    expect(css).toMatch(/\.zb-drawer \{[^}]*grid-template-rows 120ms cubic-bezier\(\.4,0,1,1\)/);
    expect(css).toMatch(/opacity 160ms cubic-bezier\(\.2,\.7,\.2,1\) 60ms/);
    expect(css).toMatch(/\.zb-drawer\.zb-open \.zb-drawer-body::before \{[^}]*transition: transform 220ms ease-out/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.zb-drawer, \.zb-drawer-body, \.zb-drawer-body::before, \.zb-fee \{ transition: none !important; \} \}/);
  });
});
