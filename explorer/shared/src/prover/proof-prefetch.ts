import { encodeAbiParameters, keccak256, numberToHex, zeroHash, type Address, type Hex, type PublicClient } from "viem";
import { beaconLightClientAbi } from "../abis/index.js";
import type { ProofCacheStore } from "./proof-cache.js";

/**
 * The proof prefetcher: it follows the head of a chain and, at each epoch boundary, fetches the `eth_getProof` answer that
 * the `opening-proof` command of the prover will need, while the block is still new enough for a node to serve it.
 *
 * Why: a node answers `eth_getProof` only inside its proof window (measured: about 64 blocks on a public Sepolia node,
 * 128 on a public PulseChain testnet v4 node; some providers refuse every historical depth). The opening proof needs the
 * answer at the execution block of the head that the other chain's light client stored. That head is a finalized
 * checkpoint, already about two epochs old when it is stored, so asking at opening time fails with "distance to target
 * block exceeds maximum proof window". The checkpoint blocks are known in advance: the block of the first slot of each
 * epoch, or, when that slot is empty, the latest block before it. The prefetcher fetches each one within a few blocks of
 * the tip and stores it in the proof cache (see `proof-cache.ts`), which the prover reads before it asks a node.
 *
 * What it asks is what opening.rs asks: the account of the remote light client, with one storage key, the slot of
 * `executionBlockHashes[head]`, where `head` is the light client's head in that same block.
 */

/** The storage slot of the mapping `executionBlockHashes` in `BeaconLightClient` (opening.rs, BeaconProofVerifier.sol). */
export const EXECUTION_BLOCK_HASHES_MAPPING_SLOT = 3n;

/** The slots of one epoch on every beacon chain that the bridge follows. */
export const SLOTS_PER_EPOCH = 32n;

/** The storage key of `executionBlockHashes[storedSlot]`: `keccak256(abi.encode(uint256(storedSlot), 3))`. */
export function openingStorageKey(storedSlot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [storedSlot, EXECUTION_BLOCK_HASHES_MAPPING_SLOT]));
}

/** The slot grid of a beacon chain. `slotsPerEpoch` defaults to 32. */
export interface BeaconClock {
  readonly genesisTime: bigint;
  readonly secondsPerSlot: bigint;
  readonly slotsPerEpoch?: bigint;
}

/** The slot of an execution block: `(timestamp - genesis) / secondsPerSlot`, and 0 at or before genesis. */
export function slotOfTimestamp(timestamp: bigint, clock: BeaconClock): bigint {
  return timestamp <= clock.genesisTime ? 0n : (timestamp - clock.genesisTime) / clock.secondsPerSlot;
}

/** An execution block, as far as the prefetcher needs it. */
export interface BlockStamp {
  readonly number: bigint;
  readonly hash: Hex;
  readonly timestamp: bigint;
}

/**
 * The checkpoint blocks between two consecutive blocks: for each epoch whose first slot lies after `previous` and at or
 * before `next`, the block at that slot (`next`, when it holds it) or else the latest block before it (`previous`).
 * When `next` holds the epoch's first slot, `previous` comes too: from the Gloas fork on, a beacon block commits to the
 * execution block of the slot before its own, so the head a light client stores for that checkpoint is `previous`.
 */
export function checkpointsBetween(previous: BlockStamp, next: BlockStamp, clock: BeaconClock): BlockStamp[] {
  const perEpoch = clock.slotsPerEpoch ?? SLOTS_PER_EPOCH;
  const previousSlot = slotOfTimestamp(previous.timestamp, clock);
  const nextSlot = slotOfTimestamp(next.timestamp, clock);
  const firstBoundary = (previousSlot / perEpoch + 1n) * perEpoch;
  const found: BlockStamp[] = [];
  const nextStartsEpoch = nextSlot % perEpoch === 0n && nextSlot >= firstBoundary;
  if (firstBoundary < nextSlot || nextStartsEpoch) found.push(previous);
  if (nextStartsEpoch) found.push(next);
  return found;
}

/** Keeps only the scheme and host of every URL in a text, so that no key in a path or query reaches a log. */
export function withoutUrls(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s"'<>()[\]{},]*)/gi, (_match, scheme: string, rest: string) => {
    const authority = rest.split(/[/?#]/)[0] as string;
    return `${scheme}${authority.slice(authority.lastIndexOf("@") + 1)}`;
  });
}

