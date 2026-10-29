/** SHA-256 of files and the `SHA256SUMS` list, in the format `sha256sum --check` reads. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Lower-case hex SHA-256 of bytes. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Lower-case hex SHA-256 of a file, read as a stream. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part as Buffer);
  return hash.digest("hex");
}

/** One line of `SHA256SUMS`: a path relative to the release directory and its hash. */
export type ChecksumEntry = { file: string; sha256: string };

/** The `SHA256SUMS` text: one `<hash>  <file>` line per entry, sorted by file. */
export function formatSha256Sums(entries: readonly ChecksumEntry[]): string {
  return [...entries]
    .sort((a, b) => (a.file < b.file ? -1 : 1))
    .map((entry) => `${entry.sha256}  ${entry.file}\n`)
    .join("");
}

const LINE = /^([0-9a-f]{64}) [ *](.+)$/;

/**
 * Reads `SHA256SUMS` text into a map from file to hash.
 * @throws Error naming the first line that is not a hash and a file name.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  text
    .split("\n")
    .filter((line) => line.length > 0)
    .forEach((line, index) => {
      const match = LINE.exec(line);
      if (!match) throw new Error(`line ${index + 1} is not a SHA-256 and a file name`);
      sums.set(match[2]!, match[1]!);
    });
  return sums;
}
