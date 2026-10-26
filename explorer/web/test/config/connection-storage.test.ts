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

  it("drops an indexer URL that is not text and an RPC map that is not a record", () => {
    expect(loadUserConnections(memoryStorage(JSON.stringify({ indexerUrl: 7, rpcUrls: "x" })))).toEqual(EMPTY_CONNECTION_SETTINGS);
  });
});

describe("saveUserConnections", () => {
  it("writes the settings under one key so a later load gives them back", () => {
    const storage = memoryStorage();
    const settings = { indexerUrl: "https://indexer.example.org", rpcUrls: { 1: "https://eth.example.org" } };
    expect(saveUserConnections(storage, settings)).toEqual({ saved: true });
    expect(loadUserConnections(storage)).toEqual(settings);
  });

  it("says that the save failed when the storage is absent or throws", () => {
    expect(saveUserConnections(null, EMPTY_CONNECTION_SETTINGS)).toEqual({ saved: false });
    expect(saveUserConnections(throwing(), EMPTY_CONNECTION_SETTINGS)).toEqual({ saved: false });
  });

  it("uses a key that names this page", () => {
    const writes: string[] = [];
    saveUserConnections({ getItem: () => null, setItem: (key) => void writes.push(key) }, EMPTY_CONNECTION_SETTINGS);
    expect(writes).toEqual([CONNECTION_STORAGE_KEY]);
  });
});
