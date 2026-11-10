import { describe, expect, it, vi } from "vitest";
import { custom, encodeAbiParameters, type Address } from "viem";

const calls: { readonly to: string; readonly data: string }[] = [];
/** An RPC that answers eth_call: the selector of symbol() with "FROG", decimals() with 9. */
vi.mock("../../src/app/rpc-transport", () => ({
  rpcTransport: () =>
    custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
        const { to, data } = (params as [{ to: string; data: string }])[0];
        calls.push({ to, data });
        if (data.startsWith("0x95d89b41")) return encodeAbiParameters([{ type: "string" }], ["FROG"]);
        if (data.startsWith("0x313ce567")) return encodeAbiParameters([{ type: "uint8" }], [9]);
        throw new Error("reverted");
      },
    }),
}));

const { erc20ReaderFor, resolveCustomToken } = await import("../../src/bridge/custom-token");
const ADDRESS = "0x9999999999999999999999999999999999999999" as Address;

describe("the ERC-20 reader over an RPC", () => {
  it("makes eth_call reads of the token's symbol and decimals", async () => {
    const read = erc20ReaderFor("https://rpc.example");
    expect(await read(ADDRESS, "symbol")).toBe("FROG");
    expect(await read(ADDRESS, "decimals")).toBe(9);
    expect(calls.every((call) => call.to.toLowerCase() === ADDRESS)).toBe(true);
  });

  it("names a token whose contract has no name() by its symbol", async () => {
    expect(await resolveCustomToken(ADDRESS, "second", erc20ReaderFor("https://rpc.example"))).toMatchObject({ symbol: "FROG", name: "FROG", decimals: 9, side: "second", custom: true });
  });
});
