import { createPublicClient, http, type Address, type PublicClient } from "viem";
import type { Pair, PairSide } from "@zk-bridge/shared";
import {
  createProofPrefetcher,
  createViemPrefetchClient,
  lightClientClock,
  withoutUrls,
  type ProofCacheStore,
  type ProofPrefetcher,
} from "@zk-bridge/shared/prover";
import { backendRowsSchema, ingestBackendRows } from "./backend-rows";
import { logArchive, proofArchive, proofArchiveEnabled, type ArchiveEnvironment } from "./runtime";
import type { ProofArchive } from "./store";

/**
 * The archiver: the part of the archive that runs beside the indexing, in the indexer process.
 *
 * Storage proofs. For each side of the pair it follows the tip and, at each epoch boundary, fetches the `eth_getProof`
 * answer that an opening proof of the bridge on the other side needs (the light client on this side, with the storage
 * key of the head it holds in that block), within a few blocks of the tip, while a node still serves it. It reuses the
 * prefetcher of the runner (`proof-prefetch.ts`) over a store that writes into the archive. It never looks back further
 * than the prefetcher's depth: a block that is already too old is skipped, never retried, and never holds back the
 * indexing, which runs apart from it. Unlike the runner it does not stop once a bridge is open: every answer stays useful
 * evidence, and costs one RPC call an epoch.
 *
 * Held proofs. When `PROOF_ARCHIVE_BACKEND_URL` names the backend, it reads `GET /archive/proofs` every few minutes and
 * takes the proofs and evidence the backend holds (`backend-rows.ts`).
 */

/** The proof archive as a proof cache store: the prefetcher asks it before it fetches and writes what it fetched. */
export function archiveStore(archive: ProofArchive, sourceHost: string | null): ProofCacheStore {
  const find = async (key: Parameters<ProofCacheStore["has"]>[0]) =>
    (await archive.storageProofsAt(key)).find((entry) => entry.blockHash.toLowerCase() === key.blockHash.toLowerCase()) ?? null;
  return {
    has: async (key) => (await find(key)) !== null,
    async read(key) {
      const found = await find(key);
      if (found === null) return null;
      const { sourceHost: _host, ...entry } = found;
      return entry;
    },
    async write(entry) {
      const outcome = await archive.putStorageProof({ ...entry, sourceHost });
      if (outcome === "conflict") logArchive("warn", "proof_archive_conflict", { table: "storage_proofs", chainId: entry.chainId, blockNumber: entry.blockNumber });
    },
    // The archive never deletes.
    prune: async () => 0,
  };
}

/** The host of an endpoint: what the archive records as the source of an answer. Never the path or a key. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Everything the archiver needs. */
export interface ArchiverDependencies {
  readonly pair: Pair;
  readonly archive: ProofArchive;
  /** The viem client of a side. */
  readonly clientOf: (side: PairSide) => Pick<PublicClient, "getBlockNumber" | "getBlock" | "readContract" | "request">;
  /** The backend base URL, or null for none. */
  readonly backendUrl: string | null;
  readonly fetch?: typeof fetch;
  /** Between two prefetch steps. Default 12 seconds, one slot. */
  readonly prefetchIntervalMilliseconds?: number;
  /** Between two reads of the backend. Default 5 minutes. */
  readonly backendIntervalMilliseconds?: number;
}

/** The parts of the archiver, for a test to step by hand. */
export interface Archiver {
  readonly prefetchers: readonly ProofPrefetcher[];
  /** Reads the backend once. Never throws. */
  pollBackend(): Promise<void>;
  /** Starts the timers. Returns the function that stops them. */
  start(): () => void;
}

/** Builds the archiver. */
export function createArchiver(dependencies: ArchiverDependencies): Archiver {
  const { pair, archive } = dependencies;
  const doFetch = dependencies.fetch ?? fetch;
  const logger = {
    info: (event: string, fields?: Readonly<Record<string, unknown>>) => logArchive("info", event, fields),
    warn: (event: string, fields?: Readonly<Record<string, unknown>>) => logArchive("warn", event, fields),
  };
  const prefetchers = pair.sides.map((side, index) => {
    const other = pair.sides[1 - index] as PairSide;
    return createProofPrefetcher({
      chainId: side.chainId,
      address: side.contracts.lightClient as Address,
      client: createViemPrefetchClient(dependencies.clientOf(side)),
      store: archiveStore(archive, hostOf(side.rpcUrl)),
      // The light client on the other side tracks the beacon chain of this side: its stored heads are on that grid.
      clock: lightClientClock(dependencies.clientOf(other), other.contracts.lightClient as Address),
      isOpen: async () => false,
      logger,
    });
  });

  async function pollBackend(): Promise<void> {
    if (dependencies.backendUrl === null) return;
    try {
      const response = await doFetch(new URL("/archive/proofs", dependencies.backendUrl), { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`the backend answered ${response.status}`);
      const rows = backendRowsSchema.parse(await response.json());
      const tally = await ingestBackendRows(archive, pair.name, rows);
      if (tally.inserted + tally.merged + tally.conflict + tally.invalid > 0) logger.info("proof_archive_backend_ingested", tally);
    } catch (error) {
      logger.warn("proof_archive_backend_failed", { error: withoutUrls((error as Error).message) });
    }
  }

  return {
    prefetchers,
    pollBackend,
    start() {
      const timers: NodeJS.Timeout[] = [];
      const every = (milliseconds: number, step: () => Promise<unknown>) => {
        let busy = false;
        const tick = () => {
          if (busy) return;
          busy = true;
          void step().finally(() => {
            busy = false;
          });
        };
        tick();
        const timer = setInterval(tick, milliseconds);
        timer.unref();
        timers.push(timer);
      };
      for (const prefetcher of prefetchers) every(dependencies.prefetchIntervalMilliseconds ?? 12_000, () => prefetcher.step());
      every(dependencies.backendIntervalMilliseconds ?? 300_000, pollBackend);
      return () => timers.forEach((timer) => clearInterval(timer));
    },
  };
}

/**
 * Starts the archiver of this process when the archive is on. The archive opens in the background, so the API starts
 * at once; a database that is not reachable yet is tried again a minute later.
 */
export function startArchiverFromEnvironment(pair: Pair, environment: ArchiveEnvironment = process.env, open: () => Promise<ProofArchive | null> = () => proofArchive(environment)): Promise<(() => void) | null> {
  if (!proofArchiveEnabled(environment)) return Promise.resolve(null);
  const attempt = async (): Promise<(() => void) | null> => {
    const archive = await open();
    if (archive === null) {
      await new Promise((resolve) => setTimeout(resolve, 60_000).unref());
      return attempt();
    }
    const clients = new Map<number, PublicClient>();
    const archiver = createArchiver({
      pair,
      archive,
      clientOf: (side) => {
        const known = clients.get(side.chainId) ?? createPublicClient({ transport: http(side.rpcUrl) });
        clients.set(side.chainId, known);
        return known;
      },
      backendUrl: environment.PROOF_ARCHIVE_BACKEND_URL ?? null,
    });
    logArchive("info", "proof_archiver_started", { chains: pair.sides.map((side) => side.chainId), backend: environment.PROOF_ARCHIVE_BACKEND_URL === undefined ? "off" : hostOf(environment.PROOF_ARCHIVE_BACKEND_URL) });
    return archiver.start();
  };
  return attempt();
}
