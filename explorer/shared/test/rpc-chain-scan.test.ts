import { describe, expect, it, vi } from "vitest";
import type { AbiEvent, Address } from "viem";
import type { ChainBlock, ChainLog, ChainReader, LogRequest } from "../src/index.js";
import { createChainScan as scan } from "../src/rpc/chain-scan.js";

const eventA = { type: "event", name: "A", inputs: [] } as unknown as AbiEvent;
const bridge = "0x00000000000000000000000000000000000000b1" as Address;
const mediator = "0x00000000000000000000000000000000000000d1" as Address;
const sources = [
  { address: bridge, events: [eventA] },
  { address: mediator, events: [eventA] },
];

const logAt = (blockNumber: bigint, logIndex = 0, address: Address = bridge): ChainLog => ({
  eventName: "A",
  address,
  blockNumber,
  logIndex,
  transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
  args: {},
});

/** A reader over a list of logs and a head. The test can make `getLogs` fail. */
const fakeReader = (input: { head: bigint; logs: () => readonly ChainLog[]; failWith?: (request: LogRequest) => Error | undefined }) => {
  const requests: LogRequest[] = [];
  const blocks: bigint[] = [];
  let head = input.head;
  const reader: ChainReader = {
    getChainId: async () => 1,
    async getBlock(selector) {
      if ("tag" in selector) return { number: head, timestamp: head * 10n, baseFeePerGas: null } satisfies ChainBlock;
      blocks.push(selector.blockNumber);
      return { number: selector.blockNumber, timestamp: selector.blockNumber * 10n, baseFeePerGas: null };
    },
    async getLogs(request) {
      requests.push(request);
      const failure = input.failWith?.(request);
      if (failure !== undefined) throw failure;
      return input.logs().filter((log) => log.address === request.address && log.blockNumber >= request.fromBlock && log.blockNumber <= request.toBlock);
    },
    readContract: async () => undefined,
    getTransactionReceipt: async () => {
      throw new Error("not used");
    },
  };
  return { reader, requests, blocks, moveHead: (next: bigint) => void (head = next) };
};

const make = (reader: ChainReader, overrides: Partial<Parameters<typeof scan>[0]> = {}, clock = { now: 0 }) =>
  scan({
    reader,
    sources,
    startBlock: 10n,
    blockSpan: 100n,
    minimumBlockSpan: 10n,
    reorgDepth: 5n,
    headMaxAgeMilliseconds: 1_000,
    now: () => clock.now,
    ...overrides,
  });

describe("the first window", () => {
  it("reads one window that ends at the head and is no longer than the block span, for every contract", async () => {
    const chain = fakeReader({ head: 500n, logs: () => [] });
    const scanner = make(chain.reader);
    await scanner.refresh();
    expect(chain.requests.map((request) => [request.address, request.fromBlock, request.toBlock])).toEqual([
      [bridge, 401n, 500n],
      [mediator, 401n, 500n],
    ]);
    expect(scanner.scannedFromBlock()).toBe(401n);
    expect(scanner.reachedStart()).toBe(false);
  });

  it("does not read below the start block when the head is close to it", async () => {
    const chain = fakeReader({ head: 50n, logs: () => [logAt(12n)] });
    const scanner = make(chain.reader);
    await scanner.refresh();
    expect(chain.requests[0]).toMatchObject({ fromBlock: 10n, toBlock: 50n });
    expect(scanner.reachedStart()).toBe(true);
    expect(scanner.logs().map((log) => log.blockNumber)).toEqual([12n]);
  });
});

describe("older windows", () => {
  it("reads the windows newest first, each next to the one before, and stops at the start block", async () => {
    const chain = fakeReader({ head: 250n, logs: () => [] });
    const scanner = make(chain.reader);
    await scanner.refresh();
    expect(await scanner.extendOlder()).toBe(true);
    expect(await scanner.extendOlder()).toBe(true);
    const windows = chain.requests.filter((request) => request.address === bridge).map((request) => [request.fromBlock, request.toBlock]);
    expect(windows).toEqual([
      [151n, 250n],
      [51n, 150n],
      [10n, 50n],
    ]);
    expect(scanner.reachedStart()).toBe(true);
    expect(await scanner.extendOlder()).toBe(false);
    expect(chain.requests.every((request) => request.toBlock - request.fromBlock + 1n <= 100n)).toBe(true);
  });

  it("does not extend before the first window", async () => {
    const chain = fakeReader({ head: 250n, logs: () => [] });
    expect(await make(chain.reader).extendOlder()).toBe(false);
  });

  it("keeps the logs of all windows in block order without duplicates", async () => {
    const logs = [logAt(240n, 1), logAt(160n, 0), logAt(160n, 3, mediator), logAt(60n, 0)];
    const chain = fakeReader({ head: 250n, logs: () => logs });
    const scanner = make(chain.reader);
    await scanner.refresh();
    await scanner.extendOlder();
    await scanner.extendOlder();
    expect(scanner.logs().map((log) => [log.blockNumber, log.logIndex])).toEqual([
      [60n, 0],
      [160n, 0],
      [160n, 3],
      [240n, 1],
    ]);
  });
});

