import { DatabaseSync } from "node:sqlite";
import { BUCKETS, STATES, WINDOWS, type CheckResult, type Section, type State, type WindowName } from "./types.ts";

/**
 * The tables. `runs` has one row per run of a check (the key is the check and the time, so it needs no second index);
 * an ok run stores no detail, because the detail of the newest run is in `current`. `current` has one row per check.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  check_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  state INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  detail TEXT,
  PRIMARY KEY (check_id, at)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS current (
  check_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  section TEXT NOT NULL,
  at INTEGER NOT NULL,
  state INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  detail TEXT NOT NULL,
  since INTEGER NOT NULL
);
`;

/** The newest result of one check, with the name and the section it belongs to. */
export type CurrentRow = {
  readonly id: string;
  readonly name: string;
  readonly section: Section;
  readonly at: number;
  readonly state: State;
  readonly latencyMs: number;
  readonly detail: string;
  /** Since when the check has been in this state. */
  readonly since: number;
};

/** Uptime of one check in one window, in percent: runs that were not down, and runs that were fully ok. */
export type Uptime = { readonly runs: number; readonly uptime: number; readonly ok: number };

/** One run that was not ok. */
export type Problem = { readonly at: number; readonly state: State; readonly detail: string };

export type CheckInfo = { readonly name: string; readonly section: Section };

export interface Store {
  /** Writes the results of one round and updates the current row of each check. */
  record(results: readonly CheckResult[], info: Readonly<Record<string, CheckInfo>>): void;
  current(): CurrentRow[];
  uptime(now: number): Record<WindowName, Record<string, Uptime>>;
  /** The bars of a window: the worst state of each slice, null for a slice with no run. One check, or all of them. */
  history(now: number, window: WindowName, checkId?: string): Record<string, Array<State | null>>;
  /** The runs that were not ok since `since`, newest first. */
  problems(checkId: string, since: number, limit: number): Problem[];
  /** Deletes the runs before `before`; returns how many. */
  prune(before: number): number;
  /** The number of stored runs. */
  size(): number;
  close(): void;
}

const percent = (part: number, whole: number): number => Math.round((part / whole) * 10_000) / 100;

/** Opens (and creates, if needed) the status database. `:memory:` is for a test. */
export function openStore(path: string): Store {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(SCHEMA);
  const insertRun = database.prepare("INSERT OR REPLACE INTO runs (check_id, at, state, latency_ms, detail) VALUES (?, ?, ?, ?, ?)");
  const readCurrent = database.prepare("SELECT state, since FROM current WHERE check_id = ?");
  const writeCurrent = database.prepare(
    "INSERT OR REPLACE INTO current (check_id, name, section, at, state, latency_ms, detail, since) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const stateOf = (value: unknown): State => STATES[Number(value)] as State;

  return {
    record(results, info) {
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const result of results) {
          const state = STATES.indexOf(result.state);
          insertRun.run(result.id, result.at, state, result.latencyMs, result.state === "ok" ? null : result.detail);
          const before = readCurrent.get(result.id) as { state: number; since: number } | undefined;
          const since = before !== undefined && before.state === state ? before.since : result.at;
          const names = info[result.id] ?? { name: result.id, section: "services" as const };
          writeCurrent.run(result.id, names.name, names.section, result.at, state, result.latencyMs, result.detail, since);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },

    current() {
      const rows = database.prepare("SELECT * FROM current ORDER BY check_id").all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: row.check_id as string,
        name: row.name as string,
        section: row.section as Section,
        at: Number(row.at),
        state: stateOf(row.state),
        latencyMs: Number(row.latency_ms),
        detail: row.detail as string,
        since: Number(row.since),
      }));
    },

    uptime(now) {
      const answer = {} as Record<WindowName, Record<string, Uptime>>;
      const statement = database.prepare("SELECT check_id, COUNT(*) AS runs, SUM(state < 2) AS up, SUM(state = 0) AS ok FROM runs WHERE at > ? AND at <= ? GROUP BY check_id");
      for (const [window, milliseconds] of Object.entries(WINDOWS) as Array<[WindowName, number]>) {
        answer[window] = {};
        for (const row of statement.all(now - milliseconds, now) as Array<Record<string, number | string>>) {
          const runs = Number(row.runs);
          answer[window][row.check_id as string] = { runs, uptime: percent(Number(row.up), runs), ok: percent(Number(row.ok), runs) };
        }
      }
      return answer;
    },

    history(now, window, checkId) {
      const length = BUCKETS[window];
      const start = now - WINDOWS[window];
      const slice = WINDOWS[window] / length;
      const rows = database
        .prepare(
          `SELECT check_id, CAST((at - ?1) / ?2 AS INTEGER) AS slot, MAX(state) AS worst FROM runs WHERE at > ?1 AND at <= ?3 ${checkId === undefined ? "" : "AND check_id = ?4"} GROUP BY check_id, slot`,
        )
        .all(...(checkId === undefined ? [start, slice, now] : [start, slice, now, checkId])) as Array<Record<string, number | string>>;
      const bars: Record<string, Array<State | null>> = {};
      for (const row of rows) {
        const bar = (bars[row.check_id as string] ??= Array.from({ length }, () => null));
        bar[Math.min(length - 1, Number(row.slot))] = stateOf(row.worst);
      }
      return bars;
    },

    problems(checkId, since, limit) {
      const rows = database
        .prepare("SELECT at, state, detail FROM runs WHERE check_id = ? AND at >= ? AND state > 0 ORDER BY at DESC LIMIT ?")
        .all(checkId, since, limit) as Array<Record<string, unknown>>;
      return rows.map((row) => ({ at: Number(row.at), state: stateOf(row.state), detail: row.detail as string }));
    },

    prune(before) {
      return Number(database.prepare("DELETE FROM runs WHERE at < ?").run(before).changes);
    },

    size() {
      return Number((database.prepare("SELECT COUNT(*) AS total FROM runs").get() as { total: number }).total);
    },

    close() {
      database.close();
    },
  };
}
