import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archivedEntryRefusal,
  createArchivedProofCacheStore,
  createProofArchiveClient,
  ProofArchiveError,
  storedHeadCacheKey,
  type ProofArchiveReader,
} from "../src/prover/proof-archive-client.js";
import { createProofCacheStore, type ProofCacheEntry, type ProofCacheStore } from "../src/prover/proof-cache.js";
import { openingStorageKey } from "../src/prover/proof-prefetch.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/sepolia-get-proof.json", import.meta.url), "utf8")) as {
  chainId: number;
  blockNumber: number;
  blockHash: Hex;
  stateRoot: Hex;
  address: Hex;
  storedSlot: number;
  storageKeys: Hex[];
  proof: Record<string, unknown>;
};

const entry: ProofCacheEntry = {
  schemaVersion: 1,
  chainId: fixture.chainId,
  blockNumber: fixture.blockNumber,
  blockHash: fixture.blockHash,
  address: fixture.address,
  storedSlot: fixture.storedSlot,
  storageKeys: fixture.storageKeys,
  fetchedAt: "2026-11-01T00:00:00.000Z",
  proof: fixture.proof,
};
const key = { chainId: entry.chainId, address: entry.address, blockNumber: BigInt(entry.blockNumber), blockHash: entry.blockHash };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createProofArchiveClient", () => {
  it("reads an entry without its fetch time, as the archive publishes it, and names the archive there", async () => {
    const { fetchedAt: _time, ...published } = entry;
    const client = createProofArchiveClient({ baseUrl: "http://indexer.test", fetch: (async () => json(200, { entries: [published] })) as unknown as typeof fetch });
    expect(await client.storageProofs({ chainId: 1, address: "0x01", blockNumber: 1n })).toEqual([{ ...entry, fetchedAt: "from the proof archive" }]);
  });

  it("asks the storage route of the indexer, and keeps only the entries that parse", async () => {
    const fetcher = vi.fn(async () => json(200, { entries: [entry, { schemaVersion: 9 }] }));
    const client = createProofArchiveClient({ baseUrl: "http://indexer.test:42069", fetch: fetcher as unknown as typeof fetch });
    const found = await client.storageProofs({ chainId: 11155111, address: "0xABCDEF", blockNumber: 12n });
    expect(found).toEqual([entry]);
    expect(String((fetcher.mock.calls[0] as unknown[])[0])).toBe("http://indexer.test:42069/api/proofs/storage/11155111/0xabcdef/12");
  });

  it("reads a 404 or a body without entries as none, and throws on another error without naming the URL", async () => {
    const answers = [json(404, {}), json(200, { other: 1 }), json(503, {})];
    const client = createProofArchiveClient({ baseUrl: "http://secret-host.test/key", fetch: (async () => answers.shift()) as unknown as typeof fetch, timeoutMilliseconds: 50 });
    expect(await client.storageProofs({ chainId: 1, address: "0x01", blockNumber: 1n })).toEqual([]);
    expect(await client.storageProofs({ chainId: 1, address: "0x01", blockNumber: 1n })).toEqual([]);
    const failure = client.storageProofs({ chainId: 1, address: "0x01", blockNumber: 1n });
    await expect(failure).rejects.toThrow(ProofArchiveError);
    await expect(failure).rejects.toThrow("the proof archive answered 503");
  });

  it("uses the global fetch by default", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(404, {}));
    try {
      expect(await createProofArchiveClient({ baseUrl: "http://indexer.test" }).storageProofs({ chainId: 1, address: "0x01", blockNumber: 1n })).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("archivedEntryRefusal", () => {
  const header = vi.fn(async (_hash: Hex) => ({ number: BigInt(fixture.blockNumber), stateRoot: fixture.stateRoot }));
  const expected = { ...key, storedSlot: BigInt(fixture.storedSlot) };

  it("accepts an entry that proves exactly the requested account, block and stored slot, also when the slot is unknown", async () => {
    expect(await archivedEntryRefusal(entry, expected, header)).toBeNull();
    expect(await archivedEntryRefusal(entry, { ...expected, storedSlot: null }, header)).toBeNull();
    expect(header).toHaveBeenCalledWith(fixture.blockHash);
  });

  it("refuses an entry for another chain, account, block or stored slot, whatever it says about itself", async () => {
    expect(await archivedEntryRefusal({ ...entry, chainId: 1 }, expected, header)).toBe("another chain");
    expect(await archivedEntryRefusal({ ...entry, address: `0x${"ab".repeat(20)}` }, expected, header)).toBe("another account");
    expect(await archivedEntryRefusal({ ...entry, blockNumber: fixture.blockNumber + 1 }, expected, header)).toBe("another block");
    expect(await archivedEntryRefusal({ ...entry, blockHash: `0x${"ee".repeat(32)}` }, expected, header)).toBe("another block");
    expect(await archivedEntryRefusal(entry, { ...expected, storedSlot: 5n }, header)).toBe("another stored slot");
  });

  it("refuses an entry that proves another key than the one of the stored slot", async () => {
    // Proves only the second key of the fixture (an unrelated slot), while claiming the right stored slot.
    expect(await archivedEntryRefusal({ ...entry, storageKeys: [fixture.storageKeys[1] as Hex] }, expected, header)).toBe("no proof of the stored slot's key");
    // Claims another stored slot (the request does not know the head): its key is not among the proven keys.
    expect(await archivedEntryRefusal({ ...entry, storedSlot: fixture.storedSlot + 1 }, { ...expected, storedSlot: null }, header)).toBe("no proof of the stored slot's key");
    // Names the right key but its answer holds no proof of it.
    const [present] = (fixture.proof as { storageProof: unknown[] }).storageProof;
    const absent = { ...entry, proof: { ...fixture.proof, storageProof: (fixture.proof as { storageProof: unknown[] }).storageProof.filter((item) => item !== present) } };
    expect(await archivedEntryRefusal(absent, expected, header)).toBe(`the answer has no proof for key ${fixture.storageKeys[0]}`);
  });

  it("refuses an entry whose block header has another number, or whose proof fails against the requested block", async () => {
    expect(await archivedEntryRefusal(entry, expected, async () => ({ number: 1n, stateRoot: fixture.stateRoot }))).toBe("the header of the block hash has another number");
    expect(await archivedEntryRefusal(entry, expected, async () => ({ number: BigInt(fixture.blockNumber), stateRoot: `0x${"00".repeat(32)}` }))).toBe("node 0 does not match its hash");
  });

  it("refuses a proof that the stored slot holds no block hash", async () => {
    // An account that does not exist, proven against the empty state root: every slot of it is zero.
    const emptyRoot: Hex = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421";
    const slotKey = openingStorageKey(7n);
    const empty: ProofCacheEntry = {
      ...entry,
      storedSlot: 7,
      storageKeys: [slotKey],
      proof: { balance: "0x0", nonce: "0x0", codeHash: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", storageHash: emptyRoot, accountProof: [], storageProof: [{ key: "0x", value: "0x0", proof: [] }, { key: slotKey, value: "0x", proof: [] }] },
    };
    expect(await archivedEntryRefusal(empty, { ...expected, storedSlot: 7n }, async () => ({ number: BigInt(fixture.blockNumber), stateRoot: emptyRoot }))).toBe("the stored slot holds no block hash");
  });
});

describe("createArchivedProofCacheStore", () => {
  let directory: string;
  let local: ProofCacheStore;
  const logger = { info: vi.fn(), warn: vi.fn() };
  const readHeader = vi.fn(async (_hash: Hex) => ({ number: BigInt(fixture.blockNumber), stateRoot: fixture.stateRoot }));
  const storedSlot = vi.fn(async () => BigInt(fixture.storedSlot) as bigint | null);
  const archiveOf = (entries: ProofCacheEntry[] | Error): ProofArchiveReader => ({
    storageProofs: vi.fn(async () => {
      if (entries instanceof Error) throw entries;
      return entries;
    }),
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "proof-archive-store-"));
    local = createProofCacheStore(directory);
    logger.info.mockClear();
    logger.warn.mockClear();
  });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  it("takes a verified archived entry first and copies it into the local cache for the prover", async () => {
    const store = createArchivedProofCacheStore({ archive: archiveOf([entry]), local, readHeader, storedSlot, logger });
    expect(await store.has(key)).toBe(true);
    expect(await local.read(key)).toEqual({ ...entry, address: entry.address.toLowerCase() });
    expect(logger.info).toHaveBeenCalledWith("proof_archive_hit", { chainId: entry.chainId, blockNumber: key.blockNumber });
    // A second hit finds the local file and writes nothing new.
    const write = vi.spyOn(local, "write");
    expect(await store.read(key)).toEqual(entry);
    expect(write).not.toHaveBeenCalled();
  });

  it("skips archived entries of another block, account or stored slot and those that do not verify, then falls back to the local cache", async () => {
    const forged = { ...entry, proof: { ...fixture.proof, nonce: "0x9" } };
    const archive = archiveOf([{ ...entry, blockHash: `0x${"ee".repeat(32)}` }, { ...entry, address: `0x${"ab".repeat(20)}` }, { ...entry, storedSlot: 1 }, forged]);
    const store = createArchivedProofCacheStore({ archive, local, readHeader, storedSlot, logger });
    expect(await store.has(key)).toBe(false);
    expect(logger.warn.mock.calls.map((call) => (call[1] as { reason: string }).reason)).toEqual(["another block", "another account", "another stored slot", "the nonce differs from the proof"]);
    expect(storedSlot).toHaveBeenCalledWith(key);
    expect(await store.read(key)).toBeNull();
    await local.write(entry);
    expect(await store.has(key)).toBe(true);
    expect(await store.read(key)).toEqual({ ...entry, address: entry.address.toLowerCase() });
  });

  it("counts an archive that cannot be reached as a miss, and logs it without the URL", async () => {
    const store = createArchivedProofCacheStore({ archive: archiveOf(new Error("fetch failed for https://user:pw@rpc.example/key123")), local, readHeader, storedSlot, logger });
    expect(await store.has(key)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith("proof_archive_unavailable", { chainId: entry.chainId, blockNumber: key.blockNumber, error: "fetch failed for https://rpc.example" });
  });

  it("writes and prunes only the local cache", async () => {
    const store = createArchivedProofCacheStore({ archive: archiveOf([]), local, readHeader, storedSlot, logger });
    // An empty archive answer reads no stored slot.
    storedSlot.mockClear();
    expect(await store.has(key)).toBe(false);
    expect(storedSlot).not.toHaveBeenCalled();
    await store.write(entry);
    expect(await local.has(key)).toBe(true);
    expect(await store.prune({ chainId: entry.chainId, address: entry.address, keep: 0, protectedBlockHashes: [] })).toBe(1);
    expect(await local.has(key)).toBe(false);
  });
});

describe("storedHeadCacheKey", () => {
  it("is the remote light client in the execution block of the stored head, or null while that block is unknown", async () => {
    const hashes: Hex[] = [entry.blockHash as Hex, `0x${"00".repeat(32)}`];
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "head") return 100n;
      if (functionName === "executionBlockHashes") return hashes.shift();
      return 12n;
    });
    const keyOf = storedHeadCacheKey({ readContract } as never, `0x${"0a".repeat(20)}`, { chainId: 7, lightClient: `0x${"0b".repeat(20)}` });
    expect(await keyOf()).toEqual({ chainId: 7, address: `0x${"0b".repeat(20)}`, blockNumber: 12n, blockHash: entry.blockHash });
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "executionBlockHashes", args: [100n] }));
    expect(await keyOf()).toBeNull();
  });
});
