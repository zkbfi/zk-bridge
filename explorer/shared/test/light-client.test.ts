import type { PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { beaconLightClientAbi } from "../src/abis/index.js";
import { createLightClientReader } from "../src/prover/light-client.js";

const word = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as const;

describe("the light client reader", () => {
  it("reads the head, the program key and the header root of that very head", async () => {
    const readContract = vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "head") return 164n;
      if (functionName === "programVKey") return word(0x42);
      if (functionName === "headers") return args?.[0] === 164n ? word(0x77) : word(0x00);
      throw new Error(`unexpected ${functionName}`);
    });
    const lightClient = `0x${"44".repeat(20)}` as const;
    const state = await createLightClientReader({ readContract } as unknown as PublicClient, lightClient).read();
    expect(state).toEqual({ headSlot: 164n, headRoot: word(0x77), programKey: word(0x42) });
    expect(readContract).toHaveBeenCalledWith({ address: lightClient, abi: beaconLightClientAbi, functionName: "headers", args: [164n] });
  });

  it("fails when a read fails", async () => {
    const readContract = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(createLightClientReader({ readContract } as unknown as PublicClient, `0x${"44".repeat(20)}`).read()).rejects.toThrow("down");
  });
});
