import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeeControl, FeeLine, tickLabels, type FeeLineProps, type FeeSlider } from "../../src/bridge/FeeLine";

const tipSlider: FeeSlider = { label: "Tip", help: "How much of the amount pays the deliverer.", value: 0.1, min: 0, max: 1, step: 0.01, valueText: "0.1%", ticks: [{ at: 0.04, label: "break-even for bots" }, { at: 0.3, label: "typical" }], onChange: vi.fn() };
const menuOf = (sliders: readonly FeeSlider[]) => (
  <div role="group" aria-label="Delivery settings">
    {sliders.map((slider) => (
      <FeeControl key={slider.label} slider={slider} />
    ))}
  </div>
);

const props = (overrides: Partial<FeeLineProps> = {}): FeeLineProps => ({
  summary: "Deliver for 0.39%, max $0.39",
  summaryFull: "Deliver for 0.39%, max $0.39",
  gasHelp: "Gas level: Low up to 2× today's base fee, Normal 3×, High 5×.",
  gasLevel: 2,
  time: "~15 min",
  steps: [
    { label: "Sent on Ethereum", estimate: "~12 s", seconds: 12 },
    { label: "Final on Ethereum", estimate: "~13 min", seconds: 798 },
  ],
  menu: menuOf([tipSlider]),
  ...overrides,
});
const summary = () => screen.getByRole("button", { name: /^Delivery settings/ });

