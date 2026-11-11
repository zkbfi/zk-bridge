import { MIGRATION } from "./schema";
import type { EvidenceRecord, ForkProofArchiveRecord, HandoffRecord, LightClientProofRecord, StorageProofRecord } from "./records";

/** The SQL that the archive needs: a `pg` pool and PGlite both fit. */
export interface SqlExecutor {
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  /** Runs a script of several statements without parameters. */
  exec(text: string): Promise<unknown>;
}

/** What one upsert did. */
export type UpsertOutcome = "inserted" | "unchanged" | "merged" | "conflict";

/** Counts of upsert outcomes. */
export type UpsertTally = Record<UpsertOutcome, number>;

export const emptyTally = (): UpsertTally => ({ inserted: 0, unchanged: 0, merged: 0, conflict: 0 });

type Column = { readonly name: string; readonly field: string; readonly type: string };

/**
 * How a table is written. `key`: the natural key. `compare`: must equal the archived value, or it is a conflict. `fill`:
 * an archived null takes the new value; two different values are a conflict. `meta`: written on insert only (where and
 * when it came from), never compared.
 */
type TableSpec = {
  readonly table: string;
  readonly key: readonly Column[];
  readonly compare: readonly Column[];
  readonly fill: readonly Column[];
  readonly meta: readonly Column[];
};

const column = (name: string, field: string, type: string): Column => ({ name, field, type });

const STORAGE: TableSpec = {
  table: "proof_archive.storage_proofs",
  key: [column("chain_id", "chainId", "integer"), column("address", "address", "text"), column("block_number", "blockNumber", "bigint"), column("block_hash", "blockHash", "text"), column("storage_keys", "storageKeys", "text[]")],
  compare: [column("stored_slot", "storedSlot", "bigint"), column("proof", "proof", "jsonb")],
  fill: [],
  meta: [column("fetched_at", "fetchedAt", "text"), column("source_host", "sourceHost", "text")],
};

const LIGHT_CLIENT: TableSpec = {
  table: "proof_archive.light_client_proofs",
  key: [column("pair", "pair", "text"), column("direction", "direction", "text"), column("start_slot", "startSlot", "bigint"), column("new_slot", "newSlot", "bigint"), column("proof_hash", "proofHash", "text")],
  compare: [
    column("proof", "proof", "text"),
    column("public_values", "publicValues", "text"),
    column("start_root", "startRoot", "text"),
    column("new_root", "newRoot", "text"),
    column("execution_block_hash", "executionBlockHash", "text"),
    column("execution_block_number", "executionBlockNumber", "bigint"),
  ],
  fill: [
    column("program_key", "programKey", "text"),
    column("payload", "payload", "text"),
    column("posted_chain_id", "postedChainId", "integer"),
    column("posted_transaction_hash", "postedTransactionHash", "text"),
    column("posted_block_number", "postedBlockNumber", "bigint"),
    column("board_message_hash", "boardMessageHash", "text"),
    column("backend_job_id", "backendJobId", "text"),
  ],
  meta: [column("source", "source", "text")],
};

const EVIDENCE: TableSpec = {
  table: "proof_archive.message_evidence",
  key: [column("message_id", "messageId", "text"), column("body_hash", "bodyHash", "text")],
  compare: [column("pair", "pair", "text"), column("direction", "direction", "text"), column("body", "body", "text")],
  fill: [column("stored_at", "storedAt", "bigint")],
  meta: [column("source", "source", "text")],
};

const HANDOFF: TableSpec = {
  table: "proof_archive.handoff_updates",
  key: [column("chain_id", "chainId", "integer"), column("period", "period", "integer")],
  compare: [column("sha256", "sha256", "text"), column("attested_slot", "attestedSlot", "bigint"), column("finalized_slot", "finalizedSlot", "bigint"), column("record", "record", "text")],
  fill: [],
  meta: [column("stored_at", "storedAt", "bigint"), column("source", "source", "text")],
};

const FORK_PROOF: TableSpec = {
  table: "proof_archive.fork_proofs",
  key: [column("chain_id", "chainId", "integer"), column("state_root", "stateRoot", "text")],
  compare: [
    column("sha256", "sha256", "text"),
    column("slot", "slot", "bigint"),
    column("block_root", "blockRoot", "text"),
    column("execution_block_number", "executionBlockNumber", "bigint"),
    column("execution_block_hash", "executionBlockHash", "text"),
    column("shape", "shape", "integer"),
    column("record", "record", "text"),
  ],
  fill: [],
  meta: [column("stored_at", "storedAt", "bigint"), column("source", "source", "text")],
};

