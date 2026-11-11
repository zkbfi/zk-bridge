import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import * as icons from "../../src/bridge/icons";

const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7" as const;
const drawn = ["Chevron", "LockIcon", "UnlockIcon", "FloppyIcon", "ListIcon", "OrbitIcon", "TakeMyMoney", "GasCan", "ClockIcon", "ExternalLink", "CopyIcon", "FlipIcon", "SearchIcon"] as const;

describe("the line icons", () => {
  it.each(drawn)("%s is hidden from screen readers without a title and named with one", (name) => {
    const Icon = icons[name];
    const plain = render(<Icon />).container.querySelector("svg")!;
    expect(plain.getAttribute("aria-hidden")).toBe("true");
    expect(plain.getAttribute("role")).toBeNull();
    const named = render(<Icon title={`the ${name}`} />).container.querySelector("svg")!;
    expect(named.getAttribute("role")).toBe("img");
    expect(named.getAttribute("aria-label")).toBe(`the ${name}`);
  });
});

describe("the gas can", () => {
  it("shows no bars without a level and lights as many bars as the level", () => {
    expect(render(<icons.GasCan />).container.querySelector("[data-level]")).toBeNull();
    const bars = render(<icons.GasCan level={2} />).container.querySelectorAll("[data-level] rect");
    expect([...bars].map((bar) => bar.getAttribute("fill"))).toEqual(["currentColor", "currentColor", "var(--zb-pill-edge)"]);
  });
});

describe("the identicon", () => {
  it("is a plain disc with no account, and a disc for an account", () => {
    const none = render(<icons.Identicon address={null} />).container.firstElementChild as HTMLElement;
    expect(none.style.background).toContain("--zb-pill-edge");
    const some = render(<icons.Identicon address={ADDRESS} />).container.firstElementChild as HTMLElement;
    expect(some.className).toBe("zb-ident");
    expect(some.getAttribute("aria-hidden")).toBe("true");
  });

  it("takes four hues from the address, the same for the same account and different for another", () => {
    expect(icons.identiconGradient(`0x00000a00010000000000007b${"0".repeat(16)}`)).toBe("conic-gradient(hsl(10 70% 55%) 0 25%, hsl(256 70% 55%) 0 50%, hsl(0 70% 55%) 0 75%, hsl(123 70% 55%) 0)");
    expect(icons.identiconGradient(ADDRESS)).toBe(icons.identiconGradient(ADDRESS));
    expect(icons.identiconGradient("0x0000000000000000000000000000000000000001")).not.toBe(icons.identiconGradient(ADDRESS));
  });
});
