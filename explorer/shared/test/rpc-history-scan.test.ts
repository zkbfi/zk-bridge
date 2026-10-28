import { describe, expect, it } from "vitest";
import { compareHistoryEvents, scanHistory, type ChainReader } from "../src/index.js";
import { createFakeChain } from "./support/fake-chain.js";
import { buildScenario, FIRST_CHAIN, SECOND_CHAIN } from "./support/scenario.js";
import { testPair } from "./support/fixtures.js";

const setup = () => {
  const pair = testPair();
  const scenario = buildScenario(pair);
  const first = createFakeChain(scenario, FIRST_CHAIN);
  const second = createFakeChain(scenario, SECOND_CHAIN);
  const readers = new Map<number, ChainReader>([
    [FIRST_CHAIN, first],
    [SECOND_CHAIN, second],
  ]);
  return { pair, scenario, readers };
};

describe("scanHistory", () => {
  it("lists the sends, deliveries and head updates of both chains, newest first, and says it is partial", async () => {
    const { pair, scenario, readers } = setup();
    const result = await scanHistory({ pair, readers, fromBlock: 0n });
    expect(result.partial).toBe(true);
    expect([...result.items].sort(compareHistoryEvents)).toEqual(result.items);
    const kinds = new Set(result.items.map((item) => item.kind));
    expect(kinds).toEqual(new Set(["sent", "delivered", "head-update"]));
    const sends = result.items.filter((item) => item.kind === "sent");
    expect(sends.map((item) => item.messageId).sort()).toEqual(Object.values(scenario.ids).sort());
  });

  it("puts a send on its source chain and a delivery on its destination chain", async () => {
    const { pair, scenario, readers } = setup();
    const { items } = await scanHistory({ pair, readers, fromBlock: 0n });
    const sent = items.find((item) => item.kind === "sent" && item.messageId === scenario.ids.delivered);
    const delivered = items.find((item) => item.kind === "delivered" && item.messageId === scenario.ids.delivered);
    expect(sent?.chainId).toBe(FIRST_CHAIN);
    expect(delivered?.chainId).toBe(SECOND_CHAIN);
    const back = items.find((item) => item.kind === "delivered" && item.messageId === scenario.ids.returned);
    expect(back?.chainId).toBe(FIRST_CHAIN);
  });

  it("gives the outcome of the delivery as the status, and null to a send with no delivery in the scan", async () => {
    const { pair, scenario, readers } = setup();
    const { items } = await scanHistory({ pair, readers, fromBlock: 0n });
    const statusOf = (id: string) => items.find((item) => item.kind === "sent" && item.messageId === id)?.status;
    expect(statusOf(scenario.ids.delivered)).toBe("delivered");
    expect(statusOf(scenario.ids.failed)).toBe("failed_call");
    expect(statusOf(scenario.ids.stuck)).toBe("release_failed");
    expect(statusOf(scenario.ids.young)).toBeNull();
  });

  it("gives a head update its slot and no message", async () => {
    const { pair, readers } = setup();
    const { items } = await scanHistory({ pair, readers, fromBlock: 0n });
    const heads = items.filter((item) => item.kind === "head-update");
    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) expect(head).toMatchObject({ messageId: null, status: null, slot: expect.any(BigInt) });
  });

  it("reads nothing below the first block that the caller names", async () => {
    const { pair, readers } = setup();
    const everything = await scanHistory({ pair, readers, fromBlock: 0n });
    const latest = 10_000_000n;
    const none = await scanHistory({ pair, readers, fromBlock: latest });
    expect(everything.items.length).toBeGreaterThan(0);
    expect(none.items).toEqual([]);
  });

  it("fails when a chain has no reader", async () => {
    const { pair, readers } = setup();
    readers.delete(SECOND_CHAIN);
    await expect(scanHistory({ pair, readers, fromBlock: 0n })).rejects.toThrow("No RPC reader is set for chain 369.");
  });
});
