import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { loadPairConfig, readConfiguration, type WebConfiguration } from "../../src/config/environment";
import { ConfigurationError } from "../../src/config/secret-scan";

const DEPLOYMENT = JSON.stringify({
  chain_a: { chain_id: 1, bridge: `0x${"11".repeat(20)}`, mediator: `0x${"22".repeat(20)}`, light_client: `0x${"33".repeat(20)}` },
  chain_b: { chain_id: 369, bridge: `0x${"44".repeat(20)}`, mediator: `0x${"55".repeat(20)}`, light_client: `0x${"66".repeat(20)}`, delivery_router: `0x${"77".repeat(20)}` },
});

const live = (overrides: Partial<WebConfiguration> = {}): WebConfiguration => ({
  ...readConfiguration({ VITE_EXPLORER_DEPLOYMENT_JSON: DEPLOYMENT }),
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readConfiguration: the RPC variables", () => {
  it.each([
    ["a name that is not a number", "VITE_EXPLORER_RPC_URL_abc"],
    ["a chain of zero", "VITE_EXPLORER_RPC_URL_0"],
    ["a negative chain", "VITE_EXPLORER_RPC_URL_-5"],
    ["a chain with a fraction", "VITE_EXPLORER_RPC_URL_1.5"],
  ])("keeps no endpoint for %s", (_name, variable) => {
    const configuration = readConfiguration({ VITE_EXPLORER_DATA: "fixture", [variable]: "https://rpc.example.org" });
    expect(configuration.rpcUrls).toEqual({});
  });

  it("keeps no endpoint for a blank value, and trims a value that has spaces", () => {
    const configuration = readConfiguration({
      VITE_EXPLORER_DATA: "fixture",
      VITE_EXPLORER_RPC_URL_1: "   ",
      VITE_EXPLORER_RPC_URL_369: "  https://pls.example.org  ",
    });
    expect(configuration.rpcUrls).toEqual({ 369: "https://pls.example.org" });
  });

  it("reads the wallet project identifier and the pair name when they are set", () => {
    const configuration = readConfiguration({ VITE_EXPLORER_DATA: "fixture", VITE_WALLETCONNECT_PROJECT_ID: "project-1", VITE_EXPLORER_PAIR: "other-pair" });
    expect(configuration.walletConnectProjectId).toBe("project-1");
    expect(configuration.pairName).toBe("other-pair");
  });
});

describe("loadPairConfig: the source of the deployment", () => {
  it("returns the sample pair for a fixture page and reads no file", async () => {
    const fetcher = vi.fn();
    const pair = await loadPairConfig(readConfiguration({ VITE_EXPLORER_DATA: "fixture" }), fetcher);
    expect(pair).toBe(FIXTURE_PAIR);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("prefers the inline JSON over the URL", async () => {
    const fetcher = vi.fn();
    const pair = await loadPairConfig(live({ deploymentUrl: "https://example.org/d.json" }), fetcher);
    expect(pair.first.chainId).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetches with an empty address when a hand-made configuration names no source, and the fetcher result decides", async () => {
    const seen: string[] = [];
    const configuration = live({ deploymentJson: null, deploymentUrl: null });
    await expect(
      loadPairConfig(configuration, async (url) => {
        seen.push(url);
        return "not json";
      }),
    ).rejects.toThrow(/The deployment file is not usable: /);
    expect(seen).toEqual([""]);
  });

  it("gives the text of the failure when the deployment file is not JSON", async () => {
    await expect(loadPairConfig(live({ deploymentJson: "{oops" }))).rejects.toThrow(/^The deployment file is not usable: .*JSON/);
  });

  it("fetches with the browser fetch by default and reads the text of the answer", async () => {
    const fetchStub = vi.fn(async () => new Response(DEPLOYMENT, { status: 200 }));
    vi.stubGlobal("fetch", fetchStub);
    const pair = await loadPairConfig(live({ deploymentJson: null, deploymentUrl: "https://example.org/d.json" }));
    expect(fetchStub).toHaveBeenCalledWith("https://example.org/d.json");
    expect(pair.second.chainId).toBe(369);
  });

  it("names the status when the deployment file does not load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
    const attempt = loadPairConfig(live({ deploymentJson: null, deploymentUrl: "https://example.org/d.json" }));
    await expect(attempt).rejects.toThrow(ConfigurationError);
    await expect(attempt).rejects.toThrow("The deployment file answered 404.");
  });
});