/** What the public list of fork proofs shows of one record: where it is and what names it. */
export type ForkProofEntry = { readonly slot: number; readonly stateRoot: string; readonly blockRoot: string; readonly executionBlockNumber: number };

/** A value as a parameter: JSON for jsonb, a decimal string for bigint, lower case for hex keys. */
function parameterOf(spec: Column, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (spec.type === "jsonb") return JSON.stringify(value);
  if (spec.type === "bigint") return String(value);
  return value;
}

/** The SQL of one column, read back as a record field. */
function selectOf(spec: Column): string {
  if (spec.type === "bigint") return `${spec.name}::text AS "${spec.field}"`;
  if (spec.type === "text[]") return `to_jsonb(${spec.name}) AS "${spec.field}"`;
  return `${spec.name} AS "${spec.field}"`;
}

/** A conflict as the archive reports it. */
export type ConflictRecord = {
  readonly table: string;
  readonly key: Record<string, unknown>;
  readonly column: string;
  readonly existing: string | null;
  readonly incoming: string | null;
  readonly source: string;
};

/** The archive over a database. */
export interface ProofArchive {
  /** Creates or upgrades the schema. Safe to run again, and from two processes at once. */
  migrate(): Promise<void>;
  putStorageProof(record: StorageProofRecord): Promise<UpsertOutcome>;
  putLightClientProof(record: LightClientProofRecord): Promise<UpsertOutcome>;
  putEvidence(record: EvidenceRecord): Promise<UpsertOutcome>;
  /** The storage proofs of one chain, address and block (all hashes and key sets). */
  storageProofsAt(input: { readonly chainId: number; readonly address: string; readonly blockNumber: bigint }): Promise<StorageProofRecord[]>;
  /** The newest proofs of a direction, newest start first; from one start slot when given. */
  lightClientProofs(input: { readonly direction: string; readonly startSlot?: bigint; readonly limit: number }): Promise<LightClientProofRecord[]>;
  evidence(messageId: string): Promise<EvidenceRecord[]>;
  /** The handoff update of a sync-committee period of a source chain. A different one is a conflict; the first stays. */
  putHandoff(record: HandoffRecord): Promise<UpsertOutcome>;
  /** The periods that have a handoff update for a chain, ascending. */
  handoffPeriods(chainId: number): Promise<number[]>;
  /** The handoff update of one period, or null. */
  handoff(chainId: number, period: number): Promise<HandoffRecord | null>;
  /** The fork proof of a source block. A different record text for the same chain and state root is a conflict; the first stays. */
  putForkProof(record: ForkProofArchiveRecord): Promise<UpsertOutcome>;
  /** The fork proofs of a chain from a slot on, ascending by slot (then state root), at most `limit`. */
  forkProofs(input: { readonly chainId: number; readonly fromSlot: bigint; readonly limit: number }): Promise<ForkProofEntry[]>;
  /** The fork proof of one state root of a chain, or null. */
  forkProof(chainId: number, stateRoot: string): Promise<ForkProofArchiveRecord | null>;
  /** Row counts of each table. */
  counts(): Promise<Record<"storageProofs" | "lightClientProofs" | "evidence" | "handoffUpdates" | "forkProofs" | "conflicts", number>>;
  /** Every row of a table, in key order, one page at a time. */
  pages(table: "storage_proofs" | "light_client_proofs" | "message_evidence" | "handoff_updates" | "fork_proofs" | "conflicts", pageSize?: number): AsyncGenerator<unknown[]>;
}

const SPECS = { storage_proofs: STORAGE, light_client_proofs: LIGHT_CLIENT, message_evidence: EVIDENCE, handoff_updates: HANDOFF, fork_proofs: FORK_PROOF } as const;

