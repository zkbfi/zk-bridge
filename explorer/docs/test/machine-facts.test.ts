// @vitest-environment node
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allContractAddresses, buildChainsFile, buildContractsFile, loadFacts, resolvePlaceholders } from "../machine/facts";

const fixture = (path: string): string => fileURLToPath(new URL(`./fixtures/machine/${path}`, import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("chains.json", () => {
  it("lists every chain of the shared metadata with its coin, explorers and timing", () => {
    const { chains } = buildChainsFile();
    expect(chains["11155111"]).toMatchObject({ id: 11155111, name: "Sepolia", nativeSymbol: "SepETH", slotSeconds: 12, finalitySeconds: 768 });
    expect(chains["943"]?.explorers.length).toBe(2);
    expect(chains["369"]).toMatchObject({ nativeSymbol: "PLS", finalitySeconds: 640 });
  });
});

describe("contracts.json", () => {
  it("reads each chain of a deployment with its test tokens, and leaves the wallets out", () => {
    const file = buildContractsFile(fixture("deployments"));
    expect(file.pairs).toEqual(["demo"]);
    expect(file.chains["11155111"]).toMatchObject({ bridge: "0x1111111111111111111111111111111111111111", deliveryRouter: "0x2222222222222222222222222222222222222222", forkRegistry: null, pair: "demo", name: "Sepolia" });
    expect(file.chains["943"]?.testTokens.tUSD?.decimals).toBe(6);
    expect(JSON.stringify(file)).not.toMatch(/minter|traffic/i);
  });

  it("holds the real deployments the dapp ships", () => {
    const { contracts } = loadFacts(repositoryRoot);
    expect(Object.keys(contracts.chains)).toEqual(expect.arrayContaining(["11155111", "943"]));
    expect(allContractAddresses(contracts).has(contracts.chains["943"]?.bridge.toLowerCase() as string)).toBe(true);
  });

  it("lists every address in lowercase for the prose check", () => {
    const all = allContractAddresses(buildContractsFile(fixture("deployments")));
    expect(all.has("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(all.has("0x0123456789abcdef0123456789abcdef01234567")).toBe(true);
  });
});

describe("placeholders", () => {
  const facts = { chains: buildChainsFile(), contracts: buildContractsFile(fixture("deployments")) };

  it("resolves contract and chain facts", () => {
    expect(resolvePlaceholders("{{contracts.11155111.bridge}} / {{ chains.943.nativeSymbol }} / {{contracts.943.testTokens.tUSD.address}}", facts, "p.md")).toBe(
      "0x1111111111111111111111111111111111111111 / v4tPLS / 0x0123456789abcdef0123456789abcdef01234567",
    );
  });

  it("fails on a placeholder that names nothing, and on one that names a whole object", () => {
    expect(() => resolvePlaceholders("{{contracts.1.bridge}}", facts, "p.md")).toThrow(/p\.md: unknown placeholder \{\{contracts\.1\.bridge\}\}/);
    expect(() => resolvePlaceholders("{{contracts.943}}", facts, "p.md")).toThrow(/unknown placeholder/);
    expect(() => resolvePlaceholders("{{nothing.x}}", facts, "p.md")).toThrow(/unknown placeholder/);
  });

  it("leaves text without placeholders alone", () => {
    expect(resolvePlaceholders("a { b } {c}", facts, "p.md")).toBe("a { b } {c}");
  });
});
