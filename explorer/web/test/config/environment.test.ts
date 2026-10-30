import { describe, expect, it, vi } from "vitest";
import { defaultPairOf, loadPairConfig, loadSharedPair, PREFERRED_PAIRS, readConfiguration, requestedPair, selectPair, withDeploymentText } from "../../src/config/environment";
import { ConfigurationError } from "../../src/config/secret-scan";

const DEPLOYMENT = JSON.stringify({
  chain_a: { chain_id: 1, bridge: `0x${"11".repeat(20)}`, mediator: `0x${"22".repeat(20)}`, light_client: `0x${"33".repeat(20)}` },
  chain_b: { chain_id: 369, bridge: `0x${"44".repeat(20)}`, mediator: `0x${"55".repeat(20)}`, light_client: `0x${"66".repeat(20)}`, delivery_router: `0x${"77".repeat(20)}` },
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
    expect(configuration.rpcUrls).toEqual({
      1: "https://eth.example.org",
      369: "https://pls.example.org",
      11155111: "https://one.valve.city/rpc/vk_demo/evm/11155111",
      943: "https://one.valve.city/rpc/vk_demo/evm/943",
    });
    expect(configuration.pairName).toBe("eth-pls");
    expect(configuration.dataMode).toBe("live");
  });

  it("defaults every chain's RPC to the valve.city demo key, testnets included, when the build names none", () => {
    expect(readConfiguration({ VITE_EXPLORER_DEPLOYMENT_JSON: DEPLOYMENT }).rpcUrls).toEqual({
      1: "https://one.valve.city/rpc/vk_demo/evm/1",
      369: "https://one.valve.city/rpc/vk_demo/evm/369",
      11155111: "https://one.valve.city/rpc/vk_demo/evm/11155111",
      943: "https://one.valve.city/rpc/vk_demo/evm/943",
    });
  });

  it("leaves the indexer unset when no variable names it, so the registry default decides later", () => {
    expect(readConfiguration({ VITE_EXPLORER_DEPLOYMENT_URL: "https://example.org/d.json" }).indexerUrl).toBeNull();
  });

  it("reads the four endpoints, drops one trailing slash, and leaves each unset when its variable is missing", () => {
    const configuration = readConfiguration({
      VITE_EXPLORER_DEPLOYMENT_URL: "https://example.org/d.json",
      VITE_EXPLORER_BACKEND_URL: "https://backend.example.org/api/",
      VITE_EXPLORER_MSGBOARD_INDEXER_URL: "https://mb-indexer.example.org",
      VITE_EXPLORER_ARCHIVE_URL: "https://archive.example.org/v1/",
      VITE_EXPLORER_MSGBOARD_URL: "  ",
    });
    expect(configuration.backendUrl).toBe("https://backend.example.org/api");
    expect(configuration.msgboardIndexerUrl).toBe("https://mb-indexer.example.org");
    expect(configuration.archiveUrl).toBe("https://archive.example.org/v1");
    expect(configuration.msgboardUrl).toBeNull();
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
    expect(pair.second.contracts.deliveryRouter?.toLowerCase()).toBe(`0x${"77".repeat(20)}`);
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

const section = (chainId: number, byte: string, extra: Record<string, unknown> = {}) => ({
  chain_id: chainId,
  bridge: `0x${byte.repeat(20)}`,
  mediator: `0x${byte.repeat(20)}`,
  token_factory: `0x${byte.repeat(20)}`,
  wrapped_native: `0x${byte.repeat(20)}`,
  gate: `0x${byte.repeat(20)}`,
  light_client: `0x${byte.repeat(20)}`,
  start_block: 100,
  ...extra,
});

const FULL_DEPLOYMENT = JSON.stringify({ chain_a: section(1, "11"), chain_b: section(369, "44") });

describe("loadSharedPair", () => {
  it("builds the pair with the addresses of the deployment and no RPC URL, because the user can set one later", async () => {
    const pair = await loadSharedPair(readConfiguration({ VITE_EXPLORER_DEPLOYMENT_JSON: FULL_DEPLOYMENT }));
    expect(pair?.sides.map((side) => side.chainId)).toEqual([1, 369]);
    expect(pair?.sides.map((side) => side.rpcUrl)).toEqual(["", ""]);
  });

  it("reads the same deployment text as the view pair, through the fetcher when only a URL is set", async () => {
    const seen: string[] = [];
    const pair = await loadSharedPair(readConfiguration({ VITE_EXPLORER_DEPLOYMENT_URL: "https://example.org/d.json" }), async (url) => {
      seen.push(url);
      return FULL_DEPLOYMENT;
    });
    expect(seen).toEqual(["https://example.org/d.json"]);
    expect(pair?.name).toBe("eth-pls");
  });

  it("needs no pair on a fixture page and reads no file", async () => {
    const fetcher = vi.fn();
    expect(await loadSharedPair(readConfiguration({ VITE_EXPLORER_DATA: "fixture" }), fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("explains a deployment file that does not describe the pair", async () => {
    await expect(loadSharedPair(readConfiguration({ VITE_EXPLORER_DEPLOYMENT_JSON: "{}" }))).rejects.toThrow(/^The deployment file is not usable: /);
  });
});

describe("withDeploymentText", () => {
  it("fetches the file once and holds its text inline, so two loaders share one read", async () => {
    const fetcher = vi.fn(async () => DEPLOYMENT);
    const configuration = await withDeploymentText(readConfiguration({ VITE_EXPLORER_DEPLOYMENT_URL: "https://example.org/d.json" }), fetcher);
    expect(configuration.deploymentJson).toBe(DEPLOYMENT);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns a configuration that holds the text already, and a fixture configuration, unchanged", async () => {
    const fetcher = vi.fn();
    const inline = readConfiguration({ VITE_EXPLORER_DEPLOYMENT_JSON: FULL_DEPLOYMENT });
    const fixture = readConfiguration({ VITE_EXPLORER_DATA: "fixture" });
    expect(await withDeploymentText(inline, fetcher)).toBe(inline);
    expect(await withDeploymentText(fixture, fetcher)).toBe(fixture);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches with an empty address when a hand-made configuration names no source", async () => {
    const seen: string[] = [];
    const base = readConfiguration({ VITE_EXPLORER_DEPLOYMENT_JSON: FULL_DEPLOYMENT });
    await withDeploymentText({ ...base, deploymentJson: null, deploymentUrl: null }, async (url) => {
      seen.push(url);
      return "{}";
    });
    expect(seen).toEqual([""]);
  });
});

describe("a release with the deployments of several pairs", () => {
  const TESTNET = { chain_a: section(11155111, "a1"), chain_b: section(943, "b1") };
  const both = { "sepolia-pls943": TESTNET, "eth-pls": JSON.parse(FULL_DEPLOYMENT) };

  it("offers every pair of the map, opens Ethereum and PulseChain by default once it is deployed, and holds its deployment", () => {
    const configuration = readConfiguration({ VITE_EXPLORER_DEPLOYMENTS_JSON: JSON.stringify(both) });
    expect(configuration.availablePairs).toEqual(["sepolia-pls943", "eth-pls"]);
    expect(configuration.pairName).toBe("eth-pls");
    expect(JSON.parse(configuration.deploymentJson ?? "")).toEqual(JSON.parse(FULL_DEPLOYMENT));
  });

  it("opens the Sepolia and PulseChain testnet pair while Ethereum and PulseChain is not deployed", () => {
    const configuration = readConfiguration({ VITE_EXPLORER_DEPLOYMENTS_JSON: JSON.stringify({ "other-pair": TESTNET, "sepolia-pls943": TESTNET }) });
    expect(configuration.pairName).toBe("sepolia-pls943");
  });

  it("picks the default pair by preference, then the release's first pair", () => {
    expect(defaultPairOf(["sepolia-pls943", "eth-pls"])).toBe("eth-pls");
    expect(defaultPairOf(["sepolia-pls943"])).toBe("sepolia-pls943");
    expect(defaultPairOf(["b-pair", "a-pair"])).toBe("b-pair");
    expect(defaultPairOf([])).toBeNull();
    expect(defaultPairOf(null)).toBeNull();
    expect(PREFERRED_PAIRS).toEqual(["eth-pls", "sepolia-pls943"]);
  });

  it("opens the pair that VITE_EXPLORER_PAIR names when the map has it, and refuses a name the map lacks", () => {
    expect(readConfiguration({ VITE_EXPLORER_DEPLOYMENTS_JSON: JSON.stringify(both), VITE_EXPLORER_PAIR: "eth-pls" }).pairName).toBe("eth-pls");
    expect(() => readConfiguration({ VITE_EXPLORER_DEPLOYMENTS_JSON: JSON.stringify(both), VITE_EXPLORER_PAIR: "nope" })).toThrow(/VITE_EXPLORER_PAIR/);
  });

  it("refuses a map that is not JSON, not an object of deployments, or empty", () => {
    for (const text of ["{", "[]", "{}", JSON.stringify({ "eth-pls": "text" })]) {
      expect(() => readConfiguration({ VITE_EXPLORER_DEPLOYMENTS_JSON: text }), text).toThrow(/VITE_EXPLORER_DEPLOYMENTS_JSON/);
    }
  });

  it("offers just the one pair of a single deployment", () => {
    expect(readConfiguration({ VITE_EXPLORER_DEPLOYMENT_JSON: DEPLOYMENT }).availablePairs).toEqual(["eth-pls"]);
  });

  it("switches to a requested pair of the map, and keeps the configuration for an unknown or missing request", async () => {
    const configuration = readConfiguration({ VITE_EXPLORER_DEPLOYMENTS_JSON: JSON.stringify(both) });
    const switched = selectPair(configuration, "eth-pls");
    expect(switched.pairName).toBe("eth-pls");
    expect((await loadSharedPair(switched))?.sides.map((side) => side.chainId)).toEqual([1, 369]);
    expect(selectPair(configuration, "nope")).toBe(configuration);
    expect(selectPair(configuration, null)).toBe(configuration);
    const single = readConfiguration({ VITE_EXPLORER_DEPLOYMENT_JSON: DEPLOYMENT });
    expect(selectPair(single, "sepolia-pls943")).toBe(single);
  });

  it("reads the requested pair from ?pair= first, then from a #/pair/ route, else none", () => {
    expect(requestedPair({ search: "?pair=eth-pls", hash: "#/pair/sepolia-pls943" })).toBe("eth-pls");
    expect(requestedPair({ search: "", hash: "#/pair/sepolia-pls943?token=0x1" })).toBe("sepolia-pls943");
    expect(requestedPair({ search: "?pair=", hash: "#/history" })).toBeNull();
  });
});
