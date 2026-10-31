import { describe, expect, it } from "vitest";
import { createExplorerConnection, resolveConnection, type JsonFetcher, type ResolvedConnection } from "../src/index.js";
import { createFakeChain } from "./support/fake-chain.js";
import { testPair } from "./support/fixtures.js";
import { buildScenario } from "./support/scenario.js";

const KEY = "FAKEKEY1234567890";
const pair = testPair();
const scenario = buildScenario(pair);

const base = (): ResolvedConnection =>
  resolveConnection({
    chainIds: [1, 369],
    user: { indexerUrl: `https://indexer.example.org/${KEY}` },
    environment: {},
    registry: { rpcUrls: { 1: "https://rpc1.example.org/v3/abc", 369: "https://rpc369.example.org/abc" } },
  });

const connectionOf = (resolved: ResolvedConnection) =>
  createExplorerConnection({
    pair,
    resolved,
    fetchJson: (async () => ({ status: 200, body: {} })) as JsonFetcher,
    createReader: ({ chainId }) => createFakeChain(scenario, chainId),
  });

const text = `failed at https://beacon.example.org/${KEY} for https://indexer.example.org/${KEY}`;

describe("the beacon endpoints of a resolved connection", () => {
  it("accepts a resolved connection that has no beaconUrls", () => {
    const { beaconUrls: _beaconUrls, ...without } = base();
    const cleaned = connectionOf(without).redact(text);
    // The key of the indexer is a known secret; the beacon URL is not known, so its text stays.
    expect(cleaned).not.toContain(`indexer.example.org/${KEY}`);
    expect(cleaned).toContain("beacon.example.org");
  });

  it("accepts a resolved connection that has no msgboardUrls", () => {
    const { msgboardUrls: _msgboardUrls, ...without } = base();
    expect(connectionOf(without).redact(text)).not.toContain(`indexer.example.org/${KEY}`);
  });

  it("skips a beacon endpoint that is not set", () => {
    expect(connectionOf({ ...base(), beaconUrls: { 1: null } }).redact(text)).toContain("beacon.example.org");
  });

  it("redacts the key of a beacon endpoint that is set", () => {
    const cleaned = connectionOf({ ...base(), beaconUrls: { 1: null, 369: { value: `https://beacon.example.org/${KEY}`, source: "user" } } }).redact(text);
    expect(cleaned).not.toContain(KEY);
  });
});
