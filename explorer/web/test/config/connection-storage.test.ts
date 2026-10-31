import { describe, expect, it } from "vitest";
import { EMPTY_CONNECTION_SETTINGS } from "@zk-bridge/shared";
import { CONNECTION_STORAGE_KEY, loadUserConnections, saveUserConnections, type ConnectionStorage } from "../../src/config/connection-storage";

const memoryStorage = (initial?: string): ConnectionStorage & { readonly dump: () => string | null } => {
  let value: string | null = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    dump: () => value,
  };
};

const throwing = (): ConnectionStorage => ({
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
});

describe("loadUserConnections", () => {
  it("gives no settings when the storage is absent, empty, or throws", () => {
    expect(loadUserConnections(null)).toEqual(EMPTY_CONNECTION_SETTINGS);
    expect(loadUserConnections(memoryStorage())).toEqual(EMPTY_CONNECTION_SETTINGS);
    expect(loadUserConnections(throwing())).toEqual(EMPTY_CONNECTION_SETTINGS);
  });

  it("gives no settings for text that is not JSON or not a record", () => {
    expect(loadUserConnections(memoryStorage("{oops"))).toEqual(EMPTY_CONNECTION_SETTINGS);
    expect(loadUserConnections(memoryStorage("[1,2]"))).toEqual(EMPTY_CONNECTION_SETTINGS);
    expect(loadUserConnections(memoryStorage('"text"'))).toEqual(EMPTY_CONNECTION_SETTINGS);
  });

  it("keeps a valid indexer URL and valid RPC URLs by chain", () => {
    const stored = JSON.stringify({ indexerUrl: "https://indexer.example.org/", rpcUrls: { 1: "https://eth.example.org/FAKEKEY1234567890", 369: "https://pls.example.org" } });
    expect(loadUserConnections(memoryStorage(stored))).toEqual({
      indexerUrl: "https://indexer.example.org",
      rpcUrls: { 1: "https://eth.example.org/FAKEKEY1234567890", 369: "https://pls.example.org" },
    });
  });

  it("drops each stored URL that does not pass the URL check, and keeps the others", () => {
    const stored = JSON.stringify({
      indexerUrl: "ftp://indexer.example.org",
      rpcUrls: { 1: "not a url", 369: "https://pls.example.org", 0: "https://zero.example.org", abc: "https://word.example.org", 5: 42 },
    });
    expect(loadUserConnections(memoryStorage(stored))).toEqual({ indexerUrl: null, rpcUrls: { 369: "https://pls.example.org" } });
  });

  it("keeps each valid stored endpoint in its normal form and drops the others", () => {
    const stored = JSON.stringify({
      backendUrl: "https://backend.example.org/api/",
      msgboardIndexerUrl: "https://user:FAKEKEY1234567890@mb.example.org",
      archiveUrl: 5,
      msgboardUrl: "http://node.example.org",
    });
    expect(loadUserConnections(memoryStorage(stored))).toEqual({
      indexerUrl: null,
      rpcUrls: {},
      backendUrl: "https://backend.example.org/api",
      msgboardUrl: "http://node.example.org",
    });
  });

  it("drops an indexer URL that is not text and an RPC map that is not a record", () => {
    expect(loadUserConnections(memoryStorage(JSON.stringify({ indexerUrl: 7, rpcUrls: "x" })))).toEqual(EMPTY_CONNECTION_SETTINGS);
  });
});

describe("saveUserConnections", () => {
  it("writes the settings under one key so a later load gives them back", () => {
    const storage = memoryStorage();
    const settings = { indexerUrl: "https://indexer.example.org", rpcUrls: { 1: "https://eth.example.org" } };
    expect(saveUserConnections(storage, settings)).toEqual({ saved: true, reason: "stored" });
    expect(loadUserConnections(storage)).toEqual(settings);
  });

  it("says that the save failed when the storage is absent or throws", () => {
    expect(saveUserConnections(null, EMPTY_CONNECTION_SETTINGS)).toEqual({ saved: false, reason: "no-storage" });
    expect(saveUserConnections(throwing(), EMPTY_CONNECTION_SETTINGS)).toEqual({ saved: false, reason: "no-storage" });
  });

  it("uses a key that names this page", () => {
    const writes: string[] = [];
    saveUserConnections({ getItem: () => null, setItem: (key) => void writes.push(key) }, EMPTY_CONNECTION_SETTINGS);
    expect(writes).toEqual([CONNECTION_STORAGE_KEY]);
  });
});

