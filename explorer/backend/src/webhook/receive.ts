import { createHash, timingSafeEqual } from "node:crypto";
import type { Hex } from "viem";
import { encodeProofMessage, type ProofDirection } from "@zk-bridge/shared";
import { proofPackageSchema, type ProofAssessment } from "@zk-bridge/shared/prover";
import type { Logger } from "../logger.ts";
import { getJob, updateJob } from "../requests/jobs.ts";
import type { Storage } from "../storage.ts";

/** Creates the table of proofs that wait for the board. Safe to call again. */
export function ensureProofTable(storage: Storage): void {
  storage.database.exec(`
    CREATE TABLE IF NOT EXISTS webhook_proofs (
      job_id TEXT PRIMARY KEY REFERENCES jobs (id),
      direction TEXT NOT NULL,
      payload TEXT NOT NULL,
      start_slot TEXT NOT NULL,
      new_slot TEXT NOT NULL,
      stored_at INTEGER NOT NULL,
      posted_at INTEGER,
      message_hash TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      last_error TEXT
    )
  `);
}

/**
 * Compares the presented `Authorization` header with the expected bearer token. Both sides are hashed first, so the
 * comparison takes the same time for every input, whatever its length.
 *
 * @param header The value of the `Authorization` header, or undefined.
 * @param expected The token that the backend holds.
 */
export function bearerMatches(header: string | undefined, expected: string): boolean {
  const digest = (text: string): Buffer => createHash("sha256").update(text).digest();
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const sameToken = timingSafeEqual(digest(presented), digest(expected));
  return sameToken && presented !== "";
}

/** What the receiver did with one package. */
export type ReceiveOutcome =
  | { readonly kind: "unknown-job" }
  | { readonly kind: "not-proving"; readonly status: string }
  | { readonly kind: "malformed" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unavailable" }
  | { readonly kind: "stored" };

/** Input of {@link receiveProofPackage}. */
export interface ReceiveInput {
  readonly storage: Storage;
  readonly jobId: string;
  /** The pair name that the payload must carry. */
  readonly pairName: string;
  /** The parsed request body. */
  readonly body: unknown;
  /** Runs the same checks as the bots' runner on an encoded proof message. */
  readonly assess: (input: { payload: Hex; direction: ProofDirection }) => Promise<ProofAssessment>;
  readonly now: () => number;
  readonly logger: Logger;
}

/** A reason for a failed job that is safe to show: a fixed phrase, never the text of an error. */
function refusalText(reason: string): string {
  return `the proof was refused: ${reason}`;
}

function failJob(input: ReceiveInput, reason: string): ReceiveOutcome {
  const changed = updateJob(input.storage, input.jobId, { status: "failed", error: refusalText(reason) }, input.now(), ["proving"]);
  input.logger.warn("webhook_proof_refused", { jobId: input.jobId, reason, changed });
  return { kind: "refused", reason };
}

/**
 * Checks one package from the prover and stores it for the publisher.
 *
 * The job must be proving. A package that does not verify fails the job with the reason. A light client that cannot be
 * read is not the fault of the proof: the job stays proving and the caller may send the package again. A stored
 * package keeps the job proving: the publisher moves it to published after the post.
 */
export async function receiveProofPackage(input: ReceiveInput): Promise<ReceiveOutcome> {
  const job = getJob(input.storage, input.jobId);
  if (job === null) return { kind: "unknown-job" };
  if (job.status !== "proving") return { kind: "not-proving", status: job.status };
  // A replay (the prover sends again after the light client moved) must not fail a job that holds a good proof.
  const held = input.storage.database.prepare("SELECT 1 AS held FROM webhook_proofs WHERE job_id = ?").get(job.id);
  if (held !== undefined) return { kind: "stored" };
  const parsed = proofPackageSchema.safeParse(input.body);
  if (!parsed.success) return { kind: "malformed" };
  const proofPackage = parsed.data;
  let payload: Hex;
  try {
    payload = encodeProofMessage({
      version: 1,
      pair: input.pairName,
      direction: job.direction,
      programKey: proofPackage.programKey as Hex,
      startSlot: BigInt(proofPackage.startHeadSlot),
      startRoot: proofPackage.startHeadRoot as Hex,
      newSlot: BigInt(proofPackage.newHeadSlot),
      newRoot: proofPackage.newHeadRoot as Hex,
      publicValues: proofPackage.publicValues as Hex,
      proof: proofPackage.proof as Hex,
    });
  } catch {
    return failJob(input, "the package does not fit the proof message");
  }
  const verdict = await input.assess({ payload, direction: job.direction });
  if (!verdict.accept && verdict.reason === "light-client-unreadable") {
    input.logger.warn("webhook_light_client_unreadable", { jobId: input.jobId });
    return { kind: "unavailable" };
  }
  if (!verdict.accept) return failJob(input, verdict.reason);
  input.storage.database
    .prepare("INSERT OR IGNORE INTO webhook_proofs (job_id, direction, payload, start_slot, new_slot, stored_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(job.id, job.direction, payload, String(proofPackage.startHeadSlot), String(proofPackage.newHeadSlot), input.now());
  input.logger.info("webhook_proof_stored", { jobId: job.id, startSlot: proofPackage.startHeadSlot, newSlot: proofPackage.newHeadSlot });
  return { kind: "stored" };
}
