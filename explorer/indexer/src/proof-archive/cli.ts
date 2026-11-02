import pg from "pg";
import { BlockNotFoundError, createPublicClient, http, type Hex } from "viem";
import { DEFAULT_PAIR_NAME, rpcVariableName } from "@zk-bridge/shared";
import { withoutUrls } from "@zk-bridge/shared/prover";
import { ingestBackendRows, readBackendSnapshot } from "./backend-rows";
import { checkManifest, exportArchive, importArchive, ingestCache, verifyStorageProofs, writeManifest, type BlockRootReader } from "./bundle";
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
  verify-storage --in <bundle>          verify the storage proofs of a bundle against block state roots (bad: exit 3)
  public-export --out <dir> [--in <bundle>]   write the public tree, from the archive or from a bundle
  public-check --dir <dir>              the sanitizer of a public tree (problem: exit 3)
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

const ARCHIVE_COMMANDS = new Set(["migrate", "export", "import", "ingest-backend", "ingest-cache"]);

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
        const result = await verifyStorageProofs(required(options, "in"), dependencies.stateRoot(environment));
        print({ verified: result.verified, invalid: result.invalid, unchecked: result.unchecked.map((item) => ({ ...item, reason: withoutUrls(item.reason) })) });
        return result.invalid.length > 0 ? 3 : 0;
      }
      case "public-export": {
        const out = required(options, "out");
        const bundle = options.in;
        if (bundle === undefined) opened = await dependencies.openArchive(environment);
        const counts = await exportPublicTree(bundle === undefined ? { kind: "archive", archive: (opened as { archive: ProofArchive }).archive } : { kind: "bundle", bundle }, out);
        print({ public: counts, out });
        return 0;
      }
      case "public-check": {
        const problems = await checkPublicTree(required(options, "dir"));
        print({ problems });
        return problems.length > 0 ? 3 : 0;
      }
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
