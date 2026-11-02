import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archivedEntryVerifies,
  createArchivedProofCacheStore,
  createProofArchiveClient,
  ProofArchiveError,
  storedHeadCacheKey,
  type ProofArchiveReader,
} from "../src/prover/proof-archive-client.js";
import { createProofCacheStore, type ProofCacheEntry, type ProofCacheStore } from "../src/prover/proof-cache.js";

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

describe("archivedEntryVerifies", () => {
  it("checks the entry against the state root of its block", async () => {
    expect(await archivedEntryVerifies(entry, async () => fixture.stateRoot)).toBe(true);
    expect(await archivedEntryVerifies(entry, async () => `0x${"00".repeat(32)}`)).toBe(false);
  });
});

describe("createArchivedProofCacheStore", () => {
  let directory: string;
  let local: ProofCacheStore;
  const logger = { info: vi.fn(), warn: vi.fn() };
  const stateRoot = vi.fn(async () => fixture.stateRoot);
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
    const store = createArchivedProofCacheStore({ archive: archiveOf([entry]), local, stateRoot, logger });
    expect(await store.has(key)).toBe(true);
    expect(await local.read(key)).toEqual({ ...entry, address: entry.address.toLowerCase() });
    expect(logger.info).toHaveBeenCalledWith("proof_archive_hit", { chainId: entry.chainId, blockNumber: key.blockNumber });
    // A second hit finds the local file and writes nothing new.
    const write = vi.spyOn(local, "write");
    expect(await store.read(key)).toEqual(entry);
    expect(write).not.toHaveBeenCalled();
  });

  it("skips archived entries of another block or account and those that do not verify, then falls back to the local cache", async () => {
    const forged = { ...entry, proof: { ...fixture.proof, nonce: "0x9" } };
    const archive = archiveOf([{ ...entry, blockHash: `0x${"ee".repeat(32)}` }, { ...entry, address: `0x${"ab".repeat(20)}` }, forged]);
    const store = createArchivedProofCacheStore({ archive, local, stateRoot, logger });
    expect(await store.has(key)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith("proof_archive_entry_refused", { chainId: entry.chainId, blockNumber: key.blockNumber });
    expect(await store.read(key)).toBeNull();
    await local.write(entry);
    expect(await store.has(key)).toBe(true);
    expect(await store.read(key)).toEqual({ ...entry, address: entry.address.toLowerCase() });
  });

  it("counts an archive that cannot be reached as a miss, and logs it without the URL", async () => {
    const store = createArchivedProofCacheStore({ archive: archiveOf(new Error("fetch failed for https://user:pw@rpc.example/key123")), local, stateRoot, logger });
    expect(await store.has(key)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith("proof_archive_unavailable", { chainId: entry.chainId, blockNumber: key.blockNumber, error: "fetch failed for https://rpc.example" });
  });

  it("writes and prunes only the local cache", async () => {
    const store = createArchivedProofCacheStore({ archive: archiveOf([]), local, stateRoot, logger });
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
