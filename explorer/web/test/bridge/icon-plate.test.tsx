import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TokenIcon } from "../../src/bridge/TokenIcon";

const css = readFileSync(`${process.cwd()}/src/bridge/bridge.css`, "utf8");
const packageCss = readFileSync(`${process.cwd()}/../react/styles.css`, "utf8");

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
    // Each theme names its plate from its palette: white on Ember light, that theme's black on Ember dark and Mono.
    const plate = (theme: string): string => {
      const block = new RegExp(`${theme} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      const name = /--zb-plate: var\(--zb-p-([\w-]+)\)/.exec(block)?.[1] ?? "";
      return `${name} ${new RegExp(`--zb-p-${name}: (#[0-9a-f]{6})`).exec(block)?.[1] ?? ""}`;
    };
    expect(plate("\\.theme-ember-light")).toBe("white #ffffff");
    expect(plate("\\.theme-ember-dark")).toMatch(/^black #1[0-4]1[0-4]1[0-4]$/);
    expect(plate("\\.theme-mono")).toMatch(/^black #0[0-9a-f]0[0-9a-f]0[0-9a-f]$/);
    // The component reads the plate through its own variable, which the dapp maps to the theme's plate.
    expect(packageCss).toMatch(/\.zb-tok-icon\.zb-on-accent \{[^}]*background: var\(--zkb-plate, [^)]*\)[^}]*padding: 2px/);
    expect(css).toMatch(/--zkb-plate: var\(--zb-plate\)/);
  });
});
