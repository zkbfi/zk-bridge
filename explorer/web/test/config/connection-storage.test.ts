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
