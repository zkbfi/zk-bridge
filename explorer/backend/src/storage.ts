import { DatabaseSync } from "node:sqlite";

/**
 * The tables of the backend, in one file. The `jobs` table carries a unique index that lets only one job per direction
 * be queued or proving, so the rule "one job per direction" holds even if two processes share the file.
 * The `proofs` and `evidence` tables belong to the msgboard indexer and the archive module, the `warmup_` tables to the
 * warm-up of the remote prover (`watch/warmup-store.ts`), and `job_timings` to the timings of each proof
 * (`requests/timings.ts`): what the prover reported, and when the webhook stored and the board took the proof.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  start_slot TEXT,
  new_slot TEXT,
  error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_per_direction
  ON jobs (direction) WHERE status IN ('queued', 'proving');
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  pair TEXT NOT NULL,
  direction TEXT NOT NULL,
  reason TEXT NOT NULL,
  message_id TEXT,
  caller TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_by_caller ON requests (caller, created_at);
CREATE TABLE IF NOT EXISTS proofs (
  direction TEXT PRIMARY KEY,
  job_id TEXT,
  start_slot TEXT NOT NULL,
  new_slot TEXT NOT NULL,
  body TEXT NOT NULL,
  stored_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
  message_id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  stored_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS warmup_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  source TEXT NOT NULL,
  seconds REAL NOT NULL,
  observed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS warmup_sessions (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  why TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  lead_seconds INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ready_at INTEGER,
  ended_at INTEGER,
  outcome TEXT,
  billed_seconds REAL
);
CREATE INDEX IF NOT EXISTS warmup_sessions_by_time ON warmup_sessions (started_at);
CREATE TABLE IF NOT EXISTS job_timings (
  job_id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  started_at INTEGER,
  proved_at INTEGER,
  wait_worker_ms INTEGER,
  not_ready_count INTEGER,
  retry_count INTEGER,
  failover_count INTEGER,
  remote_ms INTEGER,
  prove_ms INTEGER,
  total_ms INTEGER,
  worker_queue_ms INTEGER,
  worker_prove_ms INTEGER,
  worker_total_ms INTEGER,
  remote_overhead_ms INTEGER,
  endpoint TEXT,
  worker_gpu TEXT,
  webhook_stored_at INTEGER,
  board_posted_at INTEGER,
  grind_ms INTEGER
);
CREATE INDEX IF NOT EXISTS job_timings_by_proved ON job_timings (proved_at);
`;

/**
 * Brings an older file up to date. The planned slots of a job (the head it starts from and the finalized slot it
 * targets, when the watcher names them) carry a unique index: one proof of a direction from one head to one slot never
 * gets a second job, also after a restart or a failure.
 */
function migrate(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "planned_start_slot")) {
    database.exec("ALTER TABLE jobs ADD COLUMN planned_start_slot TEXT");
    database.exec("ALTER TABLE jobs ADD COLUMN planned_new_slot TEXT");
  }
  const sessionColumns = database.prepare("PRAGMA table_info(warmup_sessions)").all() as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === "billed_seconds")) database.exec("ALTER TABLE warmup_sessions ADD COLUMN billed_seconds REAL");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_per_target ON jobs (direction, planned_start_slot, planned_new_slot) WHERE planned_start_slot IS NOT NULL");
}

/** The backend database: one SQLite file. */
export interface Storage {
  /** The open database. The modules run their own statements on it. */
  readonly database: DatabaseSync;
  /**
   * Runs `work` inside one write transaction. A throw rolls the changes back and passes the error on.
   * The work must be synchronous: a transaction never waits for another task.
   */
  transaction<Result>(work: () => Result): Result;
  /** Closes the file. */
  close(): void;
}

/**
 * Opens (and creates, if needed) the backend database.
 *
 * @param path The file, or `:memory:` for a test.
 */
export function openStorage(path: string): Storage {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(SCHEMA);
  migrate(database);
  return {
    database,
    transaction(work) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      database.close();
    },
  };
}
