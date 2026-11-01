import type { CurrentRow } from "./store.ts";

export type Summary = {
  readonly status: "operational" | "degraded" | "down";
  /** One line: what is failing, in plain words. */
  readonly message: string;
  readonly failing: ReadonlyArray<{ id: string; name: string; state: "degraded" | "down"; detail: string }>;
  readonly checks: number;
  /** When the newest check ran, in milliseconds since 1970, or null before the first round. */
  readonly checkedAt: number | null;
};

const describe = (rows: ReadonlyArray<{ name: string; detail: string }>): string => rows.map((row) => `${row.name}: ${row.detail}`).join("; ");

/**
 * The one-line answer: operational, degraded or down, and what is failing. If the newest check is older than
 * `staleAfterMilliseconds` the service itself has stopped and the answer is down.
 */
export function summarize(rows: readonly CurrentRow[], now: number, staleAfterMilliseconds: number): Summary {
  if (rows.length === 0) return { status: "degraded", message: "No check has run yet.", failing: [], checks: 0, checkedAt: null };
  const checkedAt = Math.max(...rows.map((row) => row.at));
  const failing = rows
    .filter((row): row is CurrentRow & { state: "degraded" | "down" } => row.state !== "ok")
    .sort((left, right) => Number(right.state === "down") - Number(left.state === "down"))
    .map((row) => ({ id: row.id, name: row.name, state: row.state, detail: row.detail }));
  if (now - checkedAt > staleAfterMilliseconds) {
    const minutes = Math.round((now - checkedAt) / 60_000);
    return { status: "down", message: `The status service has not run its checks for ${minutes} minutes.`, failing, checks: rows.length, checkedAt };
  }
  if (failing.length === 0) return { status: "operational", message: `All ${rows.length} checks pass.`, failing, checks: rows.length, checkedAt };
  const down = failing.filter((entry) => entry.state === "down");
  const degraded = failing.filter((entry) => entry.state === "degraded");
  const parts = [...(down.length > 0 ? [`Down: ${describe(down)}.`] : []), ...(degraded.length > 0 ? [`Degraded: ${describe(degraded)}.`] : [])];
  return { status: down.length > 0 ? "down" : "degraded", message: parts.join(" "), failing, checks: rows.length, checkedAt };
}
