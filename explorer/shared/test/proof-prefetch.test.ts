import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, keccak256, type Hex, type PublicClient } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProofCacheStore, type ProofCacheEntry, type ProofCacheStore } from "../src/prover/proof-cache.js";
import {
  checkpointsBetween,
  createProofPrefetcher,
  createViemPrefetchClient,
  lightClientClock,
  storedHeadBlockHashes,
  openingStorageKey,
  slotOfTimestamp,
  withoutUrls,
  type BlockStamp,
  type ProofPrefetchClient,
  type ProofPrefetcherDependencies,
} from "../src/prover/proof-prefetch.js";

const CHAIN = 11155111;
const ADDRESS = `0x${"c3".repeat(20)}` as const;
const CLOCK = { genesisTime: 1_000n, secondsPerSlot: 12n };
const hashOf = (number: bigint): Hex => `0x${number.toString(16).padStart(64, "0")}`;

/** A block at `slot`: timestamp genesis + slot * 12. */
const at = (number: bigint, slot: bigint): BlockStamp => ({ number, hash: hashOf(number), timestamp: CLOCK.genesisTime + slot * CLOCK.secondsPerSlot });

describe("openingStorageKey", () => {
  it("is keccak256(abi.encode(uint256(storedSlot), 3)), the slot rule of opening.rs", () => {
    const expected = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [9000n, 3n]));
    expect(openingStorageKey(9000n)).toBe(expected);
  });
});

describe("slotOfTimestamp", () => {
  it("counts whole slots from genesis, and gives slot 0 at or before genesis", () => {
    expect(slotOfTimestamp(1_000n + 12n * 64n + 11n, CLOCK)).toBe(64n);
    expect(slotOfTimestamp(1_000n, CLOCK)).toBe(0n);
    expect(slotOfTimestamp(10n, CLOCK)).toBe(0n);
  });
});

describe("checkpointsBetween", () => {
  it("is the next block when it holds the first slot of an epoch", () => {
    expect(checkpointsBetween(at(9n, 63n), at(10n, 64n), CLOCK)).toEqual([at(10n, 64n)]);
  });

  it("is the previous block when the first slot of the epoch is empty", () => {
    expect(checkpointsBetween(at(9n, 63n), at(10n, 65n), CLOCK)).toEqual([at(9n, 63n)]);
  });

  it("is nothing when no epoch starts between the two blocks", () => {
    expect(checkpointsBetween(at(9n, 64n), at(10n, 65n), CLOCK)).toEqual([]);
    // Two blocks of one slot: the epoch start was the first one, already counted.
    expect(checkpointsBetween(at(9n, 64n), at(10n, 64n), CLOCK)).toEqual([]);
  });

  it("gives both blocks when an empty epoch start and a filled one lie between them", () => {
    expect(checkpointsBetween(at(9n, 63n), at(10n, 128n), CLOCK)).toEqual([at(9n, 63n), at(10n, 128n)]);
  });

  it("takes the slots of an epoch from the clock", () => {
    expect(checkpointsBetween(at(9n, 7n), at(10n, 8n), { ...CLOCK, slotsPerEpoch: 8n })).toEqual([at(10n, 8n)]);
  });
});

describe("withoutUrls", () => {
  it("keeps only the host of every URL in a text", () => {
    expect(withoutUrls('HTTP request failed. URL: https://user:pw@rpc.example.org:8545/v3/KEY?x=1 Details: "boom" (ws://h/k)')).toBe(
      'HTTP request failed. URL: https://rpc.example.org:8545 Details: "boom" (ws://h)',
    );
  });
});

