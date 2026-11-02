import { join } from "node:path";
import pg from "pg";
import { BlockNotFoundError, createPublicClient, http, type Hex } from "viem";
import { DEFAULT_PAIR_NAME, rpcVariableName } from "@zk-bridge/shared";
import { withoutUrls } from "@zk-bridge/shared/prover";
import { ingestBackendRows, readBackendSnapshot } from "./backend-rows";
import { checkManifest, exportArchive, importArchive, ingestCache, recordsOf, verifyStorageProofs, writeManifest, type BlockRootReader } from "./bundle";
import { addToMirror, checkMirror, manifestText, importMirror, mirrorRecords, pruneMirror, stageNewestStates, writeMirrorManifest, writeMirrorRecords } from "./mirror";
import { checkPublicTree, exportPublicTree } from "./public";
import { poolExecutor, type ArchiveEnvironment } from "./runtime";
import { createProofArchive, type ProofArchive } from "./store";

/**
 * `zk-bridge-proof-archive`: the commands that deploy/app-server/proofs.sh runs to move the proof archive into and out
 * of databases. Each prints one JSON object on standard output and logs nothing else there; endpoints are never printed.
 *
 * Exit codes: 0 done, 1 failed, 2 usage, 3 done but with conflicts (import, ingest) or bad proofs (verify-storage,
 * public-check). See docs/proof-archive.md.
 */

export const USAGE = `usage: zk-bridge-proof-archive <command> [options]
  migrate                               create or upgrade the proof_archive schema
  export --out <bundle>                 write <bundle>/archive/*.ndjson from the archive
  import --in <bundle>                  upsert <bundle>/archive/*.ndjson into the archive (conflicts: exit 3)
  ingest-backend --sqlite <file>        upsert the proofs and evidence of a backend SQLite snapshot
  ingest-cache --dir <proof cache>      upsert the entries of a runner proof cache
  manifest-write --dir <bundle> --commit <sha> [--ipfs-log <file>] [--public]
  manifest-check --dir <bundle>         re-hash the files of a bundle (mismatch: exit 1)
  verify-storage --in <bundle> | --mirror <dir>   verify storage proofs against block state roots (bad: exit 3)
  public-export --out <dir> [--in <bundle> | --mirror <dir>]   the public tree, from the archive, a bundle or the mirror
  public-check --dir <dir>              the sanitizer of a public tree (problem: exit 3)
  mirror-write --dir <mirror>           write each archive row as a record file, once (other content there: exit 3)
  mirror-add --dir <mirror> --from <dir> --to beacon-states|snapshots   copy files in, once (other content: exit 3)
  mirror-prune --dir <mirror> --days <n> [--held <dir>[,<dir>]]   drop beacon states, snapshots, manifests older than n days
  mirror-manifest --dir <mirror> --stamp <YYYYMMDDTHHMMSSZ> --commit <sha> --days <n> [--ipfs-log <file>] [--print]
                                        (--print: the manifest's bytes on standard output instead of a summary)
  mirror-check --dir <mirror> [--exact] [--manifest <name>]   against the newest (or the named) manifest
                                        (bad: exit 1; --exact: unlisted files too)
  mirror-import --dir <mirror>          upsert every record file (conflicts: exit 3)
  mirror-states --dir <mirror> --out <dir> [--newest <n>]   stage the newest n (16) beacon states of each chain
Environment: DATABASE_URL (archive commands), EXPLORER_PAIR, EXPLORER_RPC_URL_<chain id> (verify-storage).`;

/** What the commands reach outside: the database, the block headers, the clock, the output. */
export interface CliDependencies {
  /** Opens the archive (migrated) and the function that closes its connection. */
  readonly openArchive: (environment: ArchiveEnvironment) => Promise<{ archive: ProofArchive; close: () => Promise<void> }>;
  readonly stateRoot: (environment: ArchiveEnvironment) => BlockRootReader;
  readonly now: () => Date;
  readonly print: (text: string) => void;
  readonly log: (text: string) => void;
}

/** The archive over a `pg` pool on `DATABASE_URL`. */
export async function openPoolArchive(
  environment: ArchiveEnvironment,
  makePool: (url: string) => Pick<pg.Pool, "query" | "end"> = (url) => new pg.Pool({ connectionString: url, max: 2 }),
): Promise<{ archive: ProofArchive; close: () => Promise<void> }> {
  const url = environment.DATABASE_URL;
  if (url === undefined || url === "") throw new Error("DATABASE_URL is not set");
  const pool = makePool(url);
  const archive = createProofArchive(poolExecutor(pool));
  try {
    await archive.migrate();
  } catch (error) {
    await pool.end();
    throw error;
  }
  return { archive, close: () => pool.end() };
}

