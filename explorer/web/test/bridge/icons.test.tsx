import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Chevron, GasCan, Identicon } from "../../src/bridge/icons";

describe("icons", () => {
  it("draws the gas level as solid bars, with no transparency", () => {
    const { container } = render(<GasCan level={2} title="Gas" />);
    const bars = [...container.querySelectorAll("[data-level] rect")];
    expect(bars).toHaveLength(3);
    expect(bars.map((bar) => bar.getAttribute("fill"))).toEqual(["currentColor", "currentColor", "var(--zb-pill-edge)"]);
    expect(container.innerHTML).not.toMatch(/opacity/i);
  });

  it("labels an icon with a title for screen readers and hides it otherwise", () => {
    expect(render(<Chevron title="Open" />).container.querySelector("svg")?.getAttribute("aria-label")).toBe("Open");
    expect(render(<Chevron />).container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("gives the same account the same identicon", () => {
    const a = render(<Identicon address="0x52908400098527886E0F7030069857D2E4169EE7" />).container.innerHTML;
    const b = render(<Identicon address="0x52908400098527886E0F7030069857D2E4169EE7" />).container.innerHTML;
    expect(a).toBe(b);
  });
});
