import pg from "pg";
import { withoutUrls } from "@zk-bridge/shared/prover";
import type { Pair } from "@zk-bridge/shared";
import { recordOfHeadUpdate, type HeadUpdatedTransaction } from "./calldata";
import { createProofArchive, type ProofArchive, type SqlExecutor } from "./store";

/**
 * The archive of this process. It writes over its own `pg` pool to the database of `DATABASE_URL`, the one Ponder
 * uses, but into the schema `proof_archive`, which no release of Ponder owns. Off when `DATABASE_URL` is unset (Ponder
 * on PGlite, the tests) or `PROOF_ARCHIVE=off`.
 */

/** Variables that the archive reads. */
export type ArchiveEnvironment = Readonly<Record<string, string | undefined>>;

/** Whether the archive runs in this process. */
export function proofArchiveEnabled(environment: ArchiveEnvironment): boolean {
  return environment.PROOF_ARCHIVE !== "off" && (environment.DATABASE_URL ?? "") !== "";
}

/** A `pg` pool as the archive's executor. A query without parameters may hold several statements. */
export function poolExecutor(pool: Pick<pg.Pool, "query">): SqlExecutor {
  return {
    query: async (text, params) => pool.query(text, params) as never,
    exec: (text) => pool.query(text),
  };
}

/** Logs one line of JSON to standard error, as Ponder does with `--log-format json`. Never holds a URL. */
export function logArchive(level: "info" | "warn", event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  const line = JSON.stringify({ level, service: "proof-archive", event, ...fields }, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
  process.stderr.write(`${withoutUrls(line)}\n`);
}

let override: ProofArchive | null | undefined;
let opening: Promise<ProofArchive | null> | null = null;

/** Sets the archive of this process (a test), or with `undefined` goes back to the one of the environment. */
export function setProofArchive(archive: ProofArchive | null | undefined): void {
  override = archive;
  opening = null;
}

/**
 * The archive of this process, migrated, or null when it is off or the database cannot be reached now (then the next
 * call tries again).
 */
export function proofArchive(environment: ArchiveEnvironment = process.env, makePool: (url: string) => Pick<pg.Pool, "query"> = (url) => new pg.Pool({ connectionString: url, max: 4 })): Promise<ProofArchive | null> {
  if (override !== undefined) return Promise.resolve(override);
  if (!proofArchiveEnabled(environment)) return Promise.resolve(null);
  opening ??= (async () => {
    const archive = createProofArchive(poolExecutor(makePool(environment.DATABASE_URL as string)));
    await archive.migrate();
    logArchive("info", "proof_archive_ready");
    return archive;
  })().catch((error: unknown) => {
    opening = null;
    logArchive("warn", "proof_archive_unavailable", { error: (error as Error).message });
    return null;
  });
  return opening;
}

/**
 * Archives the proof of a `HeadUpdated` event from the calldata of its transaction. It never throws: the archive must
 * never stop the indexing. Ponder runs a handler again after a reorganisation or in a new schema; the upsert makes that
 * harmless.
 */
export async function archiveHeadUpdate(pair: Pair, transaction: HeadUpdatedTransaction, archive: Promise<ProofArchive | null> = proofArchive()): Promise<void> {
  try {
    const target = await archive;
    if (target === null) return;
    const record = recordOfHeadUpdate(pair, transaction);
    if (record === null) {
      logArchive("warn", "proof_archive_no_update_call", { chainId: transaction.chainId, transactionHash: transaction.transactionHash, slot: transaction.slot });
      return;
    }
    const outcome = await target.putLightClientProof(record);
    if (outcome === "conflict") logArchive("warn", "proof_archive_conflict", { table: "light_client_proofs", chainId: transaction.chainId, slot: transaction.slot });
  } catch (error) {
    logArchive("warn", "proof_archive_write_failed", { chainId: transaction.chainId, slot: transaction.slot, error: (error as Error).message });
  }
}
