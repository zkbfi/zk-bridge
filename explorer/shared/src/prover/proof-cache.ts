import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * The proof cache: `eth_getProof` answers fetched near the tip of a chain, while a node still serves them, for the
 * `opening-proof` command of the prover to read later (`destination.proof_cache_dir`, prover/src/proof_cache.rs).
 *
 * One file per chain, address and block: `<directory>/<chain id>/<address>/<block number>-<block hash>.json`, address and
 * hash in lower case hex. The file holds the answer exactly as the node sent it, with what it proves. The cache is public
 * data and is not trusted: the prover verifies a cached answer against the state root of the header like a live one.
 */

/** The version of the entry layout. The prover reads only this version. */
export const PROOF_CACHE_SCHEMA_VERSION = 1;

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);

/** One cached answer. */
export const proofCacheEntrySchema = z.object({
  schemaVersion: z.literal(PROOF_CACHE_SCHEMA_VERSION),
  chainId: z.number().int().positive(),
  blockNumber: z.number().int().nonnegative(),
  blockHash: hex,
  /** The account that the answer proves, in lower case hex. */
  address: hex,
  /** The slot of the light client whose `executionBlockHashes` entry the storage key opens. */
  storedSlot: z.number().int().nonnegative(),
  storageKeys: z.array(hex),
  /** When the answer was fetched, as an ISO time. */
  fetchedAt: z.string(),
  /** The `eth_getProof` result, as the node sent it. */
  proof: z.unknown(),
});

/** One cached answer. */
export type ProofCacheEntry = z.infer<typeof proofCacheEntrySchema>;

/** What names an entry. */
export interface ProofCacheKey {
  readonly chainId: number;
  readonly address: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
}

/** What {@link ProofCacheStore.prune} keeps. */
export interface ProofCachePrune {
  readonly chainId: number;
  readonly address: string;
  /** The newest entries (by block number) to keep. */
  readonly keep: number;
  /** Entries for these block hashes stay whatever their age, such as the block of a stored light-client head. */
  readonly protectedBlockHashes: readonly string[];
}

/** The proof cache on disk. */
export interface ProofCacheStore {
  has(key: ProofCacheKey): Promise<boolean>;
  /** The entry, or null when there is none or the file is not an entry. */
  read(key: ProofCacheKey): Promise<ProofCacheEntry | null>;
  /** Writes the entry through a temporary file and a rename, so a reader never sees half a file. */
  write(entry: ProofCacheEntry): Promise<void>;
  /** Removes the entries of one chain and address beyond `keep`, except the protected ones. Returns how many it removed. */
  prune(input: ProofCachePrune): Promise<number>;
}

const ENTRY_NAME = /^(\d+)-(0x[0-9a-f]{64})\.json$/;

function folderOf(directory: string, chainId: number, address: string): string {
  return join(directory, String(chainId), address.toLowerCase());
}

/** The file of an entry, as the prover reads it. */
export function proofCachePath(directory: string, key: ProofCacheKey): string {
  return join(folderOf(directory, key.chainId, key.address), `${key.blockNumber}-${key.blockHash.toLowerCase()}.json`);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * The proof cache in `directory`. It creates folders as it writes.
 *
 * @param directory The root of the cache, such as `<state directory>/proof-cache`.
 */
export function createProofCacheStore(directory: string): ProofCacheStore {
  let sequence = 0;
  return {
    async has(key) {
      try {
        await stat(proofCachePath(directory, key));
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    async read(key) {
      let text: string;
      try {
        text = await readFile(proofCachePath(directory, key), "utf8");
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      try {
        const parsed = proofCacheEntrySchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    async write(entry) {
      const value = { ...entry, address: entry.address.toLowerCase() };
      const path = proofCachePath(directory, { ...value, blockNumber: BigInt(value.blockNumber) });
      await mkdir(folderOf(directory, value.chainId, value.address), { recursive: true });
      sequence += 1;
      const temporary = `${path}.${process.pid}.${sequence}.tmp`;
      await writeFile(temporary, JSON.stringify(value));
      await rename(temporary, path);
    },
    async prune(input) {
      const folder = folderOf(directory, input.chainId, input.address);
      let names: string[];
      try {
        names = await readdir(folder);
      } catch (error) {
        if (isMissing(error)) return 0;
        throw error;
      }
      const protectedHashes = new Set(input.protectedBlockHashes.map((hash) => hash.toLowerCase()));
      const entries = names
        .map((name) => ({ name, match: ENTRY_NAME.exec(name) }))
        .filter((item): item is { name: string; match: RegExpExecArray } => item.match !== null)
        .map(({ name, match }) => ({ name, blockNumber: Number(match[1]), blockHash: match[2] as string }))
        .sort((left, right) => right.blockNumber - left.blockNumber);
      const doomed = entries.slice(input.keep).filter((item) => !protectedHashes.has(item.blockHash));
      for (const item of doomed) await rm(join(folder, item.name), { force: true });
      return doomed.length;
    },
  };
}
