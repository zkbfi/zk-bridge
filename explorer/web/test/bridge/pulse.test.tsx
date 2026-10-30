import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PulseTrack } from "../../src/bridge/PulseTrack";
import { StepList } from "../../src/bridge/StepList";

describe("PulseTrack", () => {
  it("uses no transparency anywhere", () => {
    const { container } = render(<PulseTrack position={0.55} label="Final" />);
    expect(container.innerHTML).not.toMatch(/opacity/i);
  });

  it("lights the track up to the pill, and the stops it has passed", () => {
    const { container } = render(<PulseTrack position={0.55} label="Final" />);
    const lit = container.querySelector('[data-part="lit"]')!;
    expect(Number(lit.getAttribute("x2"))).toBeCloseTo(8 + 104 * 0.55);
    const fills = [...container.querySelectorAll('[data-part="stop"]')].map((stop) => stop.getAttribute("fill"));
    expect(fills).toEqual(["var(--zb-stop-passed)", "var(--zb-stop-passed)", "var(--zb-stop-ahead)"]);
    expect(container.querySelector('[data-part="destination"]')?.getAttribute("fill")).toBe("var(--zb-track-ahead)");
  });

  it("draws a delivered transfer as a solid track with both dots lit and no pill", () => {
    const { container } = render(<PulseTrack position={1} label="Delivered" />);
    expect(container.querySelector('[data-part="pill"]')).toBeNull();
    expect(container.querySelector('[data-part="destination"]')?.getAttribute("fill")).toBe("var(--zb-accent)");
  });

  it("uses the matched proportions: the pill twice the track, the stops a third of the pill", () => {
    const { container } = render(<PulseTrack position={0.5} label="x" />);
    const pill = container.querySelector('[data-part="pill"] line')!;
    expect(Number(pill.getAttribute("stroke-width"))).toBeCloseTo(6.4);
    expect(Number(container.querySelector('[data-part="lit"]')!.getAttribute("stroke-width"))).toBe(3);
    expect(Number(container.querySelector('[data-part="stop"]')!.getAttribute("r")) * 2).toBeCloseTo(6.4 / 3, 0);
  });
});

describe("StepList", () => {
  const steps = [
    { label: "Sent on PulseChain", at: "12:03:10", href: "https://scan.example/tx/0x1" },
    { label: "Final on PulseChain", at: "12:13:50" },
    { label: "Proof posted to Ethereum", at: "12:16:02", href: "https://etherscan.example/tx/0x2" },
    { label: "Delivered", estimate: "~2 min", href: "https://etherscan.example/tx/0x3" },
  ];

  it("lights the steps up to the current one and joins them", () => {
    const { container } = render(<StepList steps={steps} current={2} />);
    expect([...container.querySelectorAll("li")].map((item) => item.getAttribute("data-state"))).toEqual(["done", "done", "now", "ahead"]);
  });

  it("links each reached step to the explorer from the right end, and never a step ahead", () => {
    render(<StepList steps={steps} current={2} />);
    const link = screen.getByRole("link", { name: "Proof posted to Ethereum on the explorer" });
    expect(link).toHaveAttribute("href", "https://etherscan.example/tx/0x2");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(link.previousElementSibling?.className).toBe("zb-step-time");
    expect(screen.queryByRole("link", { name: "Delivered on the explorer" })).toBeNull();
    expect(screen.getByText("~2 min")).toBeInTheDocument();
  });
});
