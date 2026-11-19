/**
 * The fork proof capture of this backend: the fork proof of the source block of every sent message, saved while a beacon
 * node still serves the state of that block, and kept for good.
 *
 * Owner, 2026-11-10: "yes, and save fork proofs in the watcher too". Every message proof carries `MessageProof.sourceFork`:
 * `fork.current_version` and `genesis_validators_root` proven under the state root of its source header, judged on chain
 * by `ForkShape.judge` (docs/audit/known-issues.md 1.22). The prover builds it from the state of the source block.
 * PulseChain beacon nodes prune old states and an Ethereum mainnet state is hundreds of MB, so a message left unproven for long
 * could become unprovable once no reachable node keeps that state. So, like the watcher, this capture reads the sent
 * messages of each direction from the chain indexer, and once a message's block is final it asks the prover for the fork
 * proof of that block (`zk-bridge-prover fork-proof`). Several messages in one block share one record, keyed by chain and
 * state root.
 *
 * The prover reads the record back at `GET /archive/fork-proofs/<chainId>/<stateRoot>.json` when no node serves the state
 * (`source.fork_proof_archive_urls`), the chain indexer copies it into the proof archive (`GET /archive/proofs`), and the
 * proof archive exports and publishes it (docs/proof-archive.md). A record is public chain data and nobody trusts it: the
 * prover checks it against the state root of the source header, and so does the bridge.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ProofDirection } from "@zk-bridge/shared";
import type { ForkProofProver, ForkProofRecord } from "@zk-bridge/shared/prover";
import type { JsonGet } from "../keepalive/sources.ts";
import type { Logger } from "../logger.ts";
import type { Storage } from "../storage.ts";
import { MAX_RETRY_MILLISECONDS, type StoreOutcome } from "./handoffs.ts";

/** How long the live route `GET /archive/proofs` lists a record; older ones reach the indexer through the nightly snapshot. */
export const LIVE_FORK_PROOF_MILLISECONDS = 7 * 86_400_000;

/**
 * The statuses whose messages need a record: older than the finality window and not delivered. A `sent` message is too
 * new (its block may not be final yet); a delivered one needs no proof any more.
 */
export const CAPTURED_STATUSES = "waiting_for_finality,covered";

/** The prover's answer for a block whose beacon block is not final yet (`zk-bridge-prover fork-proof`). */
const NOT_FINAL = /the beacon block of execution block \d+ is not final/;

/** The page size of the feed (the indexer allows up to 200) and the most pages one pass reads per direction. */
export const FEED_PAGE_SIZE = 200;
export const MAX_FEED_PAGES = 5;

