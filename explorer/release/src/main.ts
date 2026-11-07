/**
 * The release command line, called by script/release/*.sh:
 *   pack <site-directory> <archive-file>      packs a built site and prints its CID
 *   unpack <archive-file> <directory>         writes the files of an archive and prints its CID
 *   manifest <release-directory> --version <v> --commit <c> --published-at <time> [--previous <version.json>]
 *            [--channel <name>]               writes version.json and SHA256SUMS from archives/ and downloads/;
 *                                             the channel is stable unless named (next for staging)
 *   promote <staging-directory> <out-directory> --landing <landing.car> --version <v> --published-at <time>
 *            [--previous <production version.json>]
 *                                             writes an unsigned production release that keeps the staging dapp and
 *                                             archive (same content address) with a production landing
 *   sign <directory>                          reads the private key from standard input, signs version.json and
 *                                             releases-log.json (each when present) and writes public-keys.json
 *   log <release-directory> [--previous-log <file> --public-keys <file>]
 *                                             writes releases-log.json: the previous log (checked against the keys;
 *                                             its signature is <file>.sig) with the sites of version.json appended
 *   log-check <log-file> --public-keys <file> [--extends <published-log>] [--manifest <version.json>]
 *                                             checks a signed log; with --extends, that it only appends to the
 *                                             published log; with --manifest, that it ends with that release
 *   log-bootstrap <release-repository> <out-directory> --branch <b> --channel <c> --public-keys <file>
 *                                             writes the first releases-log.json of a channel from the signed
 *                                             version.json files in the history of a branch
 *   repin <log-file> --public-keys <file> [--mode check|apply]
 *                                             lists every CID of a checked log that the kubo node does not pin;
 *                                             with --mode apply, asks the node to pin each one
 *   verify <release-directory> --public-keys <file>
 *                                             checks the release; the file is a list of keys or a landing.config.json
 *   pin <release-directory> [--prefix <p>]    uploads each archive through the RELEASE_PIN_PROVIDER adapter
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalManifestBytes, parseManifest, type ReleaseEntry, type ReleaseManifest } from "../../landing/src/manifest.ts";
import { packDirectory, readArchive, unpackCar } from "./car.ts";
import { formatSha256Sums, sha256Bytes, sha256File, type ChecksumEntry } from "./checksums.ts";
import { downloadEntry, writeManifest } from "./manifest-writer.ts";
import { bootstrapLog, readHistory } from "./bootstrap-log.ts";
import { kuboPinsFromEnvironment, pinAdapterFromEnvironment } from "./pin.ts";
import { promoteRelease } from "./promote.ts";
import {
  appendRelease,
  canonicalLogBytes,
  checkSignedLog,
  extensionProblems,
  LOG_LAYOUT,
  manifestProblems,
  parseLog,
  type ReleaseLog,
} from "./release-log.ts";
import { publicKeyOf, readPrivateKey, signBytes, signManifest } from "./sign.ts";
import { RELEASE_LAYOUT, SITE_NAMES, verifyRelease } from "./verify.ts";

/** The standard streams and environment, passed in so tests can run every command in process. */
export type Io = {
  stdin: AsyncIterable<Uint8Array>;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
};

class UsageError extends Error {}

const USAGE = [
  "usage: release pack <site-directory> <archive-file>",
  "       release unpack <archive-file> <directory>",
  "       release manifest <release-directory> --version <v> --commit <c> --published-at <time> [--previous <file>] [--channel <name>]",
  "       release promote <staging-directory> <out-directory> --landing <landing.car> --version <v> --published-at <time> [--previous <file>]",
  "       release sign <directory>   (private key on standard input)",
  "       release verify <release-directory> --public-keys <file>",
  "       release pin <release-directory> [--prefix <p>]",
  "       release log <release-directory> [--previous-log <file> --public-keys <file>]",
  "       release log-check <log-file> --public-keys <file> [--extends <published-log>] [--manifest <version.json>]",
  "       release log-bootstrap <release-repository> <out-directory> --branch <b> --channel <c> --public-keys <file>",
  "       release repin <log-file> --public-keys <file> [--mode check|apply]",
].join("\n");

