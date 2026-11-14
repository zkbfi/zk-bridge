import { describe, expect, it } from "vitest";
import { rpcTransport } from "../../src/app/rpc-transport";
import { defaultRpcUrl, defaultRpcUrls } from "@terminal/config/default-rpc";

describe("rpcTransport", () => {
  it("makes a chain's rpc.zkb.fi default one pool with the public RPCs", () => {
    const transport = rpcTransport(defaultRpcUrl(943) ?? undefined)({ retryCount: 0 });
    expect(transport.config.type).toBe("pool");
    expect(defaultRpcUrls(943)).toEqual([
      "https://rpc.zkb.fi/943",
      "https://rpc.v4.testnet.pulsechain.com",
      "https://pulsechain-testnet-rpc.publicnode.com",
    ]);
  });

  it("uses a chosen URL alone", () => {
    expect(rpcTransport("https://example.org/rpc")({ retryCount: 0 }).config.type).toBe("http");
  });

  it("defaults every supported chain to rpc.zkb.fi first", () => {
    for (const id of [1, 369, 11155111, 943]) expect(defaultRpcUrl(id)).toBe(`https://rpc.zkb.fi/${id}`);
    expect(defaultRpcUrl(10)).toBeNull();
  });
});