/** The reads of the prefetcher. {@link createViemPrefetchClient} builds one from a viem client. */
export interface ProofPrefetchClient {
  blockNumber(): Promise<bigint>;
  block(number: bigint): Promise<BlockStamp>;
  /** `head()` of the light client at `address`, in block `blockNumber`. */
  storedHead(address: Address, blockNumber: bigint): Promise<bigint>;
  /** The raw `eth_getProof` result, as the node sent it. */
  accountProof(address: Address, storageKeys: readonly Hex[], blockNumber: bigint): Promise<unknown>;
}

/** The prefetch client over a viem client. */
export function createViemPrefetchClient(client: Pick<PublicClient, "getBlockNumber" | "getBlock" | "readContract" | "request">): ProofPrefetchClient {
  return {
    blockNumber: () => client.getBlockNumber(),
    async block(number) {
      const block = await client.getBlock({ blockNumber: number });
      if (block.number === null || block.hash === null) throw new Error(`block ${number} has no number or hash`);
      return { number: block.number, hash: block.hash, timestamp: block.timestamp };
    },
    async storedHead(address, blockNumber) {
      return BigInt(await client.readContract({ address, abi: beaconLightClientAbi, functionName: "head", blockNumber }));
    },
    accountProof: (address, storageKeys, blockNumber) => client.request({ method: "eth_getProof", params: [address, [...storageKeys], numberToHex(blockNumber)] }),
  };
}

/** Where the prefetcher logs. A bot logger fits it. Fields never hold a URL. */
export interface ProofPrefetchLog {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Everything the prefetcher of one chain and one light client needs. */
export interface ProofPrefetcherDependencies {
  /** The chain that holds the light client, the remote chain of the opening proof. */
  readonly chainId: number;
  /** The light client whose account the opening proof opens (the remote light client of the bridge that opens). */
  readonly address: Address;
  readonly client: ProofPrefetchClient;
  readonly store: ProofCacheStore;
  /** The slot grid of the beacon chain of `chainId`. */
  readonly clock: () => Promise<BeaconClock>;
  /** Whether the bridge that needs the proof is open. Once true, the prefetcher stops for good. */
  readonly isOpen: () => Promise<boolean>;
  /** The block hashes of stored light-client heads, whose entries pruning keeps. Default: none. */
  readonly protectedBlockHashes?: () => Promise<readonly string[]>;
  readonly logger: ProofPrefetchLog;
  /** The newest entries to keep per chain and address. Default 256: over a day of epochs. */
  readonly keep?: number;
  /** How far behind the tip a block may be and still be fetched. Default 16, well inside every proof window measured. */
  readonly maximumDepth?: bigint;
  /** Tries for one checkpoint. Default 3. */
  readonly attempts?: number;
  /** The pause before the second try; each further try waits one more of it. Default 2 seconds. */
  readonly retryDelayMilliseconds?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

/** What one step did. */
export type ProofPrefetchStep =
  | { readonly kind: "stopped" }
  | { readonly kind: "failed" }
  | { readonly kind: "followed"; readonly tip: bigint; readonly checkpoints: number; readonly stored: number; readonly failed: number };

/** The prefetcher of one chain and light client. */
export interface ProofPrefetcher {
  /** Reads the new blocks since the last step and fetches the proof at each checkpoint among them. It never throws. */
  step(): Promise<ProofPrefetchStep>;
}

export const DEFAULT_PROOF_CACHE_KEEP = 256;
export const DEFAULT_PREFETCH_DEPTH = 16n;

function messageOf(error: unknown): string {
  return withoutUrls(error instanceof Error ? error.message : String(error));
}

/** Builds the prefetcher. Call `step` about once a slot. */
export function createProofPrefetcher(dependencies: ProofPrefetcherDependencies): ProofPrefetcher {
  const { chainId, address, client, store, logger } = dependencies;
  const keep = dependencies.keep ?? DEFAULT_PROOF_CACHE_KEEP;
  const maximumDepth = dependencies.maximumDepth ?? DEFAULT_PREFETCH_DEPTH;
  const attempts = dependencies.attempts ?? 3;
  const retryDelay = dependencies.retryDelayMilliseconds ?? 2_000;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  let last: BlockStamp | null = null;
  let stopped = false;

  /** The new blocks up to the tip, and the checkpoints among them. */
  async function follow(tip: bigint, clock: BeaconClock): Promise<BlockStamp[]> {
    const from = last === null ? tip : last.number + 1n > tip - maximumDepth ? last.number + 1n : tip - maximumDepth;
    let previous: BlockStamp | null = last !== null && from === last.number + 1n ? last : from > 0n ? await client.block(from - 1n) : null;
    const perEpoch = clock.slotsPerEpoch ?? SLOTS_PER_EPOCH;
    const checkpoints: BlockStamp[] = [];
    for (let number = from; number <= tip; number += 1n) {
      const current = await client.block(number);
      if (previous !== null) checkpoints.push(...checkpointsBetween(previous, current, clock));
      else if (slotOfTimestamp(current.timestamp, clock) % perEpoch === 0n) checkpoints.push(current);
      previous = current;
    }
    last = previous;
    return checkpoints;
  }

  /** Fetches and stores the answer at one checkpoint, with retries. True when it stored it. */
  async function fetchAt(block: BlockStamp): Promise<boolean> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const storedSlot = await client.storedHead(address, block.number);
        const key = openingStorageKey(storedSlot);
        const proof = await client.accountProof(address, [key], block.number);
        await store.write({
          schemaVersion: 1,
          chainId,
          blockNumber: Number(block.number),
          blockHash: block.hash,
          address,
          storedSlot: Number(storedSlot),
          storageKeys: [key],
          fetchedAt: new Date(now()).toISOString(),
          proof,
        });
        logger.info("proof_prefetched", { chainId, blockNumber: block.number, blockHash: block.hash, storedSlot, attempts: attempt });
        return true;
      } catch (error) {
        if (attempt >= attempts) {
          logger.warn("proof_prefetch_failed", { chainId, blockNumber: block.number, attempts: attempt, error: messageOf(error) });
          return false;
        }
        const wait = retryDelay * attempt;
        logger.info("proof_prefetch_retry", { chainId, blockNumber: block.number, attempt, retryAfterMilliseconds: wait, error: messageOf(error) });
        await sleep(wait);
      }
    }
  }

  async function prune(): Promise<void> {
    try {
      const protectedBlockHashes = (await dependencies.protectedBlockHashes?.()) ?? [];
      const removed = await store.prune({ chainId, address, keep, protectedBlockHashes });
      if (removed > 0) logger.info("proof_cache_pruned", { chainId, removed });
    } catch (error) {
      logger.warn("proof_cache_prune_failed", { chainId, error: messageOf(error) });
    }
  }

  return {
    async step() {
      if (stopped) return { kind: "stopped" };
      try {
        if (await dependencies.isOpen()) {
          stopped = true;
          logger.info("proof_prefetch_stopped", { chainId, reason: "deposits-open" });
          return { kind: "stopped" };
        }
        const tip = await client.blockNumber();
        if (last !== null && tip <= last.number) return { kind: "followed", tip: last.number, checkpoints: 0, stored: 0, failed: 0 };
        const checkpoints = await follow(tip, await dependencies.clock());
        let stored = 0;
        let failed = 0;
        for (const block of checkpoints) {
          if (await store.has({ chainId, address, blockNumber: block.number, blockHash: block.hash })) continue;
          if (await fetchAt(block)) stored += 1;
          else failed += 1;
        }
        if (stored > 0) await prune();
        return { kind: "followed", tip, checkpoints: checkpoints.length, stored, failed };
      } catch (error) {
        logger.warn("proof_prefetch_step_failed", { chainId, error: messageOf(error) });
        return { kind: "failed" };
      }
    },
  };
}

