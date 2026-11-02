import { zeroHash, type Address, type Hex, type PublicClient } from "viem";
import { z } from "zod";
import { beaconLightClientAbi } from "../abis/index.js";
import { proofCacheEntrySchema, type ProofCacheEntry, type ProofCacheKey, type ProofCacheStore } from "./proof-cache.js";
import { openingStorageKey, withoutUrls, type ProofPrefetchLog } from "./proof-prefetch.js";
import { hexQuantity, verifyAccountProof } from "./storage-proof-verify.js";

/**
 * The read side of the proof archive of the explorer indexer (explorer/indexer, `GET /api/proofs/storage/...`), and a
 * proof cache that asks the archive first.
 *
 * Owner, 2026-11-01: "seems like proofs is another thing that the indexer should be caching for us." The indexer keeps
 * every `eth_getProof` answer it fetched at an epoch boundary in a Postgres schema that outlives its releases. A runner
 * that needs an answer for an old block asks the archive first, its own proof cache second, and an RPC node last. The
 * archive is not trusted: an entry is used only when it proves exactly what was asked (`archivedEntryRefusal`).
 */

/**
 * An entry as the archive serves it: a proof cache entry whose fetch time the archive does not publish. The prover does
 * not read that time, so the local copy names its origin there instead.
 */
const archivedEntrySchema = proofCacheEntrySchema.extend({ fetchedAt: z.string().default("from the proof archive") });

/** The archive as the runner reads it. */
export interface ProofArchiveReader {
  /** The archived answers for one chain, address and block. Entries that do not parse are left out. */
  storageProofs(input: { readonly chainId: number; readonly address: string; readonly blockNumber: bigint }): Promise<ProofCacheEntry[]>;
}

/** The archive answered with an error. The message holds no URL. */
export class ProofArchiveError extends Error {
  override readonly name = "ProofArchiveError";
}

/** Input of {@link createProofArchiveClient}. */
export interface ProofArchiveClientInput {
  /** The base URL of the indexer, such as `http://127.0.0.1:42069`. */
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /** Default 10 seconds. */
  readonly timeoutMilliseconds?: number;
}

/** The archive client over `fetch`. A 404 means no entry. */
export function createProofArchiveClient(input: ProofArchiveClientInput): ProofArchiveReader {
  const doFetch = input.fetch ?? fetch;
  return {
    async storageProofs({ chainId, address, blockNumber }) {
      const path = `/api/proofs/storage/${chainId}/${address.toLowerCase()}/${blockNumber}`;
      const response = await doFetch(new URL(path, input.baseUrl), { signal: AbortSignal.timeout(input.timeoutMilliseconds ?? 10_000) });
      if (response.status === 404) return [];
      if (!response.ok) throw new ProofArchiveError(`the proof archive answered ${response.status}`);
      const body = (await response.json()) as { entries?: unknown };
      const entries = Array.isArray(body.entries) ? body.entries : [];
      return entries.flatMap((entry) => {
        const parsed = archivedEntrySchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      });
    },
  };
}

/** The header fields of a block that the check needs, read by its hash from a node the caller trusts for headers. */
export type BlockHeaderReader = (blockHash: Hex) => Promise<{ readonly number: bigint; readonly stateRoot: Hex }>;

/** What an archived entry must prove: the request, and the stored head of the light client when the caller knows it. */
export interface ExpectedOpeningEntry extends ProofCacheKey {
  /** `head()` of the light client at `address` in that block. Null when the caller cannot read it (a pruned node). */
  readonly storedSlot: bigint | null;
}

const lower = (value: string): string => value.toLowerCase();

/**
 * Checks an archived entry against what the caller asked for, never against what the entry says about itself: the
 * chain, the account, the block number and hash of the request; the stored slot of the light client when it is known;
 * the storage key of `executionBlockHashes[storedSlot]` (the rule of opening.rs and `openingStorageKey`), which must
 * hold a non-zero block hash; and the proof against the state root of the requested block, whose header must carry the
 * requested number.
 *
 * @returns null when the entry is good, else why it is refused.
 */
