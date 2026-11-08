/**
 * The idle timeout of the RunPod endpoint over time (`idle_timeout_history`: from `at` on, `seconds`), so that the billing
 * breakdown applies the timeout that was in effect when a job ended, not today's. The table is seeded by the migration in
 * `storage.ts` (60 s from the beginning, 5 s from 2026-11-08T01:59:00Z); the start-up sync (`idle-timeout.ts`) adds a row
 * whenever the endpoint's timeout, as read or as set, differs from the latest row.
 */
import type { Storage } from "./storage.ts";

/** From `at` (milliseconds since 1970) on, the endpoint's idle timeout is `seconds`. */
export type IdleChange = { readonly at: number; readonly seconds: number };

/** The timeout in effect at `at`: the latest change at or before it, else the first one, else `fallback`. `changes` is oldest first. */
export function idleSecondsAt(changes: readonly IdleChange[], at: number, fallback: number): number {
  let found: IdleChange | undefined = changes[0];
  for (const change of changes) {
    if (change.at > at) break;
    found = change;
  }
  return found?.seconds ?? fallback;
}

export interface IdleHistory {
  /** All changes, oldest first. */
  changes(): IdleChange[];
  /** Records the endpoint's timeout seen at `at`; nothing is written when it equals the latest row. */
  record(at: number, seconds: number): void;
  /** The timeout in effect at `at`, or `fallback` when the table is empty. */
  secondsAt(at: number, fallback: number): number;
}

export function createIdleHistory(storage: Storage): IdleHistory {
  const { database } = storage;
  const changes = () => (database.prepare("SELECT at, seconds FROM idle_timeout_history ORDER BY at").all() as Array<{ at: number; seconds: number }>).map((row) => ({ at: row.at, seconds: row.seconds }));
  return {
    changes,
    record(at, seconds) {
      const latest = changes().pop();
      if (latest?.seconds === seconds) return;
      database.prepare("INSERT OR REPLACE INTO idle_timeout_history (at, seconds) VALUES (?, ?)").run(at, seconds);
    },
    secondsAt: (at, fallback) => idleSecondsAt(changes(), at, fallback),
  };
}
