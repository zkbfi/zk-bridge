import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { collapseZeros, dollarsText, shortAmountText } from "../../src/bridge/number";
import { Num } from "../../src/bridge/Num";

describe("collapseZeros", () => {
  it("collapses three or more leading zeros after the point into a count", () => {
    expect(collapseZeros("0.0001234")).toEqual({ lead: "0.0", zeros: 3, rest: "1234" });
    expect(collapseZeros("0.00000042")).toEqual({ lead: "0.0", zeros: 6, rest: "42" });
  });

  it("leaves numbers with fewer than three leading zeros, and whole numbers, as they are", () => {
    expect(collapseZeros("0.0012")).toBeNull();
    expect(collapseZeros("0.01")).toBeNull();
    expect(collapseZeros("12.5")).toBeNull();
    expect(collapseZeros("1.0001")).toBeNull();
    expect(collapseZeros("0")).toBeNull();
    expect(collapseZeros("")).toBeNull();
  });
});

describe("Num", () => {
  it("renders the count as a subscript and keeps the full value for screen readers", () => {
    const { container } = render(<Num text="0.0001234" />);
    expect(container.querySelector("sub")?.textContent).toBe("3");
    expect(container.textContent).toContain("1234");
    expect(container.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe("0.0001234");
  });

  it("renders a short number as plain text", () => {
    const { container } = render(<Num text="0.0012" />);
    expect(container.querySelector("sub")).toBeNull();
    expect(container.textContent).toBe("0.0012");
  });
});

describe("dollars as text", () => {
  it("shows two decimals from one cent, three significant digits below, and collapses three or more leading zeros", () => {
    expect(dollarsText(1_234_500_000_000_000_000_000n)).toBe("$1,234.50");
    expect(dollarsText(2_520_000_000_000_000_000n)).toBe("$2.52");
    expect(dollarsText(25_000_000_000_000_000n)).toBe("$0.02");
    expect(dollarsText(500_000_000_000_000_000n)).toBe("$0.50");
    expect(dollarsText(10_000_000_000_000_000n)).toBe("$0.01");
    expect(dollarsText(9_990_000_000_000_000n)).toBe("$0.00999");
    expect(dollarsText(169_123_000_000_000_000n)).toBe("$0.16");
    expect(dollarsText(50_400_000_000n)).toBe("$0.0₇504");
    expect(dollarsText(56_200_000_000_000n)).toBe("$0.0₄562");
    expect(dollarsText(0n)).toBe("$0");
  });
});

describe("a short amount as text", () => {
  it("collapses three or more leading zeros with subscript digits, cut to three significant digits", () => {
    expect(shortAmountText(315_000_000_000n, 18)).toBe("0.0₆315");
    expect(shortAmountText(840_000_000_000_000n, 18)).toBe("0.0₃84");
    expect(shortAmountText(12_000_000_000_000_000n, 18)).toBe("0.012");
    expect(shortAmountText(0n, 18)).toBe("0");
  });
  it("keeps three significant digits from one, and whole units from a thousand", () => {
    expect(shortAmountText(1_234_500_000_000_000_000n, 18)).toBe("1.23");
    expect(shortAmountText(2_000_000_000_000_000_000n, 18)).toBe("2");
    expect(shortAmountText(45_678n, 3)).toBe("45.6");
    expect(shortAmountText(1_234_567n, 3)).toBe("1,234");
  });
});
