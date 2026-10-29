import type { PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { beaconLightClientAbi } from "../src/abis/index.js";
import { createLightClientReader } from "../src/prover/light-client.js";

const word = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as const;
const lightClient = `0x${"44".repeat(20)}` as const;

/** A client whose answers depend on the block that a read names, as on a node behind a load balancer. */
const clientAt = (blockNumber: bigint, headers: (slot: unknown) => string = (slot) => (slot === 164n ? word(0x77) : word(0x00))) => {
  const readContract = vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
    if (functionName === "head") return 164n;
    if (functionName === "programVKey") return word(0x42);
    if (functionName === "headers") return headers(args?.[0]);
    throw new Error(`unexpected ${functionName}`);
  });
  return { readContract, getBlockNumber: vi.fn(async () => blockNumber) };
};

describe("the light client reader", () => {
  it("reads the head, the program key and the header root of that very head", async () => {
    const client = clientAt(900n);
    const state = await createLightClientReader(client as unknown as PublicClient, lightClient).read();
    expect(state).toEqual({ headSlot: 164n, headRoot: word(0x77), programKey: word(0x42) });
    expect(client.readContract).toHaveBeenCalledWith({ address: lightClient, abi: beaconLightClientAbi, functionName: "headers", args: [164n], blockNumber: 900n });
  });

  it("pins every read to one block, so the three answers come from one state", async () => {
    const client = clientAt(900n);
    await createLightClientReader(client as unknown as PublicClient, lightClient).read();
    expect(client.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(client.readContract.mock.calls.map(([call]) => call.blockNumber)).toEqual([900n, 900n, 900n]);
  });

  it("fails instead of giving an empty root for the head, as a node that lags would", async () => {
    const client = clientAt(900n, () => word(0x00));
    await expect(createLightClientReader(client as unknown as PublicClient, lightClient).read()).rejects.toThrow(/no header root/);
  });

  it("fails when a read fails", async () => {
    const readContract = vi.fn(async () => {
      throw new Error("down");
    });
    const client = { readContract, getBlockNumber: async () => 1n };
    await expect(createLightClientReader(client as unknown as PublicClient, lightClient).read()).rejects.toThrow("down");
  });
});
