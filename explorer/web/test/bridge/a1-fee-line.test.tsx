import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeeControl, FeeLine, HelpButton, type FeeLineProps, type FeeSlider } from "../../src/bridge/FeeLine";

const slider = (overrides: Partial<FeeSlider> = {}): FeeSlider => ({ label: "Tip", help: "What the deliverer keeps.", value: 0.5, min: 0, max: 1, step: 0.01, ticks: [], onChange: vi.fn(), ...overrides });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the help button", () => {
  it("shows its text while the pointer is on it and hides it when the pointer leaves", async () => {
    render(<HelpButton label="Tip" text="What the deliverer keeps." />);
    const button = screen.getByRole("button", { name: "About Tip" });
    await userEvent.hover(button);
    expect(screen.getByRole("tooltip")).toHaveTextContent("What the deliverer keeps.");
    expect(button).toHaveAttribute("aria-expanded", "true");
    await userEvent.unhover(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("stays open once tapped, and closes when it loses focus", async () => {
    render(<HelpButton label="Tip" text="What the deliverer keeps." />);
    const button = screen.getByRole("button", { name: "About Tip" });
    await userEvent.click(button);
    await userEvent.unhover(button);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await userEvent.click(document.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });
});

describe("the gas bars' keys", () => {
  const props = (gasLevel: FeeLineProps["gasLevel"], onGasLevel: FeeLineProps["onGasLevel"]): FeeLineProps => ({ summary: "Deliver", summaryFull: "Deliver", gasHelp: "Gas.", gasLevel, onGasLevel, time: "~15 min", steps: [], menu: null });
  const bars = () => screen.getByRole("button", { name: /^Gas level: / });

  it("step up with the up and right arrows and down with the down and left arrows, one level at a time", async () => {
    const onGasLevel = vi.fn();
    render(<FeeLine {...props(2, onGasLevel)} />);
    bars().focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(onGasLevel).toHaveBeenLastCalledWith(3);
    await userEvent.keyboard("{ArrowRight}");
    expect(onGasLevel).toHaveBeenLastCalledWith(3);
    await userEvent.keyboard("{ArrowDown}");
    expect(onGasLevel).toHaveBeenLastCalledWith(1);
    await userEvent.keyboard("{ArrowLeft}");
    expect(onGasLevel).toHaveBeenLastCalledWith(1);
    expect(onGasLevel).toHaveBeenCalledTimes(4);
  });

  it("stop at High and at Low instead of wrapping", async () => {
    const onGasLevel = vi.fn();
    const { rerender } = render(<FeeLine {...props(3, onGasLevel)} />);
    bars().focus();
    await userEvent.keyboard("{ArrowUp}");
    rerender(<FeeLine {...props(1, onGasLevel)} />);
    await userEvent.keyboard("{ArrowDown}");
    expect(onGasLevel).not.toHaveBeenCalled();
  });

  it("leave other keys alone, and keep the arrows from reaching the screen's own arrow keys", () => {
    const onGasLevel = vi.fn();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <FeeLine {...props(2, onGasLevel)} />
      </div>,
    );
    const key = (name: string) => fireEvent.keyDown(bars(), { key: name });
    expect(key("a")).toBe(true);
    expect(outer).toHaveBeenCalledTimes(1);
    expect(key("ArrowUp")).toBe(false);
    expect(outer).toHaveBeenCalledTimes(1);
    expect(onGasLevel).toHaveBeenCalledTimes(1);
  });
});

describe("the pill's segments", () => {
  const base: FeeLineProps = { summary: "Deliver", summaryFull: "Deliver full", gasHelp: "Gas help.", gasLevel: 2, time: "~15 min", steps: [], menu: null };

  it("each explain themselves while the pointer or the keyboard is on them, and stop when it leaves", async () => {
    render(<FeeLine {...base} onGasLevel={vi.fn()} />);
    const segments: Array<[string, RegExp]> = [
      [`Delivery settings: Deliver full`, /Tap for the delivery settings\.$/],
      ["Gas level: Normal. Change", /^Gas help\.$/],
      ["~15 min", /Tap for every step\.$/],
    ];
    for (const [name, text] of segments) {
      const segment = screen.getByRole("button", { name: name === "~15 min" ? /~15 min/ : name });
      await userEvent.hover(segment);
      expect(screen.getByRole("tooltip")).toHaveTextContent(text);
      await userEvent.unhover(segment);
      expect(screen.queryByRole("tooltip")).toBeNull();
      act(() => segment.focus());
      expect(screen.getByRole("tooltip")).toHaveTextContent(text);
      act(() => segment.blur());
      expect(screen.queryByRole("tooltip")).toBeNull();
    }
  });

  it("explains a gas can that only shows the level (no way to change it) the same way", async () => {
    const { container } = render(<FeeLine {...base} />);
    const can = container.querySelector<HTMLElement>('span[data-fee="gas"]')!;
    await userEvent.hover(can);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Gas help.");
    await userEvent.unhover(can);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("a slider's undo", () => {
  it("offers a way back to the earlier value after a reset when the control has no exact input", async () => {
    const written: number[] = [];
    const Harness = () => {
      const [value, setValue] = useState(0.7);
      return <FeeControl slider={slider({ value, onChange: (next) => { written.push(next); setValue(next); }, recommended: { at: 0.2, differs: value !== 0.2, onReset: () => setValue(0.2) } })} />;
    };
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Reset to recommended" }));
    expect(screen.getByRole("slider", { name: "Tip" })).toHaveValue("0.2");
    await userEvent.click(screen.getByRole("button", { name: "Back to your earlier value" }));
    expect(written).toEqual([0.7]);
    expect(screen.getByRole("slider", { name: "Tip" })).toHaveValue("0.7");
  });
});

describe("a slider whose range is a single point", () => {
  it("draws everything at the start of the track instead of dividing by zero", () => {
    const { container } = render(<FeeControl slider={slider({ min: 1, max: 1, value: 1 })} />);
    expect(container.querySelector<HTMLElement>(".zb-range-knob")!.style.left).toBe("0%");
    expect(container.querySelector<HTMLElement>(".zb-range-fill")!.style.width).toBe("0%");
  });
});

describe("the track's width", () => {
  const ticks = [{ at: 0.2, label: "break-even for bots" }, { at: 0.4, label: "typical delivery" }];
  const labels = (container: HTMLElement): string[] => [...container.querySelectorAll(".zb-ticks span")].map((node) => node.textContent ?? "");

  it("uses the measured width: labels that collide on a phone's column fit on a wide track", () => {
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 2000 } as DOMRect);
    const { container } = render(<FeeControl slider={slider({ ticks })} />);
    expect(measure).toHaveBeenCalled();
    expect(labels(container)).toEqual(["break-even for bots", "typical delivery"]);
    expect(screen.getByRole("button", { name: "About Tip" })).toBeInTheDocument();
  });

  it("assumes a phone's column while nothing has a size, so the second label moves into the help", () => {
    const { container } = render(<FeeControl slider={slider({ ticks })} />);
    expect(labels(container)).toEqual(["break-even for bots"]);
  });

  it("follows the track as it is resized, and lets go of the observer when the control goes", () => {
    const observers: Array<{ callback: () => void; disconnect: ReturnType<typeof vi.fn> }> = [];
    class Observer {
      readonly disconnect = vi.fn();
      constructor(readonly callback: () => void) {
        observers.push(this);
      }
      observe(): void {}
    }
    vi.stubGlobal("ResizeObserver", Observer);
    let width = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width }) as DOMRect);
    const { container, unmount } = render(<FeeControl slider={slider({ ticks })} />);
    expect(labels(container)).toEqual(["break-even for bots"]);
    width = 2000;
    act(() => observers[0]!.callback());
    expect(labels(container)).toEqual(["break-even for bots", "typical delivery"]);
    unmount();
    expect(observers[0]!.disconnect).toHaveBeenCalled();
  });

  it("works where the browser has no resize observer", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { container } = render(<FeeControl slider={slider({ ticks })} />);
    expect(labels(container)).toEqual(["break-even for bots"]);
  });
});
