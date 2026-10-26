import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redactSecrets } from "@zk-bridge/shared/config";

/** One line of the outcome file: a delivery or a light client update that the runner decided on. */
export interface OutcomeRecord {
  readonly kind: "delivery" | "update";
  readonly pair: string;
  readonly direction: string;
  readonly status: "delivered" | "skipped" | "failed" | "posted" | "refused";
  readonly [field: string]: unknown;
}

/** Where outcomes go. The dashboard reads the file that the real sink writes. */
export interface OutcomeSink {
  record(entry: OutcomeRecord): Promise<void>;
}

function serializable(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializable);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializable(item)]));
  return value;
}

/** Input of {@link createFileOutcomeSink}. */
export interface FileOutcomeSinkInput {
  readonly path: string;
  readonly now: () => Date;
  readonly knownSecrets: () => readonly string[];
}

/**
 * Appends one JSON object per line to a file with mode 0600. Amounts are decimal strings. Each line passes through the
 * redactor, as every log line does.
 */
export function createFileOutcomeSink(input: FileOutcomeSinkInput): OutcomeSink {
  return {
    async record(entry) {
      await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
      const line = JSON.stringify(serializable({ time: input.now().toISOString(), ...entry }));
      await appendFile(input.path, `${redactSecrets(line, input.knownSecrets())}\n`, { mode: 0o600 });
      await chmod(input.path, 0o600);
    },
  };
}
