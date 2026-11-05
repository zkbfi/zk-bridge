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
 *   sign <release-directory>                  reads the private key from standard input, writes version.json.sig
 *                                             and public-keys.json
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
import { pinAdapterFromEnvironment } from "./pin.ts";
import { promoteRelease } from "./promote.ts";
import { publicKeyOf, readPrivateKey, signManifest } from "./sign.ts";
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
  "       release sign <release-directory>   (private key on standard input)",
  "       release verify <release-directory> --public-keys <file>",
  "       release pin <release-directory> [--prefix <p>]",
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
      const manifest = await readManifestFile(join(directory, RELEASE_LAYOUT.manifest));
      const privateKey = await readPrivateKey(io.stdin);
      const signature = await signManifest({ manifest, privateKey });
      await writeFile(join(directory, RELEASE_LAYOUT.signature), signature);
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
