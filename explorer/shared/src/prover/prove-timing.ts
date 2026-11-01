/** The fields of one `prove_timing` line of the prover: numbers for the counters and times, text for the rest. */
export type ProveTiming = Readonly<Record<string, string | number>>;

/** Keys that every prover line carries. They describe the line, not the run, so they are not part of the timing. */
const LINE_KEYS = new Set(["ts", "level", "event"]);

/** Splits one `key=value key="quoted value"` line. A quoted value may hold `\"` and `\\`. */
function splitFields(line: string): Array<readonly [string, string]> {
  const fields: Array<readonly [string, string]> = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|\S*)/g;
  for (const match of line.matchAll(pattern)) {
    const raw = match[2] as string;
    const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw;
    fields.push([match[1] as string, value]);
  }
  return fields;
}

/**
 * The fields of the last `prove_timing` line in the standard error of a `prove` run, or null when the prover wrote none
 * (an older prover). Values of keys that end in `_ms` or `_count` become numbers; everything else stays text, such as
 * `worker_gpu` and `worker_timings`.
 */
export function parseProveTiming(stderr: string): ProveTiming | null {
  const lines = stderr.split("\n").filter((line) => / event=prove_timing(\s|$)/.test(line));
  const last = lines.at(-1);
  if (last === undefined) return null;
  const timing: Record<string, string | number> = {};
  for (const [key, value] of splitFields(last)) {
    if (LINE_KEYS.has(key)) continue;
    const isNumber = (key.endsWith("_ms") || key.endsWith("_count")) && /^\d+$/.test(value);
    timing[key] = isNumber ? Number(value) : value;
  }
  return timing;
}
