import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { beaconLightClientAbi, multicall3Abi } from "@zk-bridge/shared";
import { pair } from "../../src/lib/pair";
import { directionOfLightClientChain, recordOfHeadUpdate, updateCallsIn } from "../../src/proof-archive/calldata";
import { ingestBackendRows, readBackendSnapshot } from "../../src/proof-archive/backend-rows";
import { archiveHeadUpdate, logArchive, poolExecutor, proofArchive, proofArchiveEnabled, setProofArchive } from "../../src/proof-archive/runtime";
import type { ProofArchive } from "../../src/proof-archive/store";
import { freshArchive, proofBytes, proofMessage, publicValuesFor } from "./support/proof-archive-fixtures";

const updateData = (startSlot: bigint, newSlot: bigint, proof: Hex = proofBytes()) =>
  encodeFunctionData({ abi: beaconLightClientAbi, functionName: "update", args: [proof, publicValuesFor(startSlot, newSlot)] });
const headerRoot: Hex = `0x${"aa".repeat(32)}`;
const [first, second] = pair.sides;

describe("updateCallsIn", () => {
  it("finds a direct update, and the updates inside a Multicall3 batch", () => {
    expect(updateCallsIn(updateData(1n, 2n))).toEqual([{ proof: proofBytes(), publicValues: publicValuesFor(1n, 2n) }]);
    const batch = encodeFunctionData({
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [[{ target: `0x${"11".repeat(20)}`, allowFailure: true, callData: updateData(3n, 4n) }, { target: `0x${"22".repeat(20)}`, allowFailure: true, callData: "0x1234" }]],
    });
    expect(updateCallsIn(batch).map((call) => call.publicValues)).toEqual([publicValuesFor(3n, 4n)]);
    const tryBatch = encodeFunctionData({ abi: multicall3Abi, functionName: "tryAggregate", args: [false, [{ target: `0x${"11".repeat(20)}`, callData: updateData(5n, 6n) }]] });
    expect(updateCallsIn(tryBatch).map((call) => call.publicValues)).toEqual([publicValuesFor(5n, 6n)]);
  });

  it("finds nothing in another call of the light client or in unknown calldata", () => {
    expect(updateCallsIn(encodeFunctionData({ abi: beaconLightClientAbi, functionName: "head" }))).toEqual([]);
    expect(updateCallsIn("0xdeadbeef")).toEqual([]);
  });
});

describe("recordOfHeadUpdate", () => {
  const transaction = { chainId: second.chainId, input: updateData(64n, 96n), transactionHash: `0x${"CD".repeat(32)}` as Hex, blockNumber: 50n, slot: 96n, headerRoot };

  it("takes the update that stored the head of the event, with its posting transaction", () => {
    expect(directionOfLightClientChain(pair, second.chainId)).toBe("first-to-second");
    expect(directionOfLightClientChain(pair, first.chainId)).toBe("second-to-first");
    expect(recordOfHeadUpdate(pair, transaction)).toMatchObject({
      pair: pair.name,
      direction: "first-to-second",
      startSlot: "64",
      newSlot: "96",
      postedChainId: second.chainId,
      postedTransactionHash: `0x${"cd".repeat(32)}`,
      postedBlockNumber: "50",
      source: "calldata",
    });
  });

  it("skips an update for another head and one whose public values do not decode", () => {
    expect(recordOfHeadUpdate(pair, { ...transaction, slot: 97n })).toBeNull();
    expect(recordOfHeadUpdate(pair, { ...transaction, headerRoot: `0x${"bb".repeat(32)}` })).toBeNull();
    const broken = encodeFunctionData({ abi: beaconLightClientAbi, functionName: "update", args: [proofBytes(), "0x1234"] });
    expect(recordOfHeadUpdate(pair, { ...transaction, input: broken })).toBeNull();
  });
});

