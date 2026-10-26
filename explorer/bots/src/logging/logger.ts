import { redactError, redactSecrets } from "@zk-bridge/shared/config";

/** The severity of a log line, from least to most serious. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/** The named values of one log line. A value can be any JSON value, a `bigint` or an `Error`. */
export type LogFields = Readonly<Record<string, unknown>>;

/** A writer of structured log lines. Every line is one JSON object. */
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that adds `bindings` to every line it writes. */
  child(bindings: LogFields): Logger;
}

/** Input of {@link createLogger}. */
export interface LoggerOptions {
  /** Receives each finished line, without a line break. */
  readonly write: (line: string) => void;
  readonly now: () => Date;
  /** The secret values that this process holds. The logger removes each one from every line, whatever its shape. */
  readonly knownSecrets: () => readonly string[];
  readonly minimumLevel: LogLevel;
  readonly bindings?: LogFields;
}

/** Turns a field value into something `JSON.stringify` keeps: an error becomes its redacted message, a `bigint` text. */
function serializableValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: redactError(value, secrets) };
  if (Array.isArray(value)) return value.map((item) => serializableValue(item, secrets));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializableValue(item, secrets)]));
  }
  return value;
}

/**
 * Builds a logger that writes one JSON line per event. Every line passes through the redactor before it is written,
 * so a key that sits in an error message or in an endpoint never reaches the output.
 */
export function createLogger(options: LoggerOptions): Logger {
  const bindings = options.bindings ?? {};
  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[options.minimumLevel]) return;
    const secrets = options.knownSecrets();
    const entry = { time: options.now().toISOString(), level, event, ...bindings, ...fields };
    const line = JSON.stringify(serializableValue(entry, secrets));
    options.write(redactSecrets(line, secrets));
  };
  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    child: (more) => createLogger({ ...options, bindings: { ...bindings, ...more } }),
  };
}
