/**
 * The part of a logger that the msgboard and prover code writes to. A bot logger fits it without a wrapper. The code
 * in this package never logs a secret, but the logger that the caller passes also redacts every line.
 */
export interface LogSink {
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
}
