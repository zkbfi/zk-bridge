import { describe, expect, it } from "vitest";
import { evidenceRecord, lightClientRecord, lightClientRecordConsistent } from "../../src/proof-archive/records";
import { emptyTally } from "../../src/proof-archive/store";
import { freshArchive, proofBytes, publicValuesFor, sepolia, sepoliaRecord } from "./support/proof-archive-fixtures";

const collect = async (pages: AsyncGenerator<unknown[]>): Promise<unknown[]> => {
  const all: unknown[] = [];
  for await (const page of pages) all.push(...page);
  return all;
};

describe("the proof archive schema", () => {
  it("migrates idempotently, into its own schema", async () => {
    const { archive, sql } = await freshArchive();
    await archive.migrate();
    const tables = await sql.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'proof_archive' ORDER BY table_name");
    expect(tables.rows.map((row) => row.table_name)).toEqual(["conflicts", "fork_proofs", "handoff_updates", "light_client_proofs", "message_evidence", "schema_version", "storage_proofs"]);
    expect((await sql.query("SELECT version FROM proof_archive.schema_version")).rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(emptyTally()).toEqual({ inserted: 0, unchanged: 0, merged: 0, conflict: 0 });
  });
});

describe("storage proofs", () => {
  it("inserts once, reads back the entry the prover reads, and counts an identical second write as unchanged", async () => {
    const { archive } = await freshArchive();
    const record = sepoliaRecord();
    expect(await archive.putStorageProof({ ...record, address: record.address.toUpperCase().replace("0X", "0x") })).toBe("inserted");
    expect(await archive.putStorageProof({ ...record, fetchedAt: "later", sourceHost: null })).toBe("unchanged");
    const found = await archive.storageProofsAt({ chainId: sepolia.chainId, address: sepolia.address, blockNumber: BigInt(sepolia.blockNumber) });
    expect(found).toEqual([{ ...record, address: record.address.toLowerCase() }]);
    expect(await archive.storageProofsAt({ chainId: sepolia.chainId, address: sepolia.address, blockNumber: 1n })).toEqual([]);
    expect(await collect(archive.pages("storage_proofs"))).toEqual(found);
  });

  it("keeps the first answer and records a conflict for a different one, once", async () => {
    const { archive, sql } = await freshArchive();
    const record = sepoliaRecord();
    await archive.putStorageProof(record);
    const other = { ...record, proof: { ...record.proof as object, nonce: "0x9" }, sourceHost: null };
    expect(await archive.putStorageProof(other)).toBe("conflict");
    expect(await archive.putStorageProof(other)).toBe("conflict");
    const conflicts = await collect(archive.pages("conflicts"));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ table: "proof_archive.storage_proofs", column: "proof", source: "unknown" });
    expect((await sql.query<{ nonce: string }>("SELECT proof->>'nonce' AS nonce FROM proof_archive.storage_proofs")).rows).toEqual([{ nonce: "0x1" }]);
    expect(await archive.counts()).toEqual({ storageProofs: 1, lightClientProofs: 0, evidence: 0, handoffUpdates: 0, forkProofs: 0, conflicts: 1 });
  });
});

describe("light client proofs", () => {
  const record = lightClientRecord({ pair: "sepolia-pls943", direction: "first-to-second", proof: proofBytes(), publicValues: publicValuesFor(64n, 96n), source: "calldata" });

  it("derives the slots, roots and hash from the proof and its public values", () => {
    expect(record).toMatchObject({ startSlot: "64", newSlot: "96", executionBlockNumber: "777", programKey: null, source: "calldata" });
    expect(lightClientRecordConsistent(record)).toBe(true);
    expect(lightClientRecordConsistent({ ...record, newSlot: "97" })).toBe(false);
    expect(lightClientRecordConsistent({ ...record, publicValues: "0x01" })).toBe(false);
  });

  it("fills the fields a later source knows, and reports a different posting as a conflict", async () => {
    const { archive } = await freshArchive();
    expect(await archive.putLightClientProof({ ...record, postedChainId: 943, postedTransactionHash: "0xaa", postedBlockNumber: "5" })).toBe("inserted");
    expect(await archive.putLightClientProof({ ...record, source: "backend-held", payload: "0x1234", backendJobId: "job-1" })).toBe("merged");
    expect(await archive.putLightClientProof({ ...record, source: "backend-held", payload: "0x1234" })).toBe("unchanged");
    expect(await archive.putLightClientProof({ ...record, postedTransactionHash: "0xbb" })).toBe("conflict");
    const [stored] = await archive.lightClientProofs({ direction: "first-to-second", limit: 10 });
    expect(stored).toEqual({ ...record, postedChainId: 943, postedTransactionHash: "0xaa", postedBlockNumber: "5", payload: "0x1234", backendJobId: "job-1" });
    expect(await archive.lightClientProofs({ direction: "first-to-second", startSlot: 65n, limit: 10 })).toEqual([]);
    expect(await archive.lightClientProofs({ direction: "first-to-second", startSlot: 64n, limit: 10 })).toHaveLength(1);
    expect(await archive.lightClientProofs({ direction: "second-to-first", limit: 10 })).toEqual([]);
  });

  it("keeps a second distinct proof of the same slots as its own row", async () => {
    const { archive } = await freshArchive();
    await archive.putLightClientProof(record);
    const second = lightClientRecord({ pair: "sepolia-pls943", direction: "first-to-second", proof: proofBytes("6f"), publicValues: publicValuesFor(64n, 96n), source: "calldata" });
    expect(await archive.putLightClientProof(second)).toBe("inserted");
    expect(await collect(archive.pages("light_client_proofs", 1))).toHaveLength(2);
  });
});

describe("evidence", () => {
  it("keys the evidence by message and the hash of its text, and fills a stored time", async () => {
    const { archive } = await freshArchive();
    const first = evidenceRecord({ messageId: `0x${"AB".repeat(32)}`, pair: "sepolia-pls943", direction: "second-to-first", body: '{"a":1}', storedAt: null, source: "backend" });
    expect(first.bodyHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await archive.putEvidence(first)).toBe("inserted");
    expect(await archive.putEvidence({ ...first, storedAt: 5 })).toBe("merged");
    expect(await archive.putEvidence({ ...first, direction: "first-to-second" })).toBe("conflict");
    expect(await archive.evidence(first.messageId.toUpperCase())).toEqual([{ ...first, messageId: first.messageId.toLowerCase(), storedAt: 5 }]);
    expect(await collect(archive.pages("message_evidence"))).toHaveLength(1);
    expect(await collect(archive.pages("storage_proofs"))).toEqual([]);
  });
});
