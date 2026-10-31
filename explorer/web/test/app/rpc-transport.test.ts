import { describe, expect, it } from "vitest";
import { rpcTransport } from "../../src/app/rpc-transport";
import { defaultRpcUrl, defaultRpcUrls } from "@terminal/config/default-rpc";

describe("rpcTransport", () => {
  it("puts the demo key behind a chain's default public RPC", () => {
    const transport = rpcTransport(defaultRpcUrl(943) ?? undefined)({ retryCount: 0 });
    expect(transport.config.type).toBe("fallback");
    expect(defaultRpcUrls(943)).toEqual(["https://rpc.v4.testnet.pulsechain.com", "https://one.valve.city/rpc/vk_demo/evm/943"]);
  });

  it("uses a chosen URL alone", () => {
    expect(rpcTransport("https://example.org/rpc")({ retryCount: 0 }).config.type).toBe("http");
  });

  it("defaults every supported chain to a public RPC first", () => {
    for (const id of [1, 369, 11155111, 943]) expect(defaultRpcUrl(id)).not.toContain("valve.city");
    expect(defaultRpcUrl(10)).toBeNull();
  });
});
