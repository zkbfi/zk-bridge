import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChoicePill, FiltersPill, valueLabel, type FilterDef } from "../../src/explore/FilterMenus";

const defs: readonly FilterDef[] = [
  { kind: "menu", key: "status", label: "Status", any: "Any status", options: [{ value: "sent", label: "Sent" }, { value: "done", label: "Delivered" }] },
  { kind: "text", key: "start", label: "Starts with", placeholder: "0x…", accepts: /^0x[0-9a-f]*$/i, why: "Start with 0x." },
];

describe("a choice pill", () => {
  it("shows a value that is not among its options as nothing, and opens on Down only while closed", async () => {
    const onPick = vi.fn();
    render(<ChoicePill label="Sort" value="unknown" any="" options={[{ value: "a", label: "A" }]} onPick={onPick} />);
    const trigger = screen.getByRole("button", { name: /^Sort/ });
    expect(trigger).toHaveTextContent(/^Sort$/);
    fireEvent.keyDown(trigger, { key: "x" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("menu", { name: "Sort" })).toBeInTheDocument();
    // Already open: Down on the pill does not toggle or reopen it.
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    await userEvent.click(screen.getByRole("menuitemradio", { name: "A" }));
    expect(onPick).toHaveBeenCalledWith("a");
  });

  it("does not pick a disabled choice and keeps the menu open", async () => {
    const onPick = vi.fn();
    render(<ChoicePill label="Sort" value="" any="" options={[{ value: "a", label: "A (not yet)", disabled: true }]} onPick={onPick} />);
    await userEvent.click(screen.getByRole("button", { name: /^Sort/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "A (not yet)" }));
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});

describe("the Filters menu", () => {
  it("opens a filter with Right, goes back with Left or the Filters row, and shows each filter's value or Any", async () => {
    const onApply = vi.fn();
    render(<FiltersPill defs={defs} filters={{ status: "done" }} onApply={onApply} />);
    await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const menu = screen.getByRole("menu", { name: "Filters" });
    const status = within(menu).getByRole("menuitem", { name: /^Status/ });
    expect(status).toHaveTextContent("Delivered");
    expect(within(menu).getByRole("menuitem", { name: /^Starts with/ })).toHaveTextContent("Any");
    fireEvent.keyDown(status, { key: "x" });
    expect(within(menu).queryByText("Any status")).toBeNull();
    fireEvent.keyDown(status, { key: "ArrowRight" });
    expect(within(menu).getByRole("menuitemradio", { name: "Any status" })).toBeInTheDocument();
    const back = within(menu).getByRole("menuitem", { name: "Filters" });
    fireEvent.keyDown(back, { key: "x" });
    expect(within(menu).getByRole("menuitemradio", { name: "Any status" })).toBeInTheDocument();
    fireEvent.keyDown(back, { key: "ArrowLeft" });
    expect(within(menu).getByText("Filter by")).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("menuitem", { name: /^Status/ }));
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Filters" }));
    expect(within(menu).getByText("Filter by")).toBeInTheDocument();
  });

  it("goes back from a typed filter with Left, and applies a typed value on Enter, clearing it when empty", async () => {
    const onApply = vi.fn();
    render(<FiltersPill defs={defs} filters={{ start: "0xabc" }} onApply={onApply} />);
    await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: /^Starts with/ }));
    const box = screen.getByRole("textbox", { name: "Starts with" });
    expect(box).toHaveValue("0xabc");
    fireEvent.keyDown(box, { key: "a" });
    expect(onApply).not.toHaveBeenCalled();
    await userEvent.clear(box);
    await userEvent.type(box, "{Enter}");
    expect(onApply).toHaveBeenCalledWith("start", null);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("leaves the menu open with the reason when a typed value is refused, and goes back with Left inside a menu filter", async () => {
    render(<FiltersPill defs={defs} filters={{}} onApply={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: /^Status/ }));
    const pane = screen.getByRole("menuitemradio", { name: "Any status" }).parentElement!;
    fireEvent.keyDown(pane, { key: "x" });
    expect(screen.getByText("Status", { selector: ".zb-m-head" })).toBeInTheDocument();
    fireEvent.keyDown(pane, { key: "ArrowLeft" });
    await userEvent.click(screen.getByRole("menuitem", { name: /^Starts with/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "Starts with" }), "zz{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("Start with 0x.");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});

describe("the text of a filter's value", () => {
  it("is nothing without a value, a choice's label or the value, and a long typed value shortened", () => {
    expect(valueLabel(defs[0]!, undefined)).toBeNull();
    expect(valueLabel(defs[0]!, "sent")).toBe("Sent");
    expect(valueLabel(defs[0]!, "other")).toBe("other");
    expect(valueLabel(defs[1]!, "0xabc")).toBe("0xabc");
    expect(valueLabel(defs[1]!, `0x${"1".repeat(40)}`)).toBe("0x111111…1111");
  });
});
