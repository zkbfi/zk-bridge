import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadRecords, PAGE_PATH, renderPage, sectionsOf } from "../../../deploy/contracts-page/lib.mjs";
import { explorerLinks } from "../../data/src/chain-metadata";

describe("the deployed contracts page", () => {
  const records = loadRecords();

  it("is what the deployment records render to, so a deploy that changes a record also regenerates the page", () => {
    expect(readFileSync(PAGE_PATH, "utf8")).toBe(renderPage(records));
  });

  it("lists every address of the record's own fields in its contracts list", () => {
    for (const { pair, record } of records) {
      for (const [key, section] of sectionsOf(record)) {
        const listed = new Set(section.contracts.map((entry: { address: string }) => entry.address.toLowerCase()));
        for (const field of ["bridge", "mediator", "gate", "light_client", "token_factory", "wrapped_native", "delivery_router", "fork_registry"]) {
          if (typeof section[field] === "string") expect(listed.has(section[field].toLowerCase()), `${pair} ${key} ${field}`).toBe(true);
        }
        for (const old of (section.delivery_routers ?? []) as string[]) expect(listed.has(old.toLowerCase()), `${pair} ${key} old router`).toBe(true);
      }
    }
  });

  it("links PulseChain scans by hash and Etherscan and Blockscout by path", () => {
    expect(explorerLinks(943, "address", "0xabc")[0]?.url).toBe("https://scan.v4.testnet.pulsechain.com/#/address/0xabc");
    expect(explorerLinks(11155111, "address", "0xabc").map((link) => link.url)).toEqual(["https://sepolia.etherscan.io/address/0xabc", "https://eth-sepolia.blockscout.com/address/0xabc"]);
    const page = renderPage(records);
    expect(page).toContain("(https://scan.v4.testnet.pulsechain.com/#/address/0x5897d3de91d59fb691e3887d6ffbba072384293a)");
    expect(page).not.toMatch(/scan\.v4\.testnet\.pulsechain\.com\/address\//);
    expect(page).toContain("(https://repo.sourcify.dev/11155111/0x5897d3de91d59fb691e3887d6ffbba072384293a)");
    expect(page).not.toContain("repo.sourcify.dev/943/");
  });
});