describe("the delivery control (owner, quote 98)", () => {
  it("is one joined pill: the take-my-money summary, the gas can and the time, with no second row", () => {
    const { container } = render(<FeeLine {...props()} />);
    const pill = container.querySelector(".zb-joined.zb-dctl")!;
    expect(pill.querySelectorAll(".zb-dseg")).toHaveLength(3);
    expect(summary()).toHaveTextContent("Deliver for 0.39%, max $0.39");
    expect(summary()).toHaveAccessibleName("Delivery settings: Deliver for 0.39%, max $0.39");
    expect(summary().querySelector("svg.zb-icon-fill")).not.toBeNull();
    expect(screen.getByRole("img", { name: "Gas" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Time" })).toBeInTheDocument();
    expect(container.querySelector(".zb-fees")).toBeNull();
    expect(container.querySelector('[data-fee="gas"]')!.textContent).toBe("");
  });

  it("makes the bars beside the gas can the level control: a tap asks for the next level, wrapping after High", async () => {
    const onGasLevel = vi.fn();
    const { rerender } = render(<FeeLine {...props({ gasLevel: 1, onGasLevel })} />);
    await userEvent.click(screen.getByRole("button", { name: "Gas level: Low. Change" }));
    expect(onGasLevel).toHaveBeenLastCalledWith(2);
    rerender(<FeeLine {...props({ gasLevel: 2, onGasLevel })} />);
    await userEvent.click(screen.getByRole("button", { name: "Gas level: Normal. Change" }));
    expect(onGasLevel).toHaveBeenLastCalledWith(3);
    rerender(<FeeLine {...props({ gasLevel: 3, onGasLevel })} />);
    await userEvent.click(screen.getByRole("button", { name: "Gas level: High. Change" }));
    expect(onGasLevel).toHaveBeenLastCalledWith(1);
    // No level yet reads as the default, Normal, so the next one is High.
    rerender(<FeeLine {...props({ gasLevel: 0, onGasLevel })} />);
    await userEvent.click(screen.getByRole("button", { name: "Gas level: Normal. Change" }));
    expect(onGasLevel).toHaveBeenLastCalledWith(3);
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("says the whole arrangement in the summary's tooltip", async () => {
    render(<FeeLine {...props()} />);
    await userEvent.hover(summary());
    expect(screen.getByRole("tooltip")).toHaveTextContent("Deliver for 0.39%, max $0.39. Tap for the delivery settings.");
  });

  it("says who sets a value, with the way back", async () => {
    const onClick = vi.fn();
    render(<FeeLine {...props({ menu: menuOf([{ ...tipSlider, status: { text: "Set by you · the automatic fee is off", action: { label: "Back to automatic", onClick } } }]) })} />);
    await userEvent.click(summary());
    expect(screen.getByText("Set by you · the automatic fee is off")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to automatic" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("gives every value the same ? button, named for it, its tooltip on hover or tap", async () => {
    render(<FeeLine {...props()} />);
    await userEvent.click(summary());
    const help = screen.getByRole("button", { name: "About Tip" });
    expect(help).toHaveClass("zb-q");
    await userEvent.hover(help);
    expect(screen.getByRole("tooltip")).toHaveTextContent("How much of the amount pays the deliverer.");
  });

  it("opens the one delivery menu, and closes it on a second click, a click away and Escape", async () => {
    render(<FeeLine {...props()} />);
    await userEvent.click(summary());
    expect(summary()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("slider", { name: "Tip" })).toBeInTheDocument();
    expect(screen.getByText("break-even for bots")).toBeInTheDocument();
    await userEvent.click(summary());
    expect(screen.queryByRole("slider")).toBeNull();
    await userEvent.click(summary());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("slider")).toBeNull();
    await userEvent.click(summary());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("moves a slider", async () => {
    const onChange = vi.fn();
    render(<FeeLine {...props({ menu: menuOf([{ ...tipSlider, onChange }]) })} />);
    await userEvent.click(summary());
    fireEvent.change(screen.getByRole("slider", { name: "Tip" }), { target: { value: "0.5" } });
    expect(onChange).toHaveBeenCalledWith(0.5);
  });

  it("lists every technical step under the time", async () => {
    render(<FeeLine {...props()} />);
    await userEvent.click(screen.getByRole("button", { name: /~15 min/ }));
    expect(screen.getByText("Final on Ethereum")).toBeInTheDocument();
    expect(screen.getByText("~13 min")).toBeInTheDocument();
  });

  it("puts a small floppy-disk save button beside a value that can be saved, disabled once saved", async () => {
    const onSave = vi.fn();
    const cap = { label: "Automatic fee cap", help: "The most the automatic fee may take.", value: 0.5, min: 0.05, max: 2, step: 0.05, valueText: "0.5%", ticks: [], onChange: vi.fn() };
    const { rerender } = render(<FeeLine {...props({ menu: menuOf([{ ...cap, save: { saved: false, onSave, label: "Save 0.5% as your default cap" } }]) })} />);
    await userEvent.click(summary());
    const save = screen.getByRole("button", { name: "Save 0.5% as your default cap" });
    expect(save.querySelector("svg")).not.toBeNull();
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledOnce();
    rerender(<FeeLine {...props({ menu: menuOf([{ ...cap, save: { saved: true, onSave, label: "0.5% is your default cap" } }]) })} />);
    expect(screen.getByRole("button", { name: "0.5% is your default cap" })).toBeDisabled();
  });
});

describe("one control for every fee value (owner, quote 90)", () => {
  const base = (overrides: Partial<FeeSlider> = {}): FeeSlider => ({ label: "Hard fee cap", help: "The most the fee may be.", value: 2, min: 0, max: 5, step: 0.05, ticks: [], onChange: vi.fn(), ...overrides });

  it("has a recommended tick, and a reset only while the value differs", async () => {
    const onReset = vi.fn();
    const { rerender } = render(<FeeControl slider={base({ recommended: { at: 2, differs: false, onReset } })} />);
    expect(screen.getByText("recommended")).toBeInTheDocument();
    expect(document.querySelector(".zb-range-tick[data-recommended]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to recommended" })).toBeNull();
    rerender(<FeeControl slider={base({ value: 3, recommended: { at: 2, differs: true, onReset } })} />);
    await userEvent.click(screen.getByRole("button", { name: "Reset to recommended" }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("offers a one-step undo where the reset was, until this value or anything else changes", async () => {
    const onText = vi.fn();
    const onReset = vi.fn();
    const slider = (value: number, differs: boolean) => base({ value, input: { text: String(value), unit: "%", check: () => null, onText }, recommended: { at: 2, differs, onReset } });
    const { rerender } = render(
      <>
        <FeeControl slider={slider(0.44, true)} />
        <input aria-label="elsewhere" />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Reset to recommended" }));
    expect(onReset).toHaveBeenCalledOnce();
    const again = () => (
      <>
        <FeeControl slider={slider(2, false)} />
        <input aria-label="elsewhere" />
      </>
    );
    rerender(again());
    await userEvent.click(screen.getByRole("button", { name: "Back to your 0.44%" }));
    expect(onText).toHaveBeenLastCalledWith("0.44");
    expect(screen.queryByRole("button", { name: "Back to your 0.44%" })).toBeNull();
    // A second reset, then a change elsewhere: the undo is gone.
    rerender(
      <>
        <FeeControl slider={slider(0.5, true)} />
        <input aria-label="elsewhere" />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Reset to recommended" }));
    rerender(again());
    expect(screen.getByRole("button", { name: "Back to your 0.5%" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "elsewhere" }), "x");
    expect(screen.queryByRole("button", { name: /Back to your/ })).toBeNull();
  });

  it("takes an exact value against its unit, writes it once it passes, names a problem inline, and shows the value in force after", async () => {
    const onText = vi.fn();
    const check = (text: string) => (Number.isFinite(Number(text)) && text !== "" ? null : "Enter a number.");
    render(<FeeControl slider={base({ input: { text: "2", unit: "%", check, onText } })} />);
    const field = screen.getByRole("textbox", { name: "Hard fee cap, exact" });
    expect(field.nextElementSibling).toHaveTextContent("%");
    await userEvent.clear(field);
    await userEvent.type(field, "2.5");
    expect(onText).toHaveBeenLastCalledWith("2.5");
    await userEvent.type(field, "x");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a number.");
    expect(field).toHaveAttribute("aria-invalid", "true");
    fireEvent.blur(field);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field).toHaveValue("2");
  });

  it("shades a band on the track with its anchor, and a note under it", () => {
    render(<FeeControl slider={base({ band: { from: 1, to: 4, mark: 2, label: "Could land between $1 and $4" }, note: "Anchored at today's gas" })} />);
    const band = screen.getByRole("img", { name: "Could land between $1 and $4" });
    expect(band.style.left).toBe("20%");
    expect(band.style.width).toBe("60%");
    expect((document.querySelector(".zb-range-anchor") as HTMLElement).style.left).toBe("40%");
    expect(screen.getByText("Anchored at today's gas")).toBeInTheDocument();
  });
});

describe("tickLabels", () => {
  it("keeps labels on one row, the most important first, and leaves out one that would touch another", () => {
    const placed = tickLabels(
      [
        { label: "recommended", left: 30 },
        { label: "2× cost", left: 33 },
        { label: "high cap", left: 90 },
      ],
      320,
    );
    expect(placed.shown.map((tick) => tick.label)).toEqual(["recommended", "high cap"]);
    expect(placed.hidden).toEqual(["2× cost"]);
  });

  it("shows every label on a track wide enough for them", () => {
    const placed = tickLabels(
      [
        { label: "recommended", left: 10 },
        { label: "2× cost", left: 40 },
        { label: "high cap", left: 90 },
      ],
      600,
    );
    expect(placed.shown.map((tick) => tick.label)).toEqual(["recommended", "2× cost", "high cap"]);
    expect(placed.hidden).toEqual([]);
  });

  it("names a left-out label in the control's help, and keeps its mark", async () => {
    render(<FeeControl slider={{ label: "Tip", help: "The tip.", value: 0.1, min: 0, max: 1, step: 0.01, ticks: [{ at: 0.31, label: "2× cost" }], recommended: { at: 0.3, differs: false, onReset: vi.fn() }, onChange: vi.fn() }} />);
    expect(screen.getByText("recommended")).toBeInTheDocument();
    expect(screen.queryByText("2× cost")).toBeNull();
    expect(document.querySelectorAll(".zb-range-tick")).toHaveLength(2);
    await userEvent.hover(screen.getByRole("button", { name: "About Tip" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("The tip. Also marked on the track: 2× cost.");
  });

  it("returns nothing for no ticks", () => {
    expect(tickLabels([], 320)).toEqual({ shown: [], hidden: [] });
  });
});

describe("the time drawer with a wait timeline (2026-11-07)", () => {
  it("shows the timeline instead of the plain step list when one is given, and the steps when none is", async () => {
    const { unmount } = render(<FeeLine {...props({ timeline: <p>typical 18 min · up to 75 min</p> })} />);
    await userEvent.click(document.querySelector('[data-fee="time"]') as HTMLElement);
    expect(screen.getByText("typical 18 min · up to 75 min")).toBeInTheDocument();
    expect(screen.queryByText("Sent on Ethereum")).toBeNull();
    unmount();
    render(<FeeLine {...props()} />);
    await userEvent.click(document.querySelector('[data-fee="time"]') as HTMLElement);
    expect(screen.getByText("Sent on Ethereum")).toBeInTheDocument();
  });
});

describe("a route that carries no tip (the native coin)", () => {
  it("says so in a segment that opens nothing, leaves out the gas level, and keeps the time", async () => {
    const full = "Sent as ETH: no tip; anyone can deliver it, for free; it may take longer.";
    const { container } = render(<FeeLine {...props({ tipless: true, summary: "No tip", summaryFull: full })} />);
    const pill = container.querySelector(".zb-joined.zb-dctl")!;
    expect(pill.querySelectorAll(".zb-dseg")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^Delivery settings/ })).toBeNull();
    expect(screen.queryByRole("img", { name: "Gas" })).toBeNull();
    const segment = pill.querySelector('[data-fee="none"]')!;
    expect(segment).toHaveTextContent("No tip");
    expect(segment).toHaveAccessibleName(full);
    await userEvent.hover(segment);
    expect(screen.getByRole("tooltip")).toHaveTextContent(full);
    expect(screen.getByRole("tooltip")).not.toHaveTextContent(/delivery settings/);
    expect(screen.getByRole("img", { name: "Time" })).toBeInTheDocument();
  });
});
