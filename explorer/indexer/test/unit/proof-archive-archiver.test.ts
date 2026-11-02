import { Hono } from "hono";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { pair } from "../../src/lib/pair";
import { archiveStore, createArchiver, hostOf, startArchiverFromEnvironment } from "../../src/proof-archive/archiver";
import { setProofArchive } from "../../src/proof-archive/runtime";
import { registerProofRoutes } from "../../src/api/routes/proofs";
import { lightClientRecord } from "../../src/proof-archive/records";
import { publicStorageProof } from "../../src/proof-archive/public";
import { freshArchive, proofBytes, proofMessage, publicValuesFor, sepoliaRecord } from "./support/proof-archive-fixtures";

const EPOCH_SECONDS = 32n * 12n;
const hashOf = (number: bigint): Hex => `0x${number.toString(16).padStart(64, "0")}`;

/** A chain whose tip is block 100, at the first slot of epoch 10 (genesis 0, 12 second slots). */
function fakeClient(options: { tip?: () => Promise<bigint> } = {}) {
  return {
    getBlockNumber: vi.fn(options.tip ?? (async () => 100n)),
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: hashOf(blockNumber), timestamp: EPOCH_SECONDS * 10n - (100n - blockNumber) * 12n })),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => (functionName === "genesisTime" ? 0n : functionName === "secondsPerSlot" ? 12n : 7n)),
    request: vi.fn(async () => ({ accountProof: [], balance: "0x0" })),
  };
}

let stderr: MockInstance<typeof process.stderr.write>;
beforeEach(() => {
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  stderr.mockRestore();
  vi.useRealTimers();
});
const events = () => stderr.mock.calls.map((call: unknown[]) => (JSON.parse(String(call[0])) as { event: string }).event);

