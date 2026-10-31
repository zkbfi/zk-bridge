import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { collapseZeros, dollarsText } from "../../src/bridge/number";
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
  it("shows two decimals from $1, three significant digits below, and collapses three or more leading zeros", () => {
    expect(dollarsText(1_234_500_000_000_000_000_000n)).toBe("$1,234.50");
    expect(dollarsText(2_520_000_000_000_000_000n)).toBe("$2.52");
    expect(dollarsText(25_000_000_000_000_000n)).toBe("$0.025");
    expect(dollarsText(169_123_000_000_000_000n)).toBe("$0.169");
    expect(dollarsText(50_400_000_000n)).toBe("$0.0₇504");
    expect(dollarsText(56_200_000_000_000n)).toBe("$0.0₄562");
    expect(dollarsText(0n)).toBe("$0");
  });
});
