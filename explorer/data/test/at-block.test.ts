import { describe, expect, it } from "vitest";
import {
  pinReader,
  readAt,
  readBridgedCopyAt,
  readFinalizedSlot,
  readFinalizedSlotAt,
  readGateAt,
  readMediatorBalancesAt,
  readStoredHeadAt,
  type ChainBlock,
  type ChainReader,
  type ViewCall,
} from "../src/index.js";
import { address } from "./support/builders.js";
import { testPair } from "./support/fixtures.js";

const side = testPair().sides[0]!;
const otherSide = testPair().sides[1]!;

const blockAt = (number: bigint): ChainBlock => ({ number, timestamp: 1_000n + number, baseFeePerGas: 7n });

/** A reader that remembers each call, and moves its latest block on every `getBlock("latest")`. */
function fakeReader(answer: (call: ViewCall) => unknown, options: { latest?: bigint; finalized?: bigint | "fail" } = {}) {
  let latest = options.latest ?? 100n;
  const reads: ViewCall[] = [];
  const blocks: unknown[] = [];
  const reader: ChainReader = {
    getChainId: async () => 1,
    async getBlock(selector) {
      blocks.push(selector);
      if ("blockNumber" in selector) return blockAt(selector.blockNumber);
      if (selector.tag === "finalized") {
        if (options.finalized === "fail") throw new Error("no finalized tag");
        return blockAt(options.finalized ?? 90n);
      }
      return blockAt(latest++);
    },
    getLogs: async () => [],
    async readContract(call) {
      reads.push(call);
      return answer(call);
    },
    getTransactionReceipt: async () => ({ from: address(1), blockNumber: 1n, gasUsed: 1n, effectiveGasPrice: 1n, logs: [] }),
  };
  return { reader, reads, blocks };
}

describe("pinReader", () => {
  it("names the block in contract reads, keeps a block that the call names, and passes the other methods through", async () => {
    const { reader, reads, blocks } = fakeReader(() => 1n);
    const pinned = pinReader(reader, 55n);
    await pinned.readContract({ address: address(1), abi: [], functionName: "a" });
    await pinned.readContract({ address: address(1), abi: [], functionName: "b", blockNumber: 7n });
    expect(reads.map((call) => call.blockNumber)).toEqual([55n, 7n]);
    expect(await pinned.getChainId()).toBe(1);
    expect((await pinned.getBlock({ blockNumber: 3n })).number).toBe(3n);
    expect(await pinned.getLogs({ address: address(1), events: [], fromBlock: 1n, toBlock: 2n })).toEqual([]);
    expect((await pinned.getTransactionReceipt("0x01")).gasUsed).toBe(1n);
    expect(blocks).toEqual([{ blockNumber: 3n }]);
  });
});

describe("readAt", () => {
  it("reads a tag once, fixes it to its number, and returns the block", async () => {
    const { reader, reads, blocks } = fakeReader(() => 5n);
    const result = await readAt(reader, { tag: "latest" }, async (pinned, block) => {
      await pinned.readContract({ address: address(1), abi: [], functionName: "x" });
      await pinned.readContract({ address: address(1), abi: [], functionName: "y" });
      return block.number;
    });
    expect(result).toEqual({ value: 100n, block: blockAt(100n) });
    expect(reads.map((call) => call.blockNumber)).toEqual([100n, 100n]);
    expect(blocks).toEqual([{ tag: "latest" }]);
  });

  it("reads at a block number the caller names", async () => {
    const { reader, reads } = fakeReader(() => 5n);
    const result = await readAt(reader, { blockNumber: 42n }, (pinned) => pinned.readContract({ address: address(1), abi: [], functionName: "x" }));
    expect(result.block.number).toBe(42n);
    expect(reads[0]?.blockNumber).toBe(42n);
  });
});

describe("the reads of the contracts at one block", () => {
  it("reads the stored head at one block, and gives null for slot zero", async () => {
    const answers: Record<string, unknown> = { head: 9n, executionBlockHashes: "0xaa", executionBlockNumber: 77n };
    const { reader, reads } = fakeReader((call) => answers[call.functionName]);
    const result = await readStoredHeadAt(reader, side);
    expect(result).toEqual({ value: { slot: 9n, executionBlockNumber: 77n }, block: blockAt(100n) });
    expect(reads.map((call) => call.blockNumber)).toEqual([100n, 100n, 100n]);
    answers.head = 0n;
    expect((await readStoredHeadAt(reader, side, { blockNumber: 5n })).value).toBeNull();
  });

  it("reads the gate at one block", async () => {
    const answers: Record<string, unknown> = {
      enforcing: true,
      isSealed: false,
      depositsOpen: true,
      confirmedEpoch: [3n, true],
      genesisTime: 1_000n,
      slotsPerEpoch: 32n,
      secondsPerSlot: 12n,
    };
    const { reader, reads } = fakeReader((call) => answers[call.functionName]);
    const result = await readGateAt(reader, side);
    expect(result.value).toEqual({ enforcing: true, sealed: false, depositsOpen: true, confirmedEpoch: 3n, confirmedEpochStart: 1_000n + 3n * 32n * 12n });
    expect(result.block.number).toBe(100n);
    expect(reads.every((call) => call.blockNumber === 100n)).toBe(true);
  });

  it("reads the escrow of a token at one block", async () => {
    const { reader, reads } = fakeReader(() => 12n);
    const result = await readMediatorBalancesAt(reader, side, address(5), { blockNumber: 8n });
    expect(result).toEqual({ value: { escrow: 12n }, block: blockAt(8n) });
    expect(reads[0]?.blockNumber).toBe(8n);
  });

  it("reads a bridged copy at one block of the other chain", async () => {
    const native = address(5);
    const copy = address(6);
    const { reader, reads } = fakeReader((call) => ({ bridgedTokenAddress: copy, nativeTokenAddress: native, totalSupply: 40n })[call.functionName]);
    const result = await readBridgedCopyAt(reader, otherSide, native);
    expect(result.value).toEqual({ token: copy, supply: 40n });
    expect(reads.every((call) => call.blockNumber === 100n)).toBe(true);
  });
});

describe("the finalized slot", () => {
  const lightClient = { genesisTime: 1_000n, secondsPerSlot: 12n };

  it("returns the slot with the finalized block it came from", async () => {
    const light = fakeReader((call) => lightClient[call.functionName as keyof typeof lightClient]);
    const tracked = fakeReader(() => 0n, { finalized: 1_120n });
    const result = await readFinalizedSlotAt(light.reader, tracked.reader, side);
    expect(result).toEqual({ slot: (1_000n + 1_120n - 1_000n) / 12n === 0n ? 0 : Number((blockAt(1_120n).timestamp - 1_000n) / 12n), block: blockAt(1_120n) });
    expect(await readFinalizedSlot(light.reader, tracked.reader, side)).toBe(result?.slot);
  });

  it("gives null when the finalized block is older than genesis or a read fails", async () => {
    const light = fakeReader((call) => ({ genesisTime: 9_999_999n, secondsPerSlot: 12n })[call.functionName as "genesisTime"]);
    expect(await readFinalizedSlotAt(light.reader, fakeReader(() => 0n).reader, side)).toBeNull();
    const failing = fakeReader(() => 0n, { finalized: "fail" });
    expect(await readFinalizedSlotAt(fakeReader(() => lightClient.genesisTime).reader, failing.reader, side)).toBeNull();
    expect(await readFinalizedSlot(light.reader, failing.reader, side)).toBeNull();
  });
});
