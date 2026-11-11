import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { createServices, indexerBaseOf } from "../../src/app/services";
import { fakeConnections, liveConfiguration, sharedPairForTests } from "../support/live";

afterEach(() => vi.unstubAllGlobals());

describe("indexerBaseOf", () => {
  const resolved = { indexerUrl: { value: "https://indexer.example.org", source: "environment" as const }, rpcUrls: {} } as unknown as Parameters<typeof indexerBaseOf>[0];

  it("gives the URL in force, and null when none is set", () => {
    expect(indexerBaseOf(resolved)).toBe("https://indexer.example.org");
    expect(indexerBaseOf({ ...resolved, indexerUrl: null })).toBeNull();
  });
});

describe("the Explore source of a live page", () => {
  it("reads the indexer that is in force when it asks", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    const services = createServices(liveConfiguration({ VITE_EXPLORER_INDEXER_URL: "https://env-indexer.example.org/" }), FIXTURE_PAIR, { sharedPair: sharedPairForTests(), createConnection: fakeConnections().create });
    await expect(services.explore.proofs()).resolves.toEqual([]);
    expect(fetched).toEqual(["https://env-indexer.example.org/api/head-updates?limit=200"]);
  });
});
