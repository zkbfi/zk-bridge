import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_NOW, FIXTURE_PAIR } from "@terminal/data/fixtures";
import { createServices } from "../../src/app/services";
import { readConfiguration } from "../../src/config/environment";

afterEach(() => {
  vi.useRealTimers();
});

const liveConfiguration = () =>
  readConfiguration({
    VITE_EXPLORER_DATA: "live",
    VITE_EXPLORER_INDEXER_URL: "https://indexer.example.org/",
    VITE_EXPLORER_DEPLOYMENT_URL: "https://example.org/deployment.json",
    VITE_EXPLORER_RPC_URL_1: "https://eth.example.org",
    VITE_EXPLORER_RPC_URL_369: "https://pls.example.org",
  });

describe("createServices for a fixture page", () => {
  const services = createServices(readConfiguration({ VITE_EXPLORER_DATA: "fixture" }), FIXTURE_PAIR);

  it("uses sample data and a clock that stands still, so the sample data stays the same", () => {
    expect(services.dataSource.label).toBe("fixture");
    expect(services.chainAccess.mode).toBe("fixture");
    expect(services.now()).toBe(FIXTURE_NOW);
  });

  it("lists the known pair with its name, marked as the configured one", () => {
    expect(services.knownPairs).toEqual([{ id: "eth-pls", label: "Ethereum and PulseChain", configured: true }]);
  });
});

describe("createServices for a live page", () => {
  it("reads through the indexer and the real endpoints of the page", () => {
    const services = createServices(liveConfiguration(), FIXTURE_PAIR);
    expect(services.dataSource.label).toBe("indexer");
    expect(services.chainAccess.mode).toBe("rpc");
  });

  it("reads the clock of the machine, in whole seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_999));
    expect(createServices(liveConfiguration(), FIXTURE_PAIR).now()).toBe(1_700_000_000);
  });

  it("gives the RPC address of each chain to the chain access under the variable name of that chain", () => {
    const services = createServices(liveConfiguration(), FIXTURE_PAIR);
    expect(() => services.chainAccess.flowClient(FIXTURE_PAIR.first.chainId)).not.toThrow();
    expect(() => services.chainAccess.flowClient(FIXTURE_PAIR.second.chainId)).not.toThrow();
  });

  it("refuses the flow client of a chain that has no RPC address", () => {
    const configuration = readConfiguration({
      VITE_EXPLORER_DATA: "live",
      VITE_EXPLORER_DEPLOYMENT_URL: "https://example.org/deployment.json",
      VITE_EXPLORER_RPC_URL_1: "https://eth.example.org",
    });
    const services = createServices(configuration, FIXTURE_PAIR);
    expect(() => services.chainAccess.flowClient(FIXTURE_PAIR.second.chainId)).toThrow();
  });
});