/** State roots from `EXPLORER_RPC_URL_<chain id>`: null for a block the node does not know; throws without an endpoint. */
export function rpcStateRoot(environment: ArchiveEnvironment, makeClient = (url: string) => createPublicClient({ transport: http(url) })): BlockRootReader {
  const clients = new Map<number, ReturnType<typeof makeClient>>();
  return async (chainId, blockHash) => {
    const url = environment[rpcVariableName(chainId)];
    if (url === undefined || url === "") throw new Error(`no ${rpcVariableName(chainId)}`);
    const client = clients.get(chainId) ?? makeClient(url);
    clients.set(chainId, client);
    try {
      return (await client.getBlock({ blockHash })).stateRoot as Hex;
    } catch (error) {
      if (error instanceof BlockNotFoundError) return null;
      throw error;
    }
  };
}

export const defaultDependencies: CliDependencies = {
  openArchive: openPoolArchive,
  stateRoot: (environment) => rpcStateRoot(environment),
  now: () => new Date(),
  print: (text) => process.stdout.write(`${text}\n`),
  log: (text) => process.stderr.write(`${text}\n`),
};

class UsageError extends Error {}

/** `--name value` options. A flag without a value (`--public`) is "true". */
export function parseOptions(words: readonly string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    if (!word.startsWith("--")) throw new UsageError(`unexpected argument ${word}`);
    const next = words[index + 1];
    if (next === undefined || next.startsWith("--")) options[word.slice(2)] = "true";
    else {
      options[word.slice(2)] = next;
      index += 1;
    }
  }
  return options;
}

const required = (options: Record<string, string>, name: string): string => {
  const value = options[name];
  if (value === undefined || value === "true") throw new UsageError(`--${name} is required`);
  return value;
};

/** A positive whole number option. */
const days = (options: Record<string, string>, name: string): number => {
  const value = required(options, name);
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new UsageError(`--${name} must be a positive number`);
  return Number(value);
};

const ARCHIVE_COMMANDS = new Set(["migrate", "export", "import", "ingest-backend", "ingest-cache", "mirror-write", "mirror-import"]);

