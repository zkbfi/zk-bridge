import { describe, expect, it } from "vitest";
import { settingOf } from "../../src/views/ConnectionsView";

const resolved = { indexerUrl: null, rpcUrls: { 1: { value: "https://eth.example.org", source: "user" as const } }, backendUrl: null, msgboardIndexerUrl: null, archiveUrl: null, msgboardUrl: null };

describe("settingOf for an RPC target", () => {
  it("gives the setting in force for a chain that has one, and null for a chain that has none", () => {
    expect(settingOf(resolved, { kind: "rpc", label: "Ethereum RPC URL", chainId: 1 })).toEqual({ value: "https://eth.example.org", source: "user" });
    expect(settingOf(resolved, { kind: "rpc", label: "Other RPC URL", chainId: 999 })).toBeNull();
  });
});