/** A chain whose blocks have the slots in `slots` (block number = index), with a stored head and proofs. */
function fakeChain(slots: readonly bigint[]) {
  const state = { tip: BigInt(slots.length - 1), headFailures: 0, proofFailures: 0, head: 4242n };
  const calls: string[] = [];
  const client: ProofPrefetchClient = {
    async blockNumber() {
      calls.push("blockNumber");
      return state.tip;
    },
    async block(number) {
      calls.push(`block ${number}`);
      const slot = slots[Number(number)];
      if (slot === undefined) throw new Error(`no block ${number}`);
      return at(number, slot);
    },
    async storedHead(address, blockNumber) {
      calls.push(`head ${address} ${blockNumber}`);
      if (state.headFailures > 0) {
        state.headFailures -= 1;
        throw new Error("fetch failed. URL: https://rpc.example.org/v3/SECRET");
      }
      return state.head;
    },
    async accountProof(address, keys, blockNumber) {
      calls.push(`proof ${address} ${keys.join(",")} ${blockNumber}`);
      if (state.proofFailures > 0) {
        state.proofFailures -= 1;
        throw new Error("429 Too Many Requests at https://rpc.example.org/v3/SECRET");
      }
      return { accountProof: [`0x${blockNumber.toString(16)}`], storageProof: [{ key: keys[0], value: "0x1", proof: [] }] };
    },
  };
  return { client, state, calls };
}

function memoryStore() {
  const entries = new Map<string, ProofCacheEntry>();
  const pruned: Array<{ keep: number; protectedBlockHashes: readonly string[] }> = [];
  const store: ProofCacheStore = {
    async has(key) {
      return entries.has(`${key.blockNumber}-${key.blockHash}`);
    },
    async read(key) {
      return entries.get(`${key.blockNumber}-${key.blockHash}`) ?? null;
    },
    async write(entry) {
      entries.set(`${entry.blockNumber}-${entry.blockHash}`, entry);
    },
    async prune(input) {
      pruned.push({ keep: input.keep, protectedBlockHashes: input.protectedBlockHashes });
      return 1;
    },
  };
  return { store, entries, pruned };
}

function logs() {
  const lines: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  return {
    lines,
    logger: {
      info: (event: string, fields: Record<string, unknown> = {}) => lines.push({ level: "info", event, fields }),
      warn: (event: string, fields: Record<string, unknown> = {}) => lines.push({ level: "warn", event, fields }),
    },
  };
}

function prefetcherOn(slots: readonly bigint[], extra: Partial<ProofPrefetcherDependencies> = {}) {
  const chain = fakeChain(slots);
  const cache = memoryStore();
  const log = logs();
  const sleep = vi.fn(async (_milliseconds: number) => undefined);
  let open = false;
  const prefetcher = createProofPrefetcher({
    chainId: CHAIN,
    address: ADDRESS,
    client: chain.client,
    store: cache.store,
    clock: async () => CLOCK,
    isOpen: async () => open,
    logger: log.logger,
    sleep,
    now: () => Date.parse("2026-11-01T00:00:00.000Z"),
    ...extra,
  });
  return { prefetcher, chain, cache, log, sleep, setOpen: (value: boolean) => (open = value) };
}

