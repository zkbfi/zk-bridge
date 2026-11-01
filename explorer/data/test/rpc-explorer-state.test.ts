import { describe, expect, it } from "vitest";
import { ConnectionNotSetError, createRpcExplorer } from "../src/index.js";
import { createFakeChain } from "./support/fake-chain.js";
import { testPair } from "./support/fixtures.js";
import { buildScenario } from "./support/scenario.js";

const pair = testPair();
const scenario = buildScenario(pair);
const readers = () => ({ 1: createFakeChain(scenario, 1), 369: createFakeChain(scenario, 369) });

describe("the explorer state", () => {
  it("reads older windows on the chain with the shortest history, and stops when both chains reached the start block", async () => {
    const explorer = createRpcExplorer({ pair, readers: readers(), blockSpan: 150, minimumBlockSpan: 10 });
    await explorer.prepare();
    const reads = [] as boolean[];
    for (let step = 0; step < 6; step += 1) reads.push(await explorer.extendOlder());
    expect(reads).toEqual([true, true, false, false, false, false]);
    const snapshot = await explorer.snapshot();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.horizon).toBeNull();
    expect([...snapshot.reachedStart.values()]).toEqual([true, true]);
  });

  it("builds a snapshot with the latest block, the stored head and the lowest scanned block of each chain", async () => {
    const explorer = createRpcExplorer({ pair, readers: readers(), blockSpan: 100 });
    await explorer.prepare();
    const snapshot = await explorer.snapshot();
    expect(snapshot.tips.get(1)?.number).toBe(300n);
    expect(snapshot.heads.get(369)).toMatchObject({ slot: 300n, executionBlockNumber: 105n });
    expect(snapshot.scannedFromBlock.get(1)).toBe(201n);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.horizon).toBe(scenario.timestampOf(1, 201n));
  });

  it("keeps a snapshot for a few seconds, so three polls at once read the chains once", async () => {
    const chains = readers();
    let now = 0;
    const explorer = createRpcExplorer({ pair, readers: chains, now: () => now, headMaxAgeMilliseconds: 4_000 });
    await explorer.prepare();
    const first = await explorer.snapshot();
    const calls = chains[1].calls.readContract.length;
    expect(await explorer.snapshot()).toBe(first);
    expect(chains[1].calls.readContract.length).toBe(calls);
    now = 5_000;
    expect(await explorer.snapshot()).not.toBe(first);
  });

  it("serves the timestamps and the receipts that it reads, and keeps a receipt that it read", async () => {
    const chains = readers();
    const explorer = createRpcExplorer({ pair, readers: chains });
    const hash = scenario.events[0]!.transactionHash;
    expect(await explorer.blockTimestamp(1, 100n)).toBe(scenario.timestampOf(1, 100n));
    expect((await explorer.receipt(1, hash)).from).toBe(`0x${"e0".repeat(20)}`);
    await explorer.receipt(1, hash);
    expect(chains[1].calls.getTransactionReceipt).toEqual([hash]);
    expect((await explorer.tip(369)).number).toBe(300n);
  });

  it("does not keep a receipt that failed to read, so the next call asks again", async () => {
    const chains = readers();
    const explorer = createRpcExplorer({ pair, readers: chains });
    const hash = `0x${"7".repeat(64)}` as const;
    await expect(explorer.receipt(1, hash)).rejects.toThrow("receipt was not found");
    await expect(explorer.receipt(1, hash)).rejects.toThrow("receipt was not found");
    expect(chains[1].calls.getTransactionReceipt).toHaveLength(2);
  });

  it("says which chain has no reader", async () => {
    const explorer = createRpcExplorer({ pair, readers: { 1: createFakeChain(scenario, 1) } });
    await expect(explorer.prepare()).rejects.toThrow(new ConnectionNotSetError("No RPC URL is set for pulsechain."));
    expect(() => explorer.readerOf(369)).toThrow("No RPC URL is set for pulsechain.");
  });
});
