import { PAIR_DEFINITIONS, PROOF_DIRECTIONS, type ProofDirection } from "@zk-bridge/shared";
import type { ProverBinary } from "@zk-bridge/shared/prover";
import type { Logger } from "../logger.ts";
import type { Storage } from "../storage.ts";
import type { ReceiptIndexReader } from "./receipt.ts";
import { FINISHED_STATUSES, type IndexerClient, type WorkItem } from "./work-list.ts";

/** How long the archive waits before it retries a failed build on the same head, in milliseconds. */
export const RETRY_DELAY_MILLISECONDS = 600_000;

const ARCHIVE_TABLES = `
CREATE TABLE IF NOT EXISTS archive_entries (
  message_id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  covered_by_head_slot TEXT NOT NULL,
  built_at INTEGER,
  last_error TEXT,
  failed_on_head_slot TEXT,
  retry_at INTEGER
);
`;

/** One row of the archive's bookkeeping. */
type EntryRow = {
  message_id: string;
  direction: ProofDirection;
  transaction_hash: `0x${string}`;
  log_index: number;
  covered_by_head_slot: string;
  built_at: number | null;
  last_error: string | null;
  failed_on_head_slot: string | null;
  retry_at: number | null;
};

/** The state of the archive for the health report. */
export type ArchiveStatus = {
  readonly entries: number;
  readonly withEvidence: number;
  readonly failing: number;
  readonly lastCycleError: string | null;
};

/** The archive: what the module routes and the timer call. */
export interface ArchiveService {
  /** One pass: read the work list, drop delivered entries, build what is missing. Never throws. */
  runCycle(): Promise<void>;
  /** Resolves when no pass runs. */
  settled(): Promise<void>;
  /** The evidence JSON of a message exactly as stored, or null. */
  readEvidence(messageId: string): string | null;
  /** Counts for the health report. */
  status(): ArchiveStatus;
}

/** Input of {@link createArchiveService}. */
export interface ArchiveServiceInput {
  readonly storage: Storage;
  readonly prover: ProverBinary;
  readonly indexer: IndexerClient;
  /** Turns the block-level log index of the work list into the receipt index that the prover takes. */
  readonly receipts: ReceiptIndexReader;
  readonly pairName: string;
  readonly now: () => number;
  readonly logger: Logger;
}

/**
 * The direction of a message from its two chains, or null when the chains are not the pair. The first side of the pair
 * is the source of the first direction.
 */
export function directionOf(pairName: string, item: Pick<WorkItem, "sourceChainId" | "destinationChainId">): ProofDirection | null {
  const definition = PAIR_DEFINITIONS.find((candidate) => candidate.name === pairName);
  if (definition === undefined) return null;
  const [first, second] = definition.sides;
  if (item.sourceChainId === first.chainId && item.destinationChainId === second.chainId) return PROOF_DIRECTIONS[0];
  if (item.sourceChainId === second.chainId && item.destinationChainId === first.chainId) return PROOF_DIRECTIONS[1];
  return null;
}

/** The source chain of a direction of a known pair (the inverse of {@link directionOf}, which only lets known pairs into the table). */
export function sourceChainIdOf(pairName: string, direction: ProofDirection): number {
  const definition = PAIR_DEFINITIONS.find((candidate) => candidate.name === pairName)!;
  return direction === PROOF_DIRECTIONS[0] ? definition.sides[0].chainId : definition.sides[1].chainId;
}

