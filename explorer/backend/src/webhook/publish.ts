import type { Hex } from "viem";
import type { ProofDirection } from "@zk-bridge/shared";
import type { BoardPublisher } from "@zk-bridge/shared/msgboard";
import type { Logger } from "../logger.ts";
import { getJob, updateJob, type Job } from "../requests/jobs.ts";
import type { Storage } from "../storage.ts";

/** The head of a light client. Only the slot matters here. */
export interface HeadReader {
  /** The slot of the head that the destination light client stores. */
  headSlot(direction: ProofDirection): Promise<bigint>;
}

/** The wait after the first failed post, in milliseconds. Each further failure doubles it. */
export const RETRY_BASE_MILLISECONDS = 15_000;

/** The longest wait between two posts of one proof, in milliseconds. */
export const RETRY_CEILING_MILLISECONDS = 900_000;

/** After this many failed posts the job fails. */
export const MAXIMUM_POST_ATTEMPTS = 10;

/** The reason of a job that the board never accepted. A fixed phrase: a board error can name an endpoint. */
export const POST_FAILED_REASON = "the proof could not be posted to the board";

/**
 * The wait before the next post, after `attempts` failed posts.
 *
 * @param attempts The number of failed posts, at least 1.
 */
export function retryDelayMilliseconds(attempts: number): number {
  return Math.min(RETRY_BASE_MILLISECONDS * 2 ** (attempts - 1), RETRY_CEILING_MILLISECONDS);
}

/** Input of {@link createProofPublisher}. */
export interface ProofPublisherInput {
  readonly storage: Storage;
  /** The board side of msgboard. The publisher holds no wallet: a post costs proof of work only. */
  readonly board: BoardPublisher;
  readonly categoryFor: (direction: ProofDirection) => Hex;
  readonly heads: HeadReader;
  readonly now: () => number;
  readonly logger: Logger;
}

/** The publisher of stored proofs. */
export interface ProofPublisher {
  /** Posts the stored proof of one job, once at a time. Never throws. */
  publish(jobId: string): Promise<void>;
  /** Retries every proof not yet posted, then moves published jobs on to on-chain when the head reached them. */
  tick(): Promise<void>;
  /** Resolves when no post runs. */
  settled(): Promise<void>;
}

type StoredProof = { job_id: string; direction: ProofDirection; payload: Hex; start_slot: string; new_slot: string; attempts: number; last_attempt_at: number | null };

/** A fixed phrase for the stored error: the text of a board error can name an endpoint. */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

/** Builds the publisher over the stored proofs. */
export function createProofPublisher(input: ProofPublisherInput): ProofPublisher {
  const { storage, logger } = input;
  const running = new Map<string, Promise<void>>();

  function unposted(): StoredProof[] {
    return storage.database.prepare("SELECT * FROM webhook_proofs WHERE posted_at IS NULL ORDER BY stored_at, rowid").all() as StoredProof[];
  }

  async function post(stored: StoredProof): Promise<void> {
    // The foreign key of the table guarantees that the job exists.
    const job = getJob(storage, stored.job_id) as Job;
    if (job.status !== "proving") {
      // The job timed out or ended while the proof waited. Posting would only waste proof of work.
      storage.database.prepare("DELETE FROM webhook_proofs WHERE job_id = ?").run(stored.job_id);
      logger.info("webhook_proof_dropped", { jobId: stored.job_id, status: job.status });
      return;
    }
    try {
      const posted = await input.board.post({ category: input.categoryFor(stored.direction), payload: stored.payload });
      storage.transaction(() => {
        storage.database.prepare("UPDATE webhook_proofs SET posted_at = ?, message_hash = ?, last_error = NULL WHERE job_id = ?").run(input.now(), posted.messageHash, stored.job_id);
        const moved = updateJob(storage, stored.job_id, { status: "published", startSlot: stored.start_slot, newSlot: stored.new_slot }, input.now(), ["proving"]);
        if (!moved) logger.warn("webhook_job_moved_during_post", { jobId: stored.job_id });
      });
      logger.info("webhook_proof_posted", { jobId: stored.job_id, messageHash: posted.messageHash, grindMilliseconds: posted.grindMilliseconds });
    } catch (error) {
      const attempts = stored.attempts + 1;
      storage.database
        .prepare("UPDATE webhook_proofs SET attempts = ?, last_attempt_at = ?, last_error = ? WHERE job_id = ?")
        .run(attempts, input.now(), errorKind(error), stored.job_id);
      logger.warn("webhook_post_failed", { jobId: stored.job_id, attempts, error });
      if (attempts < MAXIMUM_POST_ATTEMPTS) return;
      updateJob(storage, stored.job_id, { status: "failed", error: POST_FAILED_REASON }, input.now(), ["proving"]);
      storage.database.prepare("DELETE FROM webhook_proofs WHERE job_id = ?").run(stored.job_id);
      logger.warn("webhook_proof_given_up", { jobId: stored.job_id, attempts });
    }
  }

  function publish(jobId: string): Promise<void> {
    const known = running.get(jobId);
    if (known !== undefined) return known;
    const stored = unposted().find((row) => row.job_id === jobId);
    if (stored === undefined) return Promise.resolve();
    const task = post(stored).finally(() => running.delete(jobId));
    running.set(jobId, task);
    return task;
  }

  async function confirmPublished(): Promise<void> {
    const jobs = storage.database.prepare("SELECT id, direction, new_slot FROM jobs WHERE status = 'published' AND new_slot IS NOT NULL").all() as Array<{ id: string; direction: ProofDirection; new_slot: string }>;
    for (const job of jobs) {
      try {
        const head = await input.heads.headSlot(job.direction);
        if (head < BigInt(job.new_slot)) continue;
        const changed = updateJob(storage, job.id, { status: "on-chain" }, input.now(), ["published"]);
        logger.info("webhook_job_on_chain", { jobId: job.id, headSlot: head, changed });
      } catch (error) {
        logger.warn("webhook_head_unreadable", { jobId: job.id, error });
      }
    }
  }

  return {
    publish,
    async tick() {
      storage.database.prepare("DELETE FROM webhook_proofs WHERE posted_at IS NULL AND job_id IN (SELECT id FROM jobs WHERE status != 'proving')").run();
      const current = input.now();
      const due = unposted().filter((row) => row.last_attempt_at === null || current >= row.last_attempt_at + retryDelayMilliseconds(row.attempts));
      for (const stored of due) await publish(stored.job_id);
      await confirmPublished();
    },
    async settled() {
      while (running.size > 0) await Promise.all([...running.values()]);
    },
  };
}
