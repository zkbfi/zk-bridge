import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeStates, chainTips, gateStates, lightClientHeads } from "../../ponder.schema";
import { GATE_ON_PULSECHAIN, LIGHT_CLIENT_ON_PULSECHAIN, hashOf } from "./support/handler-fixtures";
import { publicClients, respondWith, type QueryCall } from "./support/fake-api";

// The caches of the module read `Date.now` when the module loads, so the fake clock starts before the import.
vi.useFakeTimers();
const { loadGates, loadHeads } = await import("../../src/api/heads");

type Rows = Partial<Record<"head" | "tip" | "gate" | "bridge", Record<string, unknown>[]>>;

/** Answers each query with the rows of its table that match the chain in its `where` clause. */
const respondByChain = (rows: Rows) =>
  respondWith((call: QueryCall) => {
    const bySource = new Map<unknown, Record<string, unknown>[] | undefined>([
      [lightClientHeads, rows.head],
      [chainTips, rows.tip],
      [gateStates, rows.gate],
      [bridgeStates, rows.bridge],
    ]);
    return (bySource.get(call.table) ?? []).filter((row) => call.whereValues.includes(row.chainId));
  });

/** The time of a block is kept for ever by block number, so each test gets a head with a block number of its own. */
let nextBlockNumber = 5_000n;
const freshHead = () => ({ chainId: 369, slot: 1_000n, headerRoot: hashOf("11"), executionBlockNumber: nextBlockNumber++, updatedTimestamp: 9_000n, updateCount: 4 });
const ethereumTip = { chainId: 1, blockNumber: 5_100n, timestamp: 61_000n, baseFeePerGas: null };
const pulseTip = { chainId: 369, blockNumber: 77n, timestamp: 9_500n, baseFeePerGas: null };

const stubBeacon = (slot: string | null) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: slot !== null, json: async () => ({ data: { header: { message: { slot } } } }) })),
  );

let clock = Date.now();