function parseArguments(argv: readonly string[], positionals: number): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value.startsWith("--")) {
      const next = argv[index + 1];
      if (next === undefined) throw new UsageError();
      flags.set(value.slice(2), next);
      index += 1;
    } else {
      positional.push(value);
    }
  }
  if (positional.length !== positionals) throw new UsageError();
  return { positional, flags };
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) throw new UsageError();
  return value;
}

async function listDownloads(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(join(directory, RELEASE_LAYOUT.downloads), { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/**
 * Writes `version.json` (canonical bytes) and `SHA256SUMS` for the archives and downloads in a release directory.
 * @throws Error when an archive of the three sites is missing.
 */
export async function assembleRelease(input: {
  directory: string;
  version: string;
  commit: string;
  publishedAt: string;
  previous: ReleaseManifest | null;
  channel?: string;
}): Promise<ReleaseManifest> {
  const sums: ChecksumEntry[] = [];
  const releases: ReleaseEntry[] = [];
  for (const name of SITE_NAMES) {
    const file = `${RELEASE_LAYOUT.archives}/${name}.car`;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(input.directory, file)));
    } catch {
      throw new Error(`${file} is missing: pack the site first`);
    }
    const archiveSha256 = sha256Bytes(bytes);
    const { root } = await readArchive(bytes);
    releases.push({ name, version: input.version, commit: input.commit, cid: root.toString(), archiveSha256, publishedAt: input.publishedAt });
    sums.push({ file, sha256: archiveSha256 });
  }
  const downloads = [];
  for (const file of await listDownloads(input.directory)) {
    const sha256 = await sha256File(join(input.directory, RELEASE_LAYOUT.downloads, file));
    downloads.push(downloadEntry(file, sha256));
    sums.push({ file: `${RELEASE_LAYOUT.downloads}/${file}`, sha256 });
  }
  const manifest = writeManifest({ previous: input.previous, releases, downloads, ...(input.channel === undefined ? {} : { channel: input.channel }) });
  await writeFile(join(input.directory, RELEASE_LAYOUT.manifest), canonicalManifestBytes(manifest));
  await writeFile(join(input.directory, RELEASE_LAYOUT.sums), formatSha256Sums(sums));
  return manifest;
}

async function readManifestFile(path: string): Promise<ReleaseManifest> {
  return parseManifest(await readFile(path, "utf8"));
}

/** Reads trusted keys from a JSON list of keys, or from the `publicKeys` field of a landing.config.json. */
async function readPublicKeys(path: string): Promise<JsonWebKey[]> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (Array.isArray(value)) return value as JsonWebKey[];
  const field = (value as { publicKeys?: unknown }).publicKeys;
  if (Array.isArray(field)) return field as JsonWebKey[];
  throw new Error(`${path} holds neither a list of keys nor a publicKeys field`);
}

async function readOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

/**
 * Reads a log file and its signature (`<file>.sig`) and checks them against the trusted keys.
 * @throws Error with every problem when the log does not check.
 */
async function readCheckedLog(path: string, publicKeys: readonly JsonWebKey[]): Promise<ReleaseLog> {
  let logBytes: Uint8Array;
  try {
    logBytes = new Uint8Array(await readFile(path));
  } catch {
    throw new Error(`${path}: missing`);
  }
  const checked = await checkSignedLog({ logBytes, signature: await readOrNull(`${path}.sig`), publicKeys, where: path });
  if (!checked.ok) throw new Error(checked.problems.join("\n"));
  return checked.log;
}

