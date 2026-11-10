import { describe, expect, it, vi } from "vitest";
import { custom } from "viem";

/** The PulseChain RPC: answers the latest block, and fails every call as an endpoint that drops requests. */
vi.mock("../../src/app/rpc-transport", () => ({
  rpcTransport: () =>
    custom({
      request: async ({ method }: { method: string }) => {
        if (method === "eth_blockNumber") return "0x15f9000";
        throw new Error("fetch failed");
      },
    }),
}));

const { poolReaderFor } = await import("../../src/bridge/use-prices");

describe("the pool reader of the dapp's RPC", () => {
  it("reads at the latest block, and counts a read that does not get through, so it is not taken for no market", async () => {
    const reader = await poolReaderFor("https://rpc.example");
    expect(reader.block).toBe(23_040_000n);
    expect(await reader.pairOf("0x1715a3E4A142d8b698131108995174F37aEBA10D", "0xA1077a294dDE1B09bB078844df40758a5D0f9a27", "0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07")).toBeNull();
    expect(reader.failures?.()).toBeGreaterThan(0);
  });
});
