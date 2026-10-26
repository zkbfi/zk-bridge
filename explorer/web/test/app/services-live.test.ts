import { beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { createServices } from "../../src/app/services";
import { describeSetting } from "@terminal/data/connection-runtime";
import { EMPTY_CONNECTION_SETTINGS } from "@zk-bridge/shared";
import { CONNECTION_STORAGE_KEY } from "../../src/config/connection-storage";
import { FIRST_CHAIN, SECOND_CHAIN, fakeConnections, fallbackStatus, liveConfiguration, liveServices, sharedPairForTests } from "../support/live";

beforeEach(() => window.localStorage.clear());

const runtimeOf = (services: ReturnType<typeof liveServices>) => {
  if (services.connection === null) throw new Error("The test expected a live page.");
  return services.connection;
};

describe("the precedence of a URL on a live page", () => {
  it("uses the registry default for the indexer and for a chain that the deployment names, when nothing else is set", () => {
    const resolved = runtimeOf(liveServices()).resolved();
    expect(resolved.indexerUrl).toEqual({ value: "http://localhost:42069", source: "default" });
    expect(resolved.rpcUrls[SECOND_CHAIN]).toEqual({ value: "https://registry.example.org/pls", source: "default" });
    expect(resolved.rpcUrls[FIRST_CHAIN]).toBeNull();
  });

  it("lets the environment of the page beat the registry default", () => {
    const resolved = runtimeOf(
      liveServices({ variables: { VITE_EXPLORER_INDEXER_URL: "https://env-indexer.example.org/", VITE_EXPLORER_RPC_URL_369: "https://env.example.org/pls" } }),
    ).resolved();
    expect(resolved.indexerUrl).toEqual({ value: "https://env-indexer.example.org", source: "environment" });
    expect(resolved.rpcUrls[SECOND_CHAIN]).toEqual({ value: "https://env.example.org/pls", source: "environment" });
  });

  it("lets the stored setting of the user beat the environment", () => {
    window.localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify({ indexerUrl: "https://mine.example.org", rpcUrls: { 369: "https://mine.example.org/pls" } }));
    const services = liveServices({ variables: { VITE_EXPLORER_INDEXER_URL: "https://env-indexer.example.org", VITE_EXPLORER_RPC_URL_369: "https://env.example.org/pls" } });
    const resolved = runtimeOf(services).resolved();
    expect(resolved.indexerUrl).toEqual({ value: "https://mine.example.org", source: "user" });
    expect(resolved.rpcUrls[SECOND_CHAIN]).toEqual({ value: "https://mine.example.org/pls", source: "user" });
    expect(services.fake.inputs[0]?.resolved).toBe(resolved);
  });

  it("starts with no user setting when the page has no storage", () => {
    expect(runtimeOf(liveServices({ storage: null })).user()).toEqual(EMPTY_CONNECTION_SETTINGS);
  });
});

describe("the options for every connection", () => {
  it("passes the connection options of the caller to each connection that the runtime builds", () => {
    const fake = fakeConnections();
    const clock = () => 42;
    const services = createServices(liveConfiguration(), FIXTURE_PAIR, { sharedPair: sharedPairForTests(), createConnection: fake.create, connectionOptions: { now: clock } });
    services.connection?.apply({ indexerUrl: "https://new.example.org", rpcUrls: {} });
    expect(fake.inputs.map((input) => input.now)).toEqual([clock, clock]);
  });
});

describe("a change of settings on a live page", () => {
  it("builds a new connection with the new URL, and the data source and the chain access stay the same objects", () => {
    const services = liveServices();
    const runtime = runtimeOf(services);
    const { dataSource, chainAccess, indexer } = services;
    runtime.apply({ indexerUrl: "https://new.example.org", rpcUrls: { [FIRST_CHAIN]: "https://new-eth.example.org" } });
    expect(services.fake.inputs).toHaveLength(2);
    expect(services.fake.made[1]?.baseUrl).toBe("https://new.example.org");
    expect(describeSetting(runtime.resolved().rpcUrls[FIRST_CHAIN] ?? null)).toBe("https://new-eth.example.org (set by you)");
    expect(services.dataSource).toBe(dataSource);
    expect(services.chainAccess).toBe(chainAccess);
    expect(services.indexer).toBe(indexer);
  });

  it("reads a message from the newest connection after a change, not from the first one", async () => {
    const services = liveServices();
    services.fake.answerWith({ status: 404, body: null });
    await services.indexer.message(`0x${"ab".repeat(32)}`);
    runtimeOf(services).apply({ indexerUrl: "https://new.example.org", rpcUrls: {} });
    await services.indexer.message(`0x${"ab".repeat(32)}`);
    const [first, second] = services.fake.made;
    expect(first?.request).toHaveBeenCalledTimes(1);
    expect(second?.request).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/new\.example\.org\/api\/messages\//));
  });

  it("answers a lookup by transaction hash from the chains when the connection takes the RPC path", async () => {
    const services = liveServices();
    const connection = services.fake.made[0]!;
    const hash = `0x${"cd".repeat(32)}` as const;
    const found = `0x${"ef".repeat(32)}` as const;
    (connection.run as unknown as { mockImplementation: (implementation: unknown) => void }).mockImplementation(async (operations: { viaRpc: () => Promise<unknown> }) => operations.viaRpc());
    (connection.rpc.findMessageByTransaction as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue(found);
    expect(await services.indexer.findMessageByTransaction(hash)).toBe(found);
    services.fake.setStatus(fallbackStatus("indexer unreachable"));
    expect(runtimeOf(services).source().label).toBe("RPC fallback: indexer unreachable");
  });
});