describe("createProofPrefetcher", () => {
  it("stores the eth_getProof answer at the checkpoint block of an epoch, with the key of the stored head, and logs it without a URL", async () => {
    // Slots: block 0 at 62, 1 at 63, 2 at 64 (an epoch start).
    const { prefetcher, chain, cache, log } = prefetcherOn([62n, 63n, 64n]);
    expect(await prefetcher.step()).toEqual({ kind: "followed", tip: 2n, checkpoints: 1, stored: 1, failed: 0 });
    const key = openingStorageKey(4242n);
    expect(chain.calls).toEqual(["blockNumber", "block 1", "block 2", `head ${ADDRESS} 2`, `proof ${ADDRESS} ${key} 2`]);
    expect([...cache.entries.values()]).toEqual([
      {
        schemaVersion: 1,
        chainId: CHAIN,
        blockNumber: 2,
        blockHash: hashOf(2n),
        address: ADDRESS,
        storedSlot: 4242,
        storageKeys: [key],
        fetchedAt: "2026-11-01T00:00:00.000Z",
        proof: { accountProof: ["0x2"], storageProof: [{ key, value: "0x1", proof: [] }] },
      },
    ]);
    expect(log.lines.find((line) => line.event === "proof_prefetched")).toEqual({
      level: "info",
      event: "proof_prefetched",
      fields: { chainId: CHAIN, blockNumber: 2n, blockHash: hashOf(2n), storedSlot: 4242n, attempts: 1 },
    });
    expect(cache.pruned).toEqual([{ keep: 256, protectedBlockHashes: [] }]);
    expect(log.lines.find((line) => line.event === "proof_cache_pruned")).toMatchObject({ fields: { chainId: CHAIN, removed: 1 } });
  });

  it("follows the head from the block it saw last, and does nothing while the tip has not moved", async () => {
    const slots = [60n, 61n, 62n, 63n, 65n, 66n];
    const { prefetcher, chain, cache } = prefetcherOn(slots);
    chain.state.tip = 1n;
    expect(await prefetcher.step()).toMatchObject({ checkpoints: 0 });
    expect(await prefetcher.step()).toEqual({ kind: "followed", tip: 1n, checkpoints: 0, stored: 0, failed: 0 });
    chain.calls.length = 0;
    chain.state.tip = 5n;
    // Slot 64 is empty: the checkpoint is block 3 at slot 63.
    expect(await prefetcher.step()).toMatchObject({ checkpoints: 1, stored: 1 });
    expect(chain.calls.slice(0, 5)).toEqual(["blockNumber", "block 2", "block 3", "block 4", "block 5"]);
    expect([...cache.entries.values()].map((entry) => entry.blockNumber)).toEqual([3]);
  });

  it("looks back no further than the maximum depth, where a node still serves the proof", async () => {
    const slots = Array.from({ length: 40 }, (_, index) => BigInt(index + 40));
    const { prefetcher, chain, cache } = prefetcherOn(slots, { maximumDepth: 4n });
    chain.state.tip = 1n;
    await prefetcher.step();
    chain.calls.length = 0;
    chain.state.tip = 39n;
    await prefetcher.step();
    // From block 35: block 34 is read as the one before. Slot 64 (block 24) is too deep and is skipped.
    expect(chain.calls.filter((call) => call.startsWith("block "))).toEqual(["block 34", "block 35", "block 36", "block 37", "block 38", "block 39"]);
    expect(cache.entries.size).toBe(0);
  });

  it("checks the genesis block alone when the chain has only that block", async () => {
    const { prefetcher, chain, cache } = prefetcherOn([0n]);
    expect(await prefetcher.step()).toMatchObject({ checkpoints: 1, stored: 1 });
    expect(chain.calls.slice(0, 2)).toEqual(["blockNumber", "block 0"]);
    expect([...cache.entries.values()].map((entry) => entry.blockNumber)).toEqual([0]);
    // A lone block that is not at the start of an epoch is no checkpoint.
    expect(await prefetcherOn([5n]).prefetcher.step()).toMatchObject({ checkpoints: 0 });
  });

  it("does not fetch again a block the cache already holds", async () => {
    const { prefetcher, chain, cache } = prefetcherOn([63n, 64n]);
    await cache.store.write({ schemaVersion: 1, chainId: CHAIN, blockNumber: 1, blockHash: hashOf(1n), address: ADDRESS, storedSlot: 1, storageKeys: [], fetchedAt: "", proof: {} });
    expect(await prefetcher.step()).toEqual({ kind: "followed", tip: 1n, checkpoints: 1, stored: 0, failed: 0 });
    expect(chain.calls.some((call) => call.startsWith("proof"))).toBe(false);
    expect(cache.pruned).toEqual([]);
  });

  it("retries a failed fetch with a growing pause, and logs each retry and the success without the URL", async () => {
    const { prefetcher, chain, log, sleep } = prefetcherOn([63n, 64n], { attempts: 3, retryDelayMilliseconds: 1000 });
    chain.state.headFailures = 1;
    chain.state.proofFailures = 1;
    expect(await prefetcher.step()).toMatchObject({ stored: 1, failed: 0 });
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([1000, 2000]);
    const retries = log.lines.filter((line) => line.event === "proof_prefetch_retry");
    expect(retries.map((line) => line.fields.error)).toEqual(["fetch failed. URL: https://rpc.example.org", "429 Too Many Requests at https://rpc.example.org"]);
    expect(log.lines.find((line) => line.event === "proof_prefetched")?.fields.attempts).toBe(3);
    expect(JSON.stringify(log.lines, (_key, value) => (typeof value === "bigint" ? value.toString() : value))).not.toContain("SECRET");
  });

  it("gives up after the last attempt, logs a warning without the URL, and stores nothing", async () => {
    const { prefetcher, chain, cache, log } = prefetcherOn([63n, 64n], { attempts: 2 });
    chain.state.proofFailures = 5;
    expect(await prefetcher.step()).toMatchObject({ checkpoints: 1, stored: 0, failed: 1 });
    expect(cache.entries.size).toBe(0);
    expect(log.lines.find((line) => line.event === "proof_prefetch_failed")).toEqual({
      level: "warn",
      event: "proof_prefetch_failed",
      fields: { chainId: CHAIN, blockNumber: 1n, attempts: 2, error: "429 Too Many Requests at https://rpc.example.org" },
    });
  });

  it("keeps the entries of the stored light-client heads when it prunes, and the number it is told to keep", async () => {
    const protectedBlockHashes = vi.fn(async () => [hashOf(7n)]);
    const { prefetcher, cache } = prefetcherOn([63n, 64n], { keep: 10, protectedBlockHashes });
    await prefetcher.step();
    expect(cache.pruned).toEqual([{ keep: 10, protectedBlockHashes: [hashOf(7n)] }]);
  });

  it("does not prune when the protected heads cannot be read, and says so", async () => {
    const { prefetcher, cache, log } = prefetcherOn([63n, 64n], {
      protectedBlockHashes: async () => {
        throw new Error("down at http://node.internal/key");
      },
    });
    expect(await prefetcher.step()).toMatchObject({ stored: 1 });
    expect(cache.pruned).toEqual([]);
    expect(log.lines.find((line) => line.event === "proof_cache_prune_failed")).toEqual({ level: "warn", event: "proof_cache_prune_failed", fields: { chainId: CHAIN, error: "down at http://node.internal" } });
  });

  it("logs nothing about pruning when nothing was removed", async () => {
    const { prefetcher, cache, log } = prefetcherOn([63n, 64n]);
    cache.store.prune = async () => 0;
    await prefetcher.step();
    expect(log.lines.some((line) => line.event === "proof_cache_pruned")).toBe(false);
  });

  it("turns a failed read of the head into a warning without the URL, and tries again on the next step", async () => {
    const { prefetcher, chain, log } = prefetcherOn([63n, 64n]);
    const blockNumber = chain.client.blockNumber;
    chain.client.blockNumber = async () => {
      throw new Error("connection refused https://rpc.example.org/SECRET");
    };
    expect(await prefetcher.step()).toEqual({ kind: "failed" });
    expect(log.lines.at(-1)).toEqual({ level: "warn", event: "proof_prefetch_step_failed", fields: { chainId: CHAIN, error: "connection refused https://rpc.example.org" } });
    chain.client.blockNumber = blockNumber;
    expect(await prefetcher.step()).toMatchObject({ kind: "followed", stored: 1 });
  });

  it("turns a failure that is not an Error into a warning with its text", async () => {
    const { prefetcher, log } = prefetcherOn([63n, 64n], {
      isOpen: () => Promise.reject("state file unreadable"),
    });
    expect(await prefetcher.step()).toEqual({ kind: "failed" });
    expect(log.lines.at(-1)?.fields.error).toBe("state file unreadable");
  });

  it("stops once the bridge is open, logs that once, and reads nothing more", async () => {
    const { prefetcher, chain, log, setOpen } = prefetcherOn([63n, 64n]);
    setOpen(true);
    expect(await prefetcher.step()).toEqual({ kind: "stopped" });
    expect(await prefetcher.step()).toEqual({ kind: "stopped" });
    expect(chain.calls).toEqual([]);
    expect(log.lines.filter((line) => line.event === "proof_prefetch_stopped")).toEqual([{ level: "info", event: "proof_prefetch_stopped", fields: { chainId: CHAIN, reason: "deposits-open" } }]);
  });

  it("uses the real clock and a real pause by default", async () => {
    vi.useFakeTimers({ now: Date.parse("2027-01-02T03:04:05.000Z") });
    try {
      const chain = fakeChain([63n, 64n]);
      chain.state.proofFailures = 1;
      const cache = memoryStore();
      const prefetcher = createProofPrefetcher({ chainId: CHAIN, address: ADDRESS, client: chain.client, store: cache.store, clock: async () => CLOCK, isOpen: async () => false, logger: logs().logger });
      const step = prefetcher.step();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await step).toMatchObject({ stored: 1 });
      expect([...cache.entries.values()][0]?.fetchedAt).toBe("2027-01-02T03:04:07.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createViemPrefetchClient", () => {
  function viemFake() {
    const request = vi.fn(async (_args: unknown) => ({ accountProof: [] }));
    const readContract = vi.fn(async (_args: unknown) => 77n);
    const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: hashOf(blockNumber), timestamp: 5n }));
    const getBlockNumber = vi.fn(async () => 12n);
    return { request, readContract, getBlock, getBlockNumber };
  }

  it("reads the tip, a block, the stored head at a block and the raw eth_getProof answer", async () => {
    const fake = viemFake();
    const client = createViemPrefetchClient(fake as unknown as PublicClient);
    expect(await client.blockNumber()).toBe(12n);
    expect(await client.block(9n)).toEqual({ number: 9n, hash: hashOf(9n), timestamp: 5n });
    expect(await client.storedHead(ADDRESS, 9n)).toBe(77n);
    expect(fake.readContract).toHaveBeenCalledWith({ address: ADDRESS, abi: expect.anything(), functionName: "head", blockNumber: 9n });
    expect(await client.accountProof(ADDRESS, [hashOf(1n)], 255n)).toEqual({ accountProof: [] });
    expect(fake.request).toHaveBeenCalledWith({ method: "eth_getProof", params: [ADDRESS, [hashOf(1n)], "0xff"] });
  });

  it("refuses a block without a number or a hash", async () => {
    const fake = viemFake();
    fake.getBlock.mockResolvedValueOnce({ number: null, hash: null, timestamp: 5n } as never);
    const client = createViemPrefetchClient(fake as unknown as PublicClient);
    await expect(client.block(3n)).rejects.toThrow("block 3 has no number or hash");
  });
});

describe("the prefetcher with the store on disk", () => {
  const directories: string[] = [];
  afterEach(async () => {
    while (directories.length > 0) await rm(directories.pop() as string, { recursive: true, force: true });
  });

  it("writes the file that the prover reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "proof-prefetch-"));
    directories.push(directory);
    const chain = fakeChain([63n, 64n]);
    const store = createProofCacheStore(directory);
    const prefetcher = createProofPrefetcher({ chainId: CHAIN, address: ADDRESS, client: chain.client, store, clock: async () => CLOCK, isOpen: async () => false, logger: logs().logger });
    await prefetcher.step();
    expect(await store.read({ chainId: CHAIN, address: ADDRESS, blockNumber: 1n, blockHash: hashOf(1n) })).toMatchObject({ blockNumber: 1, storedSlot: 4242 });
  });
});