describe("the timestamp of the oldest block", () => {
  it("is the timestamp of the lowest scanned block, and null once the scan reached the start block", async () => {
    const chain = fakeReader({ head: 250n, logs: () => [] });
    const scanner = make(chain.reader);
    expect(await scanner.oldestTimestamp()).toBeNull();
    await scanner.refresh();
    expect(await scanner.oldestTimestamp()).toBe(1510n);
    await scanner.extendOlder();
    await scanner.extendOlder();
    expect(await scanner.oldestTimestamp()).toBeNull();
  });
});

describe("new blocks", () => {
  it("reads from a few blocks before the old head, and replaces the logs that a reorganization changed", async () => {
    let logs: readonly ChainLog[] = [logAt(190n), logAt(248n)];
    const clock = { now: 0 };
    const chain = fakeReader({ head: 250n, logs: () => logs });
    const scanner = make(chain.reader, {}, clock);
    await scanner.refresh();
    expect(scanner.logs().map((log) => log.blockNumber)).toEqual([190n, 248n]);
    chain.requests.length = 0;
    logs = [logAt(190n), logAt(249n), logAt(255n)];
    chain.moveHead(260n);
    clock.now = 5_000;
    await scanner.refresh();
    expect(chain.requests[0]).toMatchObject({ fromBlock: 246n, toBlock: 260n });
    expect(scanner.logs().map((log) => log.blockNumber)).toEqual([190n, 249n, 255n]);
  });

  it("reads nothing when the head did not move", async () => {
    const clock = { now: 0 };
    const chain = fakeReader({ head: 250n, logs: () => [] });
    const scanner = make(chain.reader, {}, clock);
    await scanner.refresh();
    chain.requests.length = 0;
    clock.now = 5_000;
    await scanner.refresh();
    expect(chain.requests).toEqual([]);
  });

  it("never reads below the lowest scanned block when the reorganization depth is large", async () => {
    const clock = { now: 0 };
    const chain = fakeReader({ head: 50n, logs: () => [] });
    const scanner = make(chain.reader, { reorgDepth: 500n }, clock);
    await scanner.refresh();
    chain.requests.length = 0;
    chain.moveHead(60n);
    clock.now = 5_000;
    await scanner.refresh();
    expect(chain.requests[0]).toMatchObject({ fromBlock: 10n, toBlock: 60n });
  });
});

describe("the latest block", () => {
  it("is reused while it is fresh and read again when it is old", async () => {
    const clock = { now: 0 };
    const chain = fakeReader({ head: 250n, logs: () => [] });
    const getBlock = vi.spyOn(chain.reader, "getBlock");
    const scanner = make(chain.reader, {}, clock);
    expect((await scanner.head()).number).toBe(250n);
    clock.now = 500;
    await scanner.head();
    expect(getBlock).toHaveBeenCalledTimes(1);
    chain.moveHead(251n);
    clock.now = 1_500;
    expect((await scanner.head()).number).toBe(251n);
    expect(getBlock).toHaveBeenCalledTimes(2);
  });
});

describe("a window that the node refuses", () => {
  it("splits the window in halves when the node says the range is too large, and still returns every log", async () => {
    const logs = [logAt(120n), logAt(199n)];
    const chain = fakeReader({
      head: 200n,
      logs: () => logs,
      failWith: (request) => (request.toBlock - request.fromBlock + 1n > 30n ? new Error("query returned more than 10000 results") : undefined),
    });
    const scanner = make(chain.reader);
    await scanner.refresh();
    expect(scanner.logs().map((log) => log.blockNumber)).toEqual([120n, 199n]);
    const widths = chain.requests.filter((request) => request.toBlock - request.fromBlock + 1n <= 30n).map((request) => request.toBlock - request.fromBlock + 1n);
    expect(widths.length).toBeGreaterThan(0);
    expect(Math.max(...widths.map(Number))).toBeLessThanOrEqual(30);
  });

  it("gives up at the smallest window and passes the error on", async () => {
    const chain = fakeReader({ head: 200n, logs: () => [], failWith: () => new Error("block range too large") });
    await expect(make(chain.reader).refresh()).rejects.toThrow("block range too large");
    expect(chain.requests.every((request) => request.toBlock - request.fromBlock + 1n >= 10n)).toBe(true);
  });

  it("does not split for an error that is not about size, so an outage fails fast", async () => {
    const chain = fakeReader({ head: 200n, logs: () => [], failWith: () => new Error("connection refused") });
    await expect(make(chain.reader).refresh()).rejects.toThrow("connection refused");
    expect(chain.requests).toHaveLength(2);
  });

  it("turns an error that is not an Error object into the same rule", async () => {
    const chain = fakeReader({ head: 200n, logs: () => [], failWith: () => "plain text failure" as unknown as Error });
    await expect(make(chain.reader).refresh()).rejects.toBe("plain text failure");
  });
});

describe("block timestamps", () => {
  it("reads each block once and does not keep a failed read", async () => {
    const chain = fakeReader({ head: 250n, logs: () => [] });
    const scanner = make(chain.reader);
    expect(await scanner.blockTimestamp(77n)).toBe(770n);
    expect(await scanner.blockTimestamp(77n)).toBe(770n);
    expect(chain.blocks).toEqual([77n]);
    const failing = vi.spyOn(chain.reader, "getBlock").mockRejectedValueOnce(new Error("busy"));
    await expect(scanner.blockTimestamp(78n)).rejects.toThrow("busy");
    failing.mockRestore();
    expect(await scanner.blockTimestamp(78n)).toBe(780n);
  });
});
