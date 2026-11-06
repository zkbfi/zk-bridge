import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { PAGE } from "../src/page.ts";

const check = (id: string, name: string, state: "ok" | "degraded" | "down", detail: string) => ({
  id, name, state, detail, latencyMs: null, since: null, uptime: {},
});
const status = {
  generatedAt: 1_000_000,
  summary: { status: "operational", message: "All 3 checks pass.", checkedAt: 999_000 },
  sections: [
    { title: "Bridges & gates", checks: [check("gate-943", "PulseChain testnet gate", "ok", "detection mode (detect-beacon-roots): admits sends"), check("bridge-943", "PulseChain testnet bridge", "ok", "deposits are open")] },
    { title: "Pipeline", checks: [check("pipeline-warmup", "Prover warm-ups (24 h)", "degraded", "3 warm-ups in 24 h")] },
  ],
};

/** Opens the page at `hash` with the status API faked, and waits for the first render. */
async function open(hash: string) {
  const scrolled: string[] = [];
  const dom = new JSDOM(PAGE, {
    url: `https://status.example/${hash}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      (window.Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = function (this: Element) { scrolled.push(this.getAttribute("data-check") ?? ""); };
      (window as unknown as { fetch: unknown }).fetch = vi.fn(async (url: string) => ({ json: async () => (url.startsWith("/api/status") ? status : { checks: {} }) }));
    },
  });
  await vi.waitFor(() => expect(dom.window.document.querySelectorAll(".row").length).toBe(3));
  const document = dom.window.document;
  const visible = () => Array.from(document.querySelectorAll(".row:not(.hidden)")).map((row) => row.getAttribute("data-check"));
  return { dom, document, scrolled, visible };
}

describe("the page script", () => {
  it("draws a link to each check", async () => {
    const { document } = await open("");
    expect(document.querySelector('.row[data-check="gate-943"] a')?.getAttribute("href")).toBe("#check=gate-943");
    expect(document.querySelectorAll(".target").length).toBe(0);
  });

  it("scrolls to and highlights the check of #check=<id>", async () => {
    const { document, scrolled } = await open("#check=pipeline-warmup");
    expect(Array.from(document.querySelectorAll(".target")).map((row) => row.getAttribute("data-check"))).toEqual(["pipeline-warmup"]);
    expect(scrolled).toEqual(["pipeline-warmup"]);
  });

  it("follows a later change of the anchor, and ignores an unknown id or a broken one", async () => {
    const { dom, document, scrolled } = await open("#check=nope");
    expect(document.querySelectorAll(".target").length).toBe(0);
    dom.window.location.hash = "#check=gate-943";
    await vi.waitFor(() => expect(document.querySelector(".target")?.getAttribute("data-check")).toBe("gate-943"));
    expect(scrolled).toEqual(["gate-943"]);
    dom.window.location.hash = "#check=%E0%A4%A";
    await vi.waitFor(() => expect(document.querySelectorAll(".target").length).toBe(0));
    dom.window.location.hash = "#other";
    await vi.waitFor(() => expect(document.querySelectorAll(".target").length).toBe(0));
  });

  it("filters the checks by name, id, state and detail, and hides empty sections", async () => {
    const { dom, document, visible } = await open("");
    const filter = document.getElementById("filter") as HTMLInputElement;
    const type = (text: string) => { filter.value = text; filter.dispatchEvent(new dom.window.Event("input")); };
    type("gate");
    expect(visible()).toEqual(["gate-943"]);
    expect(document.querySelectorAll("h2.hidden").length).toBe(1);
    type("degraded");
    expect(visible()).toEqual(["pipeline-warmup"]);
    type("deposits open");
    expect(visible()).toEqual(["bridge-943"]);
    type("zzz");
    expect(visible()).toEqual([]);
    expect(document.getElementById("none-found")?.classList.contains("hidden")).toBe(false);
    type("");
    expect(visible().length).toBe(3);
    expect(document.getElementById("none-found")?.classList.contains("hidden")).toBe(true);
  });

  it("clears the filter when the anchor names a check that the filter hides", async () => {
    const { dom, document, visible } = await open("");
    const filter = document.getElementById("filter") as HTMLInputElement;
    filter.value = "bridge";
    filter.dispatchEvent(new dom.window.Event("input"));
    dom.window.location.hash = "#check=pipeline-warmup";
    await vi.waitFor(() => expect(document.querySelector(".target")?.getAttribute("data-check")).toBe("pipeline-warmup"));
    expect(filter.value).toBe("");
    expect(visible().length).toBe(3);
  });

  it("shows the warm-up check of the pipeline section", async () => {
    const { document } = await open("");
    expect(document.querySelector('.row[data-check="pipeline-warmup"]')?.textContent).toContain("Prover warm-ups (24 h)");
  });
});
