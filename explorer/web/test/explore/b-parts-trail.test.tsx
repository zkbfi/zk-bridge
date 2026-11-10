import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { StepTrail } from "../../src/explore/StepTrail";
import { XBand, XRow, shortHex } from "../../src/explore/parts";
import { lightClientCards } from "../../src/explore/explore-model";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import type { LightClientHead } from "@terminal/model/types";

describe("StepTrail rows", () => {
  it("draws each kind of step: a drawer toggles, an external link opens a tab, an internal link and a plain step stay", () => {
    render(
      <StepTrail
        steps={[
          { label: "Sent", done: true, when: "1 min ago", drawer: <p>details</p> },
          { label: "Final", done: true, when: "now", href: "https://scan.example/tx", external: true },
          { label: "Proof", done: false, when: "waiting", href: "/tx/0x1" },
          { label: "Delivered", done: false, when: "waiting" },
        ]}
      />,
    );
    const toggle = screen.getByRole("button", { name: /Sent/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const external = screen.getByRole("link", { name: /Final/ });
    expect(external.getAttribute("target")).toBe("_blank");
    expect(external.getAttribute("rel")).toBe("noreferrer");
    const internal = screen.getByRole("link", { name: /Proof/ });
    expect(internal.getAttribute("href")).toBe("/tx/0x1");
    expect(internal.getAttribute("target")).toBeNull();
    expect(document.querySelectorAll(".zb-trail-gap")).toHaveLength(1);
  });

  it("marks an internal-link step as the one now, and a drawerless external step without an href as a plain row", () => {
    render(<StepTrail steps={[{ label: "A", done: true, when: "x", external: true }]} initiallyOpen={0} />);
    expect(document.querySelector("li")!.getAttribute("data-state")).toBe("done");
    expect(document.querySelectorAll("a, button")).toHaveLength(0);
  });
});

describe("XRow", () => {
  it("shows the title alone, or with a subtitle", () => {
    const { rerender } = render(<XRow href="/a" title="Title" />);
    expect(document.querySelector(".zb-xrow-text span")).toBeNull();
    rerender(<XRow href="/a" title="Title" sub="Subtitle" />);
    expect(document.querySelector(".zb-xrow-text span")!.textContent).toBe("Subtitle");
  });
});

describe("shortHex", () => {
  it("keeps a short value whole and shortens a long one to its ends", () => {
    expect(shortHex("0x1234")).toBe("0x1234");
    expect(shortHex("0x" + "a".repeat(12))).toBe("0x" + "a".repeat(12));
    expect(shortHex(`0x4663c8c2${"0".repeat(30)}28db`)).toBe("0x4663c8c2…28db");
  });
});

describe("light-client card lag", () => {
  const head = (lagSlots: bigint | null): LightClientHead => ({ side: "first", lagSlots, secondsPerSlot: 12, storedHeadSlot: 5n, lastUpdateAt: 100 }) as LightClientHead;

  it("reads no lag, a current head and a lagging head", () => {
    const cards = lightClientCards([head(null), head(5n), head(7200n)], FIXTURE_PAIR);
    expect(cards.map((card) => card.lagText)).toEqual(["lag unknown", "current", "24 h behind"]);
    expect(cards.map((card) => card.behind)).toEqual([false, false, true]);
    expect(cards[0]!.fill).toBe(0);
  });
});

describe("XBand", () => {
  it("shows only the label and the big name, or the icon, second label and tags too", () => {
    const { container, rerender } = render(<XBand label="Chain" big="Ethereum" />);
    expect(container.querySelectorAll(".zb-xband-lbl")).toHaveLength(1);
    expect(container.querySelector(".zb-xband-tags")).toBeNull();
    rerender(<XBand label="Chain" big="Ethereum" sub="Mainnet" icon={<i data-testid="icon" />} tags={<b>tag</b>} />);
    expect(container.querySelectorAll(".zb-xband-lbl")).toHaveLength(2);
    expect(container.querySelector(".zb-xband-tags")!.textContent).toBe("tag");
    expect(screen.getByTestId("icon")).toBeTruthy();
  });
});
