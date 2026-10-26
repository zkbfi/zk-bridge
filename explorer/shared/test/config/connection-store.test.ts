import { describe, expect, it } from "vitest";
import { CONNECTION_SECRET_NAMES, loadConnectionSettings, saveConnectionSetting, type SecretStore } from "../../src/config/index.js";

const memoryStore = (initial: Record<string, string> = {}): SecretStore & { values: Record<string, string> } => {
  const values = { ...initial };
  return {
    kind: "encrypted-file",
    values,
    get: async (name) => values[name] ?? null,
    set: async (name, value) => void (values[name] = value),
    delete: async (name) => void delete values[name],
  };
};

describe("the connection settings in the secret store", () => {
  it("keeps each setting under its own name", () => {
    expect(CONNECTION_SECRET_NAMES.indexerUrl).toBe("explorer.connection.indexer");
    expect(CONNECTION_SECRET_NAMES.rpcUrl(369)).toBe("explorer.connection.rpc.369");
  });

  it("saves a setting and reads it back", async () => {
    const store = memoryStore();
    await saveConnectionSetting(store, { kind: "rpc", chainId: 369 }, "https://rpc.example.org/KEY");
    await saveConnectionSetting(store, { kind: "indexer" }, "https://indexer.example.org");
    expect(store.values).toEqual({
      "explorer.connection.rpc.369": "https://rpc.example.org/KEY",
      "explorer.connection.indexer": "https://indexer.example.org",
    });
    expect(await loadConnectionSettings(store, [1, 369])).toEqual({
      indexerUrl: "https://indexer.example.org",
      rpcUrls: { 369: "https://rpc.example.org/KEY" },
    });
  });

  it("forgets a setting when the URL is null", async () => {
    const store = memoryStore({ "explorer.connection.rpc.1": "https://rpc.example.org/1", "explorer.connection.indexer": "https://indexer.example.org" });
    await saveConnectionSetting(store, { kind: "rpc", chainId: 1 }, null);
    await saveConnectionSetting(store, { kind: "indexer" }, null);
    expect(store.values).toEqual({});
    expect(await loadConnectionSettings(store, [1])).toEqual({ indexerUrl: null, rpcUrls: {} });
  });

  it("ignores a stored text that is not a valid URL, so a damaged entry cannot stop the dashboard", async () => {
    const store = memoryStore({ "explorer.connection.rpc.1": "not a url", "explorer.connection.indexer": "ftp://x", "explorer.connection.rpc.369": "https://ok.example.org" });
    expect(await loadConnectionSettings(store, [1, 369])).toEqual({ indexerUrl: null, rpcUrls: { 369: "https://ok.example.org" } });
  });
});