const SHARED_LOCATION = { pathname: "/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/", hostname: "dweb.link" };
const OWN_LOCATION = { pathname: "/", hostname: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.dweb.link" };

describe("a shared origin", () => {
  it("settings stay in memory on a shared origin: nothing is written and nothing is read", () => {
    const calls: string[] = [];
    const storage: ConnectionStorage = {
      getItem: (key) => {
        calls.push(`get ${key}`);
        return JSON.stringify({ indexerUrl: "https://planted.example.org", rpcUrls: {} });
      },
      setItem: (key) => void calls.push(`set ${key}`),
    };
    expect(saveUserConnections(storage, { indexerUrl: "https://indexer.example.org", rpcUrls: {} }, SHARED_LOCATION)).toEqual({ saved: false, reason: "shared-origin" });
    expect(loadUserConnections(storage, SHARED_LOCATION)).toEqual(EMPTY_CONNECTION_SETTINGS);
    expect(calls).toEqual([]);
  });

  it("settings persist on an own origin", () => {
    const storage = memoryStorage();
    const settings = { indexerUrl: "https://indexer.example.org", rpcUrls: { 1: "https://eth.example.org" }, backendUrl: "https://backend.example.org/api" };
    expect(saveUserConnections(storage, settings, OWN_LOCATION)).toEqual({ saved: true, reason: "stored" });
    expect(loadUserConnections(storage, OWN_LOCATION)).toEqual(settings);
  });
});

describe("an endpoint with a key-like segment", () => {
  const KEY_SEGMENT = "3f9a7c1d5e8b2a4f6c0d9e1b7a3c5f8d";

  it("is not persisted, on any origin, and the other settings are", () => {
    const storage = memoryStorage();
    const settings = {
      indexerUrl: `https://indexer.example.org/${KEY_SEGMENT}`,
      rpcUrls: { 1: `https://eth.example.org/rpc/${KEY_SEGMENT}/evm/1`, 369: "https://pls.example.org" },
      backendUrl: `https://backend.example.org/${KEY_SEGMENT}`,
      archiveUrl: "https://archive.example.org/api",
    };
    expect(saveUserConnections(storage, settings, OWN_LOCATION)).toEqual({ saved: false, reason: "key-like-url" });
    expect(storage.dump()).not.toContain(KEY_SEGMENT);
    expect(loadUserConnections(storage, OWN_LOCATION)).toEqual({
      indexerUrl: null,
      rpcUrls: { 369: "https://pls.example.org" },
      archiveUrl: "https://archive.example.org/api",
    });
  });
});

describe("the beacon API per chain", () => {
  const page = { protocol: "https:", hostname: "zkb.fi", pathname: "/" } as never;

  it("keeps one beacon API per chain and drops a bad entry", () => {
    const storage = memoryStorage();
    expect(saveUserConnections(storage, { ...EMPTY_CONNECTION_SETTINGS, beaconUrls: { 943: "https://beacon.example.org/api" } }, page)).toEqual({ saved: true, reason: "stored" });
    expect(loadUserConnections(storage, page).beaconUrls).toEqual({ 943: "https://beacon.example.org/api" });
    const bad = memoryStorage(JSON.stringify({ beaconUrls: { 1: "https://ok.example.org/", 369: "not a url", x: "https://x.example.org" } }));
    expect(loadUserConnections(bad, page).beaconUrls).toEqual({ 1: "https://ok.example.org" });
    expect(loadUserConnections(memoryStorage(JSON.stringify({})), page).beaconUrls).toBeUndefined();
  });

  it("never writes a beacon API that looks like it holds a key", () => {
    const storage = memoryStorage();
    const result = saveUserConnections(storage, { ...EMPTY_CONNECTION_SETTINGS, beaconUrls: { 1: "https://beacon.example.org/0123456789abcdef0123456789abcdef" } }, page);
    expect(result.reason).toBe("key-like-url");
    expect(loadUserConnections(storage, page).beaconUrls ?? {}).toEqual({});
  });
});

describe("the msgboard node per chain", () => {
  it("keeps one node per chain, the same URL on both if set so, and drops a bad entry", () => {
    const storage = memoryStorage();
    expect(saveUserConnections(storage, { ...EMPTY_CONNECTION_SETTINGS, msgboardUrls: { 1: "https://same.example.org", 369: "https://same.example.org" } }, { protocol: "https:", hostname: "zkb.fi", pathname: "/" } as never)).toEqual({ saved: true, reason: "stored" });
    expect(loadUserConnections(storage, { protocol: "https:", hostname: "zkb.fi", pathname: "/" } as never).msgboardUrls).toEqual({ 1: "https://same.example.org", 369: "https://same.example.org" });
    const bad = memoryStorage(JSON.stringify({ msgboardUrls: { 1: "https://ok.example.org/", 369: "not a url", x: "https://x.example.org" } }));
    expect(loadUserConnections(bad, { protocol: "https:", hostname: "zkb.fi", pathname: "/" } as never).msgboardUrls).toEqual({ 1: "https://ok.example.org" });
  });

  it("still reads a saved single node, for the page to move to each chain", () => {
    const old = memoryStorage(JSON.stringify({ msgboardUrl: "https://old.example.org" }));
    const loaded = loadUserConnections(old, { protocol: "https:", hostname: "zkb.fi", pathname: "/" } as never);
    expect(loaded.msgboardUrl).toBe("https://old.example.org");
    expect(loaded.msgboardUrls).toBeUndefined();
  });

  it("never writes a node that looks like it holds a key", () => {
    const storage = memoryStorage();
    const result = saveUserConnections(storage, { ...EMPTY_CONNECTION_SETTINGS, msgboardUrls: { 1: "https://board.example.org/0123456789abcdef0123456789abcdef" } }, { protocol: "https:", hostname: "zkb.fi", pathname: "/" } as never);
    expect(result.reason).toBe("key-like-url");
    expect(storage.dump()).not.toMatch(/0123456789abcdef/);
  });
});