export async function archivedEntryRefusal(entry: ProofCacheEntry, expected: ExpectedOpeningEntry, readHeader: BlockHeaderReader): Promise<string | null> {
  if (entry.chainId !== expected.chainId) return "another chain";
  if (lower(entry.address) !== lower(expected.address)) return "another account";
  if (BigInt(entry.blockNumber) !== expected.blockNumber || lower(entry.blockHash) !== lower(expected.blockHash)) return "another block";
  if (expected.storedSlot !== null && BigInt(entry.storedSlot) !== expected.storedSlot) return "another stored slot";
  const storedSlot = expected.storedSlot ?? BigInt(entry.storedSlot);
  const requiredKey = openingStorageKey(storedSlot);
  if (!entry.storageKeys.some((key) => lower(key) === lower(requiredKey))) return "no proof of the stored slot's key";
  const header = await readHeader(expected.blockHash as Hex);
  if (header.number !== expected.blockNumber) return "the header of the block hash has another number";
  const verdict = verifyAccountProof({ stateRoot: header.stateRoot, address: expected.address as Address, storageKeys: [requiredKey], answer: entry.proof });
  if (!verdict.ok) return verdict.reason;
  // The answer parsed and proved the key above, so its entry for the key is there.
  const proven = (entry.proof as { storageProof: Array<{ key: Hex; value: Hex }> }).storageProof.find((item) => hexQuantity(item.key) === hexQuantity(requiredKey)) as { value: Hex };
  if (hexQuantity(proven.value) === 0n) return "the stored slot holds no block hash";
  return null;
}

/** Input of {@link createArchivedProofCacheStore}. */
export interface ArchivedProofCacheInput {
  readonly archive: ProofArchiveReader;
  /** The local proof cache, which the prover reads (`destination.proof_cache_dir`). */
  readonly local: ProofCacheStore;
  /** The header of a block by hash, for the check of an archived entry. */
  readonly readHeader: BlockHeaderReader;
  /** `head()` of the light client at the key's address in the key's block, or null when it cannot be read. */
  readonly storedSlot: (key: ProofCacheKey) => Promise<bigint | null>;
  readonly logger: ProofPrefetchLog;
}

/**
 * A proof cache that asks the archive first, the local cache second, and leaves the RPC to its caller (the prefetcher
 * fetches on a miss; the prover asks a node when the file is missing). An archived entry that verifies is copied into the
 * local cache, so the prover finds it. An archive that cannot be reached, or an entry that does not verify, counts as a
 * miss of the archive and is logged.
 */
export function createArchivedProofCacheStore(input: ArchivedProofCacheInput): ProofCacheStore {
  const { archive, local, logger } = input;

  /** The verified archived entry for the key, copied into the local cache, or null. */
  async function fromArchive(key: ProofCacheKey): Promise<ProofCacheEntry | null> {
    try {
      const entries = await archive.storageProofs(key);
      if (entries.length === 0) return null;
      const expected: ExpectedOpeningEntry = { ...key, storedSlot: await input.storedSlot(key) };
      for (const entry of entries) {
        const refusal = await archivedEntryRefusal(entry, expected, input.readHeader);
        if (refusal !== null) {
          logger.warn("proof_archive_entry_refused", { chainId: key.chainId, blockNumber: key.blockNumber, reason: refusal });
          continue;
        }
        if (!(await local.has(key))) await local.write(entry);
        logger.info("proof_archive_hit", { chainId: key.chainId, blockNumber: key.blockNumber });
        return entry;
      }
      return null;
    } catch (error) {
      logger.warn("proof_archive_unavailable", { chainId: key.chainId, blockNumber: key.blockNumber, error: withoutUrls((error as Error).message) });
      return null;
    }
  }

  return {
    async has(key) {
      return (await fromArchive(key)) !== null || local.has(key);
    },
    async read(key) {
      return (await fromArchive(key)) ?? local.read(key);
    },
    write: (entry) => local.write(entry),
    prune: (prune) => local.prune(prune),
  };
}

/**
 * The proof cache key that the next opening proof needs: the account of the remote light client (`remoteLightClient` on
 * chain `chainId`) in the execution block of the head that the light client at `lightClient` stored. Null while that
 * light client holds no block for its head. The opener reads it to fetch the entry from the archive before the prover
 * runs (opening.rs reads the same head).
 */
export function storedHeadCacheKey(
  client: Pick<PublicClient, "readContract">,
  lightClient: Address,
  remote: { readonly chainId: number; readonly lightClient: Address },
): () => Promise<ProofCacheKey | null> {
  return async () => {
    const head = await client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "head" });
    const blockHash = await client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "executionBlockHashes", args: [head] });
    if (blockHash === zeroHash) return null;
    const blockNumber = await client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "executionBlockNumber", args: [blockHash] });
    return { chainId: remote.chainId, address: remote.lightClient, blockNumber: BigInt(blockNumber), blockHash };
  };
}
