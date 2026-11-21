import { describe, expect, it } from "vitest";
import { entriesOf, loadDocEntries } from "../../src/docs/doc-entries";

describe("entriesOf", () => {
  it("takes the slug, the title and the id and text of each heading", () => {
    expect(entriesOf([{ id: "help/safety", title: "Safety", headings: [{ id: "keys", text: "Keys", level: 2 } as { id: string; text: string }] }])).toEqual([
      { slug: "safety", title: "Safety", headings: [{ id: "keys", text: "Keys" }] },
    ]);
  });
});

describe("loadDocEntries", () => {
  it("lists the real pages in reading order, each with headings the palette can find", async () => {
    const entries = await loadDocEntries([1, 369]);
    expect(entries.map((entry) => entry.slug)).toEqual(["getting-started", "how-the-bridge-works", "bridging-tokens", "sending-messages", "fees-explained", "safety", "running-a-bot", "settings-and-explore", "glossary", "deployed-contracts"]);
    for (const entry of entries) expect(entry.headings.length).toBeGreaterThanOrEqual(2);
  });

  it("adds the testnet faucet page when the pair holds Sepolia and PulseChain testnet v4, and only then", async () => {
    const testnet = await loadDocEntries([11155111, 943]);
    expect(testnet.at(-1)?.slug).toBe("get-testnet-tokens");
    expect((await loadDocEntries([1, 369])).map((entry) => entry.slug)).not.toContain("get-testnet-tokens");
  });
});
