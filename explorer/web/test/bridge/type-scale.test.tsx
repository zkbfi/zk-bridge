import { render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Header } from "../../src/bridge/Header";

const dir = `${process.cwd()}/src/bridge`;
const css = readFileSync(`${dir}/bridge.css`, "utf8");
// The scale is defined once, in the block that starts at "Type and spacing scale" and ends at its closing brace.
const scaleStart = css.indexOf("/* Type and spacing scale");
const scaleBlock = css.slice(scaleStart, css.indexOf("}", scaleStart) + 1);
const outsideScale = css.slice(0, scaleStart) + css.slice(scaleStart + scaleBlock.length);

describe("the type and spacing scale (owner: \"the baseline should be larger\")", () => {
  it("defines fluid tokens once", () => {
    for (const token of ["--zb-step--1", "--zb-step-0", "--zb-step-1", "--zb-step-fee", "--zb-step-amount", "--zb-step-micro", "--zb-col-width", "--zb-touch", "--zb-joined-h", "--zb-go-h", "--zb-header-h", "--zb-row-h"]) {
      expect(scaleBlock).toMatch(new RegExp(`${token}:`));
    }
    expect(scaleBlock).toMatch(/--zb-step-0: clamp\(16px,/);
    expect(scaleBlock).toMatch(/--zb-step-amount: clamp\(40px,/);
    expect(scaleBlock).toMatch(/--zb-step--1: clamp\(14px,/);
    expect(scaleBlock).toMatch(/--zb-step-micro: 13px/);
  });

  it("uses no raw pixel font sizes outside the scale, in the CSS or inline in the bridge components", () => {
    expect(outsideScale.match(/font-size:\s*\d+(\.\d+)?px/g) ?? []).toEqual([]);
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".tsx"))) {
      const text = readFileSync(`${dir}/${file}`, "utf8");
      expect([file, text.match(/fontSize:\s*\d+/g) ?? []]).toEqual([file, []]);
    }
  });

  it("sizes the key parts with the tokens", () => {
    const rule = (selector: string): string => {
      const at = outsideScale.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      return outsideScale.slice(at, outsideScale.indexOf("}", at));
    };
    expect(rule(".zb")).toMatch(/var\(--zb-step-0\)/);
    expect(rule(".zb-amount")).toMatch(/var\(--zb-step-amount\)/);
    expect(rule(".zb-amount-out")).toMatch(/var\(--zb-step-amount\)/);
    expect(rule(".zb-col")).toMatch(/var\(--zb-col-width\)/);
    expect(rule(".zb-joined")).toMatch(/var\(--zb-joined-h\)/);
    expect(rule(".zb-go")).toMatch(/var\(--zb-go-h\)/);
    expect(rule(".zb-pill")).toMatch(/var\(--zb-touch\)/);
    expect(rule(".zb-header")).toMatch(/var\(--zb-header-h\)/);
    expect(rule(".zb-m-tall")).toMatch(/var\(--zb-row-h\)/);
    expect(rule(".zb-dctl")).toMatch(/var\(--zb-step-fee\)/);
  });
});

describe("the header's page name (owner: chevrons must not move)", () => {
  it("keeps both chevron slots and a name block sized by every page name, on every page", () => {
    for (const page of ["Activity", "Bridge", "Explore"]) {
      const { container, unmount } = render(<Header page={page} screenHref={(screen) => `#/${screen}`} homeHref="#/" onSearch={() => undefined} />);
      const slots = container.querySelectorAll(".zb-page-name > .zb-near");
      expect(slots).toHaveLength(2);
      const hidden = [...slots].filter((slot) => slot.getAttribute("data-hidden") === "true");
      expect(hidden).toHaveLength(page === "Bridge" ? 0 : 1);
      // The name block stacks every page name in one grid cell, so its width is the longest one's.
      const names = [...container.querySelectorAll(".zb-name-stack > span")].map((span) => span.textContent);
      expect(names).toEqual(["Activity", "Bridge", "Explore"]);
      expect(screen.getByTestId("page-name")).toHaveTextContent(page);
      unmount();
    }
    expect(css).toMatch(/\.zb-name-stack > span \{[^}]*grid-area: 1 \/ 1/);
    expect(css).toMatch(/\.zb-near\[data-hidden="true"\] \{[^}]*visibility: hidden/);
  });
});