/** Builds the archive over the backend database. It creates its own table. */
export function createArchiveService(input: ArchiveServiceInput): ArchiveService {
  const database = input.storage.database;
  database.exec(ARCHIVE_TABLES);
  let lastCycleError: string | null = null;
  let running: Promise<void> | null = null;

  const listEntries = () => database.prepare("SELECT * FROM archive_entries ORDER BY covered_by_head_slot, message_id").all() as EntryRow[];

  function addMissing(items: readonly WorkItem[]): void {
    const insert = database.prepare(
      "INSERT OR IGNORE INTO archive_entries (message_id, direction, transaction_hash, log_index, covered_by_head_slot) VALUES (?, ?, ?, ?, ?)",
    );
    const advance = database.prepare("UPDATE archive_entries SET covered_by_head_slot = ? WHERE message_id = ? AND CAST(covered_by_head_slot AS INTEGER) < CAST(? AS INTEGER)");
    for (const item of items) {
      const direction = directionOf(input.pairName, item);
      if (direction === null) continue;
      const messageId = item.messageId.toLowerCase();
      insert.run(messageId, direction, item.sentTransactionHash, item.sentLogIndex, item.coveredByHeadSlot);
      advance.run(item.coveredByHeadSlot, messageId, item.coveredByHeadSlot);
    }
  }

  function drop(messageId: string): void {
    input.storage.transaction(() => {
      database.prepare("DELETE FROM evidence WHERE message_id = ?").run(messageId);
      database.prepare("DELETE FROM archive_entries WHERE message_id = ?").run(messageId);
    });
  }

  async function dropFinished(listed: ReadonlySet<string>): Promise<void> {
    for (const entry of listEntries()) {
      if (listed.has(entry.message_id)) continue;
      const status = await input.indexer.readStatus(entry.message_id);
      if (status === null || !FINISHED_STATUSES.includes(status)) continue;
      drop(entry.message_id);
      input.logger.info("archive_entry_dropped", { messageId: entry.message_id, status });
    }
  }

  /**
   * Evidence is built once. The light client never deletes or overwrites a stored header (`BeaconLightClient.sol`), and
   * `MessageBridge.sol` (lines 311-312) only checks that the anchor is stored and then checks the ancestry branch built
   * with the evidence. So evidence built against any stored head stays valid, and a built entry is never built again.
   * A failed build retries when its delay is over or when the indexer reports a newer covering head.
   */
  function shouldBuild(entry: EntryRow): boolean {
    if (entry.built_at !== null) return false;
    if (entry.last_error === null) return true;
    const newerHead = entry.failed_on_head_slot !== null && BigInt(entry.covered_by_head_slot) > BigInt(entry.failed_on_head_slot);
    return newerHead || input.now() >= (entry.retry_at ?? 0);
  }

  function recordFailure(entry: EntryRow, error: unknown): void {
    const name = error instanceof Error ? error.name : "Error";
    const exitCode = error instanceof Error && "exitCode" in error ? ` exit code ${String(error.exitCode)}` : "";
    database
      .prepare("UPDATE archive_entries SET last_error = ?, failed_on_head_slot = ?, retry_at = ? WHERE message_id = ?")
      .run(`${name}${exitCode}`, entry.covered_by_head_slot, input.now() + RETRY_DELAY_MILLISECONDS, entry.message_id);
    input.logger.warn("archive_build_failed", { messageId: entry.message_id, error });
  }

  async function build(entry: EntryRow): Promise<void> {
    try {
      // The table keeps the index of the log inside its block, as the indexer reports it. The prover counts inside the receipt.
      const chainId = sourceChainIdOf(input.pairName, entry.direction);
      const logIndex = await input.receipts.receiptIndexOf({ chainId, transactionHash: entry.transaction_hash, blockLogIndex: entry.log_index });
      const evidence = await input.prover.evidence({ direction: entry.direction, transactionHash: entry.transaction_hash, logIndex });
      if (evidence.message.messageId.toLowerCase() !== entry.message_id) {
        throw new Error("the prover built evidence for a different message");
      }
      input.storage.transaction(() => {
        database
          .prepare(
            "INSERT INTO evidence (message_id, direction, body, stored_at) VALUES (?, ?, ?, ?) ON CONFLICT (message_id) DO UPDATE SET body = excluded.body, stored_at = excluded.stored_at",
          )
          .run(entry.message_id, entry.direction, JSON.stringify(evidence), input.now());
        database
          .prepare("UPDATE archive_entries SET built_at = ?, last_error = NULL, failed_on_head_slot = NULL, retry_at = NULL WHERE message_id = ?")
          .run(input.now(), entry.message_id);
      });
    } catch (error) {
      recordFailure(entry, error);
    }
  }

  async function cycle(): Promise<void> {
    try {
      const items = await input.indexer.readWorkList();
      addMissing(items);
      await dropFinished(new Set(items.map((item) => item.messageId.toLowerCase())));
      lastCycleError = null;
    } catch (error) {
      lastCycleError = error instanceof Error ? error.name : "Error";
      input.logger.warn("archive_indexer_failed", { error });
    }
    for (const entry of listEntries()) {
      if (shouldBuild(entry)) await build(entry);
    }
  }

  return {
    runCycle() {
      running ??= cycle().finally(() => {
        running = null;
      });
      return running;
    },
    async settled() {
      await running;
    },
    readEvidence(messageId) {
      const row = database.prepare("SELECT body FROM evidence WHERE message_id = ?").get(messageId.toLowerCase()) as { body: string } | undefined;
      return row?.body ?? null;
    },
    status() {
      const entries = listEntries();
      return {
        entries: entries.length,
        withEvidence: entries.filter((entry) => entry.built_at !== null).length,
        failing: entries.filter((entry) => entry.last_error !== null).length,
        lastCycleError,
      };
    },
  };
}
