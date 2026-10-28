import { describe, expect, it } from "bun:test";
import { encodeEventTopics, type Address, type Hex, type TransactionReceipt } from "viem";
import { beaconLightClientAbi, messageBridgeAbi } from "@zk-bridge/shared";
import { readBatchReceipt } from "../src/stages/bots.ts";

const lightClient: Address = "0x00000000000000000000000000000000000000a1";
const bridge: Address = "0x00000000000000000000000000000000000000b2";
const word = (value: number): Hex => `0x${value.toString(16).padStart(64, "0")}`;

const headUpdated = (): { address: Address; topics: Hex[]; data: Hex } => ({
  address: lightClient,
  topics: encodeEventTopics({ abi: beaconLightClientAbi, eventName: "HeadUpdated", args: { slot: 5n, headerRoot: word(1), executionBlockHash: word(2) } }) as Hex[],
  data: "0x",
});

describe("readBatchReceipt", () => {
  it("counts only the events of the named contracts", () => {
    const receipt = { logs: [headUpdated(), { ...headUpdated(), address: bridge }] } as unknown as TransactionReceipt;
    // The second log has the right event but the wrong emitter: the bridge cannot update the light client head.
    expect(readBatchReceipt(receipt, { lightClient, bridge })).toEqual({ headUpdates: 1, deliveries: 0 });
  });

  it("ignores a log it cannot decode", () => {
    const receipt = { logs: [{ address: bridge, topics: [word(7)], data: "0x" }] } as unknown as TransactionReceipt;
    expect(readBatchReceipt(receipt, { lightClient, bridge })).toEqual({ headUpdates: 0, deliveries: 0 });
    expect(messageBridgeAbi.length).toBeGreaterThan(0);
  });
});
