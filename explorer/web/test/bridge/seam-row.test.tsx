import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { Shell } from "../../src/app/Shell";
import { disconnectedWallet, renderWithWallet } from "../app/support";
import { readFileSync } from "node:fs";

// Owner: "the middle buttons ... should all be in between the top and bottom": the flip and the tip, gas and time pills are
// one row on the seam, a sibling between the two band sections and in neither.

beforeEach(() => {
  window.localStorage.clear();
});

describe("the middle row", () => {
  it("is rendered between the From band and the To band, in neither, with the flip and all three pills", async () => {
    window.history.replaceState(null, "", `#/bridge/${FIXTURE_PAIR.id}?bridge.amount=1`);
    renderWithWallet(<Shell />, { wallet: disconnectedWallet() });
    const from = await screen.findByRole("region", { name: /^You send/ });
    const to = screen.getByRole("region", { name: /^You receive/ });
    await waitFor(() => expect(document.querySelector('[data-fee="tip"]')).not.toBeNull());
    const seam = document.querySelector(".zb-seam")!;
    expect(seam.previousElementSibling).toBe(from);
    expect(seam.nextElementSibling).toBe(to);
    expect(from.contains(seam) || to.contains(seam)).toBe(false);
    for (const part of ['[aria-label^="Flip"]', '[data-fee="tip"]', '[data-fee="gas"]', '[data-fee="time"]']) {
      expect(seam.querySelector(part)).not.toBeNull();
      expect(from.querySelector(part) ?? to.querySelector(part)).toBeNull();
    }
  });

  it("is centred on the boundary: it overlaps the From band by half its height and paints the To colour from its centre down", () => {
    const css = readFileSync("src/bridge/bridge.css", "utf8");
    expect(css).toMatch(/\.zb-seam \{[^}]*margin-top: calc\(var\(--zb-joined-h\) \/ -2\)/);
    expect(css).toMatch(/\.zb-seam \{[^}]*transparent calc\(var\(--zb-joined-h\) \/ 2\), var\(--zb-to\) calc\(var\(--zb-joined-h\) \/ 2\)/);
    expect(css).toMatch(/\.zb-band-from \.zb-col \{[^}]*padding-block: 14px calc\(var\(--zb-joined-h\) \/ 2 \+ 14px\)/);
  });
});