describe("the light-client reads of the runner", () => {
  const LIGHT_CLIENT = `0x${"d4".repeat(20)}` as const;

  it("reads the slot grid of the tracked chain from the light client once, and again only after a failed read", async () => {
    let failures = 1;
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "genesisTime" && failures > 0) {
        failures -= 1;
        throw new Error("down");
      }
      return functionName === "genesisTime" ? 1_655_733_600n : 12n;
    });
    const clock = lightClientClock({ readContract } as unknown as PublicClient, LIGHT_CLIENT);
    await expect(clock()).rejects.toThrow("down");
    expect(await clock()).toEqual({ genesisTime: 1_655_733_600n, secondsPerSlot: 12n });
    expect(await clock()).toEqual({ genesisTime: 1_655_733_600n, secondsPerSlot: 12n });
    expect(readContract.mock.calls.map(([call]) => call.functionName)).toEqual(["genesisTime", "secondsPerSlot", "genesisTime", "secondsPerSlot"]);
    expect(readContract).toHaveBeenCalledWith({ address: LIGHT_CLIENT, abi: expect.anything(), functionName: "secondsPerSlot" });
  });

  it("gives the execution block hash of the stored head, and nothing for an empty entry", async () => {
    const answers: Record<string, unknown> = { head: 640n, executionBlockHashes: hashOf(9n) };
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => answers[functionName]);
    const hashes = storedHeadBlockHashes({ readContract } as unknown as PublicClient, LIGHT_CLIENT);
    expect(await hashes()).toEqual([hashOf(9n)]);
    expect(readContract).toHaveBeenCalledWith({ address: LIGHT_CLIENT, abi: expect.anything(), functionName: "executionBlockHashes", args: [640n] });
    answers.executionBlockHashes = hashOf(0n);
    expect(await hashes()).toEqual([]);
  });
});