/**
 * The slot grid of the beacon chain that a light client tracks, read from the light client (`genesisTime`,
 * `secondsPerSlot`). The values are immutable, so one good read serves for good; a failed read is tried again next time.
 * The light client is the authority here: its stored heads are the checkpoints of exactly this grid.
 */
export function lightClientClock(client: Pick<PublicClient, "readContract">, lightClient: Address): () => Promise<BeaconClock> {
  let known: BeaconClock | null = null;
  return async () => {
    if (known !== null) return known;
    const [genesisTime, secondsPerSlot] = await Promise.all([
      client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "genesisTime" }),
      client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "secondsPerSlot" }),
    ]);
    known = { genesisTime: BigInt(genesisTime), secondsPerSlot: BigInt(secondsPerSlot) };
    return known;
  };
}

/**
 * The execution block hash of the head that a light client stored, as a list (empty while the entry is empty). The
 * opening proof needs the cache entry of exactly that block, so pruning keeps it.
 */
export function storedHeadBlockHashes(client: Pick<PublicClient, "readContract">, lightClient: Address): () => Promise<readonly Hex[]> {
  return async () => {
    const head = await client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "head" });
    const hash = await client.readContract({ address: lightClient, abi: beaconLightClientAbi, functionName: "executionBlockHashes", args: [head] });
    return hash === zeroHash ? [] : [hash];
  };
}