/** Runs one command. Returns the exit code. */
export async function main(argv: readonly string[], environment: ArchiveEnvironment, dependencies: CliDependencies = defaultDependencies): Promise<number> {
  const [command, ...rest] = argv;
  // Every value printed is a record of strings and numbers: the archive keeps big numbers as decimal text.
  const print = (value: unknown) => dependencies.print(JSON.stringify(value));
  let opened: { archive: ProofArchive; close: () => Promise<void> } | null = null;
  try {
    if (command === undefined || command === "--help" || command === "help") {
      dependencies.log(USAGE);
      return command === undefined ? 2 : 0;
    }
    const options = parseOptions(rest);
    if (ARCHIVE_COMMANDS.has(command)) opened = await dependencies.openArchive(environment);
    const archive = opened?.archive as ProofArchive;
    switch (command) {
      case "migrate":
        print({ migrated: true, counts: await archive.counts() });
        return 0;
      case "export":
        print({ exported: await exportArchive(archive, required(options, "out")) });
        return 0;
      case "import": {
        const tables = await importArchive(archive, required(options, "in"));
        const conflicts = Object.values(tables).reduce((sum, tally) => sum + tally.conflict, 0);
        print({ imported: tables, conflicts, counts: await archive.counts() });
        return conflicts > 0 ? 3 : 0;
      }
      case "ingest-backend": {
        const { rows, skipped } = readBackendSnapshot(required(options, "sqlite"));
        const tally = await ingestBackendRows(archive, environment.EXPLORER_PAIR ?? DEFAULT_PAIR_NAME, rows);
        print({ ingested: tally, skipped, rows: { board: rows.board.length, held: rows.held.length, evidence: rows.evidence.length } });
        return tally.conflict > 0 ? 3 : 0;
      }
      case "ingest-cache": {
        const tally = await ingestCache(archive, required(options, "dir"));
        print({ ingested: tally });
        return tally.conflict > 0 ? 3 : 0;
      }
      case "manifest-write": {
        const manifest = await writeManifest(required(options, "dir"), {
          commit: required(options, "commit"),
          now: dependencies.now,
          ipfsLog: options["ipfs-log"],
          public: options.public === "true",
        });
        print({ files: Object.keys(manifest.files).length, counts: manifest.counts });
        return 0;
      }
      case "manifest-check": {
        const check = await checkManifest(required(options, "dir"));
        print(check);
        return check.missing.length + check.changed.length + check.unlisted.length > 0 ? 1 : 0;
      }
      case "verify-storage": {
        const mirror = options.mirror;
        const records = mirror === undefined ? recordsOf(join(required(options, "in"), "archive", "storage_proofs.ndjson")) : mirrorRecords(mirror, "storage-proofs");
        const result = await verifyStorageProofs(records, dependencies.stateRoot(environment));
        print({ verified: result.verified, invalid: result.invalid, unchecked: result.unchecked.map((item) => ({ ...item, reason: withoutUrls(item.reason) })) });
        return result.invalid.length > 0 ? 3 : 0;
      }
      case "public-export": {
        const out = required(options, "out");
        const { in: bundle, mirror } = options;
        if (bundle === undefined && mirror === undefined) opened = await dependencies.openArchive(environment);
        const source =
          mirror !== undefined ? ({ kind: "mirror", mirror } as const) : bundle !== undefined ? ({ kind: "bundle", bundle } as const) : ({ kind: "archive", archive: (opened as { archive: ProofArchive }).archive } as const);
        const counts = await exportPublicTree(source, out);
        print({ public: counts, out });
        return 0;
      }
      case "public-check": {
        const problems = await checkPublicTree(required(options, "dir"));
        print({ problems });
        return problems.length > 0 ? 3 : 0;
      }
      case "mirror-write": {
        const result = await writeMirrorRecords(archive, required(options, "dir"));
        for (const path of result.conflicts) dependencies.log(`ERROR: ${path} exists with other content; it was not rewritten`);
        print({ written: result.written, identical: result.identical, conflicts: result.conflicts.length });
        return result.conflicts.length > 0 ? 3 : 0;
      }
      case "mirror-add": {
        const result = await addToMirror(required(options, "dir"), required(options, "from"), required(options, "to"));
        for (const path of result.conflicts) dependencies.log(`ERROR: ${path} exists with other content; it was not rewritten`);
        print({ added: result.added, identical: result.identical, skipped: result.skipped, conflicts: result.conflicts.length });
        return result.conflicts.length > 0 ? 3 : 0;
      }
      case "mirror-prune": {
        const held = options.held === undefined ? [] : options.held.split(",");
        const result = await pruneMirror(required(options, "dir"), { days: days(options, "days"), now: dependencies.now(), held });
        for (const path of result.undated) dependencies.log(`kept ${path}: its time is unknown`);
        for (const name of result.heldMissing) dependencies.log(`WARNING: the services hold the beacon state ${name}, and the mirror does not`);
        print({ deleted: result.deleted, kept: result.kept, undated: result.undated.length, heldMissing: result.heldMissing.length, heldExpired: result.heldExpired });
        return 0;
      }
      case "mirror-manifest": {
        const stamp = required(options, "stamp");
        const manifest = await writeMirrorManifest(required(options, "dir"), {
          stamp,
          commit: required(options, "commit"),
          now: dependencies.now,
          ipfsLog: options["ipfs-log"],
          retentionDays: days(options, "days"),
        });
        // --print: the manifest's own bytes, for root to keep a copy of what was written (print adds the final newline).
        if (options.print === "true") dependencies.print(manifestText(manifest).slice(0, -1));
        else print({ manifest: `manifests/${stamp}.json`, files: Object.keys(manifest.files).length, counts: manifest.counts });
        return 0;
      }
      case "mirror-check": {
        const check = await checkMirror(required(options, "dir"), options.manifest);
        print(check);
        const bad = check.missing.length + check.changed.length + check.misnamed.length + (options.exact === "true" ? check.unlisted.length : 0);
        return bad > 0 ? 1 : 0;
      }
      case "mirror-import": {
        const tables = await importMirror(archive, required(options, "dir"));
        const conflicts = Object.values(tables).reduce((sum, tally) => sum + tally.conflict, 0);
        print({ imported: tables, conflicts, counts: await archive.counts() });
        return conflicts > 0 ? 3 : 0;
      }
      case "mirror-states":
        print(await stageNewestStates(required(options, "dir"), required(options, "out"), options.newest === undefined ? 16 : days(options, "newest")));
        return 0;
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      dependencies.log(`${error.message}\n${USAGE}`);
      return 2;
    }
    dependencies.log(withoutUrls(`zk-bridge-proof-archive: ${(error as Error).message}`));
    return 1;
  } finally {
    await opened?.close();
  }
}