describe("the runtime of the archive", () => {
  let stderr: MockInstance<typeof process.stderr.write>;
  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    stderr.mockRestore();
    setProofArchive(undefined);
  });
  const lines = () => stderr.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>);

  it("is on with a database and not turned off", () => {
    expect(proofArchiveEnabled({ DATABASE_URL: "postgresql:///x" })).toBe(true);
    expect(proofArchiveEnabled({ DATABASE_URL: "postgresql:///x", PROOF_ARCHIVE: "off" })).toBe(false);
    expect(proofArchiveEnabled({})).toBe(false);
  });

  it("logs JSON lines without URLs, with big numbers as text", () => {
    logArchive("warn", "event", { slot: 5n, error: "failed at https://user:key@rpc.example/path" });
    expect(lines()).toEqual([{ level: "warn", service: "proof-archive", event: "event", slot: "5", error: "failed at https://rpc.example" }]);
  });

  it("opens the archive once over a pool, migrates it, and tries again after a failure", async () => {
    const { database } = await freshArchive();
    expect(await proofArchive({})).toBeNull();
    // The default pool: nothing listens on port 1, so it fails and the next call tries again.
    expect(await proofArchive({ DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none?connect_timeout=1" })).toBeNull();
    let calls = 0;
    const failing = { query: async () => {
      calls += 1;
      throw new Error("connection refused to postgresql://host/db");
    } };
    expect(await proofArchive({ DATABASE_URL: "postgresql:///x" }, () => failing)).toBeNull();
    expect(lines().at(-1)).toMatchObject({ event: "proof_archive_unavailable", error: "connection refused to postgresql://host" });
    const pool = { query: (...args: [string, unknown[]?]) => (args.length === 1 ? database.exec(args[0]) : database.query(args[0], args[1])) };
    const opened = await proofArchive({ DATABASE_URL: "postgresql:///x" }, () => pool as never);
    expect(opened).not.toBeNull();
    expect(await proofArchive({ DATABASE_URL: "postgresql:///x" }, () => failing)).toBe(opened);
    expect(calls).toBe(1);
    const executor = poolExecutor(pool as never);
    expect((await executor.query("SELECT 1 AS one", [])).rows).toEqual([{ one: 1 }]);
  });

  it("archives the proof of a head update, and never throws", async () => {
    const { archive } = await freshArchive();
    setProofArchive(archive);
    expect(await proofArchive()).toBe(archive);
    const transaction = { chainId: second.chainId, input: updateData(64n, 96n), transactionHash: `0x${"cd".repeat(32)}` as Hex, blockNumber: 50n, slot: 96n, headerRoot };
    await archiveHeadUpdate(pair, transaction);
    expect(await archive.lightClientProofs({ direction: "first-to-second", limit: 5 })).toHaveLength(1);
    await archiveHeadUpdate(pair, { ...transaction, transactionHash: `0x${"ef".repeat(32)}` });
    expect(lines().at(-1)).toMatchObject({ event: "proof_archive_conflict" });
    await archiveHeadUpdate(pair, { ...transaction, slot: 1n });
    expect(lines().at(-1)).toMatchObject({ event: "proof_archive_no_update_call" });
    const broken = { putLightClientProof: async () => Promise.reject(new Error("disk full")) } as unknown as ProofArchive;
    await archiveHeadUpdate(pair, transaction, Promise.resolve(broken));
    expect(lines().at(-1)).toMatchObject({ event: "proof_archive_write_failed", error: "disk full" });
    await archiveHeadUpdate(pair, transaction, Promise.resolve(null));
  });
});

describe("the proofs of the backend", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "backend-snapshot-"));
  });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  const evidenceBody = '{"message":{"messageId":"0x01"}}';
  const messageId = `0x${"0e".repeat(32)}`;

  function writeSnapshot(path: string, options: { tables?: boolean; badBoard?: boolean } = {}): void {
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE evidence (message_id TEXT PRIMARY KEY, direction TEXT NOT NULL, body TEXT NOT NULL, stored_at INTEGER NOT NULL)");
    if (options.tables !== false) {
      database.exec("CREATE TABLE proofs (direction TEXT PRIMARY KEY, job_id TEXT, start_slot TEXT NOT NULL, new_slot TEXT NOT NULL, body TEXT NOT NULL, stored_at INTEGER NOT NULL)");
      database.exec("CREATE TABLE webhook_proofs (job_id TEXT PRIMARY KEY, direction TEXT NOT NULL, payload TEXT NOT NULL, start_slot TEXT NOT NULL, new_slot TEXT NOT NULL, stored_at INTEGER NOT NULL, posted_at INTEGER, message_hash TEXT)");
      database.prepare("INSERT INTO proofs VALUES ('first-to-second', NULL, '64', '96', ?, 10)").run(JSON.stringify({ pair: "sepolia-pls943", payload: proofMessage("first-to-second", 64n, 96n) }));
      if (options.badBoard === true) database.prepare("INSERT INTO proofs VALUES ('second-to-first', NULL, '1', '2', 'not json', 11)").run();
      database.prepare("INSERT INTO webhook_proofs VALUES ('job-1', 'second-to-first', ?, '32', '64', 12, NULL, NULL)").run(proofMessage("second-to-first", 32n, 64n));
      database.prepare("INSERT INTO webhook_proofs VALUES ('job-2', 'first-to-second', '0x1234', '1', '2', 13, 14, '0xAB')").run();
    }
    database.prepare("INSERT INTO evidence VALUES (?, 'first-to-second', ?, 15)").run(messageId, evidenceBody);
    database.close();
  }

  it("reads a snapshot read only and ingests the board, held proofs and evidence, counting a bad payload", async () => {
    const path = join(directory, "backend.sqlite");
    writeSnapshot(path, { badBoard: true });
    const { rows, skipped } = readBackendSnapshot(path);
    expect(skipped).toBe(1);
    expect(rows.held.map((row) => row.jobId)).toEqual(["job-1", "job-2"]);
    const { archive } = await freshArchive();
    expect(await ingestBackendRows(archive, "sepolia-pls943", rows)).toEqual({ inserted: 3, unchanged: 0, merged: 0, conflict: 0, invalid: 1 });
    const [held] = await archive.lightClientProofs({ direction: "second-to-first", limit: 5 });
    expect(held).toMatchObject({ source: "backend-held", backendJobId: "job-1", programKey: `0x${"09".repeat(32)}`, startSlot: "32" });
    expect(await archive.evidence(messageId)).toMatchObject([{ body: evidenceBody, pair: "sepolia-pls943", storedAt: 15 }]);
    expect(await ingestBackendRows(archive, "sepolia-pls943", rows)).toEqual({ inserted: 0, unchanged: 3, merged: 0, conflict: 0, invalid: 1 });
  });

  it("reads a snapshot without the proof tables as evidence only, and refuses rows of an unknown shape", () => {
    const path = join(directory, "old.sqlite");
    writeSnapshot(path, { tables: false });
    expect(readBackendSnapshot(path).rows).toMatchObject({ board: [], held: [], evidence: [{ messageId }] });
    const odd = join(directory, "odd.sqlite");
    const database = new DatabaseSync(odd);
    database.exec("CREATE TABLE evidence (message_id TEXT, direction TEXT, body TEXT, stored_at INTEGER)");
    database.exec("INSERT INTO evidence VALUES ('0x01', 'sideways', '{}', 1)");
    database.close();
    expect(() => readBackendSnapshot(odd)).toThrow("the backend file holds rows of an unknown shape: evidence.0.direction");
  });
});