beforeEach(() => {
  // The caches hold an entry for 10 seconds (slot) and 5 seconds (gate flags). A minute apart gives each test a clean start.
  clock += 60_000;
  vi.setSystemTime(clock);
  for (const key of Object.keys(publicClients)) delete publicClients[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadHeads", () => {
  it("shows the stored head, the tips of both chains and the counts of the light client on each side", async () => {
    const head = freshHead();
    respondByChain({ head: [head], tip: [ethereumTip, pulseTip] });
    publicClients.ethereum = { getBlock: vi.fn(async () => ({ timestamp: 60_000n })) };
    stubBeacon("1200");
    const [ethereumSide, pulseSide] = await loadHeads();
    expect(pulseSide).toEqual({
      chainId: 369,
      name: "pulsechain",
      lightClient: LIGHT_CLIENT_ON_PULSECHAIN,
      trackedChainId: 1,
      storedHeadSlot: 1_000,
      storedHeadSource: "update",
      storedHeadExecutionBlock: Number(head.executionBlockNumber),
      storedHeadExecutionTimestamp: 60_000,
      storedHeadSlotTimestamp: null,
      lastUpdateTimestamp: 9_000,
      updateCount: 4,
      initialized: true,
      initializedAtSlot: null,
      initializedAtBlock: null,
      finalizedSlot: 1_200,
      lagSlots: 200,
      lagSeconds: 1_000,
      trackedChainTipBlock: 5_100,
      trackedChainTipTimestamp: 61_000,
      ownChainTipBlock: 77,
      ownChainTipTimestamp: 9_500,
    });
    expect(ethereumSide).toMatchObject({
      chainId: 1,
      trackedChainId: 369,
      storedHeadSlot: null,
      updateCount: 0,
      finalizedSlot: null,
      lagSlots: null,
      lagSeconds: null,
      ownChainTipBlock: 5_100,
      trackedChainTipBlock: 77,
    });
  });

  it("asks the beacon node of the tracked chain and reads the block time on the tracked chain", async () => {
    const head = freshHead();
    respondByChain({ head: [head], tip: [ethereumTip] });
    const getBlock = vi.fn(async () => ({ timestamp: 60_000n }));
    publicClients.ethereum = { getBlock };
    stubBeacon("1200");
    await loadHeads();
    expect(getBlock).toHaveBeenCalledWith({ blockNumber: head.executionBlockNumber });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("http://127.0.0.1:5052/eth/v1/beacon/headers/finalized");
  });

  it("shows the head of the deployment as the stored head, and measures its lag from the start time of its slot", async () => {
    // Slot 4_000 at 12 seconds from genesis 10_000 starts at 58_000; the tracked tip is at 61_000.
    const deployment = {
      chainId: 369,
      slot: 4_000n,
      headerRoot: hashOf("cc"),
      executionBlockNumber: null,
      updatedTimestamp: null,
      updateCount: 0,
      initialSlot: 4_000n,
      initialHeadBlockNumber: 70n,
      genesisTime: 10_000n,
      secondsPerSlot: 12n,
    };
    respondByChain({ head: [deployment], tip: [ethereumTip, pulseTip] });
    const getBlock = vi.fn(async () => ({ timestamp: 1n }));
    publicClients.ethereum = { getBlock };
    stubBeacon("4300");
    const [, pulseSide] = await loadHeads();
    expect(getBlock).not.toHaveBeenCalled();
    expect(pulseSide).toMatchObject({
      storedHeadSlot: 4_000,
      storedHeadSource: "deployment",
      storedHeadExecutionBlock: null,
      storedHeadExecutionTimestamp: null,
      storedHeadSlotTimestamp: 58_000,
      lastUpdateTimestamp: null,
      updateCount: 0,
      initialized: true,
      initializedAtSlot: 4_000,
      initializedAtBlock: 70,
      lagSlots: 300,
      lagSeconds: 3_000,
    });
  });

  it("answers a lag of zero, not a negative lag, when the head is ahead of the finalized slot", async () => {
    const head = freshHead();
    respondByChain({ head: [head], tip: [ethereumTip] });
    publicClients.ethereum = { getBlock: vi.fn(async () => ({ timestamp: 62_000n })) };
    stubBeacon("900");
    const [, pulseSide] = await loadHeads();
    expect(pulseSide).toMatchObject({ lagSlots: 0, lagSeconds: 0 });
  });

  it("answers null for the finalized slot and the lag when the beacon node does not answer", async () => {
    const head = freshHead();
    respondByChain({ head: [head], tip: [ethereumTip] });
    publicClients.ethereum = { getBlock: vi.fn(async () => ({ timestamp: 60_000n })) };
    stubBeacon(null);
    const [, pulseSide] = await loadHeads();
    expect(pulseSide).toMatchObject({ finalizedSlot: null, lagSlots: null, lagSeconds: 1_000 });
  });

  it("answers null for the time lag when the tracked chain has no tip yet", async () => {
    const head = freshHead();
    respondByChain({ head: [head], tip: [] });
    publicClients.ethereum = { getBlock: vi.fn(async () => ({ timestamp: 60_000n })) };
    stubBeacon("1200");
    const [, pulseSide] = await loadHeads();
    expect(pulseSide).toMatchObject({ storedHeadExecutionTimestamp: 60_000, lagSeconds: null, trackedChainTipBlock: null });
  });

  it("answers null for the block time when the chain has no client", async () => {
    const head = freshHead();
    respondByChain({ head: [head], tip: [ethereumTip] });
    stubBeacon("1200");
    const [, pulseSide] = await loadHeads();
    expect(pulseSide).toMatchObject({ storedHeadExecutionTimestamp: null, lagSeconds: null });
  });

  it("answers null for the block time when the read fails, and asks again the next time", async () => {
    const head = freshHead();
    respondByChain({ head: [head], tip: [ethereumTip] });
    const getBlock = vi.fn().mockRejectedValueOnce(new Error("rpc down")).mockResolvedValueOnce({ timestamp: 60_000n });
    publicClients.ethereum = { getBlock };
    stubBeacon("1200");
    expect((await loadHeads())[1]).toMatchObject({ storedHeadExecutionTimestamp: null });
    expect((await loadHeads())[1]).toMatchObject({ storedHeadExecutionTimestamp: 60_000 });
    expect(getBlock).toHaveBeenCalledTimes(2);
  });

  it("reads the time of a block once and keeps it, because a finalized block does not change", async () => {
    const head = freshHead();
    respondByChain({ head: [head], tip: [ethereumTip] });
    const getBlock = vi.fn(async () => ({ timestamp: 60_000n }));
    publicClients.ethereum = { getBlock };
    stubBeacon("1200");
    await loadHeads();
    await loadHeads();
    expect(getBlock).toHaveBeenCalledTimes(1);
  });

  it("reads the finalized slot once for ten seconds, and again after that", async () => {
    const head = freshHead();
    respondByChain({ head: [head], tip: [ethereumTip] });
    publicClients.ethereum = { getBlock: vi.fn(async () => ({ timestamp: 60_000n })) };
    stubBeacon("1200");
    await loadHeads();
    vi.advanceTimersByTime(9_000);
    await loadHeads();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await loadHeads();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});

describe("loadGates", () => {
  const gateRow = {
    chainId: 369,
    sealed: false,
    sealedVersion: "0x05000000",
    sealedSlot: 900n,
    enforcing: false,
    lastConfirmedEpoch: 12n,
    lastConfirmedVersion: "0x04000000",
    lastConfirmedTimestamp: 1_000n,
    confirmations: 3,
  };
  const bridgeRow = { chainId: 369, depositsOpen: true, openedRemoteSlot: 9n, openedBlockNumber: 8n, openedTimestamp: 7_000n };
  const flags = (enforcing: unknown, sealed: unknown) =>
    vi.fn(async ({ functionName }: { functionName: string }) => (functionName === "enforcing" ? enforcing : sealed));

  it("reads the mode flags live from the gate contract of each side and shows the stored facts", async () => {
    respondByChain({ gate: [gateRow], bridge: [bridgeRow] });
    const readContract = flags(true, true);
    publicClients.pulsechain = { readContract };
    const [, pulseSide] = await loadGates();
    expect(readContract).toHaveBeenCalledWith({ abi: expect.anything(), address: GATE_ON_PULSECHAIN, functionName: "enforcing" });
    expect(readContract).toHaveBeenCalledWith({ abi: expect.anything(), address: GATE_ON_PULSECHAIN, functionName: "isSealed" });
    expect(pulseSide).toEqual({
      chainId: 369,
      name: "pulsechain",
      gate: GATE_ON_PULSECHAIN,
      enforcing: true,
      sealed: true,
      sealedVersion: "0x05000000",
      sealedSlot: 900,
      lastConfirmedEpoch: 12,
      lastConfirmedVersion: "0x04000000",
      lastConfirmedTimestamp: 1_000,
      confirmations: 3,
      depositsOpen: true,
      depositsOpenedTimestamp: 7_000,
    });
  });

  it("treats a flag that is not exactly true as false", async () => {
    respondByChain({ gate: [gateRow] });
    publicClients.pulsechain = { readContract: flags("yes", 1) };
    expect((await loadGates())[1]).toMatchObject({ enforcing: false, sealed: false });
  });

  it("falls back to the stored flags when the chain does not answer", async () => {
    respondByChain({ gate: [{ ...gateRow, enforcing: true, sealed: true }] });
    publicClients.pulsechain = {
      readContract: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    };
    expect((await loadGates())[1]).toMatchObject({ enforcing: true, sealed: true });
  });

  it("falls back to the stored flags when the side has no client", async () => {
    respondByChain({ gate: [{ ...gateRow, enforcing: true, sealed: false }] });
    expect((await loadGates())[1]).toMatchObject({ enforcing: true, sealed: false });
  });

  it("answers null flags, no confirmations and closed deposits when nothing is stored and the chain is silent", async () => {
    respondByChain({});
    expect((await loadGates())[0]).toEqual({
      chainId: 1,
      name: "ethereum",
      gate: "0x00000000000000000000000000000000000000c1",
      enforcing: null,
      sealed: null,
      sealedVersion: null,
      sealedSlot: null,
      lastConfirmedEpoch: null,
      lastConfirmedVersion: null,
      lastConfirmedTimestamp: null,
      confirmations: 0,
      depositsOpen: false,
      depositsOpenedTimestamp: null,
    });
  });

  it("keeps the flags of a chain for five seconds, and reads again after that", async () => {
    respondByChain({});
    const readContract = flags(true, false);
    publicClients.pulsechain = { readContract };
    await loadGates();
    vi.advanceTimersByTime(4_000);
    await loadGates();
    expect(readContract).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2_000);
    await loadGates();
    expect(readContract).toHaveBeenCalledTimes(4);
  });
});