/** Builds the archive over a database. Call `migrate` once before the rest. */
export function createProofArchive(sql: SqlExecutor): ProofArchive {
  async function upsert(spec: TableSpec, record: Record<string, unknown>, source: string): Promise<UpsertOutcome> {
    const columns = [...spec.key, ...spec.compare, ...spec.fill, ...spec.meta];
    const values = columns.map((item) => parameterOf(item, record[item.field]));
    const inserted = await sql.query(
      `INSERT INTO ${spec.table} (${columns.map((item) => item.name).join(", ")}) VALUES (${columns.map((item, index) => `$${index + 1}::${item.type}`).join(", ")}) ` +
        `ON CONFLICT (${spec.key.map((item) => item.name).join(", ")}) DO NOTHING RETURNING true AS inserted`,
      values,
    );
    if (inserted.rows.length > 0) return "inserted";

    const keyValues = values.slice(0, spec.key.length);
    const where = spec.key.map((item, index) => `${item.name} = $${index + 1}::${item.type}`).join(" AND ");
    const checked = [...spec.compare, ...spec.fill];
    const checkValues = checked.map((item) => parameterOf(item, record[item.field]));
    const tests = checked
      .map((item, index) => {
        const parameter = `$${spec.key.length + index + 1}::${item.type}`;
        return `(${item.name} IS NOT DISTINCT FROM ${parameter}) AS "same_${item.name}", (${item.name} IS NULL) AS "null_${item.name}", ${item.name}::text AS "text_${item.name}", (${parameter})::text AS "incoming_${item.name}"`;
      })
      .join(", ");
    const existing = (await sql.query<Record<string, unknown>>(`SELECT ${tests} FROM ${spec.table} WHERE ${where}`, [...keyValues, ...checkValues])).rows[0] as Record<string, unknown>;

    const conflicts: Column[] = [];
    const fills: Column[] = [];
    for (const item of spec.compare) if (existing[`same_${item.name}`] !== true) conflicts.push(item);
    for (const item of spec.fill) {
      if (record[item.field] === null || record[item.field] === undefined || existing[`same_${item.name}`] === true) continue;
      if (existing[`null_${item.name}`] === true) fills.push(item);
      else conflicts.push(item);
    }
    for (const item of fills) {
      const index = checked.indexOf(item);
      await sql.query(`UPDATE ${spec.table} SET ${item.name} = $${spec.key.length + 1}::${item.type} WHERE ${where} AND ${item.name} IS NULL`, [...keyValues, checkValues[index]]);
    }
    if (conflicts.length > 0) {
      const key = Object.fromEntries(spec.key.map((item, index) => [item.name, keyValues[index]]));
      for (const item of conflicts) {
        await sql.query(
          "INSERT INTO proof_archive.conflicts (table_name, row_key, column_name, existing_value, incoming_value, source) VALUES ($1, $2::jsonb, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
          [spec.table, JSON.stringify(key), item.name, existing[`text_${item.name}`], existing[`incoming_${item.name}`], source],
        );
      }
      return "conflict";
    }
    return fills.length > 0 ? "merged" : "unchanged";
  }

  const selectAll = (spec: TableSpec) => [...spec.key, ...spec.compare, ...spec.fill, ...spec.meta].map(selectOf).join(", ");

  function storageOf(row: Record<string, unknown>): StorageProofRecord {
    return {
      schemaVersion: 1,
      chainId: row.chainId as number,
      address: row.address as string,
      blockNumber: Number(row.blockNumber),
      blockHash: row.blockHash as string,
      storageKeys: row.storageKeys as string[],
      storedSlot: Number(row.storedSlot),
      proof: row.proof,
      fetchedAt: row.fetchedAt as string,
      sourceHost: row.sourceHost as string | null,
    };
  }

  const ofTable = {
    storage_proofs: (row: Record<string, unknown>) => storageOf(row),
    light_client_proofs: (row: Record<string, unknown>) => row,
    message_evidence: (row: Record<string, unknown>) => ({ ...row, storedAt: row.storedAt === null ? null : Number(row.storedAt) }),
    handoff_updates: (row: Record<string, unknown>) => ({
      ...row,
      attestedSlot: Number(row.attestedSlot),
      finalizedSlot: Number(row.finalizedSlot),
      storedAt: row.storedAt === null ? null : Number(row.storedAt),
    }),
    fork_proofs: (row: Record<string, unknown>) => ({
      ...row,
      slot: Number(row.slot),
      executionBlockNumber: Number(row.executionBlockNumber),
      storedAt: row.storedAt === null ? null : Number(row.storedAt),
    }),
  };

  return {
    async migrate() {
      await sql.exec(MIGRATION);
    },
    putStorageProof: (record) =>
      upsert(STORAGE, { ...record, address: record.address.toLowerCase(), blockHash: record.blockHash.toLowerCase(), storageKeys: record.storageKeys.map((key) => key.toLowerCase()) }, record.sourceHost ?? "unknown"),
    putLightClientProof: (record) => upsert(LIGHT_CLIENT, record, record.source),
    putEvidence: (record) => upsert(EVIDENCE, { ...record, messageId: record.messageId.toLowerCase() }, record.source),
    async storageProofsAt({ chainId, address, blockNumber }) {
      const rows = await sql.query(`SELECT ${selectAll(STORAGE)} FROM ${STORAGE.table} WHERE chain_id = $1 AND address = $2 AND block_number = $3::bigint ORDER BY block_hash, storage_keys`, [
        chainId,
        address.toLowerCase(),
        blockNumber.toString(),
      ]);
      return rows.rows.map(storageOf);
    },
    async lightClientProofs({ direction, startSlot, limit }) {
      const rows = await sql.query<LightClientProofRecord>(
        `SELECT ${selectAll(LIGHT_CLIENT)} FROM ${LIGHT_CLIENT.table} WHERE direction = $1 AND ($2::bigint IS NULL OR start_slot = $2::bigint) ORDER BY start_slot DESC, new_slot DESC, proof_hash LIMIT $3`,
        [direction, startSlot === undefined ? null : startSlot.toString(), limit],
      );
      return rows.rows;
    },
    async evidence(messageId) {
      const rows = await sql.query(`SELECT ${selectAll(EVIDENCE)} FROM ${EVIDENCE.table} WHERE message_id = $1 ORDER BY body_hash`, [messageId.toLowerCase()]);
      return rows.rows.map((row) => ofTable.message_evidence(row) as EvidenceRecord);
    },
    putHandoff: (record) => upsert(HANDOFF, record, record.source),
    async handoffPeriods(chainId) {
      const rows = await sql.query<{ period: number }>(`SELECT period FROM ${HANDOFF.table} WHERE chain_id = $1 ORDER BY period`, [chainId]);
      return rows.rows.map((row) => row.period);
    },
    async handoff(chainId, period) {
      const rows = await sql.query(`SELECT ${selectAll(HANDOFF)} FROM ${HANDOFF.table} WHERE chain_id = $1 AND period = $2`, [chainId, period]);
      return rows.rows.length === 0 ? null : (ofTable.handoff_updates(rows.rows[0] as Record<string, unknown>) as HandoffRecord);
    },
    putForkProof: (record) => upsert(FORK_PROOF, record, record.source),
    async forkProofs({ chainId, fromSlot, limit }) {
      const rows = await sql.query<{ slot: string; stateRoot: string; blockRoot: string; executionBlockNumber: string }>(
        `SELECT slot::text AS "slot", state_root AS "stateRoot", block_root AS "blockRoot", execution_block_number::text AS "executionBlockNumber" FROM ${FORK_PROOF.table} WHERE chain_id = $1 AND slot >= $2::bigint ORDER BY slot, state_root LIMIT $3`,
        [chainId, fromSlot.toString(), limit],
      );
      return rows.rows.map((row) => ({ slot: Number(row.slot), stateRoot: row.stateRoot, blockRoot: row.blockRoot, executionBlockNumber: Number(row.executionBlockNumber) }));
    },
    async forkProof(chainId, stateRoot) {
      const rows = await sql.query(`SELECT ${selectAll(FORK_PROOF)} FROM ${FORK_PROOF.table} WHERE chain_id = $1 AND state_root = $2`, [chainId, stateRoot.toLowerCase()]);
      return rows.rows.length === 0 ? null : (ofTable.fork_proofs(rows.rows[0] as Record<string, unknown>) as ForkProofArchiveRecord);
    },
    async counts() {
      const rows = await sql.query<Record<string, string>>(
        "SELECT (SELECT count(*) FROM proof_archive.storage_proofs)::text AS storage, (SELECT count(*) FROM proof_archive.light_client_proofs)::text AS light, " +
          "(SELECT count(*) FROM proof_archive.message_evidence)::text AS evidence, (SELECT count(*) FROM proof_archive.handoff_updates)::text AS handoff, " +
          "(SELECT count(*) FROM proof_archive.fork_proofs)::text AS fork, (SELECT count(*) FROM proof_archive.conflicts)::text AS conflicts",
      );
      const row = rows.rows[0] as Record<string, string>;
      return { storageProofs: Number(row.storage), lightClientProofs: Number(row.light), evidence: Number(row.evidence), handoffUpdates: Number(row.handoff), forkProofs: Number(row.fork), conflicts: Number(row.conflicts) };
    },
    async *pages(table, pageSize = 500) {
      const select =
        table === "conflicts"
          ? `SELECT table_name AS "table", row_key AS "key", column_name AS "column", existing_value AS "existing", incoming_value AS "incoming", source FROM proof_archive.conflicts ORDER BY id`
          : `SELECT ${selectAll(SPECS[table])} FROM ${SPECS[table].table} ORDER BY ${SPECS[table].key.map((item) => item.name).join(", ")}`;
      const map = table === "conflicts" ? (row: Record<string, unknown>) => row : ofTable[table];
      for (let offset = 0; ; offset += pageSize) {
        const rows = await sql.query(`${select} LIMIT ${pageSize} OFFSET ${offset}`);
        if (rows.rows.length > 0) yield rows.rows.map(map);
        if (rows.rows.length < pageSize) return;
      }
    },
  };
}