async function command(argv: readonly string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  switch (name) {
    case "pack": {
      const { positional } = parseArguments(rest, 2);
      const { cid, carBytes } = await packDirectory(positional[0]!);
      await mkdir(dirname(positional[1]!), { recursive: true });
      await writeFile(positional[1]!, carBytes);
      io.out(cid);
      return 0;
    }
    case "unpack": {
      const { positional } = parseArguments(rest, 2);
      io.out(await unpackCar(new Uint8Array(await readFile(positional[0]!)), positional[1]!));
      return 0;
    }
    case "manifest": {
      const { positional, flags } = parseArguments(rest, 1);
      const version = required(flags, "version");
      const commit = required(flags, "commit");
      const publishedAt = required(flags, "published-at");
      const previousPath = flags.get("previous");
      const previous = previousPath === undefined ? null : await readManifestFile(previousPath);
      const channel = flags.get("channel");
      const manifest = await assembleRelease({ directory: positional[0]!, version, commit, publishedAt, previous, ...(channel === undefined ? {} : { channel }) });
      io.out(`version.json: sequence ${manifest.sequence}, ${manifest.releases.length} sites, ${manifest.downloads.length} downloads`);
      return 0;
    }
    case "promote": {
      const { positional, flags } = parseArguments(rest, 2);
      const previousPath = flags.get("previous");
      const manifest = await promoteRelease({
        staging: positional[0]!,
        out: positional[1]!,
        landingArchive: required(flags, "landing"),
        version: required(flags, "version"),
        publishedAt: required(flags, "published-at"),
        previous: previousPath === undefined ? null : await readManifestFile(previousPath),
      });
      io.out(`promoted: version ${manifest.channels.stable}, sequence ${manifest.sequence}; sign it with the production key`);
      return 0;
    }
    case "sign": {
      const { positional } = parseArguments(rest, 1);
      const directory = positional[0]!;
      const manifestPath = join(directory, RELEASE_LAYOUT.manifest);
      const logPath = join(directory, LOG_LAYOUT.log);
      const manifestText = await readOrNull(manifestPath);
      const logText = await readOrNull(logPath);
      if (manifestText === null && logText === null) throw new Error(`${directory} holds neither ${RELEASE_LAYOUT.manifest} nor ${LOG_LAYOUT.log}`);
      const manifest = manifestText === null ? null : parseManifest(Buffer.from(manifestText).toString("utf8"));
      const log = logText === null ? null : parseLog(Buffer.from(logText).toString("utf8"));
      const privateKey = await readPrivateKey(io.stdin);
      if (manifest !== null) await writeFile(join(directory, RELEASE_LAYOUT.signature), await signManifest({ manifest, privateKey }));
      if (log !== null) await writeFile(join(directory, LOG_LAYOUT.signature), await signBytes({ bytes: canonicalLogBytes(log), privateKey }));
      await writeFile(join(directory, RELEASE_LAYOUT.publicKeys), `${JSON.stringify([publicKeyOf(privateKey)], null, 2)}\n`);
      return 0;
    }
    case "verify": {
      const { positional, flags } = parseArguments(rest, 1);
      const publicKeys = await readPublicKeys(required(flags, "public-keys"));
      const result = await verifyRelease(positional[0]!, publicKeys);
      if (result.ok) {
        io.out("release verified");
        return 0;
      }
      result.problems.forEach((problem) => io.err(problem));
      io.err("release NOT verified");
      return 1;
    }
    case "pin": {
      const { positional, flags } = parseArguments(rest, 1);
      const adapter = pinAdapterFromEnvironment(io.env);
      if (adapter === null) {
        io.err("no pinning account is configured (set RELEASE_PIN_PROVIDER)");
        return 1;
      }
      const prefix = flags.get("prefix");
      for (const site of SITE_NAMES) {
        const file = `${site}.car`;
        const carBytes = new Uint8Array(await readFile(join(positional[0]!, RELEASE_LAYOUT.archives, file)));
        const { root } = await readArchive(carBytes);
        const objectKey = prefix === undefined ? file : `${prefix}/${file}`;
        io.out(`pinned ${file} ${await adapter.pin({ objectKey, carBytes, expectedCid: root.toString() })}`);
      }
      return 0;
    }
    case "log": {
      const { positional, flags } = parseArguments(rest, 1);
      const directory = positional[0]!;
      const manifest = await readManifestFile(join(directory, RELEASE_LAYOUT.manifest));
      const previousPath = flags.get("previous-log");
      let previous: ReleaseLog | null = null;
      if (previousPath !== undefined) previous = await readCheckedLog(previousPath, await readPublicKeys(required(flags, "public-keys")));
      const log = appendRelease(previous, manifest);
      await writeFile(join(directory, LOG_LAYOUT.log), canonicalLogBytes(log));
      const added = log.entries.length - (previous?.entries.length ?? 0);
      const start = previous === null ? ", a new log (no previous log given)" : "";
      io.out(`${LOG_LAYOUT.log}: ${log.entries.length} entries, ${added} new, last sequence ${manifest.sequence}${start}`);
      return 0;
    }
    case "log-check": {
      const { positional, flags } = parseArguments(rest, 1);
      const publicKeys = await readPublicKeys(required(flags, "public-keys"));
      const problems: string[] = [];
      let log: ReleaseLog | null = null;
      try {
        log = await readCheckedLog(positional[0]!, publicKeys);
      } catch (error) {
        problems.push((error as Error).message);
      }
      const extendsPath = flags.get("extends");
      if (log !== null && extendsPath !== undefined) {
        try {
          problems.push(...extensionProblems(await readCheckedLog(extendsPath, publicKeys), log));
        } catch (error) {
          problems.push(`the published log does not check: ${(error as Error).message}`);
        }
      }
      const manifestPath = flags.get("manifest");
      if (log !== null && manifestPath !== undefined) problems.push(...manifestProblems(log, await readManifestFile(manifestPath)));
      if (problems.length > 0 || log === null) {
        problems.forEach((problem) => io.err(problem));
        io.err("release log NOT verified");
        return 1;
      }
      io.out(`release log verified: ${log.entries.length} entries, last sequence ${log.entries.at(-1)?.sequence ?? 0}`);
      return 0;
    }
    case "log-bootstrap": {
      const { positional, flags } = parseArguments(rest, 2);
      const publicKeys = await readPublicKeys(required(flags, "public-keys"));
      const channel = required(flags, "channel");
      const result = await bootstrapLog(readHistory(positional[0]!, required(flags, "branch")), channel, publicKeys);
      await mkdir(positional[1]!, { recursive: true });
      await writeFile(join(positional[1]!, LOG_LAYOUT.log), canonicalLogBytes(result.log));
      for (const item of result.included) io.out(`included sequence ${item.sequence} (${item.version}) from ${item.commit}`);
      for (const item of result.skipped) io.out(`skipped ${item.commit}: ${item.reason}`);
      io.out(`gaps: ${result.gaps.length === 0 ? "none" : result.gaps.join(", ")}`);
      io.out(`${LOG_LAYOUT.log}: ${result.log.entries.length} entries from ${result.included.length} releases on ${channel}; sign it with the ${channel} key`);
      return 0;
    }
    case "repin": {
      const { positional, flags } = parseArguments(rest, 1);
      const mode = flags.get("mode") ?? "check";
      if (mode !== "check" && mode !== "apply") throw new UsageError();
      const log = await readCheckedLog(positional[0]!, await readPublicKeys(required(flags, "public-keys")));
      const pins = kuboPinsFromEnvironment(io.env);
      // Each CID once, named after the latest release that lists it.
      const latest = new Map<string, { name: string; version: string }>();
      for (const entry of log.entries) latest.set(entry.cid, { name: entry.name, version: entry.version });
      let missing = 0;
      let failed = 0;
      for (const [cid, { name, version }] of latest) {
        const label = `${name} ${version}`;
        if (await pins.isPinned(cid)) {
          io.out(`pinned   ${cid} ${label}`);
          continue;
        }
        missing += 1;
        if (mode === "check") {
          io.out(`MISSING  ${cid} ${label}`);
          continue;
        }
        try {
          await pins.pin(cid, `zkbfi-${name}-${version}`);
          io.out(`repinned ${cid} ${label}`);
        } catch (error) {
          failed += 1;
          io.err(`FAILED   ${cid} ${label}: ${(error as Error).message}`);
        }
      }
      const summary = `${latest.size} CIDs in the log, ${latest.size - missing} pinned, ${missing} missing`;
      io.out(mode === "check" ? `${summary} (check only: --mode apply pins them)` : `${summary}, ${missing - failed} repinned, ${failed} failed`);
      return failed > 0 ? 1 : 0;
    }
    default:
      throw new UsageError();
  }
}

/**
 * Runs one command.
 * @returns the exit code: 0 done, 1 refused or failed (the reason on `err`), 2 wrong usage.
 */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  try {
    return await command(argv, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(USAGE);
      return 2;
    }
    io.err((error as Error).message);
    return 1;
  }
}
