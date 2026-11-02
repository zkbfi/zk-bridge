import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProofCacheStore, proofCachePath, type ProofCacheEntry } from "../src/prover/proof-cache.js";

const ADDRESS = `0x${"C3".repeat(20)}` as const;
const hashOf = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}` as const;

function entry(blockNumber: number, blockHash = hashOf(blockNumber % 256)): ProofCacheEntry {
  return {
    schemaVersion: 1,
    chainId: 11155111,
    blockNumber,
    blockHash,
    address: ADDRESS,
    storedSlot: 456,
    storageKeys: [hashOf(1)],
    fetchedAt: "2026-11-01T00:00:00.000Z",
    proof: { accountProof: ["0x01"], storageProof: [] },
  };
}

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) await rm(directories.pop() as string, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "proof-cache-"));
  directories.push(directory);
  return directory;
}

const keyOf = (value: ProofCacheEntry) => ({ chainId: value.chainId, address: value.address, blockNumber: BigInt(value.blockNumber), blockHash: value.blockHash });

describe("proofCachePath", () => {
  it("names the chain, the address and the block in lower case hex, as the prover reads it", () => {
    expect(proofCachePath("/cache", { chainId: 943, address: ADDRESS, blockNumber: 123n, blockHash: hashOf(0xab).toUpperCase().replace("0X", "0x") as `0x${string}` })).toBe(
      `/cache/943/0x${"c3".repeat(20)}/123-0x${"ab".repeat(32)}.json`,
    );
  });
});

describe("createProofCacheStore", () => {
  it("writes an entry as JSON with a lower case address, reads it back, and knows that it has it", async () => {
    const directory = await scratch();
    const store = createProofCacheStore(directory);
    const value = entry(10);
    expect(await store.has(keyOf(value))).toBe(false);
    expect(await store.read(keyOf(value))).toBeNull();
    await store.write(value);
    expect(await store.has(keyOf(value))).toBe(true);
    const written = JSON.parse(readFileSync(proofCachePath(directory, keyOf(value)), "utf8"));
    expect(written).toEqual({ ...value, address: ADDRESS.toLowerCase() });
    expect(await store.read(keyOf(value))).toEqual({ ...value, address: ADDRESS.toLowerCase() });
    // No temporary file is left next to the entry.
    expect(await readdir(join(directory, "11155111", ADDRESS.toLowerCase()))).toEqual([`10-${hashOf(10)}.json`]);
  });

  it("reads a file that is not an entry as missing", async () => {
    const directory = await scratch();
    const store = createProofCacheStore(directory);
    const value = entry(11);
    const path = proofCachePath(directory, keyOf(value));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{ not json");
    expect(await store.read(keyOf(value))).toBeNull();
    await writeFile(path, JSON.stringify({ ...value, schemaVersion: 2 }));
    expect(await store.read(keyOf(value))).toBeNull();
  });

  it("keeps the newest entries and every protected block hash, removes the rest, and leaves other files alone", async () => {
    const directory = await scratch();
    const store = createProofCacheStore(directory);
    for (const blockNumber of [1, 2, 3, 4, 5]) await store.write(entry(blockNumber));
    // Two blocks at one height, as after a reorganisation: both count among the newest.
    await store.write(entry(5, hashOf(0x55)));
    const folder = join(directory, "11155111", ADDRESS.toLowerCase());
    await writeFile(join(folder, "notes.txt"), "kept");
    const removed = await store.prune({ chainId: 11155111, address: ADDRESS, keep: 3, protectedBlockHashes: [hashOf(1).toUpperCase().replace("0X", "0x") as `0x${string}`] });
    expect(removed).toBe(2);
    expect((await readdir(folder)).sort()).toEqual([`1-${hashOf(1)}.json`, `4-${hashOf(4)}.json`, `5-${hashOf(5)}.json`, `5-${hashOf(0x55)}.json`, "notes.txt"]);
  });

  it("prunes nothing for a chain it has no folder for", async () => {
    const store = createProofCacheStore(await scratch());
    expect(await store.prune({ chainId: 1, address: ADDRESS, keep: 1, protectedBlockHashes: [] })).toBe(0);
  });

  it("passes on an error other than a missing folder or file", async () => {
    const directory = await scratch();
    const store = createProofCacheStore(directory);
    // A file where the chain folder belongs: listing it fails with ENOTDIR, and so does a read below it.
    await writeFile(join(directory, "11155111"), "in the way");
    await expect(store.prune({ chainId: 11155111, address: ADDRESS, keep: 1, protectedBlockHashes: [] })).rejects.toThrow(/ENOTDIR/);
    await expect(store.has(keyOf(entry(1)))).rejects.toThrow(/ENOTDIR/);
    await expect(store.read(keyOf(entry(1)))).rejects.toThrow(/ENOTDIR/);
  });
});
