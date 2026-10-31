import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TokenIcon } from "../../src/bridge/TokenIcon";

const css = readFileSync(`${process.cwd()}/src/bridge/bridge.css`, "utf8");

describe("icons on the accent band (owner: \"we need to have a neutral bg such as white or black\")", () => {
  it("sit on a neutral plate when the surface is the accent, and on none elsewhere", () => {
    const { container, rerender } = render(<TokenIcon subject={{ chainId: 1 }} symbol="ETH" surface="accent" size={28} />);
    const icon = container.querySelector(".zb-tok-icon")!;
    expect(icon).toHaveClass("zb-on-accent");
    // The plate adds 2 px around the icon.
    expect(icon).toHaveStyle({ width: "32px", height: "32px" });
    rerender(<TokenIcon subject={{ chainId: 1 }} symbol="ETH" size={28} />);
    expect(container.querySelector(".zb-tok-icon")).not.toHaveClass("zb-on-accent");
  });

  it("uses a plate colour per theme: white on Ember light, ink on Ember dark and Mono", () => {
    expect(css).toMatch(/--zb-plate: #ffffff/);
    expect(css).toMatch(/\.theme-ember-dark \{[^}]*--zb-plate: #121110/);
    expect(css).toMatch(/\.theme-mono \{[^}]*--zb-plate: #000000/);
    expect(css).toMatch(/\.zb-tok-icon\.zb-on-accent \{[^}]*background: var\(--zb-plate\)[^}]*padding: 2px/);
  });
});
