import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BridgeQuery } from "../../src/app/route";
import { DeliveryMenu, deliverySummary, type DeliveryMenuProps } from "../../src/bridge/DeliveryMenu";

const props = (overrides: Partial<DeliveryMenuProps> = {}): DeliveryMenuProps => ({
  form: {},
  defaultRouter: null,
  onChange: vi.fn(),
  tipChoice: "automatic",
  onTipChoice: vi.fn(),
  value: null,
  gas: null,
  caps: [],
  breakdown: [],
  note: null,
  callbackGas: null,
  ...overrides,
});
const field = (name: string) => screen.getByRole("textbox", { name });
const labelled = (label: string): HTMLInputElement => within(screen.getByText(label).closest("label")!).getByRole("textbox") as HTMLInputElement;

describe("the delivery menu without sliders", () => {
  it("shows only who delivers and the Advanced fold when there is no value, gas, cap, breakdown or note", () => {
    render(<DeliveryMenu {...props()} />);
    expect(screen.getByRole("radiogroup", { name: "Who delivers" })).toBeInTheDocument();
    expect(document.querySelector(".zb-menu-control")).toBeNull();
    expect(document.querySelector(".zb-breakdown")).toBeNull();
    expect(document.querySelector(".zb-slider-note")).toBeNull();
    expect(screen.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows a note under the values, and says what No tip means", () => {
    render(<DeliveryMenu {...props({ note: "Left of break-even a bot loses money.", tipChoice: "none" })} />);
    expect(screen.getByText("Left of break-even a bot loses money.")).toBeInTheDocument();
    expect(screen.getByTestId("no-tip-note")).toHaveTextContent(/^No tip: anyone can deliver it, for free; it may take longer\.$/);
  });

  it("reports the mode chosen", async () => {
    const onTipChoice = vi.fn();
    render(<DeliveryMenu {...props({ onTipChoice })} />);
    await userEvent.click(screen.getByRole("radio", { name: "Fixed" }));
    expect(onTipChoice).toHaveBeenCalledWith("fixed");
    expect(screen.getByRole("radio", { name: "Automatic" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("the Advanced fold", () => {
  it("opens closed, offers the router with a default placeholder, and writes or clears the router typed", async () => {
    const onChange = vi.fn();
    render(<DeliveryMenu {...props({ onChange })} />);
    await userEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(labelled("Relay router").placeholder).toBe("default");
    fireEvent.change(labelled("Relay router"), { target: { value: "0xabc" } });
    expect(onChange).toHaveBeenLastCalledWith({ tip: { routerText: "0xabc" } });
  });

  it("names the default router as the placeholder and clears a router that is emptied", () => {
    const onChange = vi.fn();
    render(<DeliveryMenu {...props({ onChange, defaultRouter: "0xdefa", form: { tip: { routerText: "0xmine" } } })} />);
    expect(labelled("Relay router").placeholder).toBe("0xdefa");
    expect(labelled("Relay router").value).toBe("0xmine");
    fireEvent.change(labelled("Relay router"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ tip: { routerText: undefined } });
  });

  it("takes a call target, then its data and gas, and drops all three when the target is cleared", () => {
    const onChange = vi.fn();
    const form: BridgeQuery = { callTarget: "0xc0ffee", callData: "0x1234", callGas: "300000" };
    const { rerender } = render(<DeliveryMenu {...props({ onChange, form })} />);
    // A link that names a call opens the fold on its own.
    expect(labelled("Call data").value).toBe("0x1234");
    fireEvent.change(labelled("Call data"), { target: { value: "0x99" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...form, callData: "0x99" });
    fireEvent.change(labelled("Call data"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...form, callData: undefined });
    fireEvent.change(field("Call gas"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...form, callGas: undefined });
    fireEvent.change(field("Call gas"), { target: { value: "500000" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...form, callGas: "500000" });
    fireEvent.change(labelled("Call after delivery"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...form, callTarget: undefined, callData: undefined, callGas: undefined });
    fireEvent.change(labelled("Call after delivery"), { target: { value: "0xbeef" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...form, callTarget: "0xbeef", callData: "0x1234" });
    // No target, no call data or gas fields.
    rerender(<DeliveryMenu {...props({ onChange, form: { tip: { routerText: "0xr" } } })} />);
    expect(screen.queryByText("Call data")).toBeNull();
    expect(screen.queryByText("Call gas")).toBeNull();
  });

  it("sends call data that is empty for a target typed with none", () => {
    const onChange = vi.fn();
    render(<DeliveryMenu {...props({ onChange, form: { callTarget: "0xc0ffee" } })} />);
    expect(labelled("Call data").value).toBe("");
    expect(field("Call gas")).toHaveValue("");
    fireEvent.change(labelled("Call data"), { target: { value: "0x01" } });
    expect(onChange).toHaveBeenLastCalledWith({ callTarget: "0xc0ffee", callData: "0x01" });
  });

  it("shows the callback gas the page worked out, grouped", () => {
    render(<DeliveryMenu {...props({ callbackGas: 1234567n, form: { callTarget: "0xc0ffee", callGas: "300000" } })} />);
    expect(screen.getByTestId("callback-gas")).toHaveTextContent("1,234,567 (set for you: the call gas plus the router's own work)");
  });
});

describe("deliverySummary details", () => {
  const FACTS = { destination: "PulseChain", feeShareText: "0.39%", worstCaseText: "$0.60", fixedText: "0.50 USDC" };

  it("says a call gas that is not a plain number as typed, and groups one that is", () => {
    const target = "0x1234567890abcdef1234567890abcdef123456ab";
    expect(deliverySummary({ callTarget: target, callGas: " lots ", tip: {} }, FACTS).full).toMatch(/with lots gas$/);
    expect(deliverySummary({ callTarget: target, callGas: "1000000", tip: {} }, FACTS).full).toMatch(/with 1,000,000 gas$/);
  });

  it("names the worst case without a share when the share is empty or missing", () => {
    expect(deliverySummary({ tip: { mode: "gas-multiplier" } }, { ...FACTS, worstCaseShareText: "" }).text).toBe("Deliver for ~0.39%, max $0.60");
    expect(deliverySummary({ tip: { mode: "gas-multiplier" } }, FACTS).text).toBe("Deliver for ~0.39%, max $0.60");
    expect(deliverySummary({ tip: { mode: "gas-multiplier" } }, { ...FACTS, worstCaseShareText: "0.6%" }).text).toBe("Deliver for ~0.39%, max $0.60 (0.6%)");
  });
});
