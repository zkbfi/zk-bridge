/**
 * The proofs the backend already has for a direction. Owner, 2026-11-01: "you should also have deduplication logic in
 * place so that you are never re-proving some proof you already have".
 *
 * Three places hold one: the board (the proof the msgboard indexer keeps, `proofs`), the webhook (a proof a job made,
 * `webhook_proofs`, posted or not), and the job itself (its slots once the prover reported them). A proof is still of
 * use while it starts at the light client's head: the contract takes an update only from its head. One that ends at or
 * below the head is applied already and covers nothing new.
 */
import type { ProofDirection } from "@zk-bridge/shared";
import type { Storage } from "../storage.ts";
import { findLatestJob } from "./jobs.ts";

/** Where a proof we have is. */
export type ProofPlace = "board" | "stored" | "job";

/** A proof we have: its slots, where it is, and since when (milliseconds since 1970). */
export type HeldProof = { readonly startSlot: number; readonly newSlot: number; readonly where: ProofPlace; readonly since: number };

const tableExists = (storage: Storage, name: string): boolean =>
  storage.database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/** Every proof of the direction in the backend database. The webhook table exists only once the webhook module ran. */
export function readHeldProofs(storage: Storage, direction: ProofDirection): HeldProof[] {
  type Row = { start_slot: string; new_slot: string; at: number };
  const of = (rows: Row[], where: ProofPlace): HeldProof[] => rows.map((row) => ({ startSlot: Number(row.start_slot), newSlot: Number(row.new_slot), where, since: row.at }));
  const board = storage.database.prepare("SELECT start_slot, new_slot, stored_at AS at FROM proofs WHERE direction = ?").all(direction) as Row[];
  const stored = tableExists(storage, "webhook_proofs") ? (storage.database.prepare("SELECT start_slot, new_slot, stored_at AS at FROM webhook_proofs WHERE direction = ?").all(direction) as Row[]) : [];
  const job = findLatestJob(storage, direction);
  const fromJob: HeldProof[] =
    job !== null && (job.status === "proving" || job.status === "published") && job.startSlot !== null && job.newSlot !== null
      ? [{ startSlot: Number(job.startSlot), newSlot: Number(job.newSlot), where: "job", since: job.updatedAt }]
      : [];
  return [...of(board, "board"), ...of(stored, "stored"), ...fromJob];
}

/**
 * The proof that can still land from the head and reaches furthest, or null. On a tie the one held longest wins: its
 * age decides whether it is stale.
 */
export function pendingFrom(held: readonly HeldProof[], headSlot: number): HeldProof | null {
  let best: HeldProof | null = null;
  for (const proof of held) {
    if (proof.startSlot !== headSlot || proof.newSlot <= headSlot) continue;
    if (best === null || proof.newSlot > best.newSlot || (proof.newSlot === best.newSlot && proof.since < best.since)) best = proof;
  }
  return best;
}

/** Whether a proof has waited to land longer than `staleSeconds`. */
export const isStale = (proof: HeldProof, nowMilliseconds: number, staleSeconds: number): boolean => nowMilliseconds - proof.since > staleSeconds * 1000;

/** A proof as a log text: "the proof from slot 1 to slot 2 (board)". */
export const describeHeld = (proof: HeldProof): string => `the proof from slot ${proof.startSlot} to slot ${proof.newSlot} (${proof.where})`;
