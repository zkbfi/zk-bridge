import { redactError, redactSecrets } from "@zk-bridge/shared/config";

/** The named values of one log line. */
export type LogFields = Readonly<Record<string, unknown>>;

/** A writer of structured log lines. Every line is one JSON object. */
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/** Input of {@link createLogger}. */
export interface LoggerOptions {
  /** Receives each finished line, without a line break. */
  readonly write: (line: string) => void;
  readonly now: () => number;
  /** The secret values this process holds. The logger removes each one from every line. */
  readonly knownSecrets: () => readonly string[];
}

function serializable(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: redactError(value, secrets) };
  if (Array.isArray(value)) return value.map((item) => serializable(item, secrets));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializable(item, secrets)]));
  }
  return value;
}

/** Builds a logger that writes one redacted JSON line per event. */
export function createLogger(options: LoggerOptions): Logger {
  const emit = (level: string, event: string, fields: LogFields = {}): void => {
    const secrets = options.knownSecrets();
    const entry = { time: new Date(options.now()).toISOString(), level, event, ...fields };
    options.write(redactSecrets(JSON.stringify(serializable(entry, secrets)), secrets));
  };
  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