/** Keeps a checked record. The first record of a state stays; a different one is refused as a conflict. */
export function storeForkProof(storage: Storage, record: ForkProofRecord, now: number): StoreOutcome {
  const sha256 = createHash("sha256").update(record.text).digest("hex");
  const stateRoot = record.stateRoot.toLowerCase();
  const existing = storage.database.prepare("SELECT sha256 FROM fork_proofs WHERE chain_id = ? AND state_root = ?").get(record.chainId, stateRoot) as { sha256: string } | undefined;
  if (existing !== undefined) return existing.sha256 === sha256 ? "known" : "conflict";
  storage.database
    .prepare(
      "INSERT INTO fork_proofs (chain_id, state_root, slot, block_root, execution_block_number, execution_block_hash, record, sha256, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(record.chainId, stateRoot, record.slot, record.blockRoot.toLowerCase(), record.executionBlockNumber, record.executionBlockHash.toLowerCase(), record.text, sha256, now);
  return "stored";
}

/** The record text of a state, or null. */
export function readForkProof(storage: Storage, chainId: number, stateRoot: string): string | null {
  const row = storage.database.prepare("SELECT record FROM fork_proofs WHERE chain_id = ? AND state_root = ?").get(chainId, stateRoot.toLowerCase()) as { record: string } | undefined;
  return row?.record ?? null;
}

/** Whether a record of the execution block is kept. */
export function hasForkProofOfBlock(storage: Storage, chainId: number, executionBlockNumber: number): boolean {
  return storage.database.prepare("SELECT 1 AS found FROM fork_proofs WHERE chain_id = ? AND execution_block_number = ?").get(chainId, executionBlockNumber) !== undefined;
}

/** The records stored at or after `since` (milliseconds), for the indexer's live poll. */
export function recentForkProofs(storage: Storage, since: number): Array<{ chainId: number; stateRoot: string; record: string; storedAt: number }> {
  type Row = { chain_id: number; state_root: string; record: string; stored_at: number };
  return (storage.database.prepare("SELECT chain_id, state_root, record, stored_at FROM fork_proofs WHERE stored_at >= ? ORDER BY chain_id, slot").all(since) as Row[]).map((row) => ({
    chainId: row.chain_id,
    stateRoot: row.state_root,
    record: row.record,
    storedAt: row.stored_at,
  }));
}

/** A sent message as the capture needs it: its transaction and the block that holds it. */
export type SentMessage = { readonly messageId: string; readonly transactionHash: `0x${string}`; readonly blockNumber: number };

const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const feedPageSchema = z.object({
  items: z.array(
    z
      .object({
        messageId: hash,
        sent: z.object({ transactionHash: hash, blockNumber: z.number().int().nonnegative() }).passthrough().nullable(),
      })
      .passthrough(),
  ),
  nextCursor: z.string().nullable().optional(),
});

/**
 * Reads the messages of a direction that need a record from the chain indexer's feed (`GET /api/feed`), newest first, at
 * most {@link MAX_FEED_PAGES} pages.
 *
 * @throws Error when the indexer fails or answers another shape.
 */
export function sentMessagesReader(input: { readonly indexerUrl: string; readonly sourceChainId: number; readonly destinationChainId: number; readonly get: JsonGet }): () => Promise<readonly SentMessage[]> {
  const base = input.indexerUrl.replace(/\/+$/, "");
  return async () => {
    const messages: SentMessage[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_FEED_PAGES; page += 1) {
      const query = new URLSearchParams({ direction: `${input.sourceChainId}>${input.destinationChainId}`, status: CAPTURED_STATUSES, limit: String(FEED_PAGE_SIZE) });
      if (cursor !== null) query.set("cursor", cursor);
      const answer = await input.get(`${base}/api/feed?${query}`);
      if (answer.status !== 200) throw new Error(`the chain indexer answered ${answer.status} for the feed`);
      const parsed = feedPageSchema.safeParse(answer.body);
      if (!parsed.success) throw new Error("the chain indexer sent the feed in an unknown shape");
      for (const item of parsed.data.items) {
        if (item.sent !== null) messages.push({ messageId: item.messageId, transactionHash: item.sent.transactionHash as `0x${string}`, blockNumber: item.sent.blockNumber });
      }
      cursor = parsed.data.nextCursor ?? null;
      if (cursor === null) break;
    }
    return messages;
  };
}

/** One source chain the capture follows: the direction whose route has it as source, and its sent messages. */
export type ForkCaptureTarget = {
  readonly direction: ProofDirection;
  readonly chainId: number;
  readonly readMessages: () => Promise<readonly SentMessage[]>;
};

/** The fork proof capture. */
export interface ForkProofCapture {
  /** Tries every block of a listed message that has no record and is due for a try. */
  runOnce(): Promise<void>;
  /** Resolves when no pass runs. */
  settled(): Promise<void>;
  /** Counts for `GET /health`. */
  status(): { readonly kept: number; readonly failing: number };
}

/**
 * Builds the capture. Each pass reads the listed messages of each target and asks the prover, one block at a time, for
 * the record of each block that has none. A failed block waits before its next try: the pass interval, doubled with each
 * failure, at most six hours (as the handoff capture).
 */
export function createForkProofCapture(input: {
  readonly storage: Storage;
  readonly prover: ForkProofProver;
  readonly targets: readonly ForkCaptureTarget[];
  readonly intervalMilliseconds: number;
  readonly logger: Logger;
  /** Milliseconds since 1970. */
  readonly now: () => number;
}): ForkProofCapture {
  const { storage, logger, now } = input;
  const failures = new Map<string, { count: number; nextAt: number }>();
  let running: Promise<void> | null = null;

  async function capture(target: ForkCaptureTarget, message: SentMessage): Promise<void> {
    const key = `${target.chainId}:${message.blockNumber}`;
    const failure = failures.get(key);
    if (failure !== undefined && now() < failure.nextAt) return;
    try {
      const record = await input.prover.forkProof({ direction: target.direction, transactionHash: message.transactionHash, chainId: target.chainId });
      if (record.executionBlockNumber !== message.blockNumber) throw new Error(`the prover gave the record of block ${record.executionBlockNumber}, not ${message.blockNumber}`);
      const outcome = storeForkProof(storage, record, now());
      failures.delete(key);
      if (outcome === "conflict") logger.warn("fork_proof_capture_conflict", { chainId: target.chainId, stateRoot: record.stateRoot });
      else logger.info("fork_proof_captured", { chainId: target.chainId, blockNumber: message.blockNumber, slot: record.slot, stateRoot: record.stateRoot, shape: record.shape });
    } catch (error) {
      if (NOT_FINAL.test(String(error))) {
        // The indexer lists a message once its finality window has passed, which can be a little before its beacon block
        // is final. That is a wait, not a failure: no backoff, not counted, asked again on the next pass.
        failures.delete(key);
        logger.info("fork_proof_capture_not_final", { chainId: target.chainId, blockNumber: message.blockNumber, messageId: message.messageId, retryInSeconds: Math.round(input.intervalMilliseconds / 1000) });
        return;
      }
      const count = (failure?.count ?? 0) + 1;
      const wait = Math.min(MAX_RETRY_MILLISECONDS, input.intervalMilliseconds * 2 ** (count - 1));
      failures.set(key, { count, nextAt: now() + wait });
      logger.warn("fork_proof_capture_failed", { chainId: target.chainId, blockNumber: message.blockNumber, messageId: message.messageId, attempts: count, retryInSeconds: Math.round(wait / 1000), error });
    }
  }

  async function pass(): Promise<void> {
    for (const target of input.targets) {
      let messages: readonly SentMessage[];
      try {
        messages = await target.readMessages();
      } catch (error) {
        logger.warn("fork_proof_capture_read_failed", { chainId: target.chainId, error });
        continue;
      }
      const blocks = new Map<number, SentMessage>();
      for (const message of messages) if (!blocks.has(message.blockNumber)) blocks.set(message.blockNumber, message);
      // Oldest first: the state of an older block is the first that a node prunes.
      for (const message of [...blocks.values()].sort((left, right) => left.blockNumber - right.blockNumber)) {
        if (!hasForkProofOfBlock(storage, target.chainId, message.blockNumber)) await capture(target, message);
      }
    }
  }

  return {
    async runOnce() {
      if (running !== null) return running;
      running = pass().finally(() => {
        running = null;
      });
      return running;
    },
    async settled() {
      await running;
    },
    status() {
      const kept = (storage.database.prepare("SELECT COUNT(*) AS count FROM fork_proofs").get() as { count: number }).count;
      return { kept, failing: failures.size };
    },
  };
}
