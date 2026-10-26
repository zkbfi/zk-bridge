import { toEventSelector, type PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { beaconLightClientAbi, messageBridgeAbi } from "@zk-bridge/shared";
import { createLightClientReader } from "../../src/chain/light-client.ts";
import { createSourceReader } from "../../src/runner/source-reader.ts";
import { address, word } from "../support/builders.ts";

describe("the light client reader", () => {
  it("reads the head, the program key and the header root of that very head", async () => {
    const readContract = vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === "head") return 164n;
      if (functionName === "programVKey") return word(0x42);
      if (functionName === "headers") return args?.[0] === 164n ? word(0x77) : word(0x00);
      throw new Error(`unexpected ${functionName}`);
    });
    const lightClient = address(0x44);
    const state = await createLightClientReader({ readContract } as unknown as PublicClient, lightClient).read();
    expect(state).toEqual({ headSlot: 164n, headRoot: word(0x77), programKey: word(0x42) });
    expect(readContract).toHaveBeenCalledWith({ address: lightClient, abi: beaconLightClientAbi, functionName: "headers", args: [164n] });
  });
});

describe("the source reader", () => {
  const bridge = address(0x33);
  const request = toEventSelector(messageBridgeAbi.find((entry) => entry.type === "event" && entry.name === "UserRequestForAffirmation") as never);
  const messageId = word(0x0a);
  const readerOver = (logs: ReadonlyArray<{ address: string; topics: readonly (string | undefined)[] }>) =>
    createSourceReader({ getTransactionReceipt: async () => ({ logs }) } as unknown as PublicClient, bridge);

  it("counts the position of the log inside the receipt, among all logs", async () => {
    const reader = readerOver([
      { address: address(0x99), topics: [request, messageId] },
      { address: bridge, topics: [request, word(0x0b)] },
      { address: bridge, topics: [request, messageId] },
    ]);
    expect(await reader.findMessageLogIndex({ transactionHash: word(1), messageId })).toBe(2);
  });

  it("compares the address and the message identifier without regard to letter case", async () => {
    const reader = readerOver([{ address: bridge.toUpperCase().replace("0X", "0x"), topics: [request, messageId.toUpperCase().replace("0X", "0x")] }]);
    expect(await reader.findMessageLogIndex({ transactionHash: word(1), messageId })).toBe(0);
  });

  it.each([
    ["another contract", [{ address: address(0x99), topics: [request, messageId] }]],
    ["another event", [{ address: bridge, topics: [word(0x01), messageId] }]],
    ["another message", [{ address: bridge, topics: [request, word(0x0c)] }]],
    ["no message topic", [{ address: bridge, topics: [request] }]],
    ["no logs", []],
  ])("returns null for %s", async (_name, logs) => {
    expect(await readerOver(logs).findMessageLogIndex({ transactionHash: word(1), messageId })).toBeNull();
  });
});
