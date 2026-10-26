import { describe, expect, it } from "vitest";
import { loadPairConfig, readConfiguration, DEFAULT_INDEXER_URL } from "../../src/config/environment";
import { ConfigurationError } from "../../src/config/secret-scan";

const DEPLOYMENT = JSON.stringify({
  chain_a: { chain_id: 1, bridge: `0x${"11".repeat(20)}`, mediator: `0x${"22".repeat(20)}`, light_client: `0x${"33".repeat(20)}` },
  chain_b: { chain_id: 369, bridge: `0x${"44".repeat(20)}`, mediator: `0x${"55".repeat(20)}`, light_client: `0x${"66".repeat(20)}`, fee_router: `0x${"77".repeat(20)}` },
});

describe("readConfiguration", () => {
  it("reads the indexer, the pair and the RPC endpoint of each chain", () => {
    const configuration = readConfiguration({
      VITE_EXPLORER_INDEXER_URL: "https://indexer.example.org/",
      VITE_EXPLORER_RPC_URL_1: "https://eth.example.org",
      VITE_EXPLORER_RPC_URL_369: "https://pls.example.org",
      VITE_EXPLORER_DEPLOYMENT_JSON: DEPLOYMENT,
    });
    expect(configuration.indexerUrl).toBe("https://indexer.example.org");
    expect(configuration.rpcUrls).toEqual({ 1: "https://eth.example.org", 369: "https://pls.example.org" });
    expect(configuration.pairName).toBe("eth-pls");
    expect(configuration.dataMode).toBe("live");
  });

  it("uses the local indexer when none is set", () => {
    expect(readConfiguration({ VITE_EXPLORER_DEPLOYMENT_URL: "https://example.org/d.json" }).indexerUrl).toBe(DEFAULT_INDEXER_URL);
  });

  it("refuses a live page with no deployment file, so the page never guesses addresses", () => {
    expect(() => readConfiguration({})).toThrow(ConfigurationError);
  });

  it("starts a fixture page with no deployment", () => {
    expect(readConfiguration({ VITE_EXPLORER_DATA: "fixture" }).dataMode).toBe("fixture");
  });

  it("refuses an unknown data mode", () => {
    expect(() => readConfiguration({ VITE_EXPLORER_DATA: "demo" })).toThrow(/live.*fixture/);
  });

  it("refuses a configuration with a key in an RPC URL and names the variable", () => {
    expect(() =>
      readConfiguration({ VITE_EXPLORER_DATA: "fixture", VITE_EXPLORER_RPC_URL_1: `https://rpc.example.org/vk_${"ab".repeat(8)}/evm/1` }),
    ).toThrow(/VITE_EXPLORER_RPC_URL_1/);
  });

  it("ignores variables that Vite does not expose to the page", () => {
    expect(readConfiguration({ VITE_EXPLORER_DATA: "fixture", EXPLORER_PRIVATE_KEY: `0x${"ab".repeat(32)}` }).dataMode).toBe("fixture");
  });
});

describe("loadPairConfig", () => {
  it("builds the pair from inline deployment JSON", async () => {
    const configuration = readConfiguration({ VITE_EXPLORER_DEPLOYMENT_JSON: DEPLOYMENT });
    const pair = await loadPairConfig(configuration);
    expect(pair.first.chainId).toBe(1);
    expect(pair.second.contracts.feeRouter?.toLowerCase()).toBe(`0x${"77".repeat(20)}`);
  });

  it("fetches the deployment file when a URL is set", async () => {
    const configuration = readConfiguration({ VITE_EXPLORER_DEPLOYMENT_URL: "https://example.org/d.json" });
    const seen: string[] = [];
    const pair = await loadPairConfig(configuration, async (url) => {
      seen.push(url);
      return DEPLOYMENT;
    });
    expect(seen).toEqual(["https://example.org/d.json"]);
    expect(pair.id).toBe("eth-pls");
  });

  it("explains a deployment file that does not describe the pair", async () => {
    const configuration = readConfiguration({ VITE_EXPLORER_DEPLOYMENT_JSON: "{}" });
    await expect(loadPairConfig(configuration)).rejects.toThrow(/not usable/);
  });
});