describe("the archiver", () => {
  it("fetches the answer at each epoch boundary of each side into the archive, with the host of the node", async () => {
    const { archive } = await freshArchive();
    const client = fakeClient();
    const archiver = createArchiver({ pair, archive, clientOf: () => client as never, backendUrl: null });
    const steps = await Promise.all(archiver.prefetchers.map((prefetcher) => prefetcher.step()));
    expect(steps).toEqual([
      { kind: "followed", tip: 100n, checkpoints: 1, stored: 1, failed: 0 },
      { kind: "followed", tip: 100n, checkpoints: 1, stored: 1, failed: 0 },
    ]);
    const [stored] = await archive.storageProofsAt({ chainId: pair.sides[0].chainId, address: pair.sides[0].contracts.lightClient, blockNumber: 100n });
    expect(stored).toMatchObject({ blockHash: hashOf(100n), storedSlot: 7, sourceHost: "127.0.0.1:1" });
    // Another archiver finds the block archived and asks no node for it.
    const again = createArchiver({ pair, archive, clientOf: () => fakeClient() as never, backendUrl: null });
    expect(await again.prefetchers[0]?.step()).toMatchObject({ stored: 0 });
  });

  it("serves as a proof cache store that never deletes and reports a conflicting answer", async () => {
    const { archive } = await freshArchive();
    const store = archiveStore(archive, null);
    const record = sepoliaRecord();
    const key = { chainId: record.chainId, address: record.address, blockNumber: BigInt(record.blockNumber), blockHash: record.blockHash };
    expect(await store.read(key)).toBeNull();
    const { sourceHost: _host, ...entry } = record;
    await store.write(entry);
    expect(await store.read(key)).toEqual({ ...entry, address: entry.address.toLowerCase() });
    await store.write({ ...entry, proof: { other: true } });
    expect(events()).toContain("proof_archive_conflict");
    expect(await store.prune({ chainId: 1, address: "0x01", keep: 0, protectedBlockHashes: [] })).toBe(0);
    expect(hostOf("not a url")).toBeNull();
  });

  it("takes the held proofs of the backend, and logs a backend that fails", async () => {
    const { archive } = await freshArchive();
    const answers: Array<Response | Error> = [
      new Response(JSON.stringify({ held: [{ jobId: "j", direction: "first-to-second", payload: proofMessage("first-to-second", 64n, 96n), storedAt: 1, postedAt: null, messageHash: null }] })),
      new Response(JSON.stringify({})),
      new Response("{}", { status: 500 }),
      new Error("fetch failed"),
    ];
    const fetcher = vi.fn(async (_url: unknown) => {
      const answer = answers.shift() as Response | Error;
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const archiver = createArchiver({ pair, archive, clientOf: () => fakeClient() as never, backendUrl: "http://127.0.0.1:8787", fetch: fetcher as unknown as typeof fetch });
    await archiver.pollBackend();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("http://127.0.0.1:8787/archive/proofs");
    expect(await archive.lightClientProofs({ direction: "first-to-second", limit: 5 })).toMatchObject([{ backendJobId: "j" }]);
    await archiver.pollBackend();
    await archiver.pollBackend();
    await archiver.pollBackend();
    expect(events().filter((event: string) => event.startsWith("proof_archive_backend"))).toEqual(["proof_archive_backend_ingested", "proof_archive_backend_failed", "proof_archive_backend_failed"]);
    await createArchiver({ pair, archive, clientOf: () => fakeClient() as never, backendUrl: null }).pollBackend();
  });

  it("runs its steps on timers, one at a time, until stopped", async () => {
    vi.useFakeTimers();
    const { archive } = await freshArchive();
    let release: (tip: bigint) => void = () => {};
    const client = fakeClient({ tip: () => new Promise((resolve) => (release = resolve)) });
    const fetcher = vi.fn(async (_url: unknown) => new Response("{}"));
    const stop = createArchiver({ pair, archive, clientOf: () => client as never, backendUrl: "http://127.0.0.1:8787", fetch: fetcher as unknown as typeof fetch, prefetchIntervalMilliseconds: 10, backendIntervalMilliseconds: 1000 }).start();
    await vi.advanceTimersByTimeAsync(50);
    // The first steps still wait for the tip, so no second one started.
    expect(client.getBlockNumber).toHaveBeenCalledTimes(2);
    release(100n);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("starts from the environment only with a database, and waits for the database", async () => {
    expect(await startArchiverFromEnvironment(pair, {})).toBeNull();
    vi.useFakeTimers();
    const { archive } = await freshArchive();
    const opens = [null, archive];
    const started = startArchiverFromEnvironment(pair, { DATABASE_URL: "postgresql:///x", PROOF_ARCHIVE_BACKEND_URL: "http://127.0.0.1:1" }, async () => opens.shift() ?? null);
    await vi.advanceTimersByTimeAsync(60_000);
    const stop = await started;
    expect(typeof stop).toBe("function");
    stop?.();
    const plain = await startArchiverFromEnvironment(pair, { DATABASE_URL: "postgresql:///x" }, async () => archive);
    plain?.();
    setProofArchive(archive);
    const fromProcess = await startArchiverFromEnvironment(pair, { DATABASE_URL: "postgresql:///x" });
    fromProcess?.();
    setProofArchive(undefined);
    expect(events()).toContain("proof_archiver_started");
  });
});

describe("the proof routes", () => {
  const app = (archive: Parameters<typeof registerProofRoutes>[1]) => {
    const hono = new Hono();
    registerProofRoutes(hono, archive);
    return hono;
  };

  it("serve archived storage proofs, light client proofs, evidence and counts", async () => {
    const { archive } = await freshArchive();
    const record = sepoliaRecord();
    await archive.putStorageProof(record);
    await archive.putLightClientProof(lightClientRecord({ pair: pair.name, direction: "first-to-second", proof: proofBytes(), publicValues: publicValuesFor(64n, 96n), source: "calldata" }));
    const messageId = `0x${"0e".repeat(32)}`;
    await archive.putEvidence({ messageId, bodyHash: `0x${"00".repeat(32)}`, pair: pair.name, direction: "first-to-second", body: "{}", storedAt: null, source: "backend" });
    const routes = app(async () => archive);
    const storage = await routes.request(`/api/proofs/storage/${record.chainId}/${record.address}/${record.blockNumber}`);
    expect(storage.status).toBe(200);
    expect(((await storage.json()) as { entries: unknown[] }).entries).toHaveLength(1);
    expect((await routes.request(`/api/proofs/storage/${record.chainId}/${record.address}/1`)).status).toBe(404);
    expect((await routes.request("/api/proofs/storage/x/0x01/1")).status).toBe(400);
    const light = (await (await routes.request("/api/proofs/light-client/first-to-second?startSlot=64&limit=5")).json()) as { proofs: unknown[] };
    expect(light.proofs).toHaveLength(1);
    expect((await routes.request("/api/proofs/light-client/first-to-second")).status).toBe(200);
    expect((await routes.request("/api/proofs/light-client/sideways")).status).toBe(400);
    expect((await routes.request("/api/proofs/light-client/first-to-second?limit=0")).status).toBe(400);
    expect((await routes.request("/api/proofs/light-client/first-to-second?startSlot=x")).status).toBe(400);
    expect((await routes.request(`/api/proofs/evidence/${messageId}`)).status).toBe(200);
    expect((await routes.request(`/api/proofs/evidence/0x${"0f".repeat(32)}`)).status).toBe(404);
    expect((await routes.request("/api/proofs/evidence/0x01")).status).toBe(400);
    expect(await (await routes.request("/api/proofs/summary")).json()).toEqual({ storageProofs: 1, lightClientProofs: 1, evidence: 1, conflicts: 0 });
  });

  it("serve only the public fields, the same as the IPFS tree: no source host, fetch time, job id, source or backend time", async () => {
    const { archive } = await freshArchive();
    const record = sepoliaRecord();
    await archive.putStorageProof({ ...record, sourceHost: "secret-node.example:8545" });
    await archive.putLightClientProof(lightClientRecord({ pair: pair.name, direction: "first-to-second", proof: proofBytes(), publicValues: publicValuesFor(64n, 96n), source: "backend-held", extras: { backendJobId: "job-hidden-1" } }));
    const messageId = `0x${"0e".repeat(32)}`;
    await archive.putEvidence({ messageId, bodyHash: `0x${"00".repeat(32)}`, pair: pair.name, direction: "first-to-second", body: "{}", storedAt: 1_700_000_000_000, source: "backend" });
    const routes = app(async () => archive);
    const texts = await Promise.all(
      [`/api/proofs/storage/${record.chainId}/${record.address}/${record.blockNumber}`, "/api/proofs/light-client/first-to-second", `/api/proofs/evidence/${messageId}`].map(async (path) => {
        const answer = await routes.request(path);
        expect(answer.status, path).toBe(200);
        return answer.text();
      }),
    );
    for (const text of texts) {
      for (const hidden of ["sourceHost", "secret-node", "fetchedAt", "backendJobId", "job-hidden-1", '"source"', "storedAt", "1700000000000"]) expect(text).not.toContain(hidden);
    }
    const [storage, light, evidence] = texts.map((text) => JSON.parse(text) as Record<string, Array<Record<string, unknown>>>);
    expect(storage?.entries?.[0]).toEqual(publicStorageProof(sepoliaRecord()));
    expect(Object.keys(light?.proofs?.[0] ?? {})).toContain("postedTransactionHash");
    expect(evidence?.evidence?.[0]).toEqual({ messageId, bodyHash: `0x${"00".repeat(32)}`, pair: pair.name, direction: "first-to-second", body: "{}" });
  });

  it("answer 503 when the archive is off, which is the default without a database", async () => {
    for (const routes of [app(async () => null), app(undefined)]) {
      for (const path of [`/api/proofs/storage/1/0x${"01".repeat(20)}/1`, "/api/proofs/light-client/first-to-second", `/api/proofs/evidence/0x${"0e".repeat(32)}`, "/api/proofs/summary"]) {
        expect((await routes.request(path)).status, path).toBe(503);
      }
    }
  });
});
