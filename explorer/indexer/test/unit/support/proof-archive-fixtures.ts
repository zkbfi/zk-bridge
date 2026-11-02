import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { encodeAbiParameters, type Hex } from "viem";
import { encodeProofMessage, type ProofDirection } from "@zk-bridge/shared";
import { createProofArchive, type ProofArchive, type SqlExecutor } from "../../../src/proof-archive/store";
import type { StorageProofRecord } from "../../../src/proof-archive/records";

/** A real `eth_getProof` answer of a public Sepolia node (the light client of the bridge), with its state root. */
export const sepolia = JSON.parse(readFileSync(new URL("./sepolia-get-proof.json", import.meta.url), "utf8")) as {
  chainId: number;
  blockNumber: number;
  blockHash: Hex;
  stateRoot: Hex;
  address: Hex;
  storedSlot: number;
  storageKeys: Hex[];
  proof: Record<string, unknown>;
};

/** The fixture as an archive record. */
export const sepoliaRecord = (): StorageProofRecord => ({
  schemaVersion: 1,
  chainId: sepolia.chainId,
  blockNumber: sepolia.blockNumber,
  blockHash: sepolia.blockHash,
  address: sepolia.address,
  storedSlot: sepolia.storedSlot,
  storageKeys: sepolia.storageKeys,
  fetchedAt: "2026-11-01T00:00:00.000Z",
  proof: sepolia.proof,
  sourceHost: "rpc.example",
});

const word = (byte: string): Hex => `0x${byte.repeat(32)}`;

/** Public values of an update from `startSlot` to `newSlot`, whose roots and block hash repeat `tag`. */
export function publicValuesFor(startSlot: bigint, newSlot: bigint, tag = "aa"): Hex {
  return encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [word("01"), word("02"), startSlot, word("03"), word("04"), word(tag), newSlot, word("05"), 777n, word("06"), word("07")],
  );
}

/** A proof of 356 bytes whose bytes repeat `byte`. */
export const proofBytes = (byte = "5e"): Hex => `0x${byte.repeat(356)}`;

/** A proof message of the pair `sepolia-pls943`. */
export function proofMessage(direction: ProofDirection, startSlot: bigint, newSlot: bigint, proof: Hex = proofBytes()): Hex {
  return encodeProofMessage({
    version: 1,
    pair: "sepolia-pls943",
    direction,
    programKey: word("09"),
    startSlot,
    startRoot: word("02"),
    newSlot,
    newRoot: word("aa"),
    publicValues: publicValuesFor(startSlot, newSlot),
    proof,
  });
}

/** A fresh in-memory Postgres (PGlite) with the archive schema. */
export async function freshArchive(): Promise<{ database: PGlite; sql: SqlExecutor; archive: ProofArchive }> {
  const database = new PGlite();
  const sql = database as unknown as SqlExecutor;
  const archive = createProofArchive(sql);
  await archive.migrate();
  return { database, sql, archive };
}
